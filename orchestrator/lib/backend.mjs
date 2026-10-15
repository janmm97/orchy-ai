// Orchy fixes himself. The owner says what's wrong in the chat ("the Logs window is blank"), Jev routes it as
// `fix_orchy`, and a Claude Code run works on Orchy's own code in the Orchy folder (the built-in "orchy" workspace,
// workspaces.mjs#backendWorkspace). Around that run:
//   - before it starts: a snapshot of the code (data/backups/<runId>/), so every fix can be undone
//   - while it runs: client folders are off-limits, and the files that hold Orchy's hard rules ask the owner, each
//     time (policy.mjs#backendLimits + the Claude Code rules from backendSettingsFile)
//   - when it ends: the files it changed. Server code changed → Orchy restarts himself once nothing is running,
//     through scripts/restart.mjs, which puts the snapshot back if the new code doesn't come up.
//     Dashboard files need no restart: the owner reloads the page.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ROOT, ORCH_DIR, DATA_DIR, env } from './env.mjs';
import { flush } from './store.mjs';
import { workspaces, RETIRED_DIR, WORKSPACES_DIR } from './workspaces.mjs';

export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const RESTART_FILE = path.join(DATA_DIR, 'restart.json');        // the restart scripts/restart.mjs carries out
const RESULT_FILE = path.join(DATA_DIR, 'restart-result.json');  // how it went, told by the new Orchy
const KEEP = 15; // snapshots kept (the oldest go)

// ── what counts as Orchy's code: text files only (fonts, vendored libraries and Orchy's data stay out) ──
const TREES = [['orchestrator', /^(data|node_modules)(\/|$)|^voice-agents\.json$/], ['dashboard', /^(vendor|fonts)(\/|$)/], ['scripts', null]];
const ROOT_FILES = ['package.json', 'CLAUDE.md', 'README.md', 'PRODUCT.md', 'DESIGN.md', 'Start Orchy.cmd'];
const TEXT = /\.(mjs|cjs|js|json|html|css|md|ps1|cmd|txt|svg)$/i;

function walk(rel, skip, out) {
  let entries;
  try { entries = fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = `${rel}/${e.name}`;
    if (skip?.test(p.slice(p.indexOf('/') + 1))) continue;
    if (e.isDirectory()) walk(p, skip, out);
    else if (e.isFile() && TEXT.test(e.name)) out.push(p);
  }
}

/** Orchy's code files, as paths relative to the Orchy folder with forward slashes. */
export function codeFiles() {
  const out = ROOT_FILES.filter(f => fs.existsSync(path.join(ROOT, f)));
  for (const [dir, skip] of TREES) walk(dir, skip, out);
  return out;
}

const sha = buf => crypto.createHash('sha1').update(buf).digest('hex');
const readRel = rel => { try { return fs.readFileSync(path.join(ROOT, rel)); } catch { return null; } };
const inRoot = rel => { const p = path.resolve(ROOT, rel); return p.startsWith(ROOT + path.sep) ? p : null; };

// ── snapshots ──
export function snapshot(runId) {
  const dir = path.join(BACKUP_DIR, runId);
  const files = {};
  for (const rel of codeFiles()) {
    const buf = readRel(rel);
    if (!buf) continue;
    const to = path.join(dir, 'files', rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, buf);
    files[rel] = sha(buf);
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ runId, at: new Date().toISOString(), files }, null, 2));
  prune();
  return dir;
}

function manifest(runId) {
  try { return JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, runId, 'manifest.json'), 'utf8')); } catch { return null; }
}
export const hasSnapshot = runId => !!manifest(runId);

function prune() {
  let dirs;
  try { dirs = fs.readdirSync(BACKUP_DIR).map(n => ({ n, t: fs.statSync(path.join(BACKUP_DIR, n)).mtimeMs })).sort((a, b) => b.t - a.t); } catch { return; }
  for (const d of dirs.slice(KEEP)) fs.rmSync(path.join(BACKUP_DIR, d.n), { recursive: true, force: true });
}

