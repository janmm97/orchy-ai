// The artifact registry: every file an agent made or changed, so the owner can open it in the dashboard's viewer.
// Files stay where the agent wrote them; the registry only remembers where (relative to the workspace folder),
// what they are and which runs touched them. Records live in state.json `artifacts` (a map by id, capped).
//
// Discovery is all real, never guessed:
//   1. live: a Write/Edit/MultiEdit/NotebookEdit tool event (every engine names its file tools that way) is
//      registered as a draft when its tool_done arrives (the file must exist);
//   2. on run end: the run's task folder, report.outputs[] that name a file in the workspace (URLs go to run.links),
//      and a bounded scan for files modified while the run ran (client runs: their sandbox only);
//   3. a huddle's HUDDLE.md (and its task folder), when the dashboard asks for it.
// Status: final (run completed), draft (live, partial or stopped), failed (run failed; still viewable), missing.
//
// The path guard (resolveFile) is the fence: realpath (native, so 8.3 short names, junctions and symlinks are
// resolved) inside the workspace folder; no dot-segments, hidden or setup parts, secrets, node_modules, other
// workspaces nested inside it; a client's artifacts only inside that client's own sandbox, and the owner's runs never
// reach into any client's sandbox; never Orchy's own folder. Every route re-resolves on every request.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db as storeDb, save as storeSave, runEventsPath } from './store.mjs';
import { emit as busEmit, bus } from './bus.mjs';
import { DATA_DIR } from './env.mjs';
import { workspace as wsById, workspaces as allWorkspaces, BACKEND_ID } from './workspaces.mjs';
import { CLIENTS_DIR, clientHome, taskRoot, taskFiles } from './clientspace.mjs';
import { officeText, xlsxSheets, pptxSlides } from './uploads.mjs';
import { BUILDER_SLUG } from './agents.mjs';

export const MAX_ARTIFACTS = 5000;
export const SCAN = { depth: 6, entries: 20_000, perRun: 200 }; // depth 6: <Department>/<agent>/Tasks/<task>/<folder>/file
const MAX_TEXT = 2 * 1024 * 1024;       // text/code/json previews
const MAX_OFFICE_CHARS = 200_000;       // office text previews
const MAX_ROWS = 1000;                  // csv/tsv/xlsx rows
const MAX_DOCX = 25 * 1024 * 1024;      // mammoth works in memory
const MAX_DOC_HTML = 8 * 1024 * 1024;   // docx HTML with its images inlined
const RUN_IDS = 20;                     // runs remembered per artifact

// Swappable for tests (scripts/test-artifacts.mjs): nothing there touches the real state.
const deps = {
  db: storeDb, save: storeSave, emit: busEmit, workspace: wsById, workspaces: allWorkspaces,
  eventsOf: runId => { try { return fs.readFileSync(runEventsPath(runId), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } },
  previewsDir: path.join(DATA_DIR, 'previews'),
  onRegistered: null, // (record, file) → media.mjs probes / makes previews
  onDropped: null,    // (id) → media.mjs deletes its previews
};
export function configure(o) { Object.assign(deps, o); }
export const previewsDir = () => deps.previewsDir;

// ── kinds ──
const EXT = {};
const kinds = {
  image: 'png jpg jpeg gif webp avif bmp ico svg heic heif tif tiff psd dng',
  pdf: 'pdf',
  video: 'mp4 m4v webm mov mkv avi wmv flv mpg mpeg 3gp ts m2ts mts ogv',
  audio: 'mp3 wav ogg oga opus m4a aac flac wma aif aiff',
  markdown: 'md markdown mdx',
  json: 'json geojson ipynb',
  csv: 'csv tsv',
  sheet: 'xlsx ods',
  doc: 'docx odt',
  slides: 'pptx odp',
  html: 'html htm',
  code: 'js mjs cjs ts tsx jsx py rb go rs java kt swift c h cc cpp hpp cs php sh bash zsh ps1 psm1 bat cmd sql css scss less vue svelte lua r pl yaml yml toml xml ini cfg conf dockerfile makefile gradle',
  text: 'txt log text rtf srt vtt jsonl ndjson tex rst adoc org',
};
for (const [k, list] of Object.entries(kinds)) for (const e of list.split(' ')) EXT[`.${e}`] = k;
/** What the viewer draws a file as. */
export function kindFor(name) { return EXT[path.extname(String(name || '')).toLowerCase()] || 'other'; }

// what /raw may show inline (on top of clientspace's INLINE + MEDIA); everything else downloads.
// Text of any kind goes as text/plain (never script), SVG only ever lands in <img>, HTML only in a sandboxed iframe,
// and the CSP sandbox header on /raw covers a tab opened on it directly.
export const VIEW_TYPES = {
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
};
for (const [e, k] of Object.entries(EXT)) if (['markdown', 'json', 'csv', 'code', 'text'].includes(k)) VIEW_TYPES[e] = 'text/plain; charset=utf-8';
const MIMES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ...VIEW_TYPES };
const mimeFor = name => MIMES[path.extname(name).toLowerCase()] || 'application/octet-stream';

