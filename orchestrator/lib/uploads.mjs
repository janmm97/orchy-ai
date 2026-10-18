// Files the owner gives Orchy: saved as-is in the Uploads folder, then reviewed by Orchy in the chat.
// Orchy reads them with Claude Code's Read tool (text, PDFs, images) from a process whose working
// directory is Uploads, so that is the only folder he can open. Office files are zips Read can't
// open: their text is pulled out here and put in the prompt.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT, ownerName } from './env.mjs';

export const UPLOADS_DIR = path.join(ROOT, 'Uploads');
export const MAX_UPLOAD = 50 * 1024 * 1024;
const MAX_INLINE = 60_000; // characters of extracted Office text per file

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const OFFICE = new Set(['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp']);
const TEXT = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.html', '.htm', '.css', '.js', '.mjs', '.ts', '.py', '.yaml', '.yml', '.log', '.ini', '.sql', '.eml', '.rtf', '.ipynb']);

/** How Orchy can open a file: image | pdf | text | office | other. */
export function kindOf(name) {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (OFFICE.has(ext)) return 'office';
  if (TEXT.has(ext)) return 'text';
  return 'other';
}

/** A safe file name, kept close to the owner's original. */
export function cleanName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/')).normalize('NFC');
  const clean = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 150);
  const out = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(clean) || !clean ? `upload${path.extname(clean)}` : clean;
  return out.replace(/\.(part)$/i, '_$1'); // ".part" is an upload still on its way in (uploadInfo)
}

/** "report.pdf" → "report (2).pdf" when Uploads already has one (or one is still arriving). */
function freeName(name, dir = UPLOADS_DIR) {
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  let n = 1, out = name;
  while (fs.existsSync(path.join(dir, out)) || fs.existsSync(path.join(dir, `${out}.part`))) out = `${stem} (${++n})${ext}`;
  return out;
}

/**
 * Files the owner attached to an agent's task (already in the Uploads folder): copied into <workspace>/Uploads,
 * inside the agent's own folder, so it opens them without asking. The same file attached again is
 * reused, not copied twice. Returns their paths relative to the workspace folder.
 */
export function handToWorkspace(ws, names = []) {
  if (!Array.isArray(names) || !names.length) return [];
  if (names.length > 10) throw Object.assign(new Error('Up to 10 files per task'), { status: 400 });
  const infos = names.map(n => uploadInfo(n) || (() => { throw Object.assign(new Error(`"${n}" isn't in Uploads any more; attach it again`), { status: 400 }); })());
  const dir = path.join(ws.dir, 'Uploads');
  fs.mkdirSync(dir, { recursive: true });
  return infos.map(u => {
    const ext = path.extname(u.name), stem = u.name.slice(0, u.name.length - ext.length);
    const src = fs.readFileSync(u.file);
    for (let n = 1; ; n++) {
      const name = n === 1 ? u.name : `${stem} (${n})${ext}`, dest = path.join(dir, name);
      if (!fs.existsSync(dest)) { fs.writeFileSync(dest, src); return `Uploads/${name}`; }
      if (fs.statSync(dest).size === u.size && fs.readFileSync(dest).equals(src)) return `Uploads/${name}`;
    }
  });
}

/** The task as the agent reads it: the owner's words plus where the attached files are. */
export function withFiles(text, paths) {
  if (!paths.length) return text;
  const list = paths.map(p => `- \`${p}\``).join('\n');
  return `${text || 'Have a look at the attached files.'}\n\nFiles ${ownerName()} attached (in this workspace folder; open them with Read):\n${list}`;
}

/** Stream a request body into Uploads. Returns the file's info. */
export async function saveUpload(req, rawName) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_UPLOAD) throw Object.assign(new Error(`That file is over ${MAX_UPLOAD / 1024 / 1024} MB`), { status: 413 });
  const name = freeName(cleanName(rawName));
  const file = path.join(UPLOADS_DIR, name);
  const tmp = `${file}.part`;
  const out = fs.createWriteStream(tmp, { fd: fs.openSync(tmp, 'wx') }); // never another upload's .part
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_UPLOAD) throw Object.assign(new Error(`That file is over ${MAX_UPLOAD / 1024 / 1024} MB`), { status: 413 });
      if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
    }
    await new Promise((res, rej) => out.end(e => (e ? rej(e) : res())));
    if (!size) throw Object.assign(new Error('That file is empty'), { status: 400 });
    fs.renameSync(tmp, file);
  } catch (e) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return uploadInfo(name);
}

