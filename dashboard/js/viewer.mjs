// The file viewer: one window that shows what agents made (artifacts) and what the owner attached (uploads),
// drawn 1-bit. A renderer per kind: image / video / audio (viewers/media.mjs), pdf (viewers/pdf.mjs, a vendored
// pdf.js), markdown (util.mjs#md, the same sanitizer as the chat), text/code/json, csv, Office (the server's
// /preview: docx as sanitized HTML, xlsx as tables, pptx as slide cards, odf as text), HTML in a sandboxed iframe
// (no scripts, no same origin), click-to-load players for YouTube/Vimeo/Loom/Drive links, and a "can't preview" state.
// Every failure is a clear state with Retry; nothing is ever a blank panel.
// The client page (client.mjs) uses this same code: configureViewer({base, client}) + mountViewer(el, …).
import { openWindow, getWindow } from './windows.mjs';
import { icon } from './pixel.mjs';
import { esc, api, md, cleanHTML, wsName, wsClass, agentName, dateTime } from './util.mjs';
import { imageView, videoView, audioView } from './viewers/media.mjs';

export const fsize = n => (n == null ? '' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : n < 1024 ** 3 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);

// the server's kinds (artifacts.mjs#kindFor), for uploads that come without one
const EXT = {};
for (const [k, list] of Object.entries({
  image: 'png jpg jpeg gif webp avif bmp ico svg heic heif tif tiff psd dng', pdf: 'pdf', video: 'mp4 m4v webm mov mkv avi wmv flv mpg mpeg 3gp ts m2ts mts ogv',
  audio: 'mp3 wav ogg oga opus m4a aac flac wma aif aiff', markdown: 'md markdown mdx', json: 'json geojson ipynb', csv: 'csv tsv', sheet: 'xlsx ods', doc: 'docx odt', slides: 'pptx odp', html: 'html htm',
  code: 'js mjs cjs ts tsx jsx py rb go rs java kt swift c h cc cpp hpp cs php sh bash zsh ps1 psm1 bat cmd sql css scss less vue svelte lua r pl yaml yml toml xml ini cfg conf',
  text: 'txt log text rtf srt vtt jsonl ndjson tex rst adoc org',
})) for (const e of list.split(' ')) EXT[e] = k;
const extOf = name => (String(name || '').match(/\.([^./\\]+)$/)?.[1] || '').toLowerCase();
export const kindFor = name => EXT[extOf(name)] || 'other';
export const kindIcon = k => ({ image: 'image', video: 'video', audio: 'note', pdf: 'pdf', csv: 'table', sheet: 'table', code: 'code', json: 'code', html: 'code', embed: 'film', other: 'file' }[k] || 'doc');

// Where artifacts come from: the owner's dashboard (/api/artifacts), or a client's page (/c/<link>/api/artifacts),
// where records are scrubbed (no workspace, paths relative to the client's folder) and video/audio play from R2
// through a short-lived link the portal mints (`remotePlay`), never from this PC.
const CFG = { base: '/api/artifacts', client: false };
export function configureViewer(o) { Object.assign(CFG, o); }
const STREAMED = new Set(['video', 'audio']);

