// Engine adapter: Hermes Agent (Nous Research), run as an ACP server (`hermes acp`) through the shared ACP client (acp.mjs).
// Status: gated, checked against the real Hermes 0.21 on Windows (docs/HARNESSES.md). Hermes's ACP mode alone asks only
// about file edits and dangerous terminal commands, so before every run Orchy writes its pre_tool_call hook into the
// profile (hermes-config.mjs): Hermes runs mcp/tool-hook.mjs before EVERY tool call and blocks when it denies, fails or
// times out. The ACP client runs strict: a tool that runs with neither an ACP request nor a hook OK stops the run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env } from '../env.mjs';
import { findBinary, probeVersion } from '../claude.mjs';
import { profilePath, psq, sq, scrubbedEnv } from './shared.mjs';
import { launchAcpRun, toAcpMcp } from './acp.mjs';
import { buildHermesConfigYaml, hermesConfigLooksSafe, HERMES_DROP } from './hermes-config.mjs';
import { inspectHermesAccount } from './tier-catalog.mjs';

let binCache = null;
function resolveBin() {
  const explicit = env('HERMES_CLI_PATH');
  if (explicit && fs.existsSync(explicit)) return explicit;
  const extra = [path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.hermes', 'bin')];
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    extra.push(path.join(process.env.LOCALAPPDATA, 'hermes', 'bin'));
  }
  return findBinary('hermes', extra);
}
const bin = () => { if (!binCache || !fs.existsSync(binCache)) binCache = resolveBin(); return binCache; };
let probe = null;
const cache = new Map();

/** `hermes acp` and what it needs: HERMES_HOME is the profile boundary (the docs' profile alias sets exactly that). */
export const hermesArgs = () => ['acp'];
export function hermesEnv(profileDir, base = process.env) {
  return scrubbedEnv(profileDir ? { HERMES_HOME: profilePath(profileDir) } : {}, { HERMES_ACP_SKIP_CONFIGURED_MCP: '1' }, { dropPrefixes: ['HERMES_'], dropNames: HERMES_DROP }, base);
}

/** The hook's command line as Hermes splits it (quotes stripped per token, so paths with spaces are fine). */
export const hermesHookCommand = ({ script, credsFile }, node = process.execPath) => [node, script, 'hermes', credsFile].map(a => `"${a}"`).join(' ');

/** Write the forced approvals and Orchy's hook into the profile's config.yaml (keeping the owner's other keys). */
export function writeHermesConfig(profileDir, { hookCommand = null } = {}) {
  const dir = profilePath(profileDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.yaml');
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf8'); } catch {}
  const next = buildHermesConfigYaml(cur, { hookCommand });
  if (!hermesConfigLooksSafe(next, { hookCommand })) throw new Error('Orchy could not build a safe Hermes config.');
  if (next !== cur) fs.writeFileSync(file, next, { mode: 0o600 });
  return file;
}

export default {
  id: 'hermes',
  label: 'Hermes',
  models: ['default', 'default', 'default'],
  blurb: 'Nous Research’s Hermes Agent. Sign in with OAuth (`hermes portal` or `hermes auth add <provider> --type oauth`); Orchy detects your plan/tier and shows only the models in your tier.',
  fields: { account: 'hermesAccount', profile: 'hermesProfile' },
  accountModel: 'profile',
  openModels: true,
  instructionFile: 'AGENTS.md',
  defaultProfileLabel: '(its own profile folder)',
  // Hermes installs natively on Windows from PowerShell (into %LOCALAPPDATA%\hermes\bin, where resolveBin looks)
  install: { cmd: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash', winCmd: 'iex (irm https://hermes-agent.nousresearch.com/install.ps1)', signIn: 'hermes portal', bin: 'hermes', optional: true, note: 'Optional: Nous Research’s agent harness.' },
  capabilities: {
    gated: true, mcp: true, resume: true, headless: true,
    clientSafe: false,
    clientReason: 'Hermes hasn’t been checked with clients’ sandboxes yet, so it is not offered to clients.',
    huddles: false,
    notes: 'hermes acp with Orchy’s pre_tool_call hook (fail_closed) in the profile: every tool call goes to the gate first; file edits also ask over ACP (answered from the hook’s OK, never twice). Approvals forced to manual, nothing allowlisted. Hermes stops a hook after 5 minutes: a longer wait for the owner is "still waiting", and the same call tried again waits on the same pop-up.',
  },
  bin,
  version() {
    const b = bin();
    if (!b) return null;
    if (!probe || probe.bin !== b || (!probe.v && Date.now() - probe.at > 60_000)) probe = { bin: b, at: Date.now(), v: probeVersion(b) };
    return probe.v;
  },
  available: () => !!bin(),
  /** Which OAuth provider(s) and plan/tier this profile is signed into, plus its tier-filtered model list. */
  async account(profileDir, { force = false, maxAge = 60_000 } = {}) {
    const key = profileDir ? profilePath(profileDir) : '__default__';
    const hit = cache.get(key);
    if (!force && hit && Date.now() - hit.at < maxAge) return hit.v;
    const v = inspectHermesAccount(profileDir ? key : null);
    cache.set(key, { at: Date.now(), v });
    return v;
  },
  profileEnv(profileDir) { return profileDir ? { HERMES_HOME: profilePath(profileDir) } : {}; },
  loginCommand: (a, { win }) => (win ? `& ${psq(bin() || 'hermes')} portal` : `${sq(bin() || 'hermes')} portal`),
  loginAlt: () => 'Signs in via OAuth to Nous Portal (`hermes portal`), or run `hermes auth add <provider> --type oauth` (e.g. openai-codex, anthropic, copilot, xai) in the same terminal to sign in with your ChatGPT Plus/Pro, Claude Pro/Max, GitHub Copilot, or SuperGrok subscription.',
  mcpConfig: ({ servers, allowed, bridge }) => toAcpMcp(servers, allowed, bridge),
  protocolNotes: ({ ownerName }) => `
## Working on Hermes
- Every tool call you make goes to ${ownerName}'s approvals first: routine work in this folder runs, and decisions (sending, posting, spending, deleting, sharing, calendar changes) wait for an OK, so a call may pause. If a call is refused, don't try another way to do the same thing. If Orchy says it is still waiting for ${ownerName}'s OK, wait a minute and make exactly the same call again.
- The jos tools above are MCP tools on the \`jos\` server. Call them like any other tool; ask ${ownerName} with \`ask_user\`.
- Skills in \`.claude/skills/<name>/\` are plain folders: when your instructions name one, read its \`SKILL.md\` and the files it points to, and follow them.
`,
  launch(run, ws, opts, rt) {
    const hooks = rt.hooks(run, ws);
    // from here every tool call Hermes makes waits for the gate (mcp/tool-hook.mjs → runner.mjs#toolHook)
    writeHermesConfig(ws.hermesProfile, { hookCommand: hermesHookCommand(hooks.useToolHook('hermes')) });
    const handle = launchAcpRun({
      cwd: ws.dir, bin: bin(), args: hermesArgs(), env: hermesEnv(ws.hermesProfile), label: 'Hermes',
      prompt: opts.prompt, system: rt.instructions(ws, run, opts.agentMarkdown, opts.planText),
      mcpServers: opts.mcp, resumeSessionId: opts.resume || null, requestedModel: run.model,
      strict: true, // every non-read tool must have asked: over ACP, or through the hook (hooks.takeHookAllow)
    }, hooks);
    rt.live.set(run.id, { fingerprint: opts.fingerprint, stop: () => handle.stop() });
    run.pid = handle.pid;
  },
};
