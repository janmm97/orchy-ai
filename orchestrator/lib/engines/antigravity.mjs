// Engine adapter: Google Antigravity's CLI (`agy`), headless: `agy -p --output-format stream-json`, the prompt on stdin.
// Status: implemented, unverified against the real binary in this repo (fake-binary tests only; docs/HARNESSES.md).
//
// Off by default: an owner switches it on with ORCHY_ANTIGRAVITY=1 in .env (engineOffered in index.mjs). Not gated
// (capabilities.gated = false): headless agy can't ask anyone and its hooks can only block, so
//   1. the workspace must opt in (allowUngated, like every ungated engine),
//   2. the owner approves every run up front (an approval card before agy starts; nothing is remembered), and
//   3. agy then runs `always-proceed` inside deny rules Orchy writes into the agent's own agy folder (`--gemini_dir`)
//      before each run: no writes to the workspace's setup, no reads of other workspaces, retired ones, Orchy's own
//      files, .env, sign-in folders or other workspaces' agy folders. Its shell commands are NOT checked, so a
//      workspace without its own One login never runs on it (runner.mjs refuses every ungated engine there).
// Its Google sign-in is one per computer, so every Antigravity workspace runs as the same account
// (`antigravityAccount`, the same in every such workspace: workspaces.mjs checks it when one is added or changed, and
// accountCheck compares it with who agy says it is signed in as before every run).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { env, expandPath, ROOT, DATA_DIR, LOGS_PATH } from '../env.mjs';
import { findBinary, probeVersion } from '../claude.mjs';
import { briefFor, textBuffer } from '../activity.mjs';
import { psq, sq, killTree, scrubbedEnv } from './shared.mjs';

export const ANTIGRAVITY = 'antigravity';
const WIN = process.platform === 'win32';

let binCache = null;
let testBinOverride = false;
function resolveBin() {
  const explicit = env('AGY_CLI_PATH');
  if (explicit) return fs.existsSync(expandPath(explicit)) ? expandPath(explicit) : null;
  const extra = [path.join(os.homedir(), '.gemini', 'bin'), path.join(os.homedir(), '.local', 'bin')];
  if (WIN && process.env.LOCALAPPDATA) {
    extra.push(
      path.join(process.env.LOCALAPPDATA, 'Programs', 'Antigravity', 'bin'),
      path.join(process.env.LOCALAPPDATA, 'Programs', 'antigravity-cli'),
    );
  }
  return findBinary('agy', extra);
}
export const agyBin = () => { if (!binCache || !fs.existsSync(binCache)) binCache = resolveBin(); return binCache; };
/** Tests point the adapter at a fake agy. */
export function setAgyBinForTests(p) { binCache = p; testBinOverride = !!p; }

function isTempTestBin(binPath) {
  if (testBinOverride) return true;
  if (!binPath) return false;
  try {
    const realTmp = fs.realpathSync(os.tmpdir()).toLowerCase();
    const realBin = fs.realpathSync(binPath).toLowerCase();
    return realBin.startsWith(realTmp);
  } catch {
    return String(binPath).toLowerCase().startsWith(os.tmpdir().toLowerCase());
  }
}

/** Read Google OAuth sign-in state from ~/.gemini/google_accounts.json + ~/.gemini/oauth_creds.json (instant, no Electron spawn). */
export function readGeminiOAuthAccount(geminiRoot = path.join(os.homedir(), '.gemini')) {
  try {
    const acctPath = path.join(geminiRoot, 'google_accounts.json');
    const credsPath = path.join(geminiRoot, 'oauth_creds.json');
    if (!fs.existsSync(acctPath)) return null;
    const acct = JSON.parse(fs.readFileSync(acctPath, 'utf8'));
    const active = typeof acct?.active === 'string' && acct.active.includes('@') ? acct.active.trim() : null;
    if (!active) return { loggedIn: false, email: null, error: 'Antigravity isn’t signed in. Click Log in to sign in with Google OAuth.' };
    if (fs.existsSync(credsPath)) {
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      if (creds && (creds.refresh_token || creds.access_token)) {
        return { loggedIn: true, email: active, subscription: 'Google OAuth', plan: 'Google OAuth' };
      }
    }
    return null; // an account named but no token stored: ask agy itself
  } catch {
    return null;
  }
}