/** An uploaded file by name (only files directly in Uploads), or null. */
export function uploadInfo(name) {
  const clean = path.basename(String(name || ''));
  if (!clean || clean !== name || /\.part$/i.test(clean)) return null;
  const file = path.join(UPLOADS_DIR, clean);
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile()) return null;
  return { name: clean, size: st.size, kind: kindOf(clean), file };
}

export const publicUpload = ({ file, ...u }) => u;

// ── Office files: a minimal zip reader (no dependencies) and the text inside ──
// Bounded, so a crafted file (a "zip bomb") can't eat the PC's memory: few entries, and only so much unpacked.
const ZIP_MAX_ENTRIES = 5000;
const ZIP_MAX_ENTRY = 40 * 1024 * 1024;   // bytes one part may unpack to
const ZIP_MAX_TOTAL = 120 * 1024 * 1024;  // bytes the whole file may unpack to
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  if (count > ZIP_MAX_ENTRIES) throw new Error('too many parts');
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  let unpacked = 0;
  for (let i = 0; i < count && p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen).replace(/\\/g, '/'); // some Windows zippers write backslashes
    entries.set(name, () => {
      if (local + 30 > buf.length) throw new Error('broken zip');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      if (start + csize > buf.length) throw new Error('broken zip');
      const data = buf.subarray(start, start + csize);
      const room = Math.min(ZIP_MAX_ENTRY, ZIP_MAX_TOTAL - unpacked);
      if (room <= 0) throw new Error('unpacks too large');
      const out = method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: room }) : data;
      if (out.length > room) throw new Error('unpacks too large');
      unpacked += out.length;
      return out.toString('utf8');
    });
    p += 46 + nlen + xlen + clen;
  }
  return entries;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = s => s.replace(/<[^>]+>/g, '').replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? m));
const tidy = s => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const numbered = (zip, re) => [...zip.keys()].filter(k => re.test(k)).sort((a, b) => Number(a.match(/(\d+)\.xml$/)?.[1] || 0) - Number(b.match(/(\d+)\.xml$/)?.[1] || 0));

function docxText(zip) {
  const parts = ['word/document.xml', ...numbered(zip, /^word\/(header|footer)\d*\.xml$/), 'word/footnotes.xml'].filter(k => zip.has(k));
  return tidy(parts.map(k => unxml(zip.get(k)().replace(/<w:tab\/>/g, '\t').replace(/<\/w:p>/g, '\n').replace(/<w:br\/>/g, '\n'))).join('\n\n'));
}

