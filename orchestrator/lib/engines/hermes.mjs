// Engine adapter: Hermes Agent (Nous Research), run as an ACP server (`hermes acp`) through the shared ACP client (acp.mjs).
// Status: implemented, unverified against the real binary, and NOT gated (capabilities.gated = false): Hermes' ACP mode
// bridges only dangerous terminal-command approvals to the client; file writes, patches, web and MCP tools never ask.
// Reasons and the evidence that would flip it: docs/HARNESSES.md. The run therefore only starts in a workspace the owner
// opted in with allowUngated.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { env } from '../env.mjs';
import { findBinary, probeVersion } from '../claude.mjs';
import { profilePath, psq, sq, scrubbedEnv } from './shared.mjs';
import { launchAcpRun, toAcpMcp } from './acp.mjs';
import { buildHermesConfigYaml, hermesConfigLooksSafe, HERMES_DROP, parseHermesStatus } from './hermes-config.mjs';

let binCache = null;
function resolveBin() {
  const explicit = env('HERMES_CLI_PATH');
  if (explicit && fs.existsSync(explicit)) return explicit;
  return findBinary('hermes', [path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.hermes', 'bin')]);
}
const bin = () => { if (!binCache || !fs.existsSync(binCache)) binCache = resolveBin(); return binCache; };
let probe = null;
const cache = new Map();

/** `hermes acp` and what it needs: HERMES_HOME is the profile boundary (the docs' profile alias sets exactly that). */
export const hermesArgs = () => ['acp'];
export function hermesEnv(profileDir, base = process.env) {
  return scrubbedEnv(profileDir ? { HERMES_HOME: profilePath(profileDir) } : {}, { HERMES_ACP_SKIP_CONFIGURED_MCP: '1' }, { dropPrefixes: ['HERMES_'], dropNames: HERMES_DROP }, base);
}

/** Write the forced approvals into the profile's config.yaml (keeping the owner's other keys). Returns the file. */
export function writeHermesConfig(profileDir) {
  const dir = profilePath(profileDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.yaml');
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf8'); } catch {}
  const next = buildHermesConfigYaml(cur);
  if (!hermesConfigLooksSafe(next)) throw new Error('Orchy could not build a safe Hermes config.');
  if (next !== cur) fs.writeFileSync(file, next, { mode: 0o600 });
  return file;
}

function runStatus(profileDir) {
  return new Promise(resolve => {
    const b = bin();
    if (!b) return resolve('');
    const shell = /\.(cmd|bat)$/i.test(b);
    execFile(shell ? `"${b}"` : b, ['status'], { env: hermesEnv(profileDir), timeout: 8000, windowsHide: true, shell }, (err, out, errOut) => resolve(err ? '' : String(out || errOut || '')));
  });
}

export default {
  id: 'hermes',
  label: 'Hermes',
  models: ['default', 'default', 'default'],
  blurb: 'Nous Research’s Hermes Agent. Orchy can’t put its file edits behind your approvals, so it only runs where you allow that.',
  fields: { account: 'hermesAccount', profile: 'hermesProfile' },
  accountModel: 'profile',
  instructionFile: 'AGENTS.md',
  defaultProfileLabel: '(its own profile folder)',
  install: { cmd: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash', shellNote: true, optional: true, note: 'Optional: Nous Research’s agent harness.' },
  capabilities: {
    gated: false, mcp: true, resume: true, headless: true,
    clientSafe: false,
    clientReason: 'Hermes cannot be held behind Orchy’s approvals, so it is not offered to clients.',
    huddles: false,
    notes: 'hermes acp: only dangerous terminal commands are sent to the client for approval (session/request_permission); file writes, patches, web and MCP tools run without asking. Approvals are forced to manual and nothing is allowlisted. Needs allowUngated.',
  },
  bin,
  version() {
    const b = bin();
    if (!b) return null;
    if (!probe || probe.bin !== b || (!probe.v && Date.now() - probe.at > 60_000)) probe = { bin: b, at: Date.now(), v: probeVersion(b) };
    return probe.v;
  },
  available: () => !!bin(),
  /** Which provider(s) this profile has (from `hermes status`, or its auth.json/.env when status says nothing). */
  async account(profileDir, { force = false, maxAge = 60_000 } = {}) {
    if (!profileDir) return { loggedIn: false, email: null, label: null, providers: [] };
    const key = profilePath(profileDir);
    const hit = cache.get(key);
    if (!force && hit && Date.now() - hit.at < maxAge) return hit.v;
    const text = await runStatus(profileDir);
    const { providers, model } = parseHermesStatus(text);
    let hasAuth = false;
    try { const j = JSON.parse(fs.readFileSync(path.join(key, 'auth.json'), 'utf8')); hasAuth = !!j && Object.keys(j).length > 0; } catch {}
    const loggedIn = providers.length > 0 || hasAuth;
    const label = providers.length ? providers.join(', ') + (model ? ` (${model})` : '') : hasAuth ? 'logged in (provider not shown)' : null;
    const v = { loggedIn, email: null, label, providers, subscription: null };
    cache.set(key, { at: Date.now(), v });
    return v;
  },
  profileEnv(profileDir) { return profileDir ? { HERMES_HOME: profilePath(profileDir) } : {}; },
  loginCommand: (a, { win }) => (win ? `& ${psq(bin() || 'hermes')} setup` : `${sq(bin() || 'hermes')} setup`),
  loginAlt: () => 'Choose the provider and model in the setup it opens, then check it with `hermes status` (same profile variable). Hermes may share OAuth logins (Anthropic, OpenAI Codex, xAI) from ~/.hermes/auth.json: use an API-key provider so the workspace keeps its own.',
  mcpConfig: ({ servers, allowed, bridge }) => toAcpMcp(servers, allowed, bridge),
  protocolNotes: ({ ownerName }) => `
## Working on Hermes
- ${ownerName}'s approvals cover dangerous shell commands here; file edits and other tools run directly, so stay inside this folder and never touch anything outside it.
- The jos tools above are MCP tools on the \`jos\` server. Call them like any other tool; ask ${ownerName} with \`ask_user\`.
- Skills in \`.claude/skills/<name>/\` are plain folders: when your instructions name one, read its \`SKILL.md\` and the files it points to, and follow them.
`,
  launch(run, ws, opts, rt) {
    writeHermesConfig(ws.hermesProfile);
    rt.record(run, { kind: 'system', text: 'Hermes only asks Orchy about dangerous shell commands. Its file edits and other tools run without approvals in this workspace (allowed by its owner).' });
    const handle = launchAcpRun({
      cwd: ws.dir, bin: bin(), args: hermesArgs(), env: hermesEnv(ws.hermesProfile), label: 'Hermes',
      prompt: opts.prompt, system: rt.instructions(ws, run, opts.agentMarkdown, opts.planText),
      mcpServers: opts.mcp, resumeSessionId: opts.resume || null, requestedModel: run.model,
      strict: false, // ungated by design: the owner opted in, so unasked actions are noted, not fatal
    }, rt.hooks(run, ws));
    rt.live.set(run.id, { fingerprint: opts.fingerprint, stop: () => handle.stop() });
    run.pid = handle.pid;
  },
};