// ── the path guard ──
// setup and private files never show, wherever they sit
const SETUP_NAMES = new Set(['claude.md', 'claude.local.md', 'agents.md', 'gemini.md', 'logs.md', 'desktop.ini', 'thumbs.db', '.ds_store']);
const SECRET_EXT = new Set(['.env', '.pem', '.key', '.p12', '.pfx', '.kdbx']);
const SKIP_DIRS = new Set(['node_modules', '__pycache__']);

/** A workspace-relative path split into parts, or null if any part could climb, hide or alias. */
function cleanParts(rel, client) {
  const r = String(rel ?? '');
  if (!r || r.includes('\0') || r.includes(':') || path.isAbsolute(r) || /^[\\/]/.test(r)) return null;
  const parts = r.split(/[\\/]+/);
  // "..", ".", empty, hidden, and Windows' trailing dot/space aliases ("CLAUDE.md." is CLAUDE.md)
  if (parts.some(s => !s || s === '.' || s === '..' || /[. ]$/.test(s))) return null;
  let i = 0;
  if (parts[0].toLowerCase() === CLIENTS_DIR) {
    // a client's own sandbox, and only for that client's artifacts
    if (!client || parts.length < 3 || parts[1].toLowerCase() !== String(client).toLowerCase()) return null;
    i = 2;
  } else if (client) return null;
  for (let j = i; j < parts.length; j++) if (parts[j].startsWith('.') || SKIP_DIRS.has(parts[j].toLowerCase())) return null;
  const base = parts.at(-1).toLowerCase();
  if (SETUP_NAMES.has(base) || SECRET_EXT.has(path.extname(base))) return null;
  return parts;
}

const realOf = p => { try { return fs.realpathSync.native(p); } catch { return null; } };
// Windows and macOS folders ignore case; Linux ones don't
const fold = s => (process.platform === 'win32' || process.platform === 'darwin' ? s.toLowerCase() : s);
const inside = (child, root) => fold(child).startsWith(fold(root).replace(/[\\/]+$/, '') + path.sep);
const same = (a, b) => fold(a) === fold(b);

/**
 * The real file behind a workspace-relative path, or null. Checked twice: the path as given, and the real path
 * (after junctions, symlinks and 8.3 names) relative to the real workspace folder.
 */
export function resolveFile(ws, rel, client = null) {
  if (!ws?.dir || ws.id === BACKEND_ID || ws.builtin || !cleanParts(rel, client)) return null;
  const root = realOf(ws.dir);
  if (!root) return null;
  const real = realOf(path.join(ws.dir, ...String(rel).split(/[\\/]+/)));
  if (!real || !inside(real, root)) return null;
  const realRel = path.relative(root, real);
  if (!cleanParts(realRel, client)) return null;
  if (client) {
    const home = realOf(clientHome(ws, client));
    if (!home || !inside(real, home)) return null;
  }
  // another workspace living inside this one's folder is its own world
  for (const o of deps.workspaces()) {
    if (o.id === ws.id || !o.dir) continue;
    const od = realOf(o.dir);
    if (od && inside(od, root) && (same(real, od) || inside(real, od))) return null;
  }
  try { if (!fs.statSync(real).isFile()) return null; } catch { return null; }
  return real;
}

