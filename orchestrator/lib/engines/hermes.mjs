// Engine adapter: Hermes Agent (Nous Research), run as an ACP server (`hermes acp`) through the shared ACP client (acp.mjs).
// Status: implemented, unverified against the real binary, and NOT gated (capabilities.gated = false): Hermes' ACP mode
// bridges only dangerous terminal-command approvals to the client; file writes, patches, web and MCP tools never ask.
// Reasons and the evidence that would flip it: docs/HARNESSES.md. The run therefore only starts in a workspace the owner
// opted in with allowUngated.
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
