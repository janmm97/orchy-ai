// A client's own corner of a workspace: <workspace>/.clients/<client id>/. Every run a client starts, and every
// follow-up on it (the owner's included), works in there and nowhere else:
//   - Claude Code refuses reads outside it (blockReadsOutsideWorkingDirectories) and sends every shell command
//     to Orchy's gate, where policy.mjs keeps it inside this folder too;
//   - no CLAUDE.md and no auto memory from the owner's own work loads (the owner writes the client a brief instead);
//   - each task gets Tasks/<date-words>/ here, with files/ for what the client uploads.
// The One CLI still finds the workspace's login from here (it looks in parent folders), and Claude Code still
// finds the workspace's agents and skills the same way.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, ROOT, expandPath, ownerName } from './env.mjs';
import { kindOf, officeText, cleanName } from './uploads.mjs';

export const CLIENTS_DIR = '.clients';
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

const safeId = cid => {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(String(cid || ''))) throw bad('Bad client id', 500);
  return cid;
};
export const clientsRoot = ws => path.join(ws.dir, CLIENTS_DIR);
export const clientHome = (ws, cid) => path.join(clientsRoot(ws), safeId(cid));
export function ensureHome(ws, cid) {
  const home = clientHome(ws, cid);
  fs.mkdirSync(path.join(home, 'Tasks'), { recursive: true });
  return home;
}

const profileOf = ws => (ws.claudeConfigDir ? expandPath(ws.claudeConfigDir) : path.join(os.homedir(), '.claude'));
/** Claude Code's own folder for a working directory's sessions (where it parks big tool results). */
export const sessionDir = (ws, dir) => path.join(profileOf(ws), 'projects', path.resolve(dir).replace(/[^a-zA-Z0-9]/g, '-'));

/** Claude Code settings for a client's run, passed with --settings. */
export function clientSettingsFile(ws, run, home) {
  const fwd = p => path.resolve(p).replace(/\\/g, '/');
  const md = [path.join(ws.dir, 'CLAUDE.md'), path.join(ws.dir, 'CLAUDE.local.md'), path.join(ROOT, 'CLAUDE.md'), path.join(profileOf(ws), 'CLAUDE.md'), path.join(home, 'CLAUDE.md')];
  const settings = {
    // nothing the owner wrote for their own work loads: not Orchy's map, not the workspace's notes, not memory
    claudeMdExcludes: ['**/CLAUDE.md', '**/CLAUDE.local.md', '**/.claude/rules/**', ...new Set(md.flatMap(f => [fwd(f), path.resolve(f)]))],
    autoMemoryEnabled: false,
    permissions: {
      blockReadsOutsideWorkingDirectories: true,
      ask: ['Bash', 'PowerShell'], // every command reaches Orchy's gate, even ones Claude Code calls read-only
    },
  };
  const file = path.join(DATA_DIR, 'runs', `${run.id}.settings.json`);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  return file;
}

/** Folders a client's run may read besides its own: the workspace's skills, and Claude's session folder for it. */
export function clientReadDirs(ws, home) {
  const out = [];
  const skills = path.join(ws.dir, '.claude', 'skills');
  if (fs.existsSync(skills)) out.push(skills);
  const own = sessionDir(ws, home);
  fs.mkdirSync(own, { recursive: true });
  out.push(own);
  return out;
}

// ── Files a client gives an agent ──
// Kept to formats an agent can read and a browser can't be tricked into running: no HTML, SVG, scripts or programs.
export const MAX_FILE = 25 * 1024 * 1024;
export const MAX_FILES = 10;          // per task (or follow-up)
const MAX_CLIENT_BYTES = 500 * 1024 * 1024;
const MAX_TEXT_CHARS = 2_000_000;     // extracted Office text kept beside the file
const ALLOWED = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.txt', '.md', '.csv', '.tsv', '.json', '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp']);
const ZIP_PARTS = { '.docx': 'word/document.xml', '.xlsx': 'xl/workbook.xml', '.pptx': 'ppt/presentation.xml', '.odt': 'content.xml', '.ods': 'content.xml', '.odp': 'content.xml' };