/** A path an agent named (absolute, or relative to where it ran) as a workspace-relative one, or null. */
export function relFor(ws, run, p) {
  const s = String(p || '').trim().replace(/^file:\/\/\/?/i, '');
  if (!s || s.includes('\0') || s.length > 1024) return null;
  // "file:///C:/x" leaves "C:/x"; "file:///home/x" leaves "home/x" (a POSIX path lost its slash)
  const abs = path.isAbsolute(s) ? path.resolve(s) : /^file:/i.test(String(p).trim()) && process.platform !== 'win32' ? path.resolve('/', s) : path.resolve(runBase(ws, run), s);
  const root = realOf(ws.dir) || path.resolve(ws.dir);
  const real = realOf(abs) || abs;
  const base = inside(real, root) ? root : path.resolve(ws.dir);
  if (!inside(real, base)) return null;
  return path.relative(base, real).split(path.sep).join('/');
}
const runBase = (ws, run) => (run?.client ? clientHome(ws, run.client) : ws.dir);

// ── records ──
const store = () => (deps.db().artifacts ||= {});
export const idFor = (wsId, rel) => `art_${crypto.createHash('sha1').update(`${wsId}\0${String(rel).toLowerCase()}`).digest('hex').slice(0, 16)}`;
const stampOf = st => `${st.size}:${Math.round(st.mtimeMs)}`;

/** The record the dashboard gets (no absolute paths; `rel` is relative to the workspace folder). */
export function publicArtifact(a) {
  if (!a) return null;
  const { stamp, was, ...rest } = a;
  return rest;
}
export const getArtifact = id => store()[id] || null;

function emitRec(type, a) { deps.emit(type, { artifact: publicArtifact(a) }); }

/**
 * Register (or bump) a file for a run. `p` is absolute or relative to the run's folder. Returns the record or null.
 * `claim:false` (scans) leaves an unchanged file with the run that made it.
 */
export function register(run, p, { source = 'write', status = 'draft', claim = true } = {}) {
  if (!run?.workspace || run.workspace === BACKEND_ID) return null;
  let ws;
  try { ws = deps.workspace(run.workspace); } catch { return null; }
  const rel0 = relFor(ws, run, p);
  if (!rel0) return null;
  const file = resolveFile(ws, rel0, run.client || null);
  if (!file) return null;
  const rel = path.relative(realOf(ws.dir), file).split(path.sep).join('/');
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  return upsert(ws, run, rel, st, { source, status, claim, file });
}