/** What the viewer needs to know about an artifact (the server's public record). */
export function fromArtifact(a) {
  const base = `${CFG.base}/${encodeURIComponent(a.id)}`;
  const remote = CFG.client && STREAMED.has(a.kind);
  return {
    key: a.id, id: a.id, isArtifact: true, name: a.name, kind: a.kind, ext: a.ext || extOf(a.name), size: a.size, version: a.version, status: a.status,
    workspace: a.workspace, agentSlug: a.agentSlug, agentName: a.agentName, updatedAt: a.updatedAt, rel: a.rel, media: a.media || null, runId: a.runId || null, video: a.video || null,
    raw: `${base}/raw?v=${a.version}`, preview: `${base}/preview?v=${a.version}`, download: remote ? null : `${base}/raw?download=1`, mediaURL: what => `${base}/media/${what}?v=${a.version}`,
    ...(remote && { remotePlay: () => api(`${base}/play`) }),
  };
}
/** A file the owner gave Orchy (Uploads). */
export function fromUpload(u) {
  const raw = `/api/uploads/${encodeURIComponent(u.name)}`;
  return { key: `upload:${u.name}`, isArtifact: false, name: u.name, kind: kindFor(u.name), ext: extOf(u.name), size: u.size, raw, preview: `${raw}/preview`, download: raw, media: null, mediaURL: () => raw };
}
/** A link the dashboard may play in place (click to load): YouTube (nocookie), Vimeo, Loom, Google Drive file previews. */
export function embedOf(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const h = u.hostname.replace(/^www\.|^m\./, '');
  const id = s => (/^[\w-]{6,80}$/.test(s || '') ? s : null);
  let src = null, host = null;
  if (h === 'youtube.com' || h === 'youtu.be') {
    const v = h === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v') || u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]+)/)?.[1];
    if (id(v)) { src = `https://www.youtube-nocookie.com/embed/${v}`; host = 'youtube-nocookie.com'; }
  } else if (h === 'vimeo.com' || h === 'player.vimeo.com') {
    const v = u.pathname.match(/(?:^|\/)(\d{5,12})(?:\/|$)/)?.[1];
    if (v) { src = `https://player.vimeo.com/video/${v}`; host = 'player.vimeo.com'; }
  } else if (h === 'loom.com') {
    const v = u.pathname.match(/^\/(?:share|embed)\/([0-9a-f]{16,64})/)?.[1];
    if (v) { src = `https://www.loom.com/embed/${v}`; host = 'loom.com'; }
  } else if (h === 'drive.google.com') {
    const v = u.pathname.match(/^\/file\/d\/([\w-]{10,120})/)?.[1];
    if (v) { src = `https://drive.google.com/file/d/${v}/preview`; host = 'drive.google.com'; }
  }
  return src ? { key: `embed:${src}`, isArtifact: false, kind: 'embed', name: `${host} video`, src, host, url } : null;
}