/** What changed in Orchy's code since the run's snapshot: [{ file, change: 'added'|'modified'|'removed', after }]. */
export function changes(runId) {
  const m = manifest(runId);
  if (!m) return null;
  const now = new Set(codeFiles());
  const out = [];
  for (const rel of now) {
    const buf = readRel(rel);
    const h = buf && sha(buf);
    if (!(rel in m.files)) out.push({ file: rel, change: 'added', after: h });
    else if (h !== m.files[rel]) out.push({ file: rel, change: 'modified', after: h });
  }
  for (const rel of Object.keys(m.files)) if (!now.has(rel)) out.push({ file: rel, change: 'removed', after: null });
  return out;
}

// the server loads these once: a change only counts after a restart (scripts and templates are read when used)
const SERVER_CODE = /^orchestrator\/(?!scripts\/|templates\/|data\/)|^package\.json$/;
export const needsRestart = list => (list || []).some(c => SERVER_CODE.test(c.file));
export const needsReload = list => (list || []).some(c => c.file.startsWith('dashboard/'));

/** Put the run's snapshot back over the files it changed. */
function restore(runId, list) {
  const src = path.join(BACKUP_DIR, runId, 'files');
  for (const c of list) {
    const to = inRoot(c.file);
    if (!to) continue;
    if (c.change === 'added') fs.rmSync(to, { force: true });
    else { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(src, c.file), to); }
  }
}

/**
 * Undo a fix: only while its files are still as it left them (a later fix changed them → refused, so undoing
 * this one can't silently undo that one too). Returns { restart, reload }.
 */
export function undo(run) {
  const list = run.backendChanges || [];
  if (!list.length) throw Object.assign(new Error('That fix didn’t change any code, so there’s nothing to undo.'), { status: 400 });
  if (run.undoneAt) throw Object.assign(new Error('That fix was already undone.'), { status: 409 });
  if (!hasSnapshot(run.id)) throw Object.assign(new Error('The snapshot from before that fix is gone (Orchy keeps the last 15).'), { status: 410 });
  const moved = list.filter(c => { const buf = readRel(c.file); return (buf ? sha(buf) : null) !== c.after; });
  if (moved.length) throw Object.assign(new Error(`Something changed ${moved.map(c => c.file).slice(0, 3).join(', ')} after that fix, so undoing it now would undo that too.`), { status: 409 });
  restore(run.id, list);
  return { restart: needsRestart(list), reload: needsReload(list) };
}

// ── restarting ──
// A restart cuts off every live run, so after a fix it waits until nothing is running.
let pending = null; // { runId, session, files, reload, why }
export const pendingRestart = () => pending;

/** Restart once `busy()` says nothing is running. Returns 'now' or 'queued'. */
export function queueRestart(info, busy) {
  pending = info;
  if (busy()) return 'queued';
  restartNow(info);
  return 'now';
}
/** Called when a run ends: a waiting restart goes ahead once nothing else is running. */
export function maybeRestart(busy) { if (pending && !busy()) restartNow(pending); }
export function cancelRestart() { const p = pending; pending = null; return p; }

/**
 * Hand over to scripts/restart.mjs and exit. It starts the new Orchy once this one is gone, and if that doesn't
 * come up, puts `files` back from the run's snapshot and starts again.
 */