function upsert(ws, run, rel, st, { source, status, claim, file }) {
  const arts = store();
  const id = idFor(ws.id, rel);
  const now = new Date().toISOString();
  const stamp = stampOf(st);
  const name = path.posix.basename(rel);
  const who = run?.id ? { runId: run.id, agentSlug: run.isBuilder ? BUILDER_SLUG : run.agentSlug || null, agentName: run.agentName || null } : {};
  let a = arts[id];
  if (!a) {
    a = arts[id] = {
      id, workspace: ws.id, runId: run?.id || null, runIds: run?.id ? [run.id] : [], agentSlug: who.agentSlug || null, agentName: who.agentName || run?.agentName || null,
      huddleId: run?.huddle || null, client: run?.client || null, rel, name, ext: path.extname(name).toLowerCase().slice(1), kind: kindFor(name), mime: mimeFor(name),
      size: st.size, mtime: st.mtime.toISOString(), createdAt: now, updatedAt: now, version: 1, status, source, stamp,
    };
    if (deps.onRegistered && ['image', 'video', 'audio'].includes(a.kind)) a.media = { state: 'queued' };
    capRegistry();
    deps.save();
    emitRec('artifact.created', a);
    deps.onRegistered?.(a, file);
    return a;
  }
  const changed = a.stamp !== stamp;
  let touched = false;
  if (changed) {
    Object.assign(a, { size: st.size, mtime: st.mtime.toISOString(), updatedAt: now, version: a.version + 1, stamp, source });
    if (a.media) a.media = { state: 'queued' }; // previews are per version: media.mjs makes the new ones
    touched = true;
  }
  if ((changed || claim) && run?.id) {
    if (a.runId !== run.id) { Object.assign(a, who, { huddleId: run.huddle || a.huddleId }); touched = true; }
    if (!a.runIds.includes(run.id)) { a.runIds = [...a.runIds, run.id].slice(-RUN_IDS); touched = true; }
  }
  if (a.status === 'missing') { a.status = a.was || status; delete a.was; touched = true; }
  if ((changed || claim) && a.runId === (run?.id || null) && a.status !== status) { a.status = status; touched = true; }
  if (touched) { a.updatedAt = now; deps.save(); emitRec('artifact.updated', a); }
  if (changed) deps.onRegistered?.(a, file);
  return a;
}

const dropListeners = [];
/** Called with each record the cap drops (a later client viewer can remove what it shared). */
export function onDrop(fn) { dropListeners.push(fn); }
function capRegistry() {
  const arts = store();
  const ids = Object.keys(arts);
  if (ids.length <= MAX_ARTIFACTS) return;
  const drop = ids.map(id => arts[id]).sort((x, y) => String(x.updatedAt).localeCompare(String(y.updatedAt))).slice(0, ids.length - MAX_ARTIFACTS);
  for (const a of drop) { delete arts[a.id]; deps.onDropped?.(a.id); for (const fn of dropListeners) { try { fn(a); } catch {} } }
}

/** Patch what media.mjs learned (probe, previews, playable copy) and tell the dashboard. */
export function updateMedia(id, patch) {
  const a = getArtifact(id);
  if (!a) return null;
  a.media = { ...(a.media || {}), ...patch };
  deps.save();
  emitRec('artifact.updated', a);
  return a;
}

/** The record and its file now: a gone file marks it missing, a changed one bumps its version. */
export function openArtifact(id) {
  const a = getArtifact(id);
  if (!a) throw Object.assign(new Error('No such file'), { status: 404 });
  let ws;
  try { ws = deps.workspace(a.workspace); } catch { throw Object.assign(new Error('That workspace is gone'), { status: 404 }); }
  const file = resolveFile(ws, a.rel, a.client);
  if (!file) {
    if (a.status !== 'missing') { a.was = a.status; a.status = 'missing'; a.updatedAt = new Date().toISOString(); deps.save(); emitRec('artifact.updated', a); }
    throw Object.assign(new Error('That file isn’t there any more'), { status: 404, artifact: publicArtifact(a) });
  }
  const st = fs.statSync(file);
  if (stampOf(st) !== a.stamp || a.status === 'missing') upsert(ws, null, a.rel, st, { source: a.source, status: a.status === 'missing' ? a.was || 'draft' : a.status, claim: false, file });
  return { artifact: a, file, ws };
}

// ── discovery ──
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const pending = new Map(); // `${runId}:${toolUseId}` → { path, source }

/** A run event as it's recorded (runner.mjs#record): file tools register on their tool_done. */
export function onRunEvent(runId, e) {
  if (!e || !runId) return;
  const key = `${runId}:${e.toolUseId}`;
  if (e.kind === 'tool' && WRITE_TOOLS.has(e.tool) && e.toolUseId) {
    const p = e.input?.file_path || e.input?.notebook_path;
    if (p && typeof p === 'string' && !p.endsWith('…')) {
      pending.set(key, { path: p, source: e.codex === 'patch' ? 'codex-patch' : String(e.tool).toLowerCase().includes('write') ? 'write' : 'edit' });
      if (pending.size > 2000) pending.delete(pending.keys().next().value);
    }
    return;
  }
  if (e.kind === 'tool_error') { pending.delete(key); return; }
  if (e.kind === 'tool_done' && pending.has(key)) {
    const p = pending.get(key);
    pending.delete(key);
    const run = deps.db().runs?.[runId];
    if (run && e.ok !== false) register(run, p.path, { source: p.source, status: 'draft' });
  }
}