/** Where a workspace keeps its agents' agy folders (`antigravityHome`, else ~/.antigravity-orchy/<id>). */
export const agyRoot = ws => (ws?.antigravityHome ? expandPath(ws.antigravityHome) : path.join(os.homedir(), '.antigravity-orchy', String(ws?.id || 'workspace')));
/** One agent's own agy folder (the generalist's is `general`): its settings, MCP servers and conversations. */
export const agyHome = (ws, slug) => path.join(agyRoot(ws), String(slug || 'general').replace(/[^\w.-]/g, '_'));

// a .cmd/.bat (AGY_CLI_PATH, tests on Windows) only starts through the shell; quote every argument for it
function start(bin, args, opts) {
  const o = { ...opts, detached: !WIN }; // its own process group, so killTree stops everything it started
  if (!/\.(cmd|bat)$/i.test(bin)) return spawn(bin, args, o);
  const q = a => `"${String(a).replace(/"/g, '""')}"`;
  return spawn([bin, ...args].map(q).join(' '), [], { ...o, shell: true });
}

// the PC's provider keys stay out (scrubbedEnv), and so do the other harnesses' profile variables
const runEnv = (extra = {}) => scrubbedEnv({}, extra, { dropNames: ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'ANTIGRAVITY_GEMINI_DIR'] });

