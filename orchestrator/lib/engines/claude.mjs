// Engine adapter: Claude Code (`claude -p --output-format stream-json`). The implementation stays in ../claude.mjs;
// this module wraps it in the engine interface (see index.mjs) and holds the launch code that used to sit in runner.mjs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../env.mjs';
import { CLAUDE_BIN, claudeVersion, claudeAvailable, authStatus, spawnClaude } from '../claude.mjs';
import { profilePath, psq, sq, killTree } from './shared.mjs';

/** Convert Orchy's `.jos/mcp.json` registry entries into Claude Code --mcp-config entries. */
export function toClaudeMcp(servers, names) {
  const out = {};
  for (const [name, s] of Object.entries(servers)) {
    if (!s.enabled) continue;
    if (names && !names.includes(name)) continue;
    out[name] = s.type === 'stdio'
      ? { type: 'stdio', command: s.command, args: s.args || [], env: s.env || {} }
      : { type: s.type, url: s.url, headers: s.headers || {} };
  }
  return out;
}

// Every Claude Code process on one profile (Orchy's runs, the owner's own sessions) shares its sign-in, and
// when the token expires they race to refresh it. The losers fail before doing anything; Claude says
// to retry in a minute, so a run that hasn't used a tool yet tries again instead of failing.
const AUTH_RACE = /Failed to refresh OAuth token|another Claude Code process is refreshing/i;
const AUTH_RETRIES = 2;

function retryAfterAuthRace(rt, run, ws, fingerprint, relaunch) {
  run.authRetries = (run.authRetries || 0) + 1;
  run.apiError = null;
  run.resultText = null;
  // jittered, so runs that collided don't collide again
  const wait = 30_000 * run.authRetries + Math.floor(Math.random() * 30_000);
  rt.record(run, { kind: 'system', text: `Claude's sign-in was busy (another Claude Code process was refreshing it). Trying again in ${Math.round(wait / 1000)}s.` });
  const timer = setTimeout(relaunch, wait);
  rt.live.set(run.id, { fingerprint, stop: () => { clearTimeout(timer); rt.finish(run, ws, null, ''); } });
  rt.save();
}

function launchClaude(rt, run, ws, { prompt, agentSlug, mcpFile, resume, fingerprint, planText = '' }) {
  const model = run.model;
  const d = rt.deps;
  // a client's run works in the client's own corner (clientspace.mjs): Claude Code refuses reads outside it,
  // every edit and command passes Orchy's gate, and none of the owner's CLAUDE.md files or memory load
  const home = run.client ? d.ensureHome(ws, run.client) : null;
  const fence = home ? [
    '--settings', d.clientSettingsFile(ws, run, home),
    ...d.clientReadDirs(ws, home).flatMap(x => ['--add-dir', x]),
  ] : ['--settings', run.backend ? d.backendSettingsFile(run) : rt.setupSettingsFile(ws, run)];

  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--model', model,
    '--mcp-config', mcpFile, '--strict-mcp-config',
    // a client's run edits nothing without the gate (default mode asks for every edit; the gate allows its own folder),
    // and a huddle turn changes nothing at all (no edit tools; every command passes the gate's talk-only rule)
    '--permission-mode', home || run.huddleTalk ? 'default' : 'acceptEdits',
    ...fence,
    '--permission-prompt-tool', 'mcp__jos__approval',
    '--disallowedTools', 'AskUserQuestion', // no one sees it headless; mcp__jos__ask_user is the owner's question box
    ...(run.huddleTalk ? ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] : []),
    // the workspace's agents never run inside another run (heads hand work over with mcp__jos__delegate instead);
    // a client's run also can't edit the workspace's setup
    ...(run.backend ? [] : new Set([...d.nativeAgentDenyRules(d.listAgents(ws.id).map(a => a.slug)), ...d.clientDenyRules(run, d.listAgents(ws.id).map(a => a.slug))])),
    '--append-system-prompt-file', d.protocolFile(ws, run, planText),
    '--name', `Orchy · ${run.agentName}`.slice(0, 60),
  ];
  if (resume) args.push('--resume', resume);
  else args.push('--session-id', run.sessionId);
  if (agentSlug) args.push('--agent', agentSlug);

  const child = spawnClaude(args, {
    cwd: home || ws.dir,
    configDir: ws.claudeConfigDir,
    noSecrets: !!home,
    extraEnv: {
      MCP_TOOL_TIMEOUT: '86400000', MCP_TIMEOUT: '60000', DISABLE_AUTOUPDATER: '1',
      ...(home ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } : {}),
      // No background work: `claude -p` kills background subagents and shells 10 minutes after the agent's
      // own turn ends, cancelling any pop-up they're waiting on. In the foreground the agent waits for its
      // helpers (and the owner) and reports when the work is really done. Long renders get up to an hour instead.
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', BASH_MAX_TIMEOUT_MS: '3600000',
    },
  });
  const stop = () => killTree(child);
  rt.live.set(run.id, { child, fingerprint, stop });
  run.pid = child.pid;

  let buf = '', stderr = '';
  child.stdout.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) rt.handleLine(run, ws, line);
    }
  });
  child.stderr.on('data', x => { stderr = (stderr + x).slice(-4000); });
  child.on('error', e => { stderr += `\n${e.message}`; });
  child.on('close', code => {
    const failed = code !== 0 || run.apiError;
    if (failed && run.status !== 'stopping' && !run.report && !rt.live.get(run.id)?.acted
      && AUTH_RACE.test(`${run.apiError || ''}\n${stderr}`) && (run.authRetries || 0) < AUTH_RETRIES) {
      return retryAfterAuthRace(rt, run, ws, fingerprint, () => {
        if (!resume) run.sessionId = crypto.randomUUID(); // the failed attempt may have claimed the old id
        launchClaude(rt, run, ws, { prompt, agentSlug, mcpFile, resume, fingerprint, planText });
      });
    }
    rt.finish(run, ws, code, stderr);
  });
  child.stdin.end(prompt);
}