const STATUS_BY_OUTCOME = { completed: 'final', failed: 'failed' };
const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/gi;
/** URLs and file-looking bits in one report output line. */
export function outputBits(s) {
  const str = String(s || '').slice(0, 2000);
  const urls = [...str.matchAll(URL_RE)].map(m => m[0].replace(/[.,;:!?]+$/, ''));
  const rest = str.replace(URL_RE, ' ');
  const paths = new Set();
  for (const m of rest.matchAll(/`([^`\n]{1,400})`/g)) paths.add(m[1].trim());
  for (const m of rest.matchAll(/\]\(([^)\s]{1,400})\)/g)) paths.add(m[1]);
  const plain = rest.replace(/^[\s\-*•]+/, '').trim().replace(/^["']|["']$/g, '');
  if (plain && plain.length <= 400 && /\.[a-z0-9]{1,8}$/i.test(plain)) paths.add(plain);
  // a POSIX absolute path's leading slash only where a path can start (after a space, quote or bracket)
  for (const m of rest.matchAll(/(?:[A-Za-z]:[\\/]|(?<![^\s"'`([])\/)?(?:[\w.()'&+-]+[\\/])*[\w()'&+-][\w.()'&+-]*\.[A-Za-z0-9]{1,8}\b/g)) paths.add(m[0].trim());
  return { urls, paths: [...paths].filter(Boolean).slice(0, 40) };
}

/** Files modified while the run ran, under `root` (bounded; skips hidden/setup folders and Uploads and Resources at the top). */
function scanModified(root, fromMs, toMs, { skipTop = [] } = {}) {
  const out = [];
  let seen = 0;
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > SCAN.entries || out.length >= SCAN.perRun) return;
      const n = e.name, low = n.toLowerCase();
      if (n.startsWith('.') || SKIP_DIRS.has(low)) continue;
      const p = path.join(dir, n);
      if (e.isDirectory()) { if (depth < SCAN.depth && !(dir === root && skipTop.includes(low))) walk(p, depth + 1); continue; }
      if (!e.isFile() || SETUP_NAMES.has(low) || low === 'task.md' || low === 'huddle.md') continue; // other runs' summaries finish at the same moment
      try { const m = fs.statSync(p).mtimeMs; if (m >= fromMs && m <= toMs) out.push(p); } catch {}
    }
  };
  walk(root, 0);
  return out;
}

/**
 * Everything a run left (on its end, or when the dashboard opens an old run): the task folder, report outputs,
 * and the modified-files scan. A live run only gets its task folder. Huddle talk turns only keep what their tools wrote.
 */
