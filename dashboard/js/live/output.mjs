// Live view, right column: the deliverables the selected run (with its hand-offs), huddle (with its approved work) or
// mission (every step) made, as a gallery of tiles. Only what the owner would hand to someone counts:
// videos, images, PDFs, Word documents, slides, spreadsheets and audio; notes, data and scripts stay in the task
// folder. A tile opens the big viewer on that file, with the gallery as its prev/next list. With nothing to show the
// column steps aside and Work takes the room; the first deliverable wipes it back in.
import { icon } from '../pixel.mjs';
import { esc, api, agentName } from '../util.mjs';
import { openViewer, fromArtifact, kindIcon, fsize } from '../viewer.mjs';
import { S, selKey, isPreview } from './model.mjs';

export const DELIVERABLE = new Set(['video', 'image', 'pdf', 'doc', 'slides', 'sheet', 'audio']);
const isDeliverable = a => DELIVERABLE.has(a?.kind);

const runIdsOf = sel => {
  const { state } = S.ctx;
  if (sel?.type === 'huddle') { const h = state.huddles.get(sel.id); return (h?.workRunIds || []).slice(0, 6); }
  // a mission's gallery covers every step's runs (the agent filter splits it by agent)
  if (sel?.type === 'mission') { const m = state.missions?.get(sel.id); return [...new Set((m?.steps || []).flatMap(s => s.runIds || []))].slice(0, 24); }
  const r = state.runs.get(sel?.id);
  return r ? [r.id, ...(r.subRuns || []).slice(0, 6)] : [];
};
/** Is this artifact a deliverable of what's selected? */
export function belongs(a, sel = S.sel) {
  if (!sel || !a || !isDeliverable(a)) return false;
  if (sel.type === 'huddle' && a.huddleId === sel.id) return true;
  const ids = runIdsOf(sel);
  return (a.runIds || [a.runId]).some(id => ids.includes(id));
}

/** Fetch the selection's deliverables. Resolves to the file entry. */
export async function loadFiles(sel = S.sel) {
  const key = selKey(sel);
  if (!sel) return { list: [] };
  if (isPreview(sel.id)) { if (!S.files.has(key)) S.files.set(key, { list: [], at: Date.now() }); return S.files.get(key); }
  const reqs = runIdsOf(sel).map(id => api(`/api/artifacts?run=${encodeURIComponent(id)}`));
  if (sel.type === 'huddle') reqs.unshift(api(`/api/artifacts?huddle=${encodeURIComponent(sel.id)}`));
  const got = await Promise.allSettled(reqs);
  const byId = new Map();
  for (const g of got) {
    if (g.status !== 'fulfilled') continue;
    for (const a of g.value.artifacts || []) if (isDeliverable(a) && (!byId.has(a.id) || byId.get(a.id).version < a.version)) byId.set(a.id, a);
  }
  const entry = { list: sortFiles([...byId.values()]), at: Date.now(), failed: got.length > 0 && got.every(g => g.status === 'rejected') };
  S.files.set(key, entry);
  return entry;
}

/** Newest first. */
export const sortFiles = list => list.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
const slugOf = a => a.agentSlug || '~'; // '~' = the generalist (no agent file)
export const visible = entry => (entry ? (S.agentFilter ? entry.list.filter(a => slugOf(a) === S.agentFilter) : entry.list) : []);
/** How many deliverables the selection has (0 hides the column). A failed load still shows, to offer Retry. */
export function outputCount(sel = S.sel) {
  const entry = S.files.get(selKey(sel));
  return entry ? entry.list.length : 0;
}
export const outputShows = (sel = S.sel) => { const e = sel && S.files.get(selKey(sel)); return !!e && (e.list.length > 0 || !!e.failed); };

