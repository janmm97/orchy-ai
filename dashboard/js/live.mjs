// The Live view: a third view of the page next to home and work, opened from LIVE in
// the top bar (`&open=live`, samples with `&preview=live`). Three ruled columns, draggable splitters (2px snap, sizes
// remembered), and on phones three tabs, one column at a time:
//   Activity (live/activity.mjs)  every live run and huddle by workspace, then what finished today
//   Work     (live/work.mjs)      the selected run's phase, task, plan, hand-offs and steps; or a huddle's talk
//   Output   (live/output.mjs)    the deliverables it made, as a gallery (a tile opens the big viewer); hidden when none
// Everything comes from /api/state + /api/runs/:id + /api/artifacts and is kept live by the stream (app.mjs feeds
// liveNotify every event), so a refresh draws the same picture. It never opens on its own and the page doesn't fold
// home while it's open. Exit (Activity head, the phone tab strip, or Esc) goes back to the chat.
import { $ } from './util.mjs';
import { icon } from './pixel.mjs';
import { windowsOpen } from './windows.mjs';
import { S, selKey, selExists, defaultSel, loadEvents, isLiveRun, runState, isPreview, waitsOnOwner, missionFocusRun } from './live/model.mjs';
import { activityHTML } from './live/activity.mjs';
import { workHTML, timelineHTML } from './live/work.mjs';
import { outputHTML, outputShows, outputCount, openTile, loadFiles, belongs, sortFiles } from './live/output.mjs';

export { S as liveState } from './live/model.mjs';
const PREFS = 'jos-live';
const phone = () => matchMedia('(max-width: 900px)').matches;
let root = null;

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) || '{}') || {};
    if (p.filter && typeof p.filter.ws === 'string') S.filter = { ws: p.filter.ws, liveOnly: !!p.filter.liveOnly };
    if (p.sel?.id && ['run', 'huddle', 'mission'].includes(p.sel.type)) S.sel = { type: p.sel.type, id: String(p.sel.id) };
    return p;
  } catch { return {}; }
}
function savePrefs(extra = {}) {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) || '{}') || {};
    localStorage.setItem(PREFS, JSON.stringify({ ...p, filter: S.filter, sel: S.sel && !isPreview(S.sel.id) ? S.sel : p.sel || null, ...extra }));
  } catch {}
}

export function initLive(ctx) {
  S.ctx = ctx;
  const p = loadPrefs();
  root = document.createElement('section');
  Object.assign(root, { className: 'livev', id: 'live', hidden: true });
  root.setAttribute('aria-label', 'Live: what every agent is doing');
  root.innerHTML = `
    <div class="ltabs" role="tablist" aria-label="Live columns"></div>
    <div class="lcols" data-noout>
      <section class="lcol lact" data-lcol="activity" aria-label="Activity"></section>
      <div class="lsplit" data-lsplit="l" role="separator" aria-orientation="vertical" aria-label="Resize Activity" aria-valuemin="220" tabindex="0"></div>
      <section class="lcol lwork" data-lcol="work" aria-label="Work"></section>
      <div class="lsplit" data-lsplit="r" role="separator" aria-orientation="vertical" aria-label="Resize Output" aria-valuemin="280" tabindex="0"></div>
      <section class="lcol lout" data-lcol="output" aria-label="Output"></section>
    </div>`;
  $('#stage').after(root);
  const cols = root.querySelector('.lcols');
  if (p.lw) cols.style.setProperty('--lw', `${p.lw}px`);
  if (p.rw) cols.style.setProperty('--rw', `${p.rw}px`);
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKey);
  // the workspace dropdown in the Activity head
  root.addEventListener('change', e => { const s = e.target.closest?.('[data-lwsel]'); if (s) { S.filter.ws = s.value; savePrefs(); schedule('activity'); } });
  document.addEventListener('keydown', onEsc, true); // capture: look before a window's own Esc closes it
  for (const s of root.querySelectorAll('[data-lsplit]')) splitter(s, cols);
}