// does Claude Code's profile for this workspace hold this session? (projects/<cwd with :  _ / as ->/<id>.jsonl)
function sessionExists(ws, sessionId) {
  try {
    const profile = ws.claudeConfigDir ? profilePath(ws.claudeConfigDir) : path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude');
    const proj = path.resolve(ws.dir).replace(/[^a-zA-Z0-9]/g, '-');
    return fs.existsSync(path.join(profile, 'projects', proj, `${sessionId}.jsonl`));
  } catch { return true; } // can't tell: let Claude decide
}

export default {
  id: 'claude',
  label: 'Claude Code',
  models: ['haiku', 'sonnet', 'opus'],
  blurb: 'Anthropic’s Claude models.',
  fields: { account: 'claudeAccount', profile: 'claudeConfigDir' },
  accountModel: 'email',
  instructionFile: 'CLAUDE.md',
  defaultProfileLabel: '(default ~/.claude)',
  install: { cmd: 'npm install -g @anthropic-ai/claude-code', optional: false, note: 'The usual choice of agent harness.' },
  capabilities: {
    gated: true, mcp: true, resume: true, headless: true,
    // can this engine be kept inside a client's folder / talk without changing anything / take handed-over work?
    clientSafe: true, huddles: true,
    notes: 'Every permission request goes to the MCP tool mcp__jos__approval, which calls the Orchy gate.',
  },
  bin: () => CLAUDE_BIN,
  version: () => claudeVersion(),
  available: () => claudeAvailable(),
  async account(profileDir, opts = {}) {
    const s = await authStatus(profileDir, opts);
    return { ...s, loggedIn: !!s.loggedIn, email: s.email || null, label: s.email || null, subscription: s.subscriptionType || null };
  },
  profileEnv: profileDir => (profileDir ? { CLAUDE_CONFIG_DIR: profilePath(profileDir) } : {}),
  loginCommand: (a, { win }) => `claude auth login --email ${win ? psq(a.email) : sq(a.email)}`,
  loginAlt: () => null,
  mcpConfig({ servers, allowed, bridge }) {
    // same for Claude Code, which otherwise drops a bridge call after 30 silent minutes while the owner decides
    return { mcpServers: { jos: { type: 'stdio', ...bridge, timeout: 86_400_000 }, ...toClaudeMcp(servers, allowed) } };
  },
  protocolNotes: () => '',
  canResume: sessionExists,
  launch(run, ws, opts, rt) {
    const mcpFile = path.join(DATA_DIR, 'runs', `${run.id}.mcp.json`);
    fs.writeFileSync(mcpFile, JSON.stringify(opts.mcp, null, 2));
    launchClaude(rt, run, ws, { prompt: opts.prompt, agentSlug: opts.agentSlug, mcpFile, resume: opts.resume, fingerprint: opts.fingerprint, planText: opts.planText });
  },
};