// Who agy is signed in as: checks ~/.gemini Google OAuth credentials first, falling back to `agy models` for test shims.
let acctCache = null;
export async function agyAccount({ force = false, maxAge = 60_000 } = {}) {
  if (!force && acctCache && Date.now() - acctCache.at < maxAge) return acctCache.value;
  const bin = agyBin();
  if (!bin) return { loggedIn: false, email: null, error: 'Antigravity (agy) isn’t installed on this computer' };
  if (!isTempTestBin(bin)) {
    const fast = readGeminiOAuthAccount();
    if (fast) {
      acctCache = { at: Date.now(), value: fast };
      return fast;
    }
  }
  const dir = path.join(DATA_DIR, 'agy-check');
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'models.log');
  try { fs.rmSync(log, { force: true }); } catch {}
  const value = await new Promise(resolve => {
    let child;
    try { child = start(bin, ['--gemini_dir', path.join(dir, 'home'), '--log-file', log, 'models'], { cwd: dir, env: runEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ loggedIn: false, email: null, error: e.message }); }
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => killTree(child), 8_000);
    child.on('error', e => { clearTimeout(timer); resolve({ loggedIn: false, email: null, error: e.message }); });
    child.on('close', () => {
      clearTimeout(timer);
      let text = ''; try { text = fs.readFileSync(log, 'utf8'); } catch {}
      const email = (text + '\n' + out).match(/authenticated successfully as\s+([^\s"']+@[^\s"']+)/i)?.[1] || null;
      resolve(email ? { loggedIn: true, email, subscription: 'Google OAuth', plan: 'Google OAuth' } : { loggedIn: false, email: null, error: /log ?in|auth|sign/i.test(out) ? out.trim().split('\n').pop().slice(0, 300) : 'Antigravity isn’t signed in. Click Log in to sign in with Google OAuth.' });
    });
  });
  acctCache = { at: Date.now(), value };
  return value;
}

// ── the agent's agy folder: settings (permissions) and MCP servers, rewritten every run ──
const slash = p => path.resolve(p).replace(/\\/g, '/');
// a workspace's own setup: agents, instructions, connections, Resources/. The builder may still write agent files.
const SETUP = ['.claude/', '.codex/', '.agents/', '.gemini/', '.one/', '.jos/mcp.json', '.jos/retired/', '.clients/', 'Resources/', 'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'GEMINI.md', '.mcp.json'];
const BUILDER_SETUP = ['.claude/settings.json', '.claude/settings.local.json', '.claude/skills/', '.claude/hooks/', '.claude/commands/', '.claude/rules/', '.claude/output-styles/', ...SETUP.filter(s => s !== '.claude/' && s !== 'Resources/')];
// the sign-in folders of the harnesses and of One, in the home folder
const SIGN_INS = ['.one', '.gemini', '.codex', '.claude', '.claude.json', '.hermes', '.config/opencode', '.local/share/opencode', '.deepseek'];

/**
 * The run's deny rules. Writes: its own workspace's setup. Reads (and so writes): every other workspace and its
 * profile folders, retired workspaces, Orchy's own code and data, .env, the owner's uploads, reports and LOGS.md, the
 * sign-in folders of every harness and of One, and other workspaces' agy folders. Commands aren't covered: the owner
 * approves each run knowing that.
 */
export function denyRules(ws, { isBuilder = false, others = [], profiles = [] } = {}) {
  const home = os.homedir();
  let homeNames = [];
  try { homeNames = fs.readdirSync(home).filter(n => /^\.(claude|codex|hermes|opencode|deepseek)-/i.test(n)); } catch {}
  const reads = [
    ...others.map(w => w.dir), path.join(ROOT, 'Retired'), path.join(ROOT, 'orchestrator'), path.join(ROOT, '.env'),
    path.join(ROOT, 'Uploads'), path.join(ROOT, 'Reports'), LOGS_PATH,
    ...SIGN_INS.map(n => path.join(home, ...n.split('/'))), ...homeNames.map(n => path.join(home, n)),
    ...profiles.filter(Boolean).map(p => expandPath(p)), ...others.map(agyRoot),
  ];
  return [
    ...(isBuilder ? BUILDER_SETUP : SETUP).map(s => `write_file(${slash(path.join(ws.dir, s))}${s.endsWith('/') ? '/' : ''})`),
    ...[...new Set(reads.map(slash))].map(p => `read_file(${p})`),
  ];
}

/** Write the agent's agy folder for this run. Run-specific values (bridge token, run id) travel in the environment. */
export function prepareHome(ws, slug, { bridge, servers = {}, allowed = null, isBuilder = false, others = [], profiles = [] }) {
  const dir = agyHome(ws, slug);
  fs.mkdirSync(path.join(dir, 'antigravity-cli'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  const names = Object.entries(servers).filter(([n, s]) => n !== 'jos' && s && s.enabled !== false && s.type !== 'sse' && (!allowed || allowed.includes(n))).map(([n]) => n);
  const settingsFile = path.join(dir, 'antigravity-cli', 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch {}
  Object.assign(settings, {
    toolPermission: 'always-proceed', artifactReviewPolicy: 'always-proceed', allowNonWorkspaceAccess: false,
    enableTelemetry: false, showFeedbackSurvey: false, notifications: false,
    permissions: { allow: ['mcp(jos/*)', ...names.map(n => `mcp(${n}/*)`)], deny: denyRules(ws, { isBuilder, others, profiles }), ask: [] },
  });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  // the other servers never see Orchy's bridge token, which every MCP server would otherwise inherit from agy
  const hide = { JOS_TOKEN: '', JOS_RUN_ID: '', JOS_URL: '' };
  const mcpServers = { jos: { command: bridge.command, args: bridge.args } };
  for (const n of names) {
    const s = servers[n];
    mcpServers[n] = s.type === 'stdio' || s.command ? { command: s.command, args: s.args || [], env: { ...(s.env || {}), ...hide } } : { url: s.url, headers: s.headers || {} };
  }
  fs.writeFileSync(path.join(dir, 'config', 'mcp_config.json'), JSON.stringify({ mcpServers }, null, 2) + '\n', { mode: 0o600 });
  return dir;
}

/** agy's arguments for one turn (the prompt goes in on stdin, never on the command line). */
export function agyArgs({ home, model, effort, resume, logFile }) {
  const args = ['--gemini_dir', home, '--output-format', 'stream-json', '--input-format', 'stream-json', '--disable-slash-commands'];
  if (model && model !== 'default') args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (resume) args.push('--conversation', resume);
  if (logFile) args.push('--log-file', logFile);
  args.push('-p=');
  return args;
}

/** Start agy for one turn. The prompt goes in on stdin (one stream-json line). */
export function spawnAgy({ home, cwd, model, effort, resume, prompt, logFile, env: extra = {} }) {
  const bin = agyBin();
  if (!bin) throw new Error('Antigravity (agy) isn’t installed on this computer. Install it, or set AGY_CLI_PATH in .env to the agy program.');
  const child = start(bin, agyArgs({ home, model, effort, resume, logFile }), { cwd, env: runEnv(extra), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ event: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n');
  return child;
}

// agy's tool calls in the names Orchy's feed, policy words and describeTool know
const TOOL_NAMES = { run_command: 'Bash', view_file: 'Read', write_to_file: 'Write', replace_file_content: 'Edit', multi_replace_file_content: 'Edit', sed_file: 'Edit', grep_search: 'Grep', find_by_name: 'Glob', list_dir: 'LS', read_url_content: 'WebFetch', search_web: 'WebSearch' };
export function agyTool(info = {}) {
  const p = info.parameters || {};
  if (info.name === 'call_mcp_tool') return { tool: `mcp__${p.ServerName}__${p.ToolName}`, input: p.Arguments || {} };
  const tool = TOOL_NAMES[info.name] || `AGY_${info.name || 'tool'}`;
  const input = info.name === 'run_command' ? { command: p.CommandLine, cwd: p.Cwd }
    : p.AbsolutePath || p.TargetFile ? { ...p, file_path: p.AbsolutePath || p.TargetFile }
    : info.name === 'read_url_content' ? { ...p, url: p.Url || p.url } : p;
  return { tool, input };
}

/**
 * One line of agy's stream-json, as what Orchy records. Returns
 * { conversationId?, init?, text?, textStep?, toolUseId?, tool?, toolDone?, toolError?, usage?, result? } (any subset).
 */
export function parseAgyLine(line) {
  let m;
  try { m = JSON.parse(String(line).replace(/^﻿/, '')); } catch { return null; }
  if (!m || typeof m !== 'object') return null;
  const out = {};
  const s = m.step_update;
  const id = m.conversation_id || s?.conversation_id || m.result?.conversation_id;
  if (id) out.conversationId = id;
  if (m.event === 'init') { out.init = true; out.permissionMode = m.init?.permission_mode; }
  if (s?.step_type === 'agent_response' && s.text_delta) { out.text = s.text_delta; out.textStep = s.step_index; }
  if (s?.usage) out.usage = s.usage;
  // a tool step's index ties its ACTIVE, DONE and ERROR updates together (the run's toolUseId)
  if (s?.step_type === 'tool' && s.step_index != null) out.toolUseId = `agy-${s.step_index}`;
  if (s?.step_type === 'tool' && s.state === 'ACTIVE') out.tool = agyTool(s.tool_info);
  if (s?.step_type === 'tool' && s.state === 'DONE') { const t = agyTool(s.tool_info); const o = s.tool_info?.output ?? s.tool_info?.result; out.toolDone = { tool: t.tool, brief: o == null ? 'done' : briefFor(t.tool, o) }; }
  if (s?.step_type === 'tool' && s.state === 'ERROR') out.toolError = { ...agyTool(s.tool_info), message: s.tool_info?.error?.message || 'Tool failed' };
  if (m.event === 'result') out.result = m.result || {};
  return out;
}

const tokensOf = u => (u ? { input: u.input_tokens || 0, output: u.output_tokens || 0, total: u.total_tokens || (u.input_tokens || 0) + (u.output_tokens || 0) } : null);

let probe = null;

export default {
  id: ANTIGRAVITY,
  label: 'Antigravity',
  models: ['gemini-3.8-flash-medium', 'gemini-4-argon-medium', 'gemini-4-argon-high'],
  blurb: 'Google’s Antigravity CLI. It can’t ask you anything once it starts, so you approve each run up front; its commands aren’t checked.',
  fields: { account: 'antigravityAccount', profile: 'antigravityHome' },
  accountModel: 'email',
  // one Google sign-in per computer: every Antigravity workspace must name the same account (workspaces.mjs)
  sharedLogin: true,
  // any model id `agy models` lists may be named in an agent file (workspaces.mjs#modelFor)
  openModels: true,
  // off unless the owner switches it on (engineOffered in index.mjs)
  optIn: 'ORCHY_ANTIGRAVITY',
  instructionFile: 'AGENTS.md',
  defaultProfileLabel: '(~/.antigravity-orchy/<workspace>)',
  install: { cmd: 'See antigravity.google for the agy CLI', optional: true, note: 'Optional and off by default (ORCHY_ANTIGRAVITY=1 in .env): Google’s Antigravity CLI.' },
  capabilities: {
    gated: false, mcp: true, resume: true, headless: true,
    clientSafe: false,
    clientReason: 'Antigravity can’t be held behind Orchy’s approvals, so it is not offered to clients.',
    huddles: false,
    notes: 'agy -p with stream-json in and out. It can’t ask mid-run, so the owner approves every run first; it then runs always-proceed inside deny rules Orchy writes (--gemini_dir). Commands are not checked. Needs allowUngated and the workspace’s own One login.',
  },
  bin: () => agyBin(),
  version() {
    const b = agyBin();
    if (!b) return null;
    if (!probe || probe.bin !== b || (!probe.v && Date.now() - probe.at > 60_000)) probe = { bin: b, at: Date.now(), v: probeVersion(b) };
    return probe.v;
  },
  available: () => !!agyBin(),
  async account(_profileDir, opts = {}) {
    const s = await agyAccount(opts);
    return { ...s, loggedIn: !!s.loggedIn, email: s.email || null, label: s.email || null };
  },
  // the agy folder is passed per run (--gemini_dir); its sign-in isn't in it
  profileEnv: () => ({}),
  // agy signs in on its first interactive start (/logout switches account)
  loginCommand: (a, { win }) => (win ? `& ${psq(agyBin() || 'agy')}` : sq(agyBin() || 'agy')),
  loginAlt: a => `Antigravity has one Google sign-in for the whole computer, shared by every Antigravity workspace. Sign in as ${a?.email || 'the shared account'} (if it's signed in as someone else, type /logout first, then start it again). Close it with /exit.`,
  // agy reads its MCP servers from its own folder (prepareHome), so launch gets the raw pieces
  mcpConfig: ({ servers, allowed, bridge }) => ({ servers, allowed, bridge }),
  protocolNotes: ({ ownerName }) => `
## Working on Antigravity
- ${ownerName} approved this whole run up front: Antigravity can't ask anything on the way, so nothing you do pauses for an OK. Hold back yourself. Your file tools can't touch this workspace's setup (.claude/, .agents/, Resources/, CLAUDE.md, AGENTS.md…), other workspaces, Orchy's files or sign-ins. Before sending, posting, spending, deleting, sharing, changing a calendar, using another folder or using a connection your definition doesn't list, ask ${ownerName} with ask_user and wait for an explicit yes.
- The jos tools above are MCP tools on the \`jos\` server (call_mcp_tool with ServerName jos). Ask questions only with ask_user and finish with report_done: nobody reads your replies until the report.
- Do the work yourself: no subagents, scheduled tasks, browser automation or image generation unless your instructions ask for them.
- Skills in \`.claude/skills/<name>/\` are plain folders: when your instructions name one, read its \`SKILL.md\` and the files it points to, and follow them. Its Claude-only parts (the Skill tool, hooks, Claude subagents) don't run here: do those steps yourself.
- If a tool is refused, don't try another way to do the same thing; say so in your report.
`,
  launch(run, ws, opts, rt) {
    const hooks = rt.hooks(run, ws);
    let child = null, stopped = false;
    rt.live.set(run.id, { fingerprint: opts.fingerprint, stop: () => { stopped = true; killTree(child); hooks.done({ code: null, status: 'interrupted' }); } });
    (async () => {
      // headless agy can't ask: this one OK covers the whole task, every time (never remembered)
      const ok = await hooks.approveRun({
        title: `Run ${run.agentName} on Antigravity?`,
        message: `Antigravity can't ask you anything once it starts, so this one OK covers the whole task: its commands, file changes in ${ws.name}, web and app tools run without further asks. Its file tools can't touch ${ws.name}'s setup, other workspaces, Orchy's files or sign-ins; its commands aren't checked.`,
      });
      if (stopped) return;
      if (!ok) { hooks.record({ kind: 'denied', text: 'The Antigravity run was not approved.' }); return hooks.done({ code: 1, status: 'failed', error: 'Antigravity run was not approved.' }); }
      const { servers, allowed, bridge } = opts.mcp || {};
      const others = rt.deps.allWorkspaces ? rt.deps.allWorkspaces().filter(w => w.id !== ws.id) : [];
      const profiles = rt.deps.profileDirs ? rt.deps.profileDirs(ws, others, ANTIGRAVITY) : [];
      const home = prepareHome(ws, run.agentSlug || 'general', { bridge, servers, allowed, isBuilder: !!run.isBuilder, others, profiles });
      let text = '', stderr = '', buf = '', result = null;
      const said = textBuffer(t => hooks.record({ kind: 'text', text: t })); // one text event per agy message, not per delta
      child = spawnAgy({
        home, cwd: ws.dir, model: run.model, effort: run.effort, resume: opts.resume,
        prompt: `${rt.instructions(ws, run, opts.agentMarkdown, opts.planText)}\n\n# Current request\n${opts.prompt}`,
        logFile: path.join(DATA_DIR, 'runs', `${run.id}.agy.log`),
        env: bridge?.env || {}, // the jos MCP server inherits its run id and token from agy; the mcp_config file holds none
      });
      run.pid = child.pid;
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', d => {
        buf += d;
        let end;
        while ((end = buf.indexOf('\n')) >= 0) {
          const e = parseAgyLine(buf.slice(0, end)); buf = buf.slice(end + 1);
          if (!e || stopped) continue;
          if (e.conversationId && run.sessionId !== e.conversationId) hooks.started({ threadId: e.conversationId });
          else if (e.init) hooks.started({ threadId: run.sessionId });
          if (e.text) { text += e.text; said.add(e.text, e.textStep); }
          if (e.tool || e.toolError || e.toolDone || e.result) said.flush();
          if (e.tool) hooks.record({ kind: 'tool', tool: e.tool.tool, toolUseId: e.toolUseId, input: e.tool.input || {} });
          if (e.toolDone) hooks.record({ kind: 'tool_done', toolUseId: e.toolUseId, tool: e.toolDone.tool, ok: true, brief: e.toolDone.brief });
          if (e.toolError) hooks.record({ kind: /permission check failed|denied/i.test(e.toolError.message) ? 'denied' : 'tool_error', toolUseId: e.toolUseId, tool: e.toolError.tool, text: e.toolError.message.slice(0, 600) });
          if (e.usage) hooks.usage(tokensOf(e.usage));
          if (e.result) result = e.result;
        }
      });
      child.on('error', e => { if (!stopped) { stopped = true; hooks.done({ code: 1, status: 'failed', error: e.message }); } });
      child.on('close', code => {
        if (stopped) return;
        stopped = true;
        said.flush();
        if (result) {
          if (result.num_turns != null) run.numTurns = result.num_turns;
          if (result.usage) hooks.usage(tokensOf(result.usage));
          const denied = result.denied_actions || [];
          if (denied.length) { run.permissionDenials = denied.length; hooks.record({ kind: 'denied', text: `Antigravity refused: ${denied.map(d => d.display_name || d.action).join(', ')}` }); }
          const ok = result.status === 'SUCCESS';
          return hooks.done({ code: ok ? 0 : (code || 1), status: ok ? 'completed' : 'failed', error: ok ? null : (stderr.trim().split('\n').pop() || `Antigravity stopped: ${result.status}`), resultText: String(result.response || text).trim() });
        }
        hooks.done({ code: code || 1, status: 'failed', error: stderr.trim().split('\n').pop() || 'Antigravity ended without a result', resultText: text.trim() });
      });
    })().catch(e => { killTree(child); if (!stopped) { stopped = true; hooks.done({ code: 1, status: 'failed', error: e.message }); } });
  },
};
