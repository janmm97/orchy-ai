// Engine registry. An engine is a coding-agent harness Orchy can run in a workspace (Claude Code, Codex, Hermes, Antigravity, Cursor).
// Everything that used to compare `runtime === 'codex'` asks the registry instead.
//
// An engine module's default export has this shape:
//   id, label, models: [quick, normal, strong], blurb
//   fields: { account, profile, computerLogin? }   the workspace keys in config.json (e.g. claudeAccount / claudeConfigDir);
//                                    computerLogin (Hermes): the key for the owner's choice between this computer's
//                                    sign-in (shared by every workspace set that way) and the profile's own
//   accountModel: 'email' | 'profile'  'email' = a login with an email address; 'profile' = no account concept (API keys,
//                                     provider logins): accountCheck needs a profile folder of its own, shared with no
//                                     other workspace, and reports the provider(s) from account().label
//   instructionFile                  the instructions file the harness reads in the workspace folder
//   defaultProfileLabel              how the default profile is shown ("(default ~/.claude)")
//   capabilities: { gated, mcp, resume, headless, clientSafe, clientReason?, huddles, notes }
//   optIn?: 'ENV_NAME'                an engine that is off unless the owner sets ENV_NAME=1 in .env (engineOffered)
//   sharedLogin?: true                one sign-in per computer: every workspace on it must name the same account
//       gated: false = Orchy can't put every risky action behind its approval gate; startRun refuses it unless the
//       workspace has `allowUngated: true` in config.json
//   install: { cmd, winCmd?, winRepair?, signIn?, bin?, optional, note, shellNote? }   how the setup guide / `npm run setup` /
//                                    `npm run check` / the Add window install it (installer.mjs runs it for the owner):
//                                    cmd for macOS/Linux, winCmd for Windows PowerShell, then signIn (the default
//                                    profile's sign-in) once `bin` runs; winRepair finishes a half-done Windows install
//   bin() → path|null, version() → string|null, available() → boolean
//   account(profileDir, { force, maxAge }) → Promise<{ loggedIn, email?, label, error?, subscription?, sandbox? }>
//   profileEnv(profileDir, account?) → { ENV_VAR: value }   the variables that pick the per-workspace profile
//                                    (account: accountFor's answer, for an engine whose login depends on computerLogin)
//   loginCommand(account, { win }) → the harness's login command (the env prefix comes from profileEnv)
//   loginAlt(account, ws) → a hint shown beside the command, or null
//   mcpConfig({ servers, allowed, bridge }) → the harness's own MCP config for Orchy's bridge + the allowed servers
//   protocolNotes({ ownerName }) → extra text for the agent's protocol (harness-specific tips), '' for none
//   canResume?(ws, sessionId) → boolean   (optional) can this profile resume that session?
//   launch(run, ws, opts, rt)        start the run; register rt.live.set(run.id, { fingerprint, stop }) and set run.pid.
//                                    opts: { prompt, agentSlug, agentMarkdown, mcp, resume, fingerprint, planText }
//                                    rt (runner.mjs): { live, record, finish, save, hooks(run, ws), instructions(…), … }
//                                    Events carry `toolUseId` on tool / tool_done / tool_error; a finished tool's
//                                    tool_done has a counts-only `brief` (rt.briefFor). A run that fails on its
//                                    account's session/usage limit (rt.SESSION_LIMIT_RE) pauses via rt.limitPause;
//                                    engines using rt.hooks get both for free.
import claude from './claude.mjs';
import codex from './codex.mjs';
import hermes from './hermes.mjs';
import antigravity from './antigravity.mjs';
import cursor from './cursor.mjs';
import { env } from '../env.mjs';

const REG = new Map();

const REQUIRED = ['id', 'label', 'models', 'fields', 'accountModel', 'capabilities', 'bin', 'available', 'account', 'profileEnv', 'loginCommand', 'mcpConfig', 'launch'];

function check(def) {
  for (const k of REQUIRED) if (def?.[k] === undefined) throw new Error(`Engine "${def?.id || '?'}" is missing "${k}"`);
  if (!['email', 'profile'].includes(def.accountModel)) throw new Error(`Engine "${def.id}": accountModel must be "email" or "profile"`);
  if (!def.fields.account || !def.fields.profile) throw new Error(`Engine "${def.id}": fields needs account and profile`);
  if (typeof def.capabilities.gated !== 'boolean') throw new Error(`Engine "${def.id}": capabilities.gated must be true or false`);
}

/** Add (or replace) an engine. Returns a function that puts the previous one back (tests use it). */
export function registerEngine(def) {
  check(def);
  const prev = REG.get(def.id);
  REG.set(def.id, def);
  return () => { if (prev) REG.set(def.id, prev); else REG.delete(def.id); };
}

for (const e of [claude, codex, hermes, antigravity, cursor]) registerEngine(e);