export function syncRun(run, { ended = !!run?.endedAt } = {}) {
  if (!run?.workspace || run.workspace === BACKEND_ID) return [];
  let ws;
  try { ws = deps.workspace(run.workspace); } catch { return []; }
  const status = ended ? STATUS_BY_OUTCOME[run.outcome] || 'draft' : 'draft';
  const seen = new Set();
  let dirty = false;
  // only a report that names a file claims it unchanged; scans leave an unchanged file with the run that made it
  const add = (p, source) => { const a = register(run, p, { source, status, claim: source === 'report-output' }); if (a) seen.add(a.id); };
  const troot = taskRoot(ws, run);
  if (troot) for (const f of taskFiles(ws, run)) add(path.join(troot, ...f.path.split('/')), 'taskdir-scan');
  if (ended && !run.artifactScan) {
    const links = new Set(run.links || []);
    for (const line of run.report?.outputs || []) {
      const { urls, paths } = outputBits(line);
      urls.forEach(u => links.size < 20 && links.add(u));
      for (const p of paths) add(p, 'report-output');
    }
    if (links.size) run.links = [...links];
    if (!run.huddleTalk && run.startedAt) {
      const from = Date.parse(run.startedAt) - 2000, to = Date.parse(run.endedAt || new Date().toISOString()) + 5000;
      const root = run.client ? clientHome(ws, run.client) : ws.dir;
      for (const f of scanModified(root, from, to, { skipTop: run.client ? [] : ['uploads', 'resources'] })) add(f, 'workspace-scan');
    }
    run.artifactScan = new Date().toISOString();
    dirty = true;
  }
  // the run's own files take its outcome
  if (ended) {
    for (const a of Object.values(store())) {
      if (a.runId !== run.id || a.status === 'missing') continue;
      const want = STATUS_BY_OUTCOME[run.outcome] || 'draft';
      if (a.status !== want) { a.status = want; a.updatedAt = new Date().toISOString(); emitRec('artifact.updated', a); dirty = true; }
    }
  }
  // state.json is big: only write it when this sync changed something (register saves its own changes)
  if (dirty) deps.save();
  return [...seen];
}

/** A huddle's transcript and task folder (asked for by the dashboard; HUDDLE.md → viewer). */
export function syncHuddle(h) {
  if (!h?.taskDir || !h.workspace) return [];
  let ws;
  try { ws = deps.workspace(h.workspace); } catch { return []; }
  const pseudo = { id: null, workspace: h.workspace, huddle: h.id, agentName: 'Huddle', taskDir: h.taskDir, taskRoot: h.taskRoot || null };
  const status = ['talking', 'wrapping'].includes(h.status) ? 'draft' : 'final';
  const out = [];
  const root = taskRoot(ws, pseudo);
  for (const f of taskFiles(ws, pseudo)) { const a = register(pseudo, path.join(root, ...f.path.split('/')), { source: 'taskdir-scan', status }); if (a) out.push(a); }
  return out;
}

/** The registry, filtered: run (its own files and its task folder's), workspace, agent, huddle, kind. Newest first. */
export function listArtifacts({ run = null, workspace = null, agent = null, huddle = null, kind = null, limit = 300 } = {}) {
  let list = Object.values(store());
  if (run) {
    let ws = null;
    try { ws = deps.workspace(run.workspace); } catch {}
    const troot = ws && taskRoot(ws, run);
    const tdir = troot ? path.relative(realOf(ws.dir) || ws.dir, realOf(troot) || troot).split(path.sep).join('/') + '/' : null;
    list = list.filter(a => a.workspace === run.workspace && (a.runIds?.includes(run.id) || (tdir && fold(a.rel).startsWith(fold(tdir)))));
  }
  if (workspace) list = list.filter(a => a.workspace === workspace);
  if (agent) list = list.filter(a => a.agentSlug === agent);
  if (huddle) list = list.filter(a => a.huddleId === huddle);
  if (kind) list = list.filter(a => a.kind === kind);
  return list.sort((x, y) => String(y.updatedAt).localeCompare(String(x.updatedAt))).slice(0, Math.max(1, Math.min(1000, Number(limit) || 300))).map(publicArtifact);
}

// ── previews (server-side text for the viewer) ──
function readHead(file, max) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, max));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return { text: buf.subarray(0, n).toString('utf8').replace(/^\uFEFF/, ''), truncated: size > max };
  } finally { fs.closeSync(fd); }
}
const looksText = file => { try { const { text } = readHead(file, 8192); return !text.includes('\0'); } catch { return false; } };