// ── states ──
export const stateHTML = (title, text = '', { retry = false, download = null, name = '' } = {}) => `<div class="empty vstate"><strong>${esc(title)}</strong>${text ? `<span>${esc(text)}</span>` : ''}${retry || download ? `<div class="btnrow">${retry ? `<button class="btn sm" data-retry>${icon('refresh')}Retry</button>` : ''}${download ? `<a class="btn sm" href="${esc(download)}" download="${esc(name)}">${icon('download')}Download</a>` : ''}</div>` : ''}</div>`;
export const loadingHTML = (text = 'Opening…') => `<div class="vpending"><span class="label blink">${esc(text)}</span></div>`;
async function previewOf(s) {
  const res = await fetch(s.preview);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Couldn’t open it (${res.status})`), { status: res.status });
  return data;
}
const noteHTML = p => (p.truncated || p.note ? `<p class="hint vnote">${esc([p.truncated ? 'Cut short: showing the start' : '', p.note || ''].filter(Boolean).join(' · '))}</p>` : '');

// ── the text kinds ──
const MAX_LINES = 20000;
function codeHTML(text) {
  const lines = String(text).replace(/\r?\n$/, '').split(/\r?\n/);
  return { html: `<div class="vcode" data-code><ol>${lines.slice(0, MAX_LINES).map(l => `<li>${esc(l) || ' '}</li>`).join('')}</ol></div>`, count: lines.length };
}
async function textView(stage, s) {
  const p = await previewOf(s);
  const { html, count } = codeHTML(p.text || '');
  stage.innerHTML = `<div class="vtools"><span class="label">${count.toLocaleString()} line${count === 1 ? '' : 's'}${p.pretty ? ' · pretty JSON' : ''}</span><button class="btn sm" data-wrap aria-pressed="false">Wrap</button></div>${html}${noteHTML({ ...p, truncated: p.truncated || count > MAX_LINES })}`;
  const b = stage.querySelector('[data-wrap]');
  b.addEventListener('click', () => { const on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(on)); stage.querySelector('[data-code]').classList.toggle('wrap', on); });
}

/** A path inside the workspace that a markdown image points at (relative to the file), or null. */
function joinRel(fromRel, src) {
  if (/^[a-z][\w+.-]*:|^\/\//i.test(src)) return null;
  const parts = String(fromRel || '').split('/').slice(0, -1);
  for (const seg of decodeURIComponent(src.split(/[?#]/)[0]).replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(seg);
  }
  return parts.join('/');
}
async function markdownView(stage, s, ctx) {
  const p = await previewOf(s);
  let text = p.text || '';
  // relative pictures load from the artifact's raw route when they're registered in the same workspace, otherwise not at all
  const refs = [...text.matchAll(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g)];
  let known = new Map();
  if (s.isArtifact && refs.some(m => !/^(https?:|data:)/i.test(m[2]))) {
    // a client's page only knows its own task's files
    const q = CFG.client ? (s.runId ? `?run=${encodeURIComponent(s.runId)}` : null) : `?workspace=${encodeURIComponent(s.workspace)}&kind=image&limit=1000`;
    try { if (q) known = new Map((await api(`${CFG.base}${q}`)).artifacts.filter(a => a.kind === 'image').map(a => [a.rel.toLowerCase(), a])); } catch {}
  }
  text = text.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g, (m, alt, src) => {
    if (/^https?:/i.test(src)) return m; // md() keeps only this page's own images anyway
    const a = known.get(String(joinRel(s.rel, src) || '').toLowerCase());
    return a ? `![${alt}](${CFG.base}/${encodeURIComponent(a.id)}/raw?v=${a.version})` : `*[picture: ${alt || src}]*`;
  });
  stage.innerHTML = `<div class="vdoc md">${md(text)}</div>${noteHTML(p)}`;
  const own = `${new URL(CFG.base, location.href).pathname}/`;
  for (const img of stage.querySelectorAll('img')) {
    const path = new URL(img.src, location.href).pathname;
    if (!path.startsWith(own) && (CFG.client || !path.startsWith('/api/uploads/'))) img.replaceWith(document.createTextNode(`[picture: ${img.alt || ''}]`));
  }
}

const tableHTML = rows => {
  if (!rows?.length) return '<p class="hint">No rows.</p>';
  const width = Math.max(...rows.map(r => r.length));
  const cells = (r, tag) => Array.from({ length: width }, (_, i) => `<${tag}>${esc(r[i] ?? '')}</${tag}>`).join('');
  return `<div class="vtable"><table><thead><tr><th class="n"></th>${cells(rows[0], 'th')}</tr></thead><tbody>${rows.slice(1).map((r, i) => `<tr><td class="n">${i + 2}</td>${cells(r, 'td')}</tr>`).join('')}</tbody></table></div>`;
};
async function csvView(stage, s) {
  const p = await previewOf(s);
  stage.innerHTML = `<div class="vtools"><span class="label">${(p.rows?.length || 0).toLocaleString()} rows</span></div>${tableHTML(p.rows)}${noteHTML(p)}`;
}
async function officeView(stage, s) {
  const p = await previewOf(s);
  if (p.type === 'sheets') {
    const show = i => {
      stage.innerHTML = `${p.sheets.length > 1 ? `<div class="vtools"><span class="seg" role="tablist">${p.sheets.map((sh, j) => `<button role="tab" data-sheet="${j}" aria-pressed="${j === i}">${esc(sh.name)}</button>`).join('')}</span></div>` : `<div class="vtools"><span class="label">${esc(p.sheets[0]?.name || 'Sheet')}</span></div>`}${p.sheets[i] ? tableHTML(p.sheets[i].rows) : '<p class="hint">No sheets.</p>'}${noteHTML(p)}`;
      stage.querySelectorAll('[data-sheet]').forEach(b => b.addEventListener('click', () => show(Number(b.dataset.sheet))));
    };
    return show(0);
  }
  if (p.type === 'slides') {
    stage.innerHTML = `<div class="vslides">${p.slides.map(sl => `<section class="vslide"><span class="label">Slide ${sl.n}</span><p>${esc(sl.text || '(no text on this slide)').replace(/\n/g, '<br>')}</p>${sl.notes ? `<p class="hint">Notes: ${esc(sl.notes)}</p>` : ''}</section>`).join('') || '<p class="hint">No slides.</p>'}</div>${noteHTML(p)}`;
    return;
  }
  if (p.type === 'html') {
    stage.innerHTML = `<div class="vdoc md">${cleanHTML(p.html, { dataImages: true })}</div><p class="hint vnote">Layout simplified; download it for the real thing.</p>`;
    return;
  }
  const { html } = codeHTML(p.text || '');
  stage.innerHTML = `<div class="vtools"><span class="label">Text only: layout not shown</span></div>${html}${noteHTML({ ...p, note: '' })}`;
}
async function htmlView(stage, s) {
  const page = s.isArtifact;
  const show = mode => {
    stage.innerHTML = `<div class="vtools"><span class="plate">Scripts off</span>${page ? `<span class="seg"><button data-mode="page" aria-pressed="${mode === 'page'}">Page</button><button data-mode="source" aria-pressed="${mode === 'source'}">Source</button></span>` : ''}</div>
      ${mode === 'page' ? `<iframe class="vframe" sandbox="" referrerpolicy="no-referrer" src="${esc(s.raw)}" title="${esc(s.name)}"></iframe>` : '<div data-src></div>'}`;
    stage.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => show(b.dataset.mode)));
    if (mode === 'source') previewOf(s).then(p => { const el = stage.querySelector('[data-src]'); if (el) el.outerHTML = codeHTML(p.text || '').html + noteHTML(p); }).catch(e => { const el = stage.querySelector('[data-src]'); if (el) el.outerHTML = stateHTML('Couldn’t open the source', e.message); });
  };
  show(page ? 'page' : 'source');
}
function embedView(stage, s) {
  stage.innerHTML = `<div class="vembed"><div class="empty"><strong>${esc(s.host)}</strong><span>Plays from ${esc(s.host)} once you load it: nothing is fetched until then.</span><div class="btnrow"><button class="btn sm primary" data-load>${icon('play')}Load the player</button><a class="btn sm" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${icon('popout')}Open the link</a></div></div></div>`;
  stage.querySelector('[data-load]').addEventListener('click', () => {
    stage.querySelector('.vembed').innerHTML = `<iframe class="vframe video" src="${esc(s.src)}" title="${esc(s.name)}" allow="fullscreen; picture-in-picture; encrypted-media" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"></iframe>`;
  });
}
function otherView(stage, s) {
  stage.innerHTML = stateHTML('Can’t preview this type', `${s.ext ? `.${s.ext} files` : 'Files like this'} open in the program they belong to.`, { download: s.download, name: s.name });
}
const pdfView = (stage, s, ctx) => import('./viewers/pdf.mjs').then(m => m.pdfView(stage, s, ctx));