/** One registered engine, or null (an id that config.json mentions but this Orchy has no adapter for is not an engine). */
export const engine = id => REG.get(id) || null;
export const engines = () => [...REG.values()];
export const engineIds = () => [...REG.keys()];

/**
 * Why a workspace may not run on this engine, or null. An engine that can't hold every risky action behind Orchy's
 * approval gate (capabilities.gated === false) is refused unless the owner opted that workspace in (allowUngated).
 */
export function ungatedRefusal(ws, eng) {
  if (!eng || eng.capabilities.gated) return null;
  if (ws?.allowUngated === true) return null;
  return `${ws?.name || 'This workspace'} runs on ${eng.label}, which Orchy can't hold behind its approval gate, so it could change files and run commands without asking. Orchy won't start it unless you allow that for this workspace (Workspaces → ${ws?.name || 'the workspace'} → allow it to run without approvals).`;
}

/**
 * Is this engine switched on here? Most always are; an opt-in one (Antigravity) only once the owner sets its variable
 * (ORCHY_ANTIGRAVITY=1 in .env). One that isn't offered is not shown for new workspaces and no run starts on it.
 */
export const engineOffered = e => !!e && (!e.optIn || /^(1|true|yes|on)$/i.test(String(env(e.optIn) || '').trim()));

/** Why no run may start on this engine right now (it is opt-in and switched off), or null. */
export function offeredRefusal(eng) {
  if (!eng || engineOffered(eng)) return null;
  return `${eng.label} is switched off in this Orchy. To use it, set ${eng.optIn}=1 in .env (README → Supported harnesses).`;
}

/** What the dashboard and /api/runtimes show about an engine. */
export const engineInfo = e => ({
  id: e.id, label: e.label, blurb: e.blurb || '', accountModel: e.accountModel, fields: e.fields,
  instructionFile: e.instructionFile || null, capabilities: e.capabilities,
  offered: engineOffered(e), optIn: e.optIn || null, sharedLogin: !!e.sharedLogin,
  computerLogin: !!e.fields.computerLogin, // a workspace may run on this computer's sign-in or one of its own
});

/** The command that installs this engine on this OS ('' when it has none). */
export function engineInstallCmd(e, { win = process.platform === 'win32' } = {}) {
  const i = e?.install || {};
  if (win && i.winCmd) return i.winCmd;
  return (i.cmd || '') + (i.shellNote && win ? '   (run in WSL or Git Bash)' : '');
}

/**
 * 'ok' (its program answers --version), 'broken' (the program is there but won't start: an install that didn't finish,
 * e.g. an npm package whose postinstall didn't run) or 'missing'.
 */
export function engineHealth(e) {
  if (!e?.available()) return 'missing';
  if (!e.version) return 'ok';
  try { return e.version() ? 'ok' : 'broken'; } catch { return 'broken'; }
}

/**
 * Why Orchy won't run this engine as it is installed here (a version it can't hold behind the owner's approvals),
 * or null. An engine without a `runRefusal()` has nothing to refuse; one whose check throws is
 * refused (fail closed).
 */
export function runRefusal(e) {
  if (!e?.runRefusal) return null;
  try { return e.runRefusal() || null; } catch (err) { return `Orchy couldn't check which ${e.label} this is (${String(err?.message || err).slice(0, 120)}), so it isn't running it.`; }
}

/** The command that finishes a half-done install: the engine's own repair on Windows, else installing it again. */
export function engineRepairCmd(e, { win = process.platform === 'win32' } = {}) {
  return (win && e?.install?.winRepair) || engineInstallCmd(e, { win });
}

/** What to tell the owner when engineHealth says 'broken'; `then` is what they do once it's fixed. */
export function brokenMessage(e, { win = process.platform === 'win32', then = 'press Re-check' } = {}) {
  const i = e?.install || {};
  const fix = engineRepairCmd(e, { win });
  return `${e.label} is on this computer but won't start (${e.bin() || i.bin || e.id}): its install didn't finish.${fix ? ` Run this in a terminal, then ${then}: ${fix}` : ` Install it again, then ${then}.`}`;
}

/** Every registered engine as a setup-guide row: found / version / install command / gated (setup, the dashboard's Tools step and `npm run check` all read this). */
export function engineTools({ win = process.platform === 'win32' } = {}) {
  return engines().filter(engineOffered).map(e => {
    const i = e.install || {};
    return {
      id: e.id, label: e.label, kind: 'harness', optional: i.optional !== false && e.id !== 'claude',
      install: engineInstallCmd(e, { win }),
      note: [i.note, e.capabilities.gated ? '' : 'Not gated: runs only in a workspace you allow to work without Orchy approvals.'].filter(Boolean).join(' '),
      gated: e.capabilities.gated,
    };
  });
}