/** CSV/TSV rows (quotes, doubled quotes, newlines inside quotes). */
export function parseDelimited(text, delim = ',', maxRows = MAX_ROWS) {
  const rows = [];
  let row = [], cell = '', q = false, truncated = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
      continue;
    }
    if (c === '"' && cell === '') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row.map(v => v.slice(0, 2000))); row = [];
      if (rows.length >= maxRows) { truncated = i < text.length - 1; break; }
    } else cell += c;
  }
  if (!truncated && (cell || row.length)) { row.push(cell); rows.push(row.map(v => v.slice(0, 2000))); }
  return { rows, truncated };
}

let mammothP = null;
async function docxHTML(file) {
  mammothP ||= import('mammoth').then(m => m.default || m);
  const mammoth = await mammothP;
  let budget = MAX_DOC_HTML;
  const ok = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  const res = await mammoth.convertToHtml({ path: file }, {
    // images only as data: URIs from the docx itself, and only so many (the dashboard's sanitizer keeps nothing else)
    convertImage: mammoth.images.imgElement(async img => {
      if (!ok.has(img.contentType)) return { src: '' };
      const b64 = await img.read('base64');
      if (b64.length > 3_000_000 || (budget -= b64.length) < 0) return { src: '' };
      return { src: `data:${img.contentType};base64,${b64}` };
    }),
    externalFileAccess: false,
  });
  return res.value;
}

/**
 * What the viewer shows for a file it can't draw from /raw alone:
 * {type:'text', text} | {type:'rows', rows} | {type:'html', html} | {type:'sheets', sheets} | {type:'slides', slides}, + truncated, note.
 * The docx HTML is mammoth's own tags only; the dashboard still sanitizes it before it lands in the page.
 */
export async function previewFile(file, name = path.basename(file)) {
  const kind = kindFor(name), ext = path.extname(name).toLowerCase();
  const size = fs.statSync(file).size;
  if (kind === 'csv') {
    const { text, truncated: cut } = readHead(file, 8 * 1024 * 1024);
    const { rows, truncated } = parseDelimited(text, ext === '.tsv' ? '\t' : sniffDelim(text));
    return { type: 'rows', rows, truncated: truncated || cut, note: `first ${MAX_ROWS.toLocaleString()} rows` };
  }
  if (kind === 'json') {
    const { text, truncated } = readHead(file, MAX_TEXT);
    if (!truncated && ext !== '.ipynb') { try { return { type: 'text', text: JSON.stringify(JSON.parse(text), null, 2), truncated: false, pretty: true }; } catch {} }
    return { type: 'text', text, truncated };
  }
  if (['markdown', 'code', 'text', 'html'].includes(kind) || (kind === 'other' && size <= MAX_TEXT && looksText(file))) {
    const { text, truncated } = readHead(file, MAX_TEXT);
    return { type: 'text', text, truncated };
  }
  if (ext === '.docx') {
    if (size > MAX_DOCX) return officeOnly(file, 'Too big to lay out: text only.');
    try { officeText(file, { probe: 'word/document.xml' }); } catch (e) { throw Object.assign(new Error(`That Word file couldn’t be opened (${e.message})`), { status: 415 }); }
    try { return { type: 'html', html: await docxHTML(file), truncated: false }; } catch { return officeOnly(file); }
  }
  if (ext === '.xlsx') {
    try { const sheets = xlsxSheets(file, { maxRows: MAX_ROWS }); return { type: 'sheets', sheets, truncated: sheets.some(s => s.truncated), note: `first ${MAX_ROWS.toLocaleString()} rows a sheet; dates show as Excel numbers` }; }
    catch (e) { throw Object.assign(new Error(`That Excel file couldn’t be opened (${e.message})`), { status: 415 }); }
  }
  if (ext === '.pptx') {
    try { return { type: 'slides', slides: pptxSlides(file), truncated: false, note: 'Slide text only: layout not shown' }; }
    catch (e) { throw Object.assign(new Error(`That PowerPoint file couldn’t be opened (${e.message})`), { status: 415 }); }
  }
  if (['.odt', '.ods', '.odp'].includes(ext)) return officeOnly(file);
  throw Object.assign(new Error('Can’t preview this type'), { status: 415 });
}
function officeOnly(file, note = 'Text only: layout not shown') {
  let text;
  try { text = officeText(file); } catch (e) { throw Object.assign(new Error(`That file couldn’t be opened (${e.message})`), { status: 415 }); }
  return { type: 'text', text: text.slice(0, MAX_OFFICE_CHARS), truncated: text.length > MAX_OFFICE_CHARS, note };
}
const sniffDelim = text => {
  const line = text.slice(0, 4000).split(/\r?\n/)[0] || '';
  const count = ch => line.split(ch).length;
  return count(';') > count(',') && count(';') > count('\t') ? ';' : count('\t') > count(',') ? '\t' : ',';
};