export const liveOpen = () => S.open;
export function openLive({ sel = null } = {}) {
  if (!S.open) {
    S.open = true;
    root.hidden = false;
    S.ctx.onOpen?.();
    document.querySelector('[data-open="live"]')?.setAttribute('aria-pressed', 'true');
    // the latest tool line of each live run (its recorded events, once)
    for (const r of [...S.ctx.state.runs.values()].filter(isLiveRun).slice(0, 8)) loadEvents(r.id).then(() => schedule('activity'));
  }
  // what was asked for, else what was on screen last time, else what needs the owner / is live / finished last
  select(selExists(sel) ? sel : selExists(S.sel) ? S.sel : defaultSel(), { jump: false });
}
export function closeLive() {
  if (!S.open) return;
  S.open = false;
  root.hidden = true;
  document.querySelector('[data-open="live"]')?.setAttribute('aria-pressed', 'false');
  S.ctx.onClose?.();
}
export const toggleLive = () => (S.open ? closeLive() : openLive());

// ── drawing (batched into one frame) ──
const due = new Set();
let raf = 0;
function schedule(...parts) {
  for (const p of parts) due.add(p);
  if (!S.open || raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const d = new Set(due);
    due.clear();
    if (d.has('activity')) drawActivity();
    if (d.has('work')) drawWork(); else if (d.has('timeline')) drawTimeline();
    if (d.has('output')) drawOutput();
    drawTabs();
  });
}

function drawActivity() {
  const col = root.querySelector('[data-lcol="activity"]');
  const keep = col.querySelector('[data-lrows]')?.scrollTop || 0;
  const focused = document.activeElement?.closest?.('[data-lsel], [data-lwsel], [data-lonly], [data-lexit]');
  const fkey = focused && root.contains(focused) ? (focused.dataset.lsel ? `[data-lsel="${CSS.escape(focused.dataset.lsel)}"]` : focused.hasAttribute('data-lwsel') ? '[data-lwsel]' : focused.hasAttribute('data-lexit') ? '.lcolh [data-lexit]' : '[data-lonly]') : null;
  const { html, live } = activityHTML();
  col.dataset.live = String(live);
  // the stream is down: say so, so a quiet column isn't read as quiet agents
  const off = S.ctx.state.orchy?.online === false;
  col.innerHTML = `<div class="lcolh"><span class="lhl"><button type="button" class="btn sm lexit" data-lexit title="Back to the chat (Esc)" aria-label="Exit Live, back to the chat">${icon('left')}Exit</button><span class="label">Activity</span></span>${off ? '<span class="chip dashed blink">Reconnecting…</span>' : live ? `<span class="plate">${live} live</span>` : '<span class="hint">nothing live</span>'}</div>${off ? '<div class="loffline" role="status">Live updates paused: Orchy’s server isn’t answering. This picks up again on its own.</div>' : ''}${html}`;
  const rows = col.querySelector('[data-lrows]');
  if (rows) rows.scrollTop = keep;
  if (fkey) col.querySelector(fkey)?.focus({ preventScroll: true });
}

