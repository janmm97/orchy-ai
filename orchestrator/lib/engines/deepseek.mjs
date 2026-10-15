// Engine adapter: DeepSeek Harness (`dsh --profile acp`, ACP over stdio) through the shared ACP client (acp.mjs).
// Status: implemented, unverified against the real binary (public preview, APIs change), and NOT gated
// (capabilities.gated = false): dsh's default policy confines writes with a sandbox instead of asking for each one,
// and the docs don't say that approvals reach ACP clients as session/request_permission. See docs/HARNESSES.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { env } from '../env.mjs';
import { findBinary, probeVersion } from '../claude.mjs';
import { profilePath, psq, sq, scrubbedEnv } from './shared.mjs';
import { launchAcpRun, toAcpMcp } from './acp.mjs';
import { buildDshPatchYaml, dshPatchLooksSafe, dshArgs, parseDshConfig, DSH_PROFILE, DSH_PERMISSION_MODE } from './deepseek-config.mjs';

let binCache = null;
function resolveBin() {
  const explicit = env('DSH_CLI_PATH') || env('DSH_PATH');
  if (explicit && fs.existsSync(explicit)) return explicit;
  return findBinary('dsh', [path.join(os.homedir(), '.local', 'bin')]);
}
const bin = () => { if (!binCache || !fs.existsSync(binCache)) binCache = resolveBin(); return binCache; };
let probe = null;
const cache = new Map();

/** DSH_HOME is the profile: credentials, settings, presets and session logs all live under it. */
export function dshEnv(profileDir, base = process.env) {
  return scrubbedEnv(profileDir ? { DSH_HOME: profilePath(profileDir) } : {}, { DSH_PERMISSION_MODE }, { dropPrefixes: ['DSH_'] }, base);
}

export function writeDshPatch(profileDir) {
  const dir = path.join(profilePath(profileDir), 'profiles', DSH_PROFILE);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'cordis.patch.yml');
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf8'); } catch {}
  const next = buildDshPatchYaml(cur);
  if (!dshPatchLooksSafe(next)) throw new Error('Orchy could not build a safe DeepSeek patch.');
  if (next !== cur) fs.writeFileSync(file, next, { mode: 0o600 });
  return file;
}

function dumpConfig(profileDir) {
  return new Promise(resolve => {
    const b = bin();
    if (!b) return resolve('');
    const shell = /\.(cmd|bat)$/i.test(b);
    execFile(shell ? `"${b}"` : b, [...dshArgs(), '--dump-config'], { env: dshEnv(profileDir), timeout: 10_000, windowsHide: true, shell }, (err, out, errOut) => resolve(err ? '' : String(out || errOut || '')));
  });
}

export default {
  id: 'deepseek',
  label: 'DeepSeek Harness',
  models: ['default', 'default', 'default'],
  blurb: 'DeepSeek’s open-source harness (public preview). Orchy can’t confirm it asks before every action, so it only runs where you allow that.',
  fields: { account: 'deepseekAccount', profile: 'deepseekProfile' },
  accountModel: 'profile',
  instructionFile: 'AGENTS.md',
  defaultProfileLabel: '(its own DSH_HOME folder)',
  install: { cmd: 'npx @deepseek-ai/dsh web', optional: true, note: 'Optional: DeepSeek’s agent harness (public preview). Orchy needs the `dsh` command on the PATH, or DSH_CLI_PATH in .env.' },
  capabilities: {
    gated: false, mcp: true, resume: false, headless: true,
    clientSafe: false,
    clientReason: 'DeepSeek Harness cannot be held behind Orchy’s approvals, so it is not offered to clients.',
    huddles: false,
    notes: 'dsh --profile acp with the workspace-write preset (approval: ask) and no auto-approval plugin. Writes inside the workspace are sandboxed rather than asked, and ACP permission requests are not documented. Needs allowUngated.',
  },
  bin,
  version() {
    const b = bin();
    if (!b) return null;
    if (!probe || probe.bin !== b || (!probe.v && Date.now() - probe.at > 60_000)) probe = { bin: b, at: Date.now(), v: probeVersion(b) };
    return probe.v;
  },
  available: () => !!bin(),
  /** The provider/model this DSH_HOME is configured with (from `dsh --profile acp --dump-config`). */
  async account(profileDir, { force = false, maxAge = 60_000 } = {}) {
    if (!profileDir) return { loggedIn: false, email: null, label: null, providers: [] };
    const key = profilePath(profileDir);
    const hit = cache.get(key);
    if (!force && hit && Date.now() - hit.at < maxAge) return hit.v;
    const { providers, model } = parseDshConfig(await dumpConfig(profileDir));
    let hasKey = false;
    try { hasKey = fs.statSync(path.join(key, '.credentials.yaml')).size > 0; } catch {}
    const loggedIn = hasKey; // the key is saved in $DSH_HOME/.credentials.yaml (Settings → Models)
    const label = loggedIn ? (providers.length ? providers.join(', ') + (model ? ` (${model})` : '') : 'API key saved') : null;
    const v = { loggedIn, email: null, label, providers, subscription: null };
    cache.set(key, { at: Date.now(), v });
    return v;
  },
  profileEnv: profileDir => (profileDir ? { DSH_HOME: profilePath(profileDir) } : {}),
  loginCommand: (a, { win }) => (win ? `& ${psq(bin() || 'dsh')} web` : `${sq(bin() || 'dsh')} web`),
  loginAlt: () => 'Open the URL it prints, go to Settings → Models, enter your DeepSeek API key and save. The key is stored in this workspace’s DSH_HOME folder.',
  mcpConfig: ({ servers, allowed, bridge }) => toAcpMcp(servers, allowed, bridge),
  protocolNotes: ({ ownerName }) => `
## Working on DeepSeek Harness
- Writes are limited to this folder by the harness; risky steps may ask ${ownerName}. Stay inside this folder.
- The jos tools above are MCP tools on the \`jos\` server. Call them like any other tool.
- Skills in \`.claude/skills/<name>/\` are plain folders: read their \`SKILL.md\` and follow it.
`,
  launch(run, ws, opts, rt) {
    writeDshPatch(ws.deepseekProfile);
    rt.record(run, { kind: 'system', text: 'DeepSeek Harness runs here without Orchy approvals for most actions (allowed by this workspace’s owner); its own workspace-write sandbox and asks still apply.' });
    const handle = launchAcpRun({
      cwd: ws.dir, bin: bin(), args: dshArgs(), env: dshEnv(ws.deepseekProfile), label: 'DeepSeek Harness',
      prompt: opts.prompt, system: rt.instructions(ws, run, opts.agentMarkdown, opts.planText),
      mcpServers: opts.mcp, resumeSessionId: null, strict: false,
    }, rt.hooks(run, ws));
    rt.live.set(run.id, { fingerprint: opts.fingerprint, stop: () => handle.stop() });
    run.pid = handle.pid;
  },
};