function xlsxText(zip) {
  const shared = zip.has('xl/sharedStrings.xml') ? [...zip.get('xl/sharedStrings.xml')().matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => unxml(m[1])) : [];
  const names = zip.has('xl/workbook.xml') ? [...zip.get('xl/workbook.xml')().matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map(m => unxml(m[1])) : [];
  return tidy(numbered(zip, /^xl\/worksheets\/sheet\d+\.xml$/).map((k, i) => {
    const rows = [...zip.get(k)().matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(r => [...r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(c => {
      const type = c[1].match(/\bt="(\w+)"/)?.[1];
      const v = c[2]?.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      if (type === 's') return shared[Number(v)] ?? '';
      if (type === 'inlineStr') return unxml(c[2]?.match(/<is>([\s\S]*?)<\/is>/)?.[1] || '');
      return v != null ? unxml(v) : '';
    }).join('\t')).filter(r => r.trim());
    return `## Sheet: ${names[i] || `Sheet ${i + 1}`}\n${rows.join('\n')}`;
  }).join('\n\n'));
}

function pptxText(zip) {
  return tidy(numbered(zip, /^ppt\/slides\/slide\d+\.xml$/).map((k, i) => {
    const notes = zip.get(`ppt/notesSlides/notesSlide${k.match(/(\d+)\.xml$/)[1]}.xml`);
    const text = x => unxml(x.replace(/<\/a:p>/g, '\n'));
    return `## Slide ${i + 1}\n${text(zip.get(k)())}${notes ? `\nSpeaker notes: ${text(notes()).replace(/\s+/g, ' ').trim()}` : ''}`;
  }).join('\n\n'));
}

// ── Office files as tables and slides, for previews (no dependency: the same small zip reader as above) ──
const colIndex = ref => { let n = 0; for (const ch of String(ref).replace(/\d+$/, '').toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

/** The sheets of an .xlsx: [{ name, rows: [[cell…]], truncated }], values as Excel stores them (dates stay serials). */
export function xlsxSheets(file, { maxRows = 1000, maxCols = 200, maxSheets = 20 } = {}) {
  const zip = unzip(fs.readFileSync(file));
  const shared = zip.has('xl/sharedStrings.xml') ? [...zip.get('xl/sharedStrings.xml')().matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => unxml(m[1])) : [];
  const names = zip.has('xl/workbook.xml') ? [...zip.get('xl/workbook.xml')().matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map(m => unxml(m[1])) : [];
  return numbered(zip, /^xl\/worksheets\/sheet\d+\.xml$/).slice(0, maxSheets).map((k, i) => {
    const rows = [];
    let truncated = false;
    for (const r of zip.get(k)().matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= maxRows) { truncated = true; break; }
      const row = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const at = c[1].match(/\br="([A-Z]+\d+)"/)?.[1];
        const col = at ? colIndex(at) : row.length;
        if (col < 0 || col >= maxCols) { if (col >= maxCols) truncated = true; continue; }
        const type = c[1].match(/\bt="(\w+)"/)?.[1];
        const v = c[2]?.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        const val = type === 's' ? shared[Number(v)] ?? '' : type === 'inlineStr' ? unxml(c[2]?.match(/<is>([\s\S]*?)<\/is>/)?.[1] || '') : type === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : v != null ? unxml(v) : '';
        while (row.length < col) row.push('');
        row[col] = val.slice(0, 2000);
      }
      rows.push(row);
    }
    while (rows.length && rows.at(-1).every(v => !v)) rows.pop();
    return { name: names[i] || `Sheet ${i + 1}`, rows, truncated };
  });
}

/** The slides of a .pptx: [{ n, text, notes }]. */
export function pptxSlides(file) {
  const zip = unzip(fs.readFileSync(file));
  const text = x => tidy(unxml(x.replace(/<\/a:p>/g, '\n')));
  return numbered(zip, /^ppt\/slides\/slide\d+\.xml$/).map((k, i) => {
    const notes = zip.get(`ppt/notesSlides/notesSlide${k.match(/(\d+)\.xml$/)[1]}.xml`);
    return { n: i + 1, text: text(zip.get(k)()), notes: notes ? text(notes()).replace(/\s+/g, ' ').trim() : '' };
  });
}

function odfText(zip) {
  return zip.has('content.xml') ? tidy(unxml(zip.get('content.xml')().replace(/<\/text:(p|h)>/g, '\n').replace(/<text:tab\/>/g, '\t').replace(/<\/table:table-cell>/g, '\t').replace(/<\/table:table-row>/g, '\n'))) : '';
}

/** The text inside a Word, Excel, PowerPoint or OpenDocument file. `probe`: only check that part opens. */
export function officeText(file, { probe } = {}) {
  const zip = unzip(fs.readFileSync(file));
  if (probe) { if (!zip.has(probe)) throw new Error(`no ${probe}`); zip.get(probe)(); return ''; }
  const ext = path.extname(file).toLowerCase();
  return ext === '.docx' ? docxText(zip) : ext === '.xlsx' ? xlsxText(zip) : ext === '.pptx' ? pptxText(zip) : odfText(zip);
}

const kb = n => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** What Orchy is told about the files the owner just attached. */
export function filesBrief(files) {
  const how = {
    image: 'an image: open it with Read and look at it',
    pdf: 'a PDF: open it with Read (for a long one, read it in page ranges with the pages parameter)',
    text: 'a text file: open it with Read',
    other: 'a file type you can\'t open; say so and describe what you can from its name and size',
  };
  return files.map(f => {
    const head = `- "${f.name}" (${kb(f.size)}): `;
    if (f.kind !== 'office') return head + how[f.kind];
    let text = '';
    try { text = officeText(f.file); } catch (e) { return `${head}an Office file I couldn't unpack (${e.message}); say so`; }
    if (!text) return `${head}an Office file with no text in it (maybe only images or charts)`;
    const cut = text.length > MAX_INLINE;
    return `${head}a ${path.extname(f.name).slice(1).toUpperCase()} file. Its text is below${cut ? ` (the first ${MAX_INLINE.toLocaleString()} of ${text.length.toLocaleString()} characters)` : ''}: work from it and don't try Read on it or mention how you got it (images and charts inside aren't included; say so only if it matters):\n<file name="${f.name}">\n${cut ? text.slice(0, MAX_INLINE) : text}\n</file>`;
  }).join('\n');
}