/** A selector that finds the same control again after a redraw (so a click or Tab position isn't lost). */
const FOCUS_KEYS = ['lsel', 'answer', 'stop', 'run', 'runNow', 'huddle', 'lretryEv'];
function focusKey(col) {
  const el = document.activeElement;
  if (!el || !col.contains(el)) return null;
  const k = FOCUS_KEYS.find(x => el.dataset?.[x] !== undefined);
  return k ? `[data-${k.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}="${CSS.escape(el.dataset[k])}"]${el.dataset.proposal ? '[data-proposal]' : ''}` : null;
}
function drawWork() {
  const col = root.querySelector('[data-lcol="work"]');
  const body = col.querySelector('[data-lbody]');
  const same = col.dataset.key === selKey(S.sel);
  const keep = same && body ? { top: body.scrollTop, end: body.scrollHeight - body.scrollTop - body.clientHeight < 60 } : null;
  const fkey = focusKey(col);
  const html = workHTML();
  const sig = html.replace(/(data-start="[^"]*"[^>]*>)[^<]*/g, '$1'); // the ticking timers don't count as a change
  if (same && col.dataset.sig === sig) return; // nothing on it changed: leave the owner's cursor where it is
  col.dataset.key = selKey(S.sel);
  col.dataset.sig = sig;
  col.innerHTML = html;
  if (fkey) col.querySelector(fkey)?.focus({ preventScroll: true });
  const nb = col.querySelector('[data-lbody]');
  if (!nb) return;
  const r = S.sel?.type === 'run' ? S.ctx.state.runs.get(S.sel.id) : null;
  // a run that waits on the owner opens at its question; a working one at its newest step
  if (!keep) nb.scrollTop = r && isLiveRun(r) && !waitsOnOwner(r) ? nb.scrollHeight : 0;
  else nb.scrollTop = keep.end && !(r && waitsOnOwner(r)) ? nb.scrollHeight : keep.top;
}
/** Only the steps changed (a run.event): redraw the timeline in place, following the end if the owner was there. */
function drawTimeline() {
  const r = S.sel?.type === 'run' ? S.ctx.state.runs.get(S.sel.id) : null;
  const tl = r && root.querySelector(`[data-ltl="${CSS.escape(r.id)}"]`);
  if (!tl) return drawWork();
  const body = root.querySelector('[data-lcol="work"] [data-lbody]');
  const end = body && body.scrollHeight - body.scrollTop - body.clientHeight < 60;
  tl.innerHTML = timelineHTML(r);
  const now = root.querySelector('[data-lcol="work"] .lnow');
  if (now) now.textContent = runState(r).label;
  if (body && end) body.scrollTop = body.scrollHeight;
}

function drawOutput() {
  const col = root.querySelector('[data-lcol="output"]');
  const cols = root.querySelector('.lcols');
  const shows = outputShows();
  // the column steps aside while there's nothing to look at, and wipes back in with the first deliverable
  if (cols.hasAttribute('data-noout') === shows) {
    cols.toggleAttribute('data-noout', !shows);
    if (shows) { col.classList.remove('enter'); void col.offsetWidth; col.classList.add('enter'); }
  }
  const same = col.dataset.key === selKey(S.sel);
  const keep = same ? col.querySelector('.lobody')?.scrollTop || 0 : 0;
  col.dataset.key = selKey(S.sel);
  col.innerHTML = shows ? outputHTML() : '';
  const body = col.querySelector('.lobody');
  if (body) body.scrollTop = keep;
}

function drawTabs() {
  const bar = root.querySelector('.ltabs');
  const n = outputCount();
  const live = Number(root.querySelector('[data-lcol="activity"]')?.dataset.live || 0);
  if (S.tab === 'output' && !outputShows()) S.tab = 'work'; // nothing made (any more): its tab goes
  const tabs = [['activity', live ? `Activity ${live}` : 'Activity'], ['work', 'Work'], ...(outputShows() ? [['output', n ? `Output ${n}` : 'Output']] : [])];
  const html = `<button type="button" class="lexit" data-lexit aria-label="Exit Live, back to the chat">${icon('left')}</button>` + tabs.map(([k, l]) => `<button type="button" role="tab" data-ltab="${k}" aria-selected="${S.tab === k}">${l}</button>`).join('');
  if (bar.dataset.html !== html) { const f = document.activeElement?.dataset?.ltab; bar.dataset.html = html; bar.innerHTML = html; if (f) bar.querySelector(`[data-ltab="${f}"]`)?.focus(); }
  root.dataset.tab = S.tab;
}

// ── selection ──
let applied = null; // the selection the columns were last set up for
function select(sel, { jump = true } = {}) {
  const changed = selKey(sel) !== applied;
  applied = selKey(sel);
  S.sel = sel;
  if (changed) S.agentFilter = null;
  savePrefs();
  if (jump && phone()) S.tab = 'work'; // phone: picking a row shows its work
  schedule('activity', 'work', 'output');
  if (!sel) return;
  if (sel.type === 'run') loadEvents(sel.id).then(() => { if (selKey(S.sel) === selKey(sel)) schedule('timeline'); });
  if (sel.type === 'mission') followMission(sel.id);
  if (changed) {
    loadFiles(sel).then(() => { if (selKey(S.sel) === selKey(sel)) schedule('output'); });
  }
}

/** A mission on screen: its step run in focus has its steps loaded (the Work column shows its timeline). */
function followMission(mid) {
  const m = S.ctx.state.missions?.get(mid);
  const r = m && missionFocusRun(m);
  if (r && !S.events.has(r.id)) loadEvents(r.id).then(() => { if (selKey(S.sel) === `mission:${mid}`) schedule('work'); });
}

// ── the stream (app.mjs calls this for every event it applied, and after each state load) ──
export function liveNotify(type, d = {}) {
  if (!S.ctx) return;
  const { state } = S.ctx;
  if (type === 'run.event') {
    const r = state.runs.get(d.runId);
    if (r && d.activity) r.activity = d.activity; // what it's doing now (activity.mjs), between run.updated frames
    const evs = S.events.get(d.runId);
    if (evs && !(d.event?.n != null && evs.some(e => e.n === d.event.n))) evs.push(d.event);
    if (d.event?.kind === 'tool') S.lastTool.set(d.runId, d.event.summary || d.event.tool || '');
    if (!S.open) return;
    schedule('activity');
    if (S.sel?.type === 'run' && S.sel.id === d.runId) schedule('timeline');
    if (S.sel?.type === 'mission' && onScreen(d.runId, null)) schedule('work');
    return;
  }
  if (type === 'mission.created' || type === 'mission.updated') {
    if (!S.open) return;
    schedule('activity');
    if (S.sel?.type === 'mission' && S.sel.id === d.mission?.id) { followMission(S.sel.id); schedule('work'); }
    else if (S.sel?.type === 'run' && state.runs.get(S.sel.id)?.missionId === d.mission?.id) schedule('work');
    return;
  }
  if (type === 'artifact.created' || type === 'artifact.updated') {
    const a = d.artifact;
    if (!a?.id) return;
    for (const [key, entry] of S.files) {
      const [t, id] = key.split(/:(.*)/s);
      if (!belongs(a, { type: t, id })) continue; // only deliverables of that selection
      const i = entry.list.findIndex(x => x.id === a.id);
      if (i >= 0) entry.list[i] = a; else entry.list.push(a);
      sortFiles(entry.list);
      if (S.open && key === selKey(S.sel)) schedule('output');
    }
    return;
  }
  if (type === 'run.ended' && d.run?.id) {
    const k = selKey(S.sel);
    if (S.open && belongs({ runIds: [d.run.id] })) loadFiles(S.sel).then(() => { if (selKey(S.sel) === k) schedule('output'); });
  }
  if (!S.open) return;
  if (type === 'state' && !selExists(S.sel)) { select(defaultSel(), { jump: false }); return; }
  if (!/^(run\.|huddle\.|inbox\.|state|agent\.|workspaces\.|voice\.)/.test(type)) return;
  schedule('activity');
  // the Work column only redraws for what it shows (drawWork also skips a redraw that changes nothing)
  const runId = d.run?.id || d.item?.runId || null;
  const hid = d.huddle?.id || null;
  if (!/^(run\.|huddle\.|inbox\.)/.test(type) || onScreen(runId, hid)) schedule('work');
}

/** Is this run or huddle (or one it hands to / comes from) what the Work column shows? */
function onScreen(runId, hid) {
  const sel = S.sel, { state } = S.ctx;
  if (!sel) return false;
  if (sel.type === 'mission') return !!runId && (state.missions?.get(sel.id)?.steps || []).some(s => (s.runIds || []).includes(runId));
  if (sel.type === 'huddle') return hid === sel.id || (!!runId && (state.huddles.get(sel.id)?.workRunIds || []).includes(runId));
  if (!runId) return hid != null && state.runs.get(sel.id)?.fromHuddle === hid;
  const r = state.runs.get(sel.id);
  return runId === sel.id || (r?.subRuns || []).includes(runId) || r?.delegatedBy === runId;
}

// the stream went down or came back (app.mjs keeps state.orchy.online): the Activity head says so
let wasOnline = true;
setInterval(() => {
  const on = S.ctx?.state.orchy?.online !== false;
  if (S.open && on !== wasOnline) schedule('activity');
  wasOnline = on;
}, 1000);

// ── clicks and keys inside the view (app.mjs handles data-run / data-answer / data-stop / data-huddle itself) ──
function onClick(e) {
  const t = e.target.closest('[data-lexit], [data-lsel], [data-lonly], [data-lfile], [data-lagent], [data-ltab], [data-lretry], [data-lretry-ev]');
  if (!t || !root.contains(t)) return;
  if (t.hasAttribute('data-lexit')) return closeLive();
  if (t.dataset.lsel) { const [type, id] = t.dataset.lsel.split(/:(.*)/s); return select({ type, id }); }
  if (t.hasAttribute('data-lonly')) { S.filter.liveOnly = !S.filter.liveOnly; savePrefs(); return schedule('activity'); }
  if (t.dataset.lfile) return openTile(t.dataset.lfile, t);
  if (t.dataset.lagent !== undefined) { S.agentFilter = t.dataset.lagent || null; return schedule('output'); }
  if (t.dataset.ltab) { S.tab = t.dataset.ltab; return schedule('output'); }
  if (t.dataset.lretryEv) { const id = t.dataset.lretryEv; S.events.delete(id); S.eventsFailed.delete(id); schedule('timeline'); return loadEvents(id).then(() => schedule('timeline')); }
  if (t.hasAttribute('data-lretry')) { S.files.delete(selKey(S.sel)); applied = null; return select(S.sel, { jump: false }); }
}
/** Esc leaves Live (back to the chat), unless a field or an open window has it. */
function onEsc(e) {
  if (e.key !== 'Escape' || !S.open || e.defaultPrevented) return;
  if (e.target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])') || windowsOpen()) return;
  closeLive();
}
function onKey(e) {
  // ↑/↓ walk the Activity rows (and select as they go)
  const row = e.target.closest?.('[data-lsel]');
  if (!row || !row.closest('[data-lrows]') || !['ArrowDown', 'ArrowUp'].includes(e.key)) return;
  const rows = [...root.querySelectorAll('[data-lrows] [data-lsel]')];
  const next = rows[rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)];
  if (!next) return;
  e.preventDefault();
  next.focus();
  next.click();
}