export function restartNow({ runId = null, session = null, files = [], reload = false, why = 'fix' } = {}) {
  pending = null;
  const backup = runId && hasSnapshot(runId) ? path.join(BACKUP_DIR, runId, 'files') : null;
  fs.writeFileSync(RESTART_FILE, JSON.stringify({ runId, session, at: new Date().toISOString(), backup, files: backup ? files : [], reload, why, port: Number(env('PORT', '8008')) }, null, 2));
  const log = fs.openSync(path.join(DATA_DIR, 'restart.log'), 'a');
  spawn(process.execPath, [path.join(ORCH_DIR, 'scripts', 'restart.mjs'), String(process.pid)], { cwd: ROOT, detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref();
  // the API answers first, then state is written and this Orchy steps aside
  setTimeout(() => { try { flush(); } finally { process.exit(0); } }, 500);
}

/** On boot: how the restart before it went (once), or null. */
export function bootReport() {
  let r = null;
  try { r = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8')); } catch { return null; }
  for (const f of [RESULT_FILE, RESTART_FILE]) try { fs.rmSync(f, { force: true }); } catch {}
  return r;
}

// ── the fence ──
// The files that hold Orchy's hard rules: accounts, One scopes, the approval gate, client fences, the
// bridge, the restart and this fence itself, plus his settings and secrets. A fix may change them, but only
// with the owner's OK, every time (never "always allow").
export const GUARDED_GLOBS = [
  'orchestrator/lib/policy.mjs', 'orchestrator/lib/gate.mjs', 'orchestrator/lib/workspaces.mjs', 'orchestrator/lib/clients.mjs',
  'orchestrator/lib/clientspace.mjs', 'orchestrator/lib/backend.mjs', 'orchestrator/lib/owner.mjs', 'orchestrator/lib/cfaccess.mjs', 'orchestrator/portal.mjs', 'orchestrator/mcp/bridge.mjs',
  'orchestrator/scripts/restart.mjs', 'orchestrator/config.json', '.env', '.claude/**', '.codex/**', '.one/**', '.mcp.json',
];
const GUARDED = new RegExp(`^(${GUARDED_GLOBS.map(g => g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\/\*\*$/, '(/.*)?')).join('|')})$`, 'i');
// …and the same rules where they're wired into other files (the dashboard's origin lock, the account check before a
// run, Claude Code's permission tool): an edit that takes out text naming one asks too
export const LOCK_MARKERS = /\b(accountCheck|crossSite|LOCAL_HOSTS|LOCAL_ORIGINS|oneScope|clientDenyRules|clientSettingsFile|backendSettingsFile|gateAndWait|BRIDGE_TOKEN|NO_SCHEDULER|isOwner|ownerOnly|OWNERLESS|RESTART_TOKEN|REPORT_TOKEN)\b|cf-ray|cf-connecting-ip|sec-fetch-site|permission-prompt-tool/i;

/** A path inside the Orchy folder as Windows reads it ("CLAUDE.md ", "x::$DATA" are the same files), relative with /, or null. */
export function rootRel(p) {
  const rel = path.relative(ROOT, path.resolve(ROOT, String(p))).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split('/').map(s => s.replace(/:.*$/, '').replace(/[. ]+$/, '')).join('/');
}
export const guardedFile = p => { const rel = rootRel(p); return !!rel && GUARDED.test(rel); };

/** Client workspaces' folders (and the retired ones): a fix never reads or changes them. */
export const fencedDirs = () => [...workspaces().map(w => w.dir), WORKSPACES_DIR, RETIRED_DIR];

/** Claude Code's own rules for a fix run: client folders refused outright; guarded files, .env, Uploads and every command reach the gate. */
export function backendSettingsFile(run) {
  const abs = p => `//${path.resolve(p).replace(/\\/g, '/').replace(/^([A-Za-z]):\//, (_, d) => `${d.toLowerCase()}/`)}`;
  const rel = d => path.relative(ROOT, d).replace(/\\/g, '/');
  const both = (tool, globs) => globs.flatMap(g => [`${tool}(./${g})`, `${tool}(${abs(ROOT)}/${g})`]);
  // Claude Code hands Read rules to ripgrep as exclude globs, where a space ("Acme Agent") or a brace breaks every
  // Grep: `?` stands in for any such character
  const fenced = fencedDirs().map(d => `${rel(d).replace(/[\s{}[\],*?!]/g, '?')}/**`);
  const settings = {
    permissions: {
      deny: [...both('Read', fenced), ...both('Edit', fenced)],
      // every command reaches Orchy's gate, even ones Claude Code calls read-only (that's where client folders are refused)
      ask: ['Bash', 'PowerShell', ...both('Edit', GUARDED_GLOBS), ...both('Read', ['.env', 'Uploads/**'])],
    },
  };
  const file = path.join(DATA_DIR, 'runs', `${run.id}.settings.json`);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  return file;
}
