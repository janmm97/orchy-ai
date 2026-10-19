// Workspace registry: folders, runtimes (the registered engines: Claude Code, Codex, Hermes…), their accounts, One connections
// and external MCP servers. config.json is the source of truth; Orchy adds, disables and retires
// workspaces from the dashboard.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, DATA_DIR, config, saveConfig, expandPath, env, ownerName, readJson, setAside } from './env.mjs';
import { one, oneInteractive, listConnections, whoami } from './one.mjs';
import { engine, engines, engineInfo, registerEngine, engineOffered, offeredRefusal, engineHealth, brokenMessage, engineRepairCmd } from './engines/index.mjs';
import { envPrefix, psq, profilePath } from './engines/shared.mjs';
import { findBinary } from './claude.mjs';
export { toClaudeMcp } from './engines/claude.mjs';
export { toCodexMcp } from './engines/codex.mjs';

export const RETIRED_DIR = path.join(ROOT, 'Retired');
const RESERVED_IDS = new Set(['none', 'general', 'all', 'retired', 'jos', 'orchy']);

const withDefaults = w => ({ runtime: 'claude', enabled: true, ...w, dir: path.join(ROOT, w.folder) });

// ── client inks: every workspace wears a colour of its own, handed out in this order.
// The named ones live in the dashboard's tokens.css (--tint-<name>); past those, a hue the dashboard draws itself
// ("h137"), kept away from cobalt, tomato and decision yellow (the owner's attention) so each colour keeps one meaning.
export const WS_INKS = ['cobalt', 'tomato', 'jade', 'violet', 'magenta', 'teal', 'olive', 'brown'];
const RESERVED_HUES = [228, 10, 46]; // cobalt, tomato, decision yellow
const INK_HUES = { cobalt: 228, tomato: 10, jade: 155, violet: 258, magenta: 324, teal: 184, olive: 70, brown: 28 };

/** A colour no workspace (current or retired) wears yet. */
export function nextInk(used) {
  const free = WS_INKS.find(c => !used.has(c));
  if (free) return free;
  const taken = [...used].map(c => INK_HUES[c] ?? Number(String(c).slice(1))).filter(Number.isFinite);
  const far = (h, list, d) => list.every(x => Math.min(Math.abs(h - x), 360 - Math.abs(h - x)) >= d);
  // golden-angle steps spread the hues; ask for less distance once the wheel fills up
  for (const gap of [24, 14, 8, 0]) {
    for (let i = 0; i < 360; i++) {
      const h = Math.round((i * 137.508 + 100) % 360);
      if (far(h, RESERVED_HUES, 25) && far(h, taken, gap) && !used.has(`h${h}`)) return `h${h}`;
    }
  }
  return `h${Math.floor(Math.random() * 360)}`;
}

const inksInUse = () => new Set([...config.workspaces, ...(config.retired || [])].map(w => w.color).filter(Boolean));

/** Give every workspace without a colour its own (saved in config.json). */
export function ensureInks() {
  const used = inksInUse();
  let changed = false;
  for (const w of config.workspaces) {
    if (w.color) continue;
    w.color = nextInk(used);
    used.add(w.color);
    changed = true;
  }
  if (changed) saveConfig();
  return changed;
}

/** Every workspace, disabled ones included. */
export function workspaces() {
  if (config.workspaces.some(w => !w.color)) ensureInks(); // an older config.json: each gets its colour now
  return config.workspaces.map(withDefaults);
}
/** The ones Orchy routes to, schedules and runs. */
export function enabledWorkspaces() {
  return workspaces().filter(w => w.enabled);
}

/** "Acme" / "Acme Agent" / "Acme Workspace" → "Acme Workspace": what the owner, Jev, Orchy and every agent call a workspace. */
export const workspaceName = s => `${String(s || '').trim().replace(/\s+(agent|workspace)$/i, '')} Workspace`;

/** What the owner calls a workspace: its id, its name without "Workspace" (or an older "Agent"), and the aliases saved for it ("acme", "the bakery").
 * A short name Orchy keeps for itself ("Orchy Workspace" → "Orchy") stays whole, so "Orchy, …" still talks to Orchy. */
export function handles(ws) {
  const short = ws.name.replace(/\s+(agent|workspace)$/i, '');
  const all = [RESERVED_IDS.has(short.trim().toLowerCase()) ? ws.name : short, ws.id, ...(ws.aliases || [])].map(s => String(s || '').trim()).filter(Boolean);
  return all.filter((s, i) => all.findIndex(x => x.toLowerCase() === s.toLowerCase()) === i);
}

const parseAliases = v => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[,;\n]/)).map(s => String(s).trim().replace(/^@/, '')).filter(s => s && s.length <= 40))].slice(0, 12);

/** An alias that already means another workspace (a retired one too, so restoring it can't clash) or a reserved word is refused. */
function checkAliases(aliases, selfId) {
  const others = [...config.workspaces, ...(config.retired || [])].filter(w => w.id !== selfId);
  for (const a of aliases) {
    const k = a.toLowerCase();
    if (RESERVED_IDS.has(k)) throw bad(`"${a}" is a word Orchy keeps for itself. Pick another name.`);
    const w = others.find(o => handles(o).some(h => h.toLowerCase() === k));
    if (w) throw Object.assign(new Error(`"${a}" already means ${w.name}${config.workspaces.includes(w) ? '' : ' (retired)'}. Pick another name, or take it off ${w.name} first.`), { status: 409 });
  }
  return aliases;
}

// ── Orchy's own backend (backend.mjs): the owner reports a problem in the chat and Orchy fixes his own code in a run
// in the Orchy folder. Built in, never in workspaces(): no client, no pane, no agents, no One. It runs as Orchy's own
// Claude Code account (config.json orchy.claudeAccount), checked like any workspace's.
export const BACKEND_ID = 'orchy';
export function backendWorkspace() {
  return {
    id: BACKEND_ID, name: 'Orchy', client: `Orchy itself (${ownerName()}’s orchestrator)`, builtin: true, enabled: true,
    blurb: 'Orchy’s own code: the server, the dashboard and the scripts in the Orchy folder.',
    folder: '.', dir: ROOT, runtime: 'claude', aliases: [],
    claudeAccount: config.orchy?.claudeAccount || null, claudeConfigDir: config.orchy?.claudeConfigDir || null,
    codexAccount: null, codexHome: null,
  };
}

/**
 * The owner picks the Claude Code account Orchy fixes himself under (Settings → Accounts, or the Fix Orchy card).
 * `ownProfile`: a profile folder of his own (an account other than this computer's sign-in), else the default profile.
 * Only sets which account is expected: accountCheck still compares it with the actual sign-in before every fix.
 */