const RENDER = { image: imageView, video: videoView, audio: audioView, pdf: pdfView, markdown: markdownView, text: textView, code: textView, json: textView, csv: csvView, sheet: officeView, doc: officeView, slides: officeView, html: htmlView, embed: embedView, other: otherView };

// ── the window ──
const STATUS = { draft: ['chip', 'Draft'], final: ['plate', 'Final'], failed: ['chip', 'Run failed'], missing: ['chip dashed', 'Missing'] };
function headHTML(s, v) {
  const n = v.items.length;
  const st = STATUS[s.status];
  const who = CFG.client && s.isArtifact ? `<span>${esc(s.agentName || 'Your agent')}</span>`
    : s.isArtifact ? `<span class="plate ${wsClass(s.workspace)}">${esc(wsName(s.workspace))}</span><span>${esc(agentName(s.workspace, s.agentSlug, s.agentName || 'Generalist'))}</span>` : s.kind === 'embed' ? '<span>Link</span>' : '<span>You attached it</span>';
  const meta = [who, s.version ? `<span class="px">v${s.version}</span>` : '', st ? `<span class="${st[0]}">${st[1]}</span>` : '', s.size != null ? `<span>${fsize(s.size)}</span>` : '', s.updatedAt ? `<span>${dateTime(s.updatedAt)}</span>` : ''].filter(Boolean).join('<i class="vdot" aria-hidden="true"></i>');
  return `<div class="vhead">
    <div class="vtitle"><b title="${esc(s.rel || s.name)}">${icon(kindIcon(s.kind))}<span>${esc(s.name)}</span></b><span class="vmeta">${meta}</span></div>
    <div class="btnrow vbtns">
      ${n > 1 ? `<span class="vnav"><button class="btn sm icon" data-v="prev" aria-label="Previous file" ${v.i === 0 ? 'disabled' : ''}>${icon('left')}</button><span class="px">${v.i + 1}/${n}</span><button class="btn sm icon" data-v="next" aria-label="Next file" ${v.i === n - 1 ? 'disabled' : ''}>${icon('right')}</button></span>` : ''}
      ${s.kind === 'embed' || !s.download ? '' : `<a class="btn sm" href="${esc(s.download)}" download="${esc(s.name)}">${icon('download')}Download</a>`}
      <button class="btn sm vlarge" data-v="large">${icon(v.w.popped ? 'popin' : 'popout')}${v.w.popped ? 'Back in' : 'Open large'}</button>
    </div></div>`;
}

