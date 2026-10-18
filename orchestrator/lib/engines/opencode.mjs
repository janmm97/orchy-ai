// Engine adapter: OpenCode (`opencode serve` + its HTTP API). Status: implemented, unverified against the real binary
// (docs/HARNESSES.md). The run adapter is opencode-run.mjs, the generated config opencode-config.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env, DATA_DIR } from '../env.mjs';
import { findBinary, probeVersion } from '../claude.mjs';
import { profilePath, psq, sq } from './shared.mjs';
import { buildOpenCodeConfig } from './opencode-config.mjs';
import { launchOpenCodeRun } from './opencode-run.mjs';
import { inspectOpenCodeAccount } from './tier-catalog.mjs';

let binCache = null;
function resolveBin() {
  const explicit = env('OPENCODE_CLI_PATH');
  if (explicit && fs.existsSync(explicit)) return explicit;
  const extra = [path.join(os.homedir(), '.opencode', 'bin')];
  if (process.platform === 'win32' && process.env.APPDATA) {
    extra.push(path.join(process.env.APPDATA, 'npm'));
  }
  return findBinary('opencode', extra);
}
const bin = () => { if (!binCache || !fs.existsSync(binCache)) binCache = resolveBin(); return binCache; };

let probe = null;
const acctCache = new Map();

/** Where a profile keeps its pieces: credentials in data/opencode/auth.json (XDG_DATA_HOME), config in config/. */
export function profileLayout(dir) {
  const d = profilePath(dir);
  return { root: d, data: path.join(d, 'data'), state: path.join(d, 'state'), xdgConfig: path.join(d, 'xdg-config'), config: path.join(d, 'config'), auth: path.join(d, 'data', 'opencode', 'auth.json') };
}

export default {
  id: 'opencode',
  label: 'OpenCode',
  // "default" = no model passed: OpenCode uses the provider/model its own config picks (or "provider/model" if the owner selects one)
  models: ['default', 'default', 'default'],
  blurb: 'Open-source coding agent (`opencode.ai`). Sign in with OAuth (`opencode auth login`); Orchy detects your plan/tier and shows only the models in your tier.',
  fields: { account: 'opencodeAccount', profile: 'opencodeProfile' },
  accountModel: 'profile',
  openModels: true,
  instructionFile: 'AGENTS.md',
  defaultProfileLabel: '(its own profile folder)',
  // opencode.ai/docs: the install script (~/.opencode/bin); on Windows the npm package (the script run in WSL lands
  // inside Linux, where Orchy can't find it). winRepair: npm leaves a placeholder opencode.exe ("not compatible with
  // the version of Windows") when the package's postinstall, which copies in the real one, didn't run
  install: { cmd: 'curl -fsSL https://opencode.ai/install | bash', winCmd: 'npm install -g opencode-ai', winRepair: 'cd "$env:APPDATA\\npm\\node_modules\\opencode-ai"; node postinstall.mjs', signIn: 'opencode auth login', bin: 'opencode', optional: true, note: 'Optional: an open-source agent harness.' },
  capabilities: {
    gated: true, mcp: true, resume: true, headless: true,
    clientSafe: false,
    clientReason: 'Orchy has not verified that OpenCode can be kept inside a client’s folder yet.',
    huddles: false,
    notes: 'opencode serve with every tool set to "ask"; each ask is answered through the permission endpoint by the Orchy gate (once / reject). Implemented, unverified against the real binary.',
  },
  bin,
  version() {
    const b = bin();
    if (!b) return null;
    if (!probe || probe.bin !== b || (!probe.v && Date.now() - probe.at > 5_000)) probe = { bin: b, at: Date.now(), v: probeVersion(b) };
    return probe.v;
  },
  available: () => !!bin(),
  /** Which OAuth provider(s) and plan/tier this profile is logged in to, plus its tier-filtered model list. */
  async account(profileDir, { force = false, maxAge = 30_000 } = {}) {
    const key = profileDir ? profilePath(profileDir) : '__default__';
    const hit = acctCache.get(key);
    if (!force && hit && Date.now() - hit.at < maxAge) return hit.v;
    const authPath = profileDir ? profileLayout(profileDir).auth : null;
    const v = await inspectOpenCodeAccount(profileDir ? key : null, {
      authPath,
      binPath: bin(),
      profileEnv: profileDir ? this.profileEnv(profileDir) : {},
    });
    acctCache.set(key, { at: Date.now(), v });
    return v;
  },
  profileEnv(profileDir) {
    if (!profileDir) return {};
    const l = profileLayout(profileDir);
    return { XDG_DATA_HOME: l.data, XDG_STATE_HOME: l.state, XDG_CONFIG_HOME: l.xdgConfig, OPENCODE_CONFIG_DIR: l.config };
  },
  loginCommand: (a, { win }) => (win ? `& ${psq(bin() || 'opencode')} auth login` : `${sq(bin() || 'opencode')} auth login`),
  loginAlt: () => 'Select your provider (OpenCode Zen/Go, Anthropic Claude Pro/Max, OpenAI ChatGPT Plus/Pro, or GitHub Copilot) in the terminal prompt to sign in via OAuth, then check it with `opencode auth list`.',
  mcpConfig: ({ servers, allowed, bridge }) => buildOpenCodeConfig({ servers, allowed, bridge }),
  protocolNotes: ({ ownerName }) => `
## Working on OpenCode
- Every tool you use (shell, file edits, web, MCP) first asks ${ownerName}'s approval policy: work in this folder goes straight through, anything outward waits for ${ownerName}. If a request is refused, don't try it another way.
- The jos tools above are MCP tools on the \`jos\` server; OpenCode names them \`jos_ask_user\`, \`jos_report_done\`, \`jos_note\`… Call them like any other tool.
- OpenCode's own question box and sub-agents are switched off: ask with \`jos_ask_user\` and do the work yourself.
- Skills in \`.claude/skills/<name>/\` are plain folders: when your instructions name one, read its \`SKILL.md\` and the files it points to, and follow them.
`,
  launch(run, ws, opts, rt) {
    const runDir = path.join(DATA_DIR, 'runs', `${run.id}.opencode`);
    const handle = launchOpenCodeRun({
      cwd: ws.dir,
      bin: bin(),
      profileEnv: this.profileEnv(ws.opencodeProfile),
      runDir,
      config: opts.mcp,
      model: run.model,
      prompt: opts.prompt,
      system: rt.instructions(ws, run, opts.agentMarkdown, opts.planText),
      resumeSessionId: opts.resume || null,
      title: `Orchy · ${run.agentName}`.slice(0, 60),
      cleanup: () => { try { fs.rmSync(runDir, { recursive: true, force: true }); } catch {} },
    }, rt.hooks(run, ws));
    rt.live.set(run.id, { fingerprint: opts.fingerprint, stop: () => handle.stop() });
    run.pid = handle.pid;
  },
};