// ── research sources (from the run's real events) ──
const SOURCE_TOOL = /fetch|scrape|crawl|browse|extract|read_url|navigate/i;
const SEARCH_TOOL = /search/i;
const SEARCH_APPS = /\b(?:firecrawl|exa|tavily|hyper-?browser|serp|perplexity|brave)\b/i;
/** The URLs a run fetched and the searches it ran: { urls:[{url, tool, t}], searches:[{query, tool, t}] }. */
export function runSources(events = []) {
  const urls = new Map(), searches = new Map();
  const addUrl = (u, tool, t) => { const s = String(u || '').trim(); if (/^https?:\/\//i.test(s) && urls.size < 200 && !urls.has(s)) urls.set(s, { url: s.slice(0, 2000), tool, t }); };
  const addQ = (q, tool, t) => { const s = String(q || '').trim(); if (s && searches.size < 200 && !searches.has(s)) searches.set(s, { query: s.slice(0, 500), tool, t }); };
  for (const e of events) {
    if (e?.kind !== 'tool') continue;
    const tool = String(e.tool || ''), inp = e.input || {};
    if (tool === 'WebFetch') addUrl(inp.url, tool, e.t);
    else if (tool === 'WebSearch') addQ(inp.query, tool, e.t);
    else if (tool.startsWith('mcp__')) {
      const short = tool.split('__').slice(1).join(' › ');
      if (SEARCH_TOOL.test(tool)) addQ(inp.query || inp.q, short, e.t);
      if (SOURCE_TOOL.test(tool) || SEARCH_TOOL.test(tool)) for (const u of [inp.url, ...(Array.isArray(inp.urls) ? inp.urls : [])]) addUrl(u, short, e.t);
    } else if ((tool === 'Bash' || tool === 'PowerShell') && SEARCH_APPS.test(String(inp.command || '')) && /\bactions\s+execute\b/.test(String(inp.command || ''))) {
      // a One action on a search/scrape app: the URLs in its payload, not One's own API
      const app = String(inp.command).match(SEARCH_APPS)[0].toLowerCase();
      for (const m of String(inp.command).matchAll(URL_RE)) if (!/api\.|withone\.ai/i.test(m[0])) addUrl(m[0].replace(/[\\'",]+$/, ''), app, e.t);
      const q = String(inp.command).match(/"query"\s*:\s*\\?"([^"\\]{1,300})/)?.[1];
      if (q) addQ(q, app, e.t);
    }
  }
  return { urls: [...urls.values()], searches: [...searches.values()] };
}
export const sourcesFor = runId => runSources(deps.eventsOf(runId));

// ── wiring (server.mjs calls start once) ──
let started = false;
export function start() {
  if (started) return;
  started = true;
  bus.on('event', e => {
    try {
      if (e.type === 'run.event') onRunEvent(e.runId, e.event);
      else if (e.type === 'run.ended' && e.run?.id) {
        // after finish() is done with the run (it emits run.ended last)
        setTimeout(() => { try { const r = deps.db().runs?.[e.run.id]; if (r) syncRun(r, { ended: true }); } catch (err) { console.error('[artifacts] sync', err.message); } }, 50);
      }
    } catch (err) { console.error('[artifacts]', err.message); }
  });
}