// ── tiles ──
const NATIVE_IMG = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp']);
/** A picture for the tile: the media pipeline's thumb or poster, else a small image as is. */
function picOf(a) {
  if (isPreview(a.id)) return null;
  const v = fromArtifact(a), m = a.media || {};
  if (m.thumb) return v.mediaURL('thumb');
  if (m.poster) return v.mediaURL('poster');
  if (a.kind === 'image' && NATIVE_IMG.has(a.ext) && (a.size || 0) < 3 * 1024 * 1024) return v.raw;
  return null;
}
const clock = s => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const seen = new Map(); // selection → tile ids already drawn (a newcomer hatches in)

function tileHTML(a, fresh, showWho) {
  const pic = picOf(a);
  const secs = a.media?.durationSec;
  const media = a.kind === 'video' || a.kind === 'image';
  const ext = String(a.ext || a.name.split('.').pop() || '').toUpperCase().slice(0, 5);
  const face = pic
    ? `<img src="${esc(pic)}" alt="" loading="lazy" draggable="false">`
    : `${icon(kindIcon(a.kind), 'ico lg')}${media ? '' : `<span class="lgal-ext">${esc(ext)}</span>`}`;
  const badge = a.kind === 'video' || a.kind === 'audio' ? `<span class="lgal-badge">${icon('play')}${secs ? clock(secs) : esc(a.kind)}</span>` : '';
  const who = showWho ? `${esc(agentName(a.workspace, a.agentSlug, a.agentName || 'Generalist'))} · ` : '';
  return `<button type="button" class="lgal-t${fresh ? ' new' : ''}" data-lfile="${esc(a.id)}" title="${esc(a.rel || a.name)}">
    <span class="lgal-pic ${media ? 'is-media' : 'is-doc'}${pic ? ' has-pic' : ''}">${face}${badge}${a.status === 'draft' ? '<span class="lgal-draft">Draft</span>' : ''}</span>
    <span class="lgal-name">${esc(a.name)}</span>
    <span class="lgal-meta">${who}${esc(fsize(a.size))}</span>
  </button>`;
}

/** The column: head (count, agent filter) over the gallery. */
export function outputHTML() {
  const sel = S.sel;
  const key = selKey(sel);
  const entry = S.files.get(key);
  const n = entry?.list.length || 0;
  const head = `<div class="lcolh"><span class="label">Output${n ? ` <span class="count">${n}</span>` : ''}</span></div>`;
  if (entry?.failed && !n) {
    return `${head}<div class="lobody"><div class="empty vstate"><strong>Couldn’t load the files</strong><span>The server didn’t answer.</span><div class="btnrow"><button class="btn sm" data-lretry>${icon('refresh')}Retry</button></div></div></div>`;
  }
  const agents = entry ? [...new Set(entry.list.map(slugOf))] : [];
  const wsOf = entry?.list[0]?.workspace;
  const filter = agents.length > 1 ? `<span class="seg lagents" role="group" aria-label="Whose files">${['', ...agents].map(s => `<button type="button" data-lagent="${esc(s)}" aria-pressed="${(S.agentFilter || '') === s}">${s === '' ? 'All' : esc(agentName(wsOf, s === '~' ? null : s, entry.list.find(a => slugOf(a) === s)?.agentName || 'Generalist'))}</button>`).join('')}</span>` : '';
  const list = visible(entry);
  const before = seen.get(key);
  seen.set(key, new Set(list.map(a => a.id)));
  const tiles = list.map(a => tileHTML(a, !!before && !before.has(a.id), agents.length > 1 && !S.agentFilter)).join('');
  return `${head}<div class="lobody">${filter}<div class="lgal" role="group" aria-label="What it made">${tiles}</div></div>`;
}

/** Open a tile in the big viewer, the gallery (as filtered) as its prev/next list. */
export function openTile(id, from) {
  const list = visible(S.files.get(selKey(S.sel)));
  const a = list.find(x => x.id === id);
  if (!a || isPreview(a.id)) return;
  openViewer({ artifact: a, list, from });
}