export function setBackendAccount({ account, ownProfile = false } = {}) {
  const email = String(account || '').trim();
  if (!EMAIL.test(email)) throw bad('Give the Claude Code account as an email address');
  config.orchy ||= {};
  config.orchy.claudeAccount = email;
  config.orchy.claudeConfigDir = ownProfile ? (config.orchy.claudeConfigDir || profileDir('claude', BACKEND_ID)) : null;
  saveConfig();
  return backendWorkspace();
}

export function workspace(id) {
  if (id === BACKEND_ID) return backendWorkspace();
  const w = workspaces().find(x => x.id === id);
  if (!w) throw Object.assign(new Error(`Unknown workspace "${id}"`), { status: 404 });
  return w;
}

// ── runtimes and models ──
// A workspace has a default engine (`runtime`); an agent can pin another one (`engine:` in its file),
// e.g. a Codex designer in a Claude workspace. Every helper below takes that engine, defaulting to the workspace's.
// Only engines with an adapter in engines/ exist here: config.json may name more, but they are not listed.
/** The registered engines as config.json describes them: { id: { label, models, … capabilities } }. */
export function runtimes() {
  const out = {};
  for (const e of engines()) {
    const c = config.runtimes?.[e.id] || {};
    out[e.id] = { ...engineInfo(e), label: c.label || e.label, models: c.models || e.models };
  }
  return out;
}
export function runtimeLabel(rt) { return config.runtimes?.[rt]?.label || engine(rt)?.label || rt; }
/** The model tiers of an engine (the workspace's own by default), quick → strong. */
export function modelsFor(ws, runtime = ws.runtime) { return config.runtimes?.[runtime]?.models || engine(runtime)?.models || config.runtimes.claude.models; }
/** A tier index (0 quick, 1 normal, 2 strong) as a model this engine understands. */
export function tierModel(ws, i, runtime = ws.runtime) { const m = modelsFor(ws, runtime); return m[Math.max(0, Math.min(m.length - 1, i))]; }
/**
 * Map any model name onto an engine (sonnet ↔ gpt-6.1-sol by tier), defaulting to the middle tier.
 * An engine whose tiers are all "default" (Hermes) answers "default": its adapter then passes no model at all.
 */
export function modelFor(ws, model, runtime = ws.runtime) {
  const mine = modelsFor(ws, runtime);
  // "inherit" (an agent file's "the workspace's model") names no model: never sent to a harness as an id
  if (model === 'inherit') model = null;
  if (model && mine.includes(model)) return model;
  if (mine.every(m => m === 'default')) {
    const s = String(model || '').trim();
    if (/^[^/\s]+\/\S+$/.test(s)) return s; // a provider/model id (Hermes)
    const isOtherTier = Object.values(runtimes()).some(rt => rt.models.includes(s));
    if (!isOtherTier && engine(runtime)?.openModels && /^[\w][\w.:-]{1,79}$/.test(s)) return s;
    return 'default';
  }
  // "default" (Hermes's "the harness picks") on an engine with real tiers is its middle one, not the
  // cheapest (every tier of those engines is "default", so the loop below would read it as tier 0)
  if (model === 'default') return mine[1] || mine[0];
  for (const rt of Object.values(runtimes())) {
    const i = rt.models.indexOf(model);
    if (i >= 0) return tierModel(ws, i, runtime);
  }
  // an engine that takes any model id it lists itself (Antigravity: `agy models`): a plain id an agent names passes as is
  if (model && engine(runtime)?.openModels && /^[\w][\w.:-]{1,79}$/.test(String(model))) return model;
  return mine[1] || mine[0];
}
/** The engine an agent runs on: its own `engine` if it pins one, else the workspace's. */
export function engineFor(ws, agent) { return agent?.engine || ws.runtime; }

// ── accounts: each workspace runs under exactly one login per runtime ──
/**
 * { runtime, email, profileDir, model, computerLogin } for one of the workspace's engines (its default one unless
 * named). computerLogin (engines that offer it, Hermes): true = it runs on this computer's sign-in, shared with every
 * workspace set that way; false = only its own profile's sign-in; undefined = the engine has no such choice.
 */
export function accountFor(ws, runtime = ws.runtime) {
  const e = engine(runtime);
  if (!e) return { runtime, email: null, profileDir: null, model: 'email', unknown: true };
  const lend = e.fields.computerLogin ? { computerLogin: ws[e.fields.computerLogin] !== false } : {};
  return { runtime: e.id, email: ws[e.fields.account] || null, profileDir: ws[e.fields.profile] || null, model: e.accountModel, ...lend };
}