/** Does the file's content match its name? */
function looksRight(file, ext) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(8192);
  const n = fs.readSync(fd, head, 0, head.length, 0);
  fs.closeSync(fd);
  const h = head.subarray(0, n);
  const starts = sig => h.subarray(0, sig.length).equals(Buffer.from(sig));
  switch (ext) {
    case '.pdf': return starts('%PDF-');
    case '.png': return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case '.jpg': case '.jpeg': return starts([0xff, 0xd8, 0xff]);
    case '.gif': return starts('GIF87a') || starts('GIF89a');
    case '.webp': return starts('RIFF') && h.subarray(8, 12).toString('latin1') === 'WEBP';
    case '.docx': case '.xlsx': case '.pptx': case '.odt': case '.ods': case '.odp': return starts([0x50, 0x4b, 0x03, 0x04]);
    default: return !h.includes(0) && !/^\s*<(!doctype|html|svg|script)/i.test(h.toString('utf8')); // plain text
  }
}

const uploadsDir = home => path.join(home, '.uploads');
function dirBytes(dir) {
  let total = 0;
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) total += fs.statSync(p).size; } };
  try { walk(dir); } catch {}
  return total;
}
/** Staged uploads nobody sent within a day are dropped. */
function sweepStaged(home) {
  const dir = uploadsDir(home);
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try { if (Date.now() - fs.statSync(p).mtimeMs > 86_400_000) fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
}

/** Stream one upload from the client's page into their staging folder. Returns { id, name, size, kind }. */
export async function stageUpload(ws, cid, req, rawName) {
  const home = ensureHome(ws, cid);
  sweepStaged(home);
  const name = cleanName(rawName);
  const ext = path.extname(name).toLowerCase();
  if (!ALLOWED.has(ext)) throw bad(`${ext ? `${ext} files` : 'Files without a type'} can’t be attached. Use PDF, images, text/CSV, Word, Excel or PowerPoint.`, 415);
  const declared = Number(req.headers['content-length'] || 0);
  const tooBig = `That file is over ${MAX_FILE / 1024 / 1024} MB.`;
  if (declared > MAX_FILE) throw bad(tooBig, 413);
  if (dirBytes(home) + declared > MAX_CLIENT_BYTES) throw bad(`Your file space is full. Ask ${ownerName()} to clear out old files.`, 507);
  const upId = crypto.randomBytes(9).toString('base64url');
  const dir = path.join(uploadsDir(home), upId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const out = fs.createWriteStream(file, { flags: 'wx' });
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_FILE) throw bad(tooBig, 413);
      if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
    }
    await new Promise((res, rej) => out.end(e => (e ? rej(e) : res())));
    if (!size) throw bad('That file is empty.');
    if (!looksRight(file, ext)) throw bad(`That doesn’t look like a real ${ext.slice(1).toUpperCase()} file.`, 415);
    if (ZIP_PARTS[ext]) { try { officeText(file, { probe: ZIP_PARTS[ext] }); } catch { throw bad(`That ${ext.slice(1).toUpperCase()} file couldn’t be opened.`, 415); } }
  } catch (e) {
    out.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return { id: upId, name, size, kind: kindOf(name) };
}

/**
 * Staged uploads (by id) moved into a task's files/ folder. Office files get their text beside them in
 * files/.text/, since the agent's Read tool can't open them. Returns paths relative to the client's folder.
 */
export function adoptUploads(ws, run, ids = []) {
  if (!ids.length) return [];
  if (ids.length > MAX_FILES) throw bad(`Up to ${MAX_FILES} files at a time.`);
  const home = clientHome(ws, run.client);
  const dest = path.join(home, 'Tasks', run.taskDir, 'files');
  fs.mkdirSync(dest, { recursive: true });
  return ids.map(upId => {
    if (!/^[A-Za-z0-9_-]{8,20}$/.test(String(upId))) throw bad('That file isn’t there any more. Attach it again.');
    const dir = path.join(uploadsDir(home), upId);
    const [name] = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    if (!name) throw bad('That file isn’t there any more. Attach it again.');
    const final = freeIn(dest, name);
    fs.renameSync(path.join(dir, name), path.join(dest, final));
    fs.rmSync(dir, { recursive: true, force: true });
    textBeside(dest, final);
    return `Tasks/${run.taskDir}/files/${final}`;
  });
}