function show(v) {
  v.cleanup?.();
  v.cleanup = null;
  v.keys = null;
  const s = v.items[v.i];
  v.w.setTitle(s.name);
  v.root.dataset.kind = s.kind;
  v.root.innerHTML = `${headHTML(s, v)}<div class="vstage" data-stage></div>`;
  v.root.querySelector('[data-v="prev"]')?.addEventListener('click', () => go(v, v.i - 1));
  v.root.querySelector('[data-v="next"]')?.addEventListener('click', () => go(v, v.i + 1));
  v.root.querySelector('[data-v="large"]').addEventListener('click', () => { if (v.w.popped) v.w.popIn(); else v.w.popOut(); setTimeout(() => { const b = v.root.querySelector('[data-v="large"]'); if (b) b.innerHTML = `${icon(v.w.popped ? 'popin' : 'popout')}${v.w.popped ? 'Back in' : 'Open large'}`; }, 300); });
  stage(v);
}
async function stage(v) {
  const el = v.root.querySelector('[data-stage]');
  const s = v.items[v.i];
  const token = (v.token = {});
  const ctx = {
    items: v.items, index: v.i, go: i => go(v, i), live: () => v.token === token,
    setKeys: fn => { if (v.token === token) v.keys = fn; }, rerender: () => v.token === token && stage(v),
  };
  el.innerHTML = loadingHTML();
  if (s.isArtifact && s.status === 'missing') { el.innerHTML = stateHTML('That file isn’t there any more', 'It was moved or deleted after the agent made it.', { retry: true }); el.querySelector('[data-retry]').addEventListener('click', () => refresh(v)); return; }
  try {
    const done = await (RENDER[s.kind] || otherView)(el, s, ctx);
    if (v.token !== token) { if (typeof done === 'function') done(); return; }
    v.cleanup = typeof done === 'function' ? done : null;
  } catch (e) {
    if (v.token !== token) return;
    el.innerHTML = e.status === 415 ? stateHTML('Can’t preview this one', e.message, { download: s.download, name: s.name }) : stateHTML('Couldn’t open it', e.message || 'The file didn’t load.', { retry: true, download: s.isArtifact || s.kind !== 'embed' ? s.download : null, name: s.name });
    el.querySelector('[data-retry]')?.addEventListener('click', () => refresh(v));
  }
}
/** Ask the server again (a gone file comes back, a changed one gets its new version). */
async function refresh(v) {
  const s = v.items[v.i];
  if (s.isArtifact) { try { const { artifact } = await api(`${CFG.base}/${encodeURIComponent(s.id)}`); v.items[v.i] = fromArtifact(artifact); } catch {} }
  show(v);
}
function go(v, i) {
  if (i < 0 || i >= v.items.length || i === v.i) return;
  v.i = i;
  show(v);
  v.root.focus({ preventScroll: true });
}

/**
 * Open the viewer on a file: { artifact } (a record from /api/artifacts), { upload } ({name, size}), or { embed } (a URL),
 * with `list` (records of the same kind of source) for prev/next and the gallery strip. One viewer window; it takes
 * the place of the window it was opened from (windows.mjs, Back returns).
 */