// ── splitters: drag the 2px rule (it snaps to 2px), arrows nudge it, double-click resets ──
function splitter(el, cols) {
  const side = el.dataset.lsplit;
  const prop = side === 'l' ? '--lw' : '--rw';
  const clamp = w => {
    const W = cols.getBoundingClientRect().width;
    const other = cols.querySelector(side === 'l' ? '[data-lcol="output"]' : '[data-lcol="activity"]').getBoundingClientRect().width;
    const max = Math.min(W * (side === 'l' ? 0.45 : 0.55), W - other - 320);
    return Math.round(Math.max(side === 'l' ? 220 : 280, Math.min(max, w)) / 2) * 2;
  };
  const set = w => { const v = clamp(w); cols.style.setProperty(prop, `${v}px`); el.setAttribute('aria-valuenow', String(v)); return v; };
  const widthNow = () => cols.querySelector(side === 'l' ? '[data-lcol="activity"]' : '[data-lcol="output"]').getBoundingClientRect().width;
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0 || phone()) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    cols.classList.add('dragging');
    const box = cols.getBoundingClientRect();
    let last = widthNow();
    const move = ev => { last = set(side === 'l' ? ev.clientX - box.left : box.right - ev.clientX); };
    const up = () => { el.removeEventListener('pointermove', move); cols.classList.remove('dragging'); savePrefs({ [side === 'l' ? 'lw' : 'rw']: last }); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up, { once: true });
    el.addEventListener('pointercancel', up, { once: true });
  });
  el.addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const d = (e.key === 'ArrowRight' ? 16 : -16) * (side === 'l' ? 1 : -1);
    savePrefs({ [side === 'l' ? 'lw' : 'rw']: set(widthNow() + d) });
  });
  el.addEventListener('dblclick', () => { cols.style.removeProperty(prop); savePrefs({ [side === 'l' ? 'lw' : 'rw']: null }); });
}