/** Files from the owner's own Uploads copied into a client's task (the owner's reply on the client's task). */
export function copyIntoTask(ws, run, srcFiles = []) {
  if (!srcFiles.length) return [];
  const dest = path.join(clientHome(ws, run.client), 'Tasks', run.taskDir, 'files');
  fs.mkdirSync(dest, { recursive: true });
  return srcFiles.map(f => {
    const final = freeIn(dest, f.name);
    fs.copyFileSync(f.file, path.join(dest, final));
    textBeside(dest, final);
    return `Tasks/${run.taskDir}/files/${final}`;
  });
}

function freeIn(dir, name) {
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  let out = name;
  for (let n = 2; fs.existsSync(path.join(dir, out)); n++) out = `${stem} (${n})${ext}`;
  return out;
}

function textBeside(dir, name) {
  if (kindOf(name) !== 'office') return;
  try {
    const text = officeText(path.join(dir, name)).slice(0, MAX_TEXT_CHARS);
    fs.mkdirSync(path.join(dir, '.text'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.text', `${name}.txt`), text || '(no text in this file: maybe only images or charts)');
  } catch {}
}

/** How the agent hears about the files: their paths, and where an Office file's text is. */
export function filesNote(paths, who) {
  if (!paths.length) return '';
  const line = p => (kindOf(p) === 'office'
    ? `- \`${p}\` (its text: \`${path.posix.join(path.posix.dirname(p), '.text', `${path.posix.basename(p)}.txt`)}\`)`
    : `- \`${p}\``);
  return `\n\nFiles ${who} attached (in this folder; open them with Read):\n${paths.map(line).join('\n')}`;
}

// ── What's in a task's folder (for the client's page and the owner's run window) ──
export function taskRoot(ws, run) {
  if (!run?.taskDir) return null;
  return path.join(run.client ? clientHome(ws, run.client) : ws.dir, 'Tasks', run.taskDir);
}

/** Every file in the task's folder (no hidden ones), newest first. */
export function taskFiles(ws, run) {
  const root = taskRoot(ws, run);
  if (!root || !fs.existsSync(root)) return [];
  const out = [];
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (out.length >= 200 || e.name.startsWith('.')) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const st = fs.statSync(path.join(root, p));
        out.push({ path: p, name: e.name, size: st.size, kind: kindOf(e.name), at: st.mtime.toISOString(), uploaded: p.startsWith('files/') });
      }
    }
  };
  walk('');
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** A file inside the task's folder, or null: no climbing out, no hidden files, no links that lead elsewhere. */
export function taskFile(ws, run, rel) {
  const root = taskRoot(ws, run);
  const r = String(rel || '');
  if (!root || !r || r.includes('\0') || path.isAbsolute(r) || /^[A-Za-z]:/.test(r)) return null;
  const parts = r.split(/[\\/]+/);
  if (parts.some(s => !s || s === '.' || s === '..' || s.startsWith('.'))) return null;
  const file = path.join(root, ...parts);
  try {
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(file);
    if (!real.startsWith(realRoot + path.sep) || !fs.statSync(real).isFile()) return null;
    return real;
  } catch { return null; }
}

// only types that can't run script open in the browser tab; anything else downloads
const INLINE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8' };
/** Send a file from a task's folder. */
export function sendTaskFile(res, file, headers = {}) {
  const type = INLINE[path.extname(file).toLowerCase()];
  res.writeHead(200, {
    ...headers,
    'Content-Type': type || 'application/octet-stream', 'Content-Length': fs.statSync(file).size, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    'Content-Disposition': `${type ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
  });
  fs.createReadStream(file).pipe(res);
}

/** Removing a client can remove their corner too. */
export function removeHome(ws, cid) {
  fs.rmSync(clientHome(ws, cid), { recursive: true, force: true });
}