export function openViewer({ artifact = null, upload = null, embed = null, list = null, from = null } = {}) {
  const norm = x => (x?.kind === 'embed' ? x : typeof x === 'string' ? embedOf(x) : x?.id ? fromArtifact(x) : x?.name ? fromUpload(x) : null);
  const first = norm(artifact || upload || (embed && (typeof embed === 'string' ? embedOf(embed) : embed)));
  if (!first) return null;
  const items = (list?.length ? list.map(norm).filter(Boolean) : [first]);
  let i = items.findIndex(s => s.key === first.key);
  if (i < 0) { items.unshift(first); i = 0; }
  const existing = getWindow('viewer');
  const root = existing?.viewer?.root || Object.assign(document.createElement('div'), { className: 'viewer', tabIndex: -1 });
  const w = openWindow({ id: 'viewer', title: first.name, size: 'wide', body: root, from, dockLabel: 'Viewer', onClose: () => { w.viewer?.cleanup?.(); w.viewer = null; } });
  if (!w.viewer) {
    w.viewer = { w, root, items, i, cleanup: null, keys: null };
    root.addEventListener('keydown', e => onKey(w.viewer, e));
  } else Object.assign(w.viewer, { items, i });
  show(w.viewer);
  setTimeout(() => root.focus({ preventScroll: true }), 200);
  return w;
}
function onKey(v, e) {
  if (!v || e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (v.keys?.(e)) { e.preventDefault(); return; }
  if (e.key === 'ArrowLeft' && v.i > 0) { e.preventDefault(); go(v, v.i - 1); }
  if (e.key === 'ArrowRight' && v.i < v.items.length - 1) { e.preventDefault(); go(v, v.i + 1); }
}

/**
 * The viewer drawn into an element the page owns (a client page's sheet) instead of a window.
 * `frame` stands in for the window: { setTitle(t), popped, popOut(), popIn() } (Open large). Returns { close }.
 */
let mounted = null;
export function mountViewer(root, { artifact, list = null, frame, focus = true }) {
  const first = fromArtifact(artifact);
  const items = list?.length ? list.map(fromArtifact) : [first];
  let i = items.findIndex(s => s.key === first.key);
  if (i < 0) { items.unshift(first); i = 0; }
  if (mounted) { mounted.cleanup?.(); mounted.token = {}; }
  root.classList.add('viewer');
  root.tabIndex = -1;
  const v = (mounted = { w: frame, root, items, i, cleanup: null, keys: null });
  if (!root.dataset.viewerKeys) { root.dataset.viewerKeys = '1'; root.addEventListener('keydown', e => onKey(mounted?.root === root ? mounted : null, e)); }
  show(v);
  if (focus) setTimeout(() => root.focus({ preventScroll: true }), 50); // the Live view mounts it without taking focus
  return { close: () => { v.cleanup?.(); v.cleanup = null; v.token = {}; if (mounted === v) mounted = null; root.innerHTML = ''; } };
}

/** artifact.created / artifact.updated from the stream: the open viewer follows a new version or media state. */
export function artifactChanged(a) {
  if (!a?.id) return;
  for (const v of [getWindow('viewer')?.viewer, mounted]) if (v) follow(v, a);
}
function follow(v, a) {
  const idx = v.items.findIndex(s => s.id === a.id);
  if (idx < 0) return;
  const before = v.items[idx];
  const after = fromArtifact(a);
  v.items[idx] = after;
  if (idx !== v.i) return;
  const m0 = before.media || {}, m1 = after.media || {};
  if (before.version !== after.version || before.status !== after.status) return show(v);
  const shape = (m, s) => [m.state, m.play, m.poster, m.thumb, m.fit, m.preview, s.video?.state].join('|');
  if (shape(m0, before) !== shape(m1, after)) return stage(v);
  if (m1.progress !== m0.progress) v.root.querySelectorAll('[data-progress]').forEach(el => { el.textContent = `${m1.progress ?? 0}%`; });
}