const sameDir = (a, b) => {
  const n = p => path.resolve(profilePath(p)).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

/** Another workspace on the same engine that points at this workspace's profile folder (or null). */
export function profileClash(ws, runtime = ws.runtime) {
  const e = engine(runtime);
  const mine = ws[e?.fields.profile];
  if (!e || !mine) return null;
  return config.workspaces.find(w => w.id !== ws.id && w[e.fields.profile] && sameDir(w[e.fields.profile], mine)) || null;
}

/**
 * Hard guard: never run a workspace under the wrong account (checked for the engine the run uses).
 * 'email' engines (Claude Code, Codex, Antigravity): the profile must be logged in as the workspace's email.
 * 'profile' engines (Hermes): the workspace has its own profile folder (and OAuth login), reporting
 * its provider(s), detected plan/tier, and tier-scoped `availableModels`.
 * A workspace profile that isn't signed in on a computer that is gets `hint`, saying so: only its own sign-in counts.
 */
export async function accountCheck(ws, { force = false, runtime = ws.runtime } = {}) {
  const e = engine(runtime);
  const a = accountFor(ws, runtime);
  if (!e) {
    return { ok: false, runtime, runtimeLabel: runtimeLabel(runtime), expected: null, actual: null, loggedIn: false, configDir: null, subscription: null, sandbox: null,
      error: `${runtimeLabel(runtime)} isn't a harness this Orchy has an adapter for`, fix: null, fixAlt: null };
  }
  const base = { runtime: e.id, runtimeLabel: runtimeLabel(e.id), accountModel: e.accountModel, gated: e.capabilities.gated };
  const configDir = a.profileDir ? expandPath(a.profileDir) : e.defaultProfileLabel;
  if (e.accountModel === 'profile') {
    let problem = null;
    const clash = a.profileDir ? profileClash(ws, e.id) : null;
    if (ws.builtin) problem = `Orchy's own backend can't run on ${e.label}`;
    else if (!a.profileDir) problem = `${ws.name} has no ${e.label} profile folder of its own (${e.fields.profile} in config.json). ${e.label} workspaces must not share logins.`;
    else if (clash) problem = `${ws.name} and ${clash.name} point at the same ${e.label} profile folder (${configDir}). Give each its own, so their logins never mix.`;
    const status = problem ? { loggedIn: false } : await e.account(a.profileDir, { force, ...(a.computerLogin === false ? { computerLogin: false } : {}) });
    // on its own sign-in, a config that would still reach the computer's is refused (tier-catalog.mjs#ownLoginProblem)
    if (!problem && status.problem) problem = `${ws.name} is set to use its own ${e.label} sign-in, but ${status.problem}`;
    const ok = !problem && !!status.loggedIn;
    return {
      ...base, ok, expected: a.email || (a.profileDir ? configDir : null), actual: status.label || null,
      computerLogin: a.computerLogin,
      hint: problem ? null : await computerHint(ws, e, a, status, { force }),
      email: status.email || a.email || null,
      loggedIn: !!status.loggedIn, configDir,
      subscription: status.subscription || status.plan || null,
      plan: status.plan || status.subscription || null,
      tier: status.tier || null,
      providers: status.providers || [],
      availableModels: Array.isArray(status.models) && status.models.length ? status.models : null,
      configuredModel: status.configuredModel || null,
      sandbox: status.sandbox ?? null,
      error: problem || status.error || null, profileProblem: problem,
      fix: ok ? null : loginHint(ws, e.id), fixAlt: ok ? null : loginAlt(ws, e.id),
    };
  }
  const status = await e.account(a.profileDir, { force });
  const email = status.email || null;
  const ok = !!a.email && !!status.loggedIn && !!email && email.toLowerCase() === a.email.toLowerCase();
  return {
    ...base,
    ok,
    expected: a.email,
    actual: email,
    loggedIn: !!status.loggedIn,
    hint: await computerHint(ws, e, a, status, { force }),
    configDir,
    subscription: status.subscriptionType || status.subscription || status.plan || null,
    plan: status.plan || status.subscriptionType || status.subscription || null,
    tier: status.tier || null,
    availableModels: Array.isArray(status.models) && status.models.length ? status.models : null,
    sandbox: status.sandbox ?? null,
    error: status.error || (a.email ? null : ws.builtin ? 'Orchy has no Claude Code account set for fixing himself yet. Pick one in Settings → Accounts' : `${ws.name} has no ${runtimeLabel(e.id)} account set (${e.fields.account} in config.json)`),
    fix: ok ? null : loginHint(ws, e.id),
    fixAlt: ok ? null : loginAlt(ws, e.id),
  };
}

/** The harness is signed in on this computer, but this workspace keeps its own profile, which isn't: the owner signed
 * in with a plain terminal. Read-only; the computer's sign-in never counts for the workspace (Hermes's already did). */
async function computerHint(ws, e, a, status, { force }) {
  if (status.loggedIn || !a.profileDir || e.sharedLogin || ws.builtin) return null;
  let pc = null;
  try { pc = await e.account(null, { force }); } catch {}
  if (!pc?.loggedIn) return null;
  const who = pc.email || pc.label || null;
  const on = `${e.label} is signed in on this computer${who ? ` (${who})` : ''}`;
  // on the computer's sign-in and still not signed in: the computer's is one Hermes doesn't lend (a key in its .env)
  if (a.computerLogin) return `${on}, but not in a way ${ws.name} can use.${e.computerLoginNote ? ` ${e.computerLoginNote}` : ''} Press Log in to sign this computer in with OAuth.`;
  if (a.computerLogin === false) return `${on}, but ${ws.name} is set to use its own ${e.label} sign-in, so it needs one: press Log in, or paste the command below. Or let it use this computer's sign-in (Workspaces → ${ws.name} → Edit).`;
  return `${on}, but ${ws.name} keeps its own ${e.label} profile, so it needs its own sign-in once: press Log in, or paste the command below.`;
}

/** A shell command (PowerShell on Windows) that logs this workspace's profile for an engine in. Pasteable as-is. */
export function loginHint(ws, runtime = ws.runtime) {
  const e = engine(runtime);
  if (!e) return '';
  const a = accountFor(ws, runtime);
  const win = process.platform === 'win32';
  return `${envPrefix(e.profileEnv(a.profileDir, a), win)}${e.loginCommand(a, { win })}`;
}
export function loginAlt(ws, runtime = ws.runtime) {
  const e = engine(runtime);
  return e?.loginAlt ? e.loginAlt(accountFor(ws, runtime), ws) : null;
}

const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
// Linux: the desktop's own terminal, else the usual ones (each takes the command after these arguments)
const LINUX_TERMINALS = [['x-terminal-emulator', ['-e']], ['gnome-terminal', ['--']], ['konsole', ['-e']], ['xfce4-terminal', ['-x']], ['kitty', []], ['alacritty', ['-e']], ['xterm', ['-e']]];

/**
 * The owner clicked "Log in": open a terminal window that runs the login command for this workspace's engine:
 * PowerShell on Windows, Terminal on macOS, the desktop's terminal on Linux (none there: the command to paste).
 */
export function openLoginWindow(ws, runtime = ws.runtime) {
  const e = engine(runtime);
  if (!e) throw bad(`Unknown engine "${runtime}"`);
  const a = accountFor(ws, runtime);
  if (e.accountModel === 'profile' ? !a.profileDir : !a.email) throw bad(`${ws.name} has no ${runtimeLabel(runtime)} ${e.accountModel === 'profile' ? 'profile' : 'account'} set`);
  // a program that won't start can't sign in: say how to finish its install instead of opening a window that fails
  if (engineHealth(e) === 'broken') throw bad(brokenMessage(e));
  fs.mkdirSync(expandPath(a.profileDir || DATA_DIR), { recursive: true });
  const file = path.join(DATA_DIR, `login-${ws.id}${runtime === ws.runtime ? '' : `-${runtime}`}.ps1`);
  const name = ws.name.replace(/\s+/g, ' '), label = runtimeLabel(a.runtime);
  if (process.platform !== 'win32') return openPosixLogin(ws, runtime, a, name, label);
  // names and emails only ever go in single quotes; the BOM makes Windows PowerShell read it as UTF-8
  // (as ANSI, some letters' bytes read as curly quotes)
  fs.writeFileSync(file, `\uFEFF# Orchy: log a workspace in to ${label.replace(/\s+/g, ' ')}\n$Host.UI.RawUI.WindowTitle = ${psq(`Log in ${name}`)}\nWrite-Host ${psq(`Logging ${name} in to ${label}. ${a.email ? `Sign in as ${a.email} in the browser.` : 'Follow the prompts to sign in.'}`)} -ForegroundColor Yellow\n${loginRun(loginHint(ws, runtime), { win: true })}`);
  spawn('cmd.exe', ['/c', 'start', '""', 'powershell', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

function openPosixLogin(ws, runtime, a, name, label) {
  const file = path.join(DATA_DIR, `login-${ws.id}${runtime === ws.runtime ? '' : `-${runtime}`}.sh`);
  const intro = `Logging ${name} in to ${label}. ${a.email ? `Sign in as ${a.email} in the browser.` : 'Follow the prompts to sign in.'}`;
  fs.writeFileSync(file, `#!/bin/sh\n# Orchy: log a workspace in to ${label.replace(/\s+/g, ' ')}\nprintf '%s\\n\\n' ${shq(intro)}\n${loginRun(loginHint(ws, runtime), { win: false })}exec "\${SHELL:-/bin/sh}"\n`, { mode: 0o700 });
  openShellWindow(file, loginHint(ws, runtime));
}

const LOGIN_DONE = 'Done. Go back to Orchy and press Re-check.';
const LOGIN_FAILED = "The sign-in didn't finish. Scroll up for the message, fix it, then press Log in in Orchy again.";
/** The login command, then "Done" only when it succeeded (a program that won't start, or a cancelled sign-in, says so). */
export function loginRun(cmd, { win = process.platform === 'win32' } = {}) {
  // native programs set the global $LASTEXITCODE; $? is false when one fails or can't start at all
  if (win) return `$global:LASTEXITCODE = 0\n${cmd}\nif ($? -and $global:LASTEXITCODE -eq 0) { Write-Host ""; Write-Host ${psq(LOGIN_DONE)} -ForegroundColor Green } else { Write-Host ""; Write-Host ${psq(LOGIN_FAILED)} -ForegroundColor Red }\n`;
  return `${cmd}\nif [ $? -eq 0 ]; then printf '\\n%s\\n' ${shq(LOGIN_DONE)}; else printf '\\n%s\\n' ${shq(LOGIN_FAILED)}; fi\n`;
}

/** Run a shell script in a terminal window on macOS (Terminal) or Linux (the desktop's terminal); none: paste `hint`. */
export function openShellWindow(file, hint, { env: childEnv } = {}) {
  if (process.platform === 'darwin') {
    const as = s => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; // an AppleScript string
    spawn('osascript', ['-e', `tell application "Terminal" to do script "sh " & quoted form of ${as(file)}`, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore', ...(childEnv ? { env: childEnv } : {}) }).unref();
    return;
  }
  const term = LINUX_TERMINALS.map(([bin, pre]) => [findBinary(bin), pre]).find(([bin]) => bin);
  if (!term) throw Object.assign(new Error(`No terminal window to open here. Run this in a terminal: ${hint}`), { status: 400 });
  spawn(term[0], [...term[1], 'sh', file], { detached: true, stdio: 'ignore', ...(childEnv ? { env: childEnv } : {}) }).unref();
}

// ── One: each workspace needs its OWN One scope, or the One CLI falls back to the orchestrator's ──
const oneHome = () => env('ONE_HOME') || os.homedir();
const oneConfig = ws => path.join(oneHome(), '.one', 'projects', path.resolve(ws.dir).replace(/[\\/<>:"|?*]/g, '-'), 'config.json');
const mtime = f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
/**
 * Does this folder have its own One login? (Without one, `one` would use the orchestrator root's account.)
 * A login an earlier workspace left in the same folder (`oneInherited`, set when it was added) doesn't count
 * until the owner signs this one in.
 */
export function oneScope(ws) {
  // Orchy's backend sits in the Orchy folder, whose One login is the orchestrator's own: never its runs'
  if (ws.builtin) return { own: false, inherited: false };
  const has = fs.existsSync(oneConfig(ws));
  return { own: has && !ws.oneInherited, inherited: has && !!ws.oneInherited };
}

const oneLogins = new Map(); // wsId -> { status: 'waiting'|'done'|'failed', startedAt, error, account }
export function oneLoginStatus(wsId) { return oneLogins.get(wsId) || null; }

/** Sign the workspace into its own One account: `one init --auth browser --project` opens a login window. */
export function startOneLogin(ws, { onDone } = {}) {
  const cur = oneLogins.get(ws.id);
  if (cur?.status === 'waiting') return cur;
  // the .one marker makes this folder the project root (else One would pick the Orchy folder and overwrite Orchy's own login)
  fs.mkdirSync(path.join(ws.dir, '.one'), { recursive: true });
  const st = { status: 'waiting', startedAt: new Date().toISOString(), error: null, account: null };
  oneLogins.set(ws.id, st);
  const before = mtime(oneConfig(ws));
  one(['init', '--auth', 'browser', '--project', '--yes'], { cwd: ws.dir, timeoutMs: 15 * 60_000 })
    .then(res => {
      if (res?.success === false || res?.error) throw new Error(res.error?.message || res.error || 'One sign-in did not complete');
      const entry = config.workspaces.find(w => w.id === ws.id);
      if (entry?.oneInherited) {
        if (mtime(oneConfig(ws)) === before) throw new Error(`One kept the sign-in an earlier workspace left in this folder. Delete ${path.dirname(oneConfig(ws))} and sign in again.`);
        delete entry.oneInherited;
        saveConfig();
      }
      st.status = 'done';
      st.account = res?.account ? { user: res.account.user?.email || null, org: res.account.organization?.name || null } : null;
    })
    .catch(e => { st.status = 'failed'; st.error = e.message; })
    .finally(() => onDone?.(st));
  return st;
}

const oneAdds = new Map(); // wsId -> { platform, status: 'waiting'|'done'|'none'|'failed', startedAt, error, added }
export function oneAddStatus(wsId) { return oneAdds.get(wsId) || null; }

/**
 * Connect an app to the workspace's own One account: `one connection add <platform>` run in its
 * folder opens One's connect page in the browser and waits (up to 5 minutes) for it to land.
 * What counts is what actually appears in this workspace's connection list afterwards.
 */
export async function startOneAdd(ws, platform, { onDone } = {}) {
  if (!oneScope(ws).own) throw Object.assign(new Error(`Sign ${ws.name} in to its own One account first, so the app lands in the right place.`), { status: 409 });
  const slug = String(platform || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(slug)) throw bad('Pick an app from the list');
  const cur = oneAdds.get(ws.id);
  if (cur?.status === 'waiting') throw Object.assign(new Error(`Still waiting on ${cur.platform} for ${ws.name}. Finish that one in the browser first (it gives up after 5 minutes).`), { status: 409 });
  const before = new Set((await listConnections(ws.dir, { force: true })).map(c => c.key));
  const st = { platform: slug, status: 'waiting', startedAt: new Date().toISOString(), error: null, added: [] };
  oneAdds.set(ws.id, st);
  oneInteractive(['connection', 'add', slug], { cwd: ws.dir }).then(async ({ code, out }) => {
    const after = await listConnections(ws.dir, { force: true }).catch(() => []);
    st.added = after.filter(c => !before.has(c.key)).map(c => ({ name: c.name, platform: c.platform }));
    st.status = st.added.length ? 'done' : code === 0 ? 'none' : 'failed';
    if (st.status === 'failed') st.error = /timed out/i.test(out) ? 'It timed out (nothing was finished in the browser within 5 minutes).' : (out.trim().split('\n').filter(l => /error|unknown|not configured/i.test(l)).pop() || `One exited with code ${code}`).replace(/[│◇◆●■▲]/g, '').trim().slice(0, 300);
  }).finally(() => onDone?.(st));
  return st;
}

// ── External connections (MCP servers) per workspace: <ws>/.jos/mcp.json ──

function mcpPath(ws) { return path.join(ws.dir, '.jos', 'mcp.json'); }

export function readMcp(ws) {
  try { return readJson(mcpPath(ws)).servers || {}; } catch { return {}; }
}
// Before a change is written: a file that won't parse is kept aside, not overwritten with just the new server
function readMcpToChange(ws) {
  const file = mcpPath(ws);
  if (!fs.existsSync(file)) return {};
  try { return readJson(file).servers || {}; } catch (e) {
    if (!setAside(file, e.message)) throw Object.assign(new Error(`${file} isn't valid JSON and couldn't be moved aside. Fix or move it, then try again.`), { status: 409 });
    return {};
  }
}

// ── What a browser the owner hasn't paired sees of the MCP servers: names and shape, never a value ──
// Nothing is guessed from names or shapes: env and header values, every argument, whatever follows the program in
// the command, a URL's user, path, query and fragment, and every field the panel doesn't draw with are all hidden.
// The owner's paired browser sees it all, and a form sent back unchanged keeps the saved values.
export const HIDDEN = '••••••';
const hide = v => (v == null || v === '' ? v : HIDDEN);
// env and headers: the names show, the values don't
const hideValues = o => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.keys(o).map(k => [k, HIDDEN])) : hide(o));
const hideArgs = a => (Array.isArray(a) ? a.map(() => HIDDEN) : hide(a));
// the program a stdio server starts: a name or a path, never KEY=value, a URL or a flag
const PROGRAM = /^(?:[A-Za-z]:)?[\w.()+~\\/-]+$/;
// Quoted, a path may have spaces, but only inside its folder names: it starts at a root, its file name has none, and
// no space sits next to a separator or before a '-'. "C:\Program Files\nodejs\node.exe" shows; a whole command line
// in quotes ("node server.js --api-key …", "/usr/bin/env node …") doesn't.
const SPACED_PATH = /^(?:[A-Za-z]:|~|\.{1,2})?[\\/][\w .()+~\\/-]*[\\/][\w.()+~-]+$/;
function isProgram(tok) {
  const q = tok.match(/^(["'])([\s\S]*)\1$/);
  const p = q ? q[2] : tok;
  if (p.startsWith('-')) return false;
  return PROGRAM.test(p) || (!!q && SPACED_PATH.test(p) && !/ [\\/-]|[\\/] /.test(p));
}
/** `node server.js --api-key …` shows as `node ••••••`. */
function hideCommand(cmd) {
  if (typeof cmd !== 'string') return hide(cmd);
  const m = cmd.trim().match(/^("[^"]*"|'[^']*'|\S+)\s*([\s\S]*)$/);
  if (!m) return cmd;
  const prog = isProgram(m[1]) ? m[1] : HIDDEN;
  return m[2] ? `${prog} ${HIDDEN}` : prog;
}
/** A URL keeps its scheme and host: https://user:pw@mcp.example.com/s/<key>/sse?k=… shows as https://••••••@mcp.example.com/•••••• */
function hideUrl(u) {
  if (typeof u !== 'string') return hide(u);
  const m = u.trim().match(/^([a-z][\w+.-]*:\/\/)([^/\\?#\s]*)([\s\S]*)$/i);
  if (!m) return hide(u);
  const at = m[2].lastIndexOf('@');
  const host = m[2].slice(at + 1);
  const shown = /^(?:[\w.-]*|\[[\w:.%]+\])(?::\d{1,5})?$/.test(host) ? host : HIDDEN;
  return m[1] + (at < 0 ? '' : `${HIDDEN}@`) + shown + (m[3] && m[3] !== '/' ? `/${HIDDEN}` : m[3]);
}
// the fields that show as they are (what the panel draws a server with), and how each value field is hidden
const SHOWN = new Map([['type', v => typeof v === 'string' && /^[a-z][\w-]{0,30}$/i.test(v)], ['enabled', v => typeof v === 'boolean'], ['description', v => typeof v === 'string']]);
const HIDERS = new Map([['env', hideValues], ['headers', hideValues], ['command', hideCommand], ['args', hideArgs], ['url', hideUrl]]);
/** A server definition as a browser the owner hasn't paired sees it. */
export function hideMcpServer(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return hide(s);
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, HIDERS.has(k) ? HIDERS.get(k)(v) : SHOWN.get(k)?.(v) ? v : hide(v)]));
}
export const hideMcp = servers => Object.fromEntries(Object.entries(servers || {}).map(([n, s]) => [n, hideMcpServer(s)]));
/** What GET /api/workspaces/:ws/mcp answers: every value to the owner's paired browser, names and shape to any other. */
export const shownMcp = (servers, paired) => (paired ? servers : hideMcp(servers));
/**
 * A server in the connection lists any browser reads (GET /api/workspaces/:ws, …/connections, a 'connections' inbox
 * item) and agents' prompts: type and description hidden as hideMcpServer hides them, on/off as true or false the
 * way the engines read it (engines/claude.mjs `if (!s.enabled)`). Nothing else from the definition.
 */
export function mcpListing(name, s) {
  const o = s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  const field = k => (SHOWN.get(k)(o[k]) ? o[k] : hide(o[k]));
  return { key: `mcp:${name}`, platform: 'mcp', name, description: field('description'), type: field('type'), enabled: !!o.enabled, source: 'mcp' };
}
/** A form sent back with values still hidden keeps the saved ones; a hidden value with nothing saved behind it is refused. */
export function unhideMcp(def, prev) {
  const p = prev && typeof prev === 'object' ? prev : {}, h = hideMcpServer(p);
  const out = { ...def };
  const keep = (field) => {
    if (!def[field] || typeof def[field] !== 'object') return;
    const saved = p[field] && typeof p[field] === 'object' ? p[field] : {};
    out[field] = Object.fromEntries(Object.entries(def[field]).map(([k, v]) => [k, v === HIDDEN && Object.hasOwn(saved, k) ? saved[k] : v]));
  };
  keep('env'); keep('headers');
  if (typeof def.command === 'string' && typeof p.command === 'string' && def.command === h.command) out.command = p.command;
  // every argument shows hidden, so a hidden one is the saved one in its place; a list that grew or shrank can't say which went where
  if (Array.isArray(def.args) && Array.isArray(p.args) && def.args.length === p.args.length) out.args = def.args.map((a, i) => (a === HIDDEN ? p.args[i] : a));
  if (typeof def.url === 'string' && typeof p.url === 'string' && def.url === h.url) out.url = p.url;
  for (const f of ['type', 'description']) if (def[f] === HIDDEN && p[f] !== undefined) out[f] = p[f];
  const still = JSON.stringify([out.type, out.description, out.env, out.headers, out.command, out.args, out.url]).includes(HIDDEN);
  if (still) throw Object.assign(new Error('Some values still show as hidden. Type the real values in, then save.'), { status: 400 });
  return out;
}

export function writeMcp(ws, servers) {
  fs.mkdirSync(path.dirname(mcpPath(ws)), { recursive: true });
  fs.writeFileSync(mcpPath(ws), JSON.stringify({ servers }, null, 2) + '\n');
}

export function upsertMcp(ws, name, def) {
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(name)) throw Object.assign(new Error('Name: letters, numbers, - and _ only'), { status: 400 });
  if (name === 'jos') throw Object.assign(new Error('"jos" is reserved for the orchestrator bridge'), { status: 400 });
  const servers = readMcpToChange(ws);
  def = unhideMcp(def || {}, servers[name]);
  const clean = { type: def.type || (def.url ? 'http' : 'stdio'), description: def.description || '', enabled: def.enabled !== false };
  if (clean.type === 'stdio') {
    if (!def.command) throw Object.assign(new Error('A stdio server needs a command'), { status: 400 });
    Object.assign(clean, { command: def.command, args: def.args || [], env: def.env || {} });
  } else {
    if (!def.url) throw Object.assign(new Error('An http/sse server needs a URL'), { status: 400 });
    Object.assign(clean, { url: def.url, headers: def.headers || {} });
    // a sign-in app the service gave out (mcpauth.mjs): its client ID and the callback port registered for it
    const clientId = String(def.oauth?.clientId || '').trim();
    const port = Number(def.oauth?.callbackPort) || null;
    if (port && (!Number.isInteger(port) || port < 1024 || port > 65535)) throw Object.assign(new Error('Callback port: a number from 1024 to 65535'), { status: 400 });
    // connection: which login the service opens on (an Auth0 connection name); set in mcp.json, kept through dashboard edits
    const was = servers[name]?.oauth;
    const connection = String(def.oauth?.connection ?? (was?.clientId === clientId ? was?.connection || '' : '')).trim();
    if (clientId) clean.oauth = { clientId, ...(port ? { callbackPort: port } : {}), ...(connection ? { connection } : {}) };
  }
  servers[name] = clean;
  writeMcp(ws, servers);
  return clean;
}

export function removeMcp(ws, name) {
  const servers = readMcpToChange(ws);
  delete servers[name];
  writeMcp(ws, servers);
}

/** Handshake with an MCP server and list its tools, to prove it works. */
export async function testMcp(def) {
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jos', version: '0.1' } } };
  const list = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
  if (def.type === 'stdio') {
    return new Promise(resolve => {
      const child = spawn(def.command, def.args || [], { env: { ...process.env, ...(def.env || {}) }, shell: process.platform === 'win32', windowsHide: true });
      let buf = '', done = false;
      const finish = r => { if (done) return; done = true; clearTimeout(t); try { child.kill(); } catch {} resolve(r); };
      const t = setTimeout(() => finish({ ok: false, error: 'No answer within 20s' }), 20_000);
      child.on('error', e => finish({ ok: false, error: e.message }));
      child.stdin.on('error', () => {}); // it exited before reading: 'error'/the timeout say so
      child.stdout.on('data', d => {
        buf += d;
        const lines = buf.split('\n');
        buf = lines.pop(); // only a line still coming in stays
        for (const line of lines) {
          try {
            const m = JSON.parse(line);
            if (m.id === 1) {
              child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
              child.stdin.write(JSON.stringify(list) + '\n');
            }
            if (m.id === 2) finish({ ok: true, tools: (m.result?.tools || []).map(t => ({ name: t.name, description: (t.description || '').slice(0, 160) })) });
          } catch {}
        }
      });
      child.stdin.write(JSON.stringify(init) + '\n');
    });
  }
  try {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(def.headers || {}) };
    const r1 = await fetch(def.url, { method: 'POST', headers, body: JSON.stringify(init), signal: AbortSignal.timeout(15_000) });
    const sid = r1.headers.get('mcp-session-id');
    if (r1.status === 401) return { ok: false, needsLogin: true, error: 'HTTP 401: it needs a sign-in. Save it, then press Sign in (or put an API key in Headers).' };
    if (!r1.ok) return { ok: false, error: `HTTP ${r1.status}` };
    const h2 = { ...headers, ...(sid ? { 'mcp-session-id': sid } : {}) };
    await fetch(def.url, { method: 'POST', headers: h2, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }).catch(() => {});
    const r2 = await fetch(def.url, { method: 'POST', headers: h2, body: JSON.stringify(list), signal: AbortSignal.timeout(15_000) });
    const text = await r2.text();
    // by the reply's type, not its text: plain JSON can say "data:" too (inside a tool's description, say)
    const jsonText = /event-stream/i.test(r2.headers.get('content-type') || '') ? text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).pop() : text;
    const m = JSON.parse(jsonText);
    return { ok: true, tools: (m.result?.tools || []).map(t => ({ name: t.name, description: (t.description || '').slice(0, 160) })) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Everything a workspace can connect to: One connections + external MCP servers. */
export async function allConnections(ws, { force = false } = {}) {
  let oneConns = [], oneError = null;
  const scoped = oneScope(ws).own;
  if (!scoped) oneError = `${ws.name} isn't signed in to its own One account yet, so One is off here (it would otherwise borrow Orchy's). Sign it in from Workspaces → ${ws.name} → Sign in to One.`;
  else { try { oneConns = await listConnections(ws.dir, { force }); } catch (e) { oneError = e.message; } }
  const mcp = Object.entries(readMcp(ws)).map(([name, s]) => mcpListing(name, s));
  return { one: oneConns, mcp, oneError, oneScoped: scoped };
}

export async function identity(ws) {
  if (!oneScope(ws).own) return { oneUser: null, oneOrg: null, error: 'Not signed in to One yet' };
  const who = await whoami(ws.dir);
  return { oneUser: who.user?.email || null, oneOrg: who.organization?.name || null, error: who.error || null };
}

// ── Adding, changing, retiring workspaces ──
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

// New workspaces live in <ROOT>/workspaces/<Name> (git-ignored); older config.json entries may still sit straight under ROOT.
export const WORKSPACES_DIR = path.join(ROOT, 'workspaces');
// Hermes 0.21 rebuilds (and on Windows fails to rebuild) its runtime for a HERMES_HOME outside its own data folder, so a
// Hermes workspace's profile is one of Hermes's own profiles: <data folder>/profiles/orchy-<id>
const profileDir = (kind, id) => kind === 'hermes'
  ? (process.platform === 'win32' ? `%LOCALAPPDATA%\\hermes\\profiles\\orchy-${id}` : `~/.hermes/profiles/orchy-${id}`)
  : process.platform === 'win32' ? `%USERPROFILE%\\.${kind}-${id}` : `~/.${kind}-${id}`;

export function checkFolderName(name) {
  const n = String(name || '').trim().replace(/\s+/g, ' ');
  if (!n) throw bad('Give it a name first');
  if (n.length > 48) throw bad('Keep the name under 48 characters');
  if (/[\\/:*?"<>|]/.test(n) || /[. ]$/.test(n) || /^\.+$/.test(n)) throw bad('A folder name can\'t contain \\ / : * ? " < > | or end with a dot');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n)) throw bad('Windows reserves that name; pick another');
  if (fs.existsSync(path.join(WORKSPACES_DIR, n))) throw Object.assign(new Error(`There is already a "${n}" folder in workspaces/`), { status: 409 });
  return n;
}

function newId(name) {
  const base = name.toLowerCase().replace(/\s+agent$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'ws';
  // a purged workspace's id stays taken: old runs, rules and voice agents still carry it
  const taken = new Set([...config.workspaces.map(w => w.id), ...(config.retired || []).map(w => w.id), ...(config.purgedIds || []), ...RESERVED_IDS]);
  let id = base, i = 2;
  while (taken.has(id)) id = `${base}-${i++}`;
  return id;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * An engine with one sign-in per computer (Antigravity): no profile of its own, and every workspace on it names the
 * same account, so two workspaces can never expect different logins from the one sign-in (accountCheck compares it
 * with who the harness is signed in as before every run, too).
 */
function sharedLoginCheck(eng, email, ownProfile, id) {
  if (!eng?.sharedLogin) return;
  if (ownProfile) throw bad(`${eng.label} has one sign-in for the whole computer, so a workspace can’t have an account of its own on it.`);
  const other = config.workspaces.find(w => w.id !== id && (w.runtime === eng.id || w[eng.fields.account]) && w[eng.fields.account]);
  const shared = other?.[eng.fields.account];
  if (shared && shared.toLowerCase() !== String(email).toLowerCase()) throw bad(`${eng.label} on this computer runs as ${shared}, shared by every ${eng.label} workspace. It can’t run as ${email} too.`);
}

/** Register a new workspace (the folder itself is created by scaffold.mjs). */
export function addWorkspace({ name, client, blurb, aliases, runtime = 'claude', account, ownProfile = false, allowUngated = false }) {
  const folder = checkFolderName(name);
  fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
  const eng = engine(runtime);
  if (!eng) throw bad(`Unknown engine "${runtime}"`);
  if (!engineOffered(eng)) throw bad(offeredRefusal(eng));
  const profileOnly = eng.accountModel === 'profile'; // no email: a provider login in a profile folder of its own
  const email = String(account || '').trim();
  if (!profileOnly && !EMAIL.test(email)) throw bad(`Which ${runtimeLabel(runtime)} account should it run as? Give an email address.`);
  sharedLoginCheck(eng, email, ownProfile, null);
  const id = newId(folder);
  const entry = {
    // the folder keeps its own name; the workspace is "<Name> Workspace"
    id, name: workspaceName(folder),
    client: String(client || '').trim() || folder.replace(/\s+agent$/i, ''),
    blurb: String(blurb || '').trim() || `Work for ${String(client || '').trim() || folder}.`,
    folder: `workspaces/${folder}`, runtime, enabled: true,
    aliases: checkAliases(parseAliases(aliases), id),
    claudeAccount: runtime === 'claude' ? email : null,
    claudeConfigDir: runtime === 'claude' && ownProfile ? profileDir('claude', id) : null,
    codexAccount: runtime === 'codex' ? email : null,
    codexHome: runtime === 'codex' && ownProfile ? profileDir('codex', id) : null,
    ...(profileOnly ? { [eng.fields.account]: email.slice(0, 80) || null, [eng.fields.profile]: profileDir(eng.id, id) } : {}),
    // Hermes: this computer's sign-in, or (ownProfile) a sign-in of its own; always written, so the choice is on record
    ...(eng.fields.computerLogin ? { [eng.fields.computerLogin]: ownProfile !== true } : {}),
    ...(eng.sharedLogin ? { [eng.fields.account]: email } : {}),
    ...(allowUngated === true && !eng.capabilities.gated ? { allowUngated: true } : {}),
    createdAt: new Date().toLocaleDateString('en-CA'),
    color: nextInk(inksInUse()), // its own client ink, never one another workspace wears
    // organised from the start: the builder in I.T. Department, the generalist in Operations; a department named in a
    // new agent's frontmatter joins this list on its own (resources.mjs#syncHomes)
    departments: ['Operations', 'I.T. Department'],
    generalistHome: 'Operations/Generalist',
  };
  // One already has a login for this folder (an earlier workspace of the same name): not this one's until the owner signs it in
  if (oneScope({ dir: path.join(WORKSPACES_DIR, folder) }).own) entry.oneInherited = true;
  config.workspaces.push(entry);
  saveConfig();
  return workspace(id);
}

/** Enable/disable, rename the client, change what it's for, or switch its engine/account. */
export function updateWorkspace(id, patch = {}) {
  const at = config.workspaces.findIndex(w => w.id === id);
  if (at < 0) throw Object.assign(new Error(`Unknown workspace "${id}"`), { status: 404 });
  // changes go on a copy and land only once all of it checks out
  const entry = { ...config.workspaces[at] };
  if ('enabled' in patch) entry.enabled = !!patch.enabled;
  if (typeof patch.client === 'string' && patch.client.trim()) entry.client = patch.client.trim();
  if (typeof patch.blurb === 'string' && patch.blurb.trim()) entry.blurb = patch.blurb.trim();
  if (patch.aliases !== undefined) entry.aliases = checkAliases(parseAliases(patch.aliases), id);
  if (patch.runtime) {
    if (!engine(patch.runtime)) throw bad(`Unknown engine "${patch.runtime}"`);
    if (patch.runtime !== entry.runtime && !engineOffered(engine(patch.runtime))) throw bad(offeredRefusal(engine(patch.runtime)));
    entry.runtime = patch.runtime;
  }
  const eng = engine(entry.runtime || 'claude');
  const profileOnly = eng.accountModel === 'profile';
  if (patch.account !== undefined) {
    const email = String(patch.account || '').trim();
    if (!profileOnly && !EMAIL.test(email)) throw bad('Give the account as an email address');
    sharedLoginCheck(eng, email, patch.ownProfile, id);
    entry[eng.fields.account] = profileOnly ? email.slice(0, 80) || null : email;
    if (patch.ownProfile !== undefined && !profileOnly && !eng.sharedLogin) {
      if (eng.id === 'claude') entry[eng.fields.profile] = patch.ownProfile ? (entry[eng.fields.profile] || profileDir(eng.id, id)) : null;
      else entry[eng.fields.profile] = patch.ownProfile ? profileDir(eng.id, id) : null;
    }
  }
  // a profile-only engine (Hermes) always has a profile folder of its own, made when the engine is picked
  if (profileOnly && !entry[eng.fields.profile]) entry[eng.fields.profile] = profileDir(eng.id, id);
  if (eng.fields.computerLogin && patch.ownProfile !== undefined) entry[eng.fields.computerLogin] = patch.ownProfile !== true;
  // running a harness Orchy can't gate is the owner's explicit, per-workspace choice
  if ('allowUngated' in patch) entry.allowUngated = patch.allowUngated === true;
  if (!profileOnly && !entry[eng.fields.account]) {
    throw bad(`Say which ${runtimeLabel(entry.runtime)} account ${entry.name} should run as`);
  }
  config.workspaces[at] = entry;
  saveConfig();
  return workspace(id);
}

/** The owner's tab order (the Workspaces window, panes, every workspace list). Ids it leaves out keep their place at the end. */
export function reorderWorkspaces(order = []) {
  if (!Array.isArray(order)) throw bad('Give the order as a list of workspace ids');
  const rank = new Map(order.map((id, i) => [String(id), i]));
  const at = w => rank.has(w.id) ? rank.get(w.id) : order.length + config.workspaces.indexOf(w);
  config.workspaces = [...config.workspaces].sort((a, b) => at(a) - at(b));
  saveConfig();
  return workspaces();
}

async function moveDir(from, to) {
  let last;
  for (let i = 0; i < 5; i++) {
    try { fs.renameSync(from, to); return; } catch (e) { last = e; if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) break; await new Promise(r => setTimeout(r, 500)); }
  }
  throw Object.assign(new Error(`Couldn't move the folder: ${last.code === 'EPERM' || last.code === 'EBUSY' ? 'Windows says something has a file open in it (an editor, Explorer, or OneDrive syncing). Close it and try again.' : last.message}`), { status: 409 });
}

/** Retire: move the folder to Retired/ and take the workspace off Orchy's list. Restorable. */
export async function retireWorkspace(id) {
  const ws = workspace(id);
  fs.mkdirSync(RETIRED_DIR, { recursive: true });
  const day = new Date().toLocaleDateString('en-CA');
  const base = path.basename(ws.folder); // folder may be workspaces/<Name>
  let archived = `${base} (retired ${day})`;
  for (let i = 2; fs.existsSync(path.join(RETIRED_DIR, archived)); i++) archived = `${base} (retired ${day} #${i})`;
  if (fs.existsSync(ws.dir)) await moveDir(ws.dir, path.join(RETIRED_DIR, archived));
  const entry = config.workspaces.find(w => w.id === id);
  config.workspaces = config.workspaces.filter(w => w.id !== id);
  (config.retired ||= []).push({ ...entry, archivedFolder: archived, retiredAt: new Date().toISOString() });
  // its clients' links stop working (a restore leaves them off until the owner switches them back on)
  const clientsOff = [];
  for (const c of config.clients || []) if (c.workspace === id && c.enabled !== false) { c.enabled = false; clientsOff.push(c.id); }
  saveConfig();
  return { id, archivedFolder: archived, clientsOff };
}

export function listRetired() {
  return (config.retired || []).map(r => ({ ...r, dirExists: fs.existsSync(path.join(RETIRED_DIR, r.archivedFolder)) }));
}

export async function restoreWorkspace(id) {
  const r = (config.retired || []).find(x => x.id === id);
  if (!r) throw Object.assign(new Error('Nothing retired by that name'), { status: 404 });
  if (config.workspaces.some(w => w.id === id)) throw Object.assign(new Error(`A workspace with id "${id}" already exists`), { status: 409 });
  const target = path.join(ROOT, r.folder);
  if (fs.existsSync(target)) throw Object.assign(new Error(`There is already a "${r.folder}" folder; rename it first`), { status: 409 });
  const from = path.join(RETIRED_DIR, r.archivedFolder);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(from)) await moveDir(from, target);
  else fs.mkdirSync(target, { recursive: true });
  const { archivedFolder, retiredAt, ...entry } = r;
  config.workspaces.push(entry);
  config.retired = config.retired.filter(x => x.id !== id);
  saveConfig();
  return workspace(id);
}

/** Delete a retired workspace's folder for good. */
export function purgeRetired(id) {
  const r = (config.retired || []).find(x => x.id === id);
  if (!r) throw Object.assign(new Error('Nothing retired by that name'), { status: 404 });
  const dir = path.resolve(RETIRED_DIR, r.archivedFolder);
  if (!dir.startsWith(path.resolve(RETIRED_DIR) + path.sep)) throw bad('Bad path');
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
  config.retired = config.retired.filter(x => x.id !== id);
  (config.purgedIds ||= []).push(id);
  // its clients go too (their folders went with the workspace's), and their voice agents in the background
  const clientsRemoved = (config.clients || []).filter(c => c.workspace === id).map(c => c.id);
  if (clientsRemoved.length) config.clients = config.clients.filter(c => c.workspace !== id);
  saveConfig();
  if (clientsRemoved.length) {
    import('./voiceagents.mjs').then(v => Promise.all(clientsRemoved.map(cid => v.removeClientVoices(cid)
      .catch(e => console.warn(`[voice] ${cid}'s voice agents not removed:`, e.message))))).catch(() => {});
  }
  return { id, clientsRemoved };
}

/** Does each registered engine's CLI run on this PC? (For the Add window.) One that is there but won't start is `broken`. */
export function runtimeAvailability() {
  return Object.fromEntries(engines().map(e => {
    const h = engineHealth(e);
    return [e.id, { available: h === 'ok', broken: h === 'broken', repair: h === 'broken' ? engineRepairCmd(e) || null : null }];
  }));
}
