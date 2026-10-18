// Floating 1-bit windows: draggable, resizable from every edge, stackable, minimize to the dock,
// zoom-rect open, and pop-out: drag a title bar past the edge of the browser (or press the
// pop-out button) and the window moves into its own browser window you can put on another screen.
// The dashboard keeps running a popped-out window, so it stays live; closing it parks it back here.
import { icon } from './pixel.mjs';
import { esc } from './util.mjs';

const layer = () => document.getElementById('windows');
const dock = () => document.getElementById('dock');
const wins = new Map(); // id -> win
let z = 10;
let cascade = 0;
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const mobile = () => matchMedia('(max-width: 900px)').matches;
// the top bar and dock lane heights come from tokens.css (--bar, --dock), so the desk density applies here too
const cssPx = name => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;
const topOf = () => cssPx('--bar') + 4;   // keep windows below the top bar
const MIN_W = 320, MIN_H = 200;

let hooks = { toast: () => {}, onPopDocument: () => {} };
/** toast(msg, kind) shows notes; onPopDocument(doc) lets the app wire its shortcuts into a popped-out window. */
export function initWindows(h) { hooks = { ...hooks, ...h }; }

// ── remembered sizes (per window kind) ──
const sizeKeyOf = opts => `jos-win2:${opts.kind === 'decision' ? 'decision' : 'normal'}:${opts.size || 'normal'}`;
function loadSize(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }
function saveSize(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }

function zoomRects(fromRect, toRect) {
  if (!fromRect || reduced()) return Promise.resolve();
  const frames = 4;
  const els = [];
  return new Promise(resolve => {
    let i = 0;
    const t = setInterval(() => {
      i++;
      const f = i / frames;
      const r = {
        left: fromRect.left + (toRect.left - fromRect.left) * f,
        top: fromRect.top + (toRect.top - fromRect.top) * f,
        width: fromRect.width + (toRect.width - fromRect.width) * f,
        height: fromRect.height + (toRect.height - fromRect.height) * f,
      };
      const el = document.createElement('div');
      el.className = 'zoomrect';
      Object.assign(el.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      document.body.appendChild(el);
      els.push(el);
      if (els.length > 2) els.shift().remove();
      if (i >= frames) { clearInterval(t); setTimeout(() => { els.forEach(e => e.remove()); resolve(); }, 40); }
    }, 34);
  });
}
export { zoomRects };

function focusWin(w) {
  if (w.pop) { try { w.pop.focus(); } catch {} return; }
  for (const o of wins.values()) if (!o.pop) o.el.classList.remove('top'); // a popped-out window is always top in its own window
  w.el.classList.add('top');
  w.el.style.zIndex = ++z;
}

function topWin() {
  let best = null;
  for (const w of wins.values()) if (!w.minimized && !w.pop && !w.stashed && (!best || Number(w.el.style.zIndex) > Number(best.el.style.zIndex))) best = w;
  return best;
}

function renderDock() {
  const d = dock();
  d.innerHTML = '';
  const parked = [...wins.values()].filter(w => w.minimized);
  const away = [...wins.values()].filter(w => w.pop);
  document.body.dataset.dock = parked.length || away.length ? '1' : '0';
  if (mobile() && parked.length > 1) {
    // phones: one chip, decisions first
    const decisions = parked.filter(w => w.kind === 'decision');
    const b = document.createElement('button');
    if (decisions.length) b.className = 'decision';
    b.innerHTML = `${icon(decisions.length ? 'bang' : 'doc')}<span>${decisions.length ? `${decisions.length} waiting on you` : `${parked.length} windows`}</span>`;
    b.addEventListener('click', () => (decisions[0] || parked[0]).restore());
    d.appendChild(b);
    return;
  }
  for (const w of parked) {
    const b = document.createElement('button');
    if (w.kind === 'decision') b.className = 'decision';
    b.title = w.title;
    b.innerHTML = `${icon(w.kind === 'decision' ? 'bang' : 'doc')}<span>${esc(w.dockLabel || w.title)}</span>`;
    b.addEventListener('click', () => w.restore());
    d.appendChild(b);
  }
  // popped-out windows: a reminder chip that brings that window to the front
  for (const w of away) {
    const b = document.createElement('button');
    b.className = `away${w.kind === 'decision' ? ' decision' : ''}`;
    b.title = `${w.title} is in its own window. Click to bring it forward.`;
    b.innerHTML = `${icon('popout')}<span>${esc(w.dockLabel || w.title)}</span>`;
    b.addEventListener('click', () => w.restore());
    d.appendChild(b);
  }
}

function clampToViewport(el) {
  const TOP = topOf();
  const dockH = [...wins.values()].some(w => w.minimized || w.pop) ? cssPx('--dock') : 0;
  const maxW = innerWidth - 24, maxH = innerHeight - TOP - 16 - dockH;
  if (el.style.width) el.style.width = `${Math.min(parseInt(el.style.width, 10), maxW)}px`;
  if (el.style.height) el.style.height = `${Math.min(parseInt(el.style.height, 10), maxH)}px`;
}

function place(el) {
  if (mobile()) return;
  const TOP = topOf(), vw = innerWidth, vh = innerHeight;
  const dockH = [...wins.values()].some(w => w.minimized || w.pop) ? cssPx('--dock') : 0;
  const w = el.offsetWidth || 440, h = Math.min(el.offsetHeight || 360, vh - TOP - 24 - dockH);
  const n = cascade++ % 7;
  const left = Math.max(12, Math.min(vw - w - 12, (vw - w) / 2 + (n - 3) * 26));
  const top = Math.max(TOP + 8, Math.min(vh - h - 16 - dockH, TOP + 24 + n * 26));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function outside(ev) { return ev.clientX <= 0 || ev.clientY <= 0 || ev.clientX >= innerWidth - 1 || ev.clientY >= innerHeight - 1; }

function makeDraggable(w) {
  const bar = w.el.querySelector('.tb');
  bar.addEventListener('pointerdown', e => {
    if (w.pop || mobile() || e.button !== 0 || e.target.closest('button')) return;
    focusWin(w);
    const TOP = topOf();
    const sx = e.clientX, sy = e.clientY;
    const ox = w.el.offsetLeft, oy = w.el.offsetTop;
    const grabX = sx - ox, grabY = sy - oy;
    let leaving = false;
    bar.setPointerCapture(e.pointerId);
    const move = ev => {
      const nx = Math.round((ox + ev.clientX - sx) / 2) * 2; // snap to 2px: pixels, not pixels-ish
      const ny = Math.round((oy + ev.clientY - sy) / 2) * 2;
      w.el.style.left = `${Math.max(-w.el.offsetWidth + 80, Math.min(innerWidth - 80, nx))}px`;
      w.el.style.top = `${Math.max(TOP - 4, Math.min(innerHeight - 40, ny))}px`;
      const out = outside(ev);
      if (out !== leaving) { leaving = out; w.el.classList.toggle('leaving', out); document.body.classList.toggle('popping', out); }
    };
    const up = ev => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      bar.removeEventListener('pointercancel', up);
      w.el.classList.remove('leaving');
      document.body.classList.remove('popping');
      if (leaving) {
        // dropped outside the browser: put it back where it was, then hand it its own window there
        w.el.style.left = `${ox}px`; w.el.style.top = `${oy}px`;
        popOut(w, { screenX: ev.screenX, screenY: ev.screenY, grabX, grabY });
      }
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
    bar.addEventListener('pointercancel', up);
  });
}

function makeResizable(w) {
  for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
    const h = document.createElement('i');
    h.className = `rz ${edge}`;
    h.dataset.rz = edge;
    h.setAttribute('aria-hidden', 'true');
    w.el.appendChild(h);
    h.addEventListener('pointerdown', e => {
      if (w.pop || mobile() || e.button !== 0) return;
      e.preventDefault();
      focusWin(w);
      const r0 = w.el.getBoundingClientRect(), TOP = topOf();
      const sx = e.clientX, sy = e.clientY;
      h.setPointerCapture(e.pointerId);
      w.el.classList.add('resizing');
      const snap = v => Math.round(v / 2) * 2;
      const move = ev => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        let { left, top, width, height } = { left: r0.left, top: r0.top, width: r0.width, height: r0.height };
        if (edge.includes('e')) width = Math.min(innerWidth - left - 4, Math.max(MIN_W, r0.width + dx));
        if (edge.includes('s')) height = Math.min(innerHeight - top - 4, Math.max(MIN_H, r0.height + dy));
        if (edge.includes('w')) { width = Math.max(MIN_W, r0.width - dx); left = Math.max(4, r0.right - width); width = r0.right - left; }
        if (edge.includes('n')) { height = Math.max(MIN_H, r0.height - dy); top = Math.max(TOP - 4, r0.bottom - height); height = r0.bottom - top; }
        Object.assign(w.el.style, { left: `${snap(left)}px`, top: `${snap(top)}px`, width: `${snap(width)}px`, height: `${snap(height)}px`, maxHeight: 'none' });
      };
      const up = () => {
        h.removeEventListener('pointermove', move);
        h.removeEventListener('pointerup', up);
        w.el.classList.remove('resizing');
        saveSize(w.sizeKey, { w: w.el.offsetWidth, h: w.el.offsetHeight });
      };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
    });
  }
}

// ── pop-out ──
let askedScreens = false;

/** Move a window into its own browser window. Must run inside a click/drag handler (pop-up rules). */
function popOut(w, at) {
  if (w.pop || mobile()) return false;
  const r = w.el.getBoundingClientRect();
  const width = Math.max(440, Math.round(r.width)), height = Math.max(360, Math.round(r.height));
  const chromeTop = Math.max(0, outerHeight - innerHeight);
  const left = Math.round(at ? at.screenX - at.grabX : screenX + r.left + 24);
  const top = Math.round(at ? at.screenY - at.grabY : screenY + chromeTop + r.top - 24);
  const pop = window.open('/popout.html', `jos-${w.id}`, `popup=yes,width=${width},height=${height},left=${left},top=${top}`);
  if (!pop) {
    hooks.toast('Your browser blocked the pop-out. Allow pop-ups for this page (the icon at the right end of the address bar), then try again.', 'warn');
    return false;
  }
  w.saved = { left: w.el.style.left, top: w.el.style.top };
  w.popping = true;
  // Let Chrome place windows on any screen (asked once). Without it a window can only open on this screen.
  if (!askedScreens && 'getScreenDetails' in window && navigator.permissions) {
    askedScreens = true;
    navigator.permissions.query({ name: 'window-management' }).then(p => {
      if (p.state === 'prompt') window.getScreenDetails().then(() => { try { pop.moveTo(left, top); } catch {} }).catch(() => {});
    }).catch(() => {});
  }
  const started = Date.now();
  const wait = setInterval(() => {
    let doc = null;
    try { doc = pop.document; } catch {}
    const host = doc?.getElementById?.('host');
    if (host && doc.readyState !== 'loading') {
      clearInterval(wait);
      adopt(w, pop, doc, host);
    } else if (pop.closed || Date.now() - started > 8000) {
      clearInterval(wait);
      w.popping = false;
      try { pop.close(); } catch {}
      if (!pop.closed || Date.now() - started > 8000) hooks.toast('The pop-out window didn’t open. Try again.', 'warn');
    }
  }, 25);
  return true;
}

function adopt(w, pop, doc, host) {
  w.popping = false;
  w.pop = pop;
  w.minimized = false;
  doc.title = `${w.title} · Orchy`;
  doc.documentElement.dataset.theme = document.documentElement.dataset.theme;
  host.innerHTML = '';
  w.el.hidden = false;
  w.el.classList.add('popped', 'top');
  host.appendChild(w.el); // the same live element: its buttons and fields keep working
  setPopButton(w);
  hooks.onPopDocument(doc, w);
  // closing the OS window: a decision parks in the dock, anything else closes
  const gone = () => { if (w.pop === pop && !w.closing) popIn(w, { park: w.kind === 'decision', closeWin: w.kind !== 'decision' }); };
  pop.addEventListener('pagehide', gone);
  w.watch = setInterval(() => { if (pop.closed) gone(); }, 600);
  renderDock();
  const f = w.el.querySelector('[autofocus]') || w.el.querySelector('textarea, input:not([type=checkbox])');
  try { pop.focus(); f?.focus({ preventScroll: true }); } catch {}
  const t = topWin();
  if (t) focusWin(t);
}

function popIn(w, { park = false, closeWin = false } = {}) {
  const pop = w.pop;
  if (!pop) return;
  w.pop = null;
  clearInterval(w.watch);
  w.el.classList.remove('popped', 'leaving');
  layer().appendChild(w.el);
  if (w.saved) { w.el.style.left = w.saved.left; w.el.style.top = w.saved.top; }
  clampToViewport(w.el);
  setPopButton(w);
  try { if (!pop.closed) pop.close(); } catch {}
  if (closeWin) return w.close();
  if (park) { w.minimized = true; w.el.hidden = true; renderDock(); return; }
  w.minimized = false; w.el.hidden = false;
  renderDock();
  focusWin(w);
}

function setPopButton(w) {
  const b = w.el.querySelector('[data-act="pop"]');
  if (!b) return;
  b.innerHTML = icon(w.pop ? 'popin' : 'popout');
  b.setAttribute('aria-label', w.pop ? 'Put back in the dashboard' : 'Pop out into its own window (or drag the title bar off the edge)');
  b.title = w.pop ? 'Put back in the dashboard' : 'Pop out: its own window you can move to another screen. Or drag the title bar past the edge of the browser.';
}

// closing the dashboard closes its pop-outs (they can't run without it)
addEventListener('pagehide', () => { for (const w of wins.values()) { try { w.pop?.close(); } catch {} } });

/**
 * openWindow({ id, title, kind:'decision'|'normal', size:''|'wide', body:Node|string,
 *              from: Element|DOMRect, dockLabel, onClose, focus: true })
 */
// One window at a time: a window opened from a button inside another window takes that window's
// place, and the one it came from steps aside until this one goes Back (or closes). Decisions never stack this way.
function parentOf(opts) {
  if (opts.kind === 'decision' || !(opts.from instanceof Element)) return null;
  const el = opts.from.closest?.('.win');
  const p = el && [...wins.values()].find(o => o.el === el);
  return p && p.kind !== 'decision' && !p.pop && p.id !== opts.id ? p : null;
}
function stash(parent, child) {
  if (!parent || parent === child || !wins.has(parent.id)) return;
  child.parent = parent;
  // the child shows where the parent was, so the swap reads as one window moving to another page
  if (!mobile() && !child.pop) { child.el.style.left = parent.el.style.left; child.el.style.top = parent.el.style.top; clampToViewport(child.el); }
  parent.stashed = true;
  parent.el.hidden = true;
  child.el.querySelector('[data-act="back"]')?.removeAttribute('hidden');
  child.el.querySelector('[data-act="back"]')?.setAttribute('aria-label', `Back to ${parent.title}`);
}
function unstash(child) {
  const p = child.parent;
  child.parent = null;
  if (!p || !wins.has(p.id) || !p.stashed) return;
  p.stashed = false;
  if (!p.minimized) { p.el.hidden = false; focusWin(p); }
}

// Two shared windows, so at most one page and one item are up:
//   - the top-bar pages (and All sessions): opening one from the bar while another is up shows it in that window's
//     place and closes the other, with whatever was opened inside it;
//   - items: a run, an agent file, a huddle's transcript: opening one (from the chat, Live, a card) replaces the item
//     window that's up.
// Close just closes. Opened from inside a window, a page or item still stands in for it with Back (stash). Popped-out
// windows and decisions (questions, approvals, huddle proposals) are never swapped away.
const PAGES = new Set(['agents', 'huddles', 'logs', 'connections', 'settings', 'history']);
const isItem = id => /^(run|agent|huddle)-/.test(String(id || '')) && !/^huddle-new-/.test(id);
const groupOf = id => (PAGES.has(id) ? 'page' : isItem(id) ? 'item' : null);
const rootOf = w => { let r = w; while (r.parent && wins.has(r.parent.id)) r = r.parent; return r; };
/** Close every open window of `keepId`'s group except its own; returns where the one on screen was, for the new one. */
function swapPages(keepId) {
  const group = groupOf(keepId);
  const keep = wins.get(keepId) ? rootOf(wins.get(keepId)) : null;
  const roots = new Set([...wins.values()].map(rootOf).filter(r => groupOf(r.id) === group && r !== keep && !r.pop && r.kind !== 'decision'));
  let spot = null;
  for (const root of roots) {
    const shown = [...wins.values()].find(o => rootOf(o) === root && !o.el.hidden && !o.pop);
    if (!spot && shown && !mobile()) spot = { left: shown.el.style.left, top: shown.el.style.top };
    root.close();
  }
  return spot;
}

export function openWindow(opts) {
  const parent = parentOf(opts);
  const spot = groupOf(opts.id) && !parent && opts.kind !== 'decision' ? swapPages(opts.id) : null;
  const existing = opts.id && wins.get(opts.id);
  if (existing) { existing.restore(); if (parent && parent !== existing && !existing.parent) stash(parent, existing); return existing; }

  const el = document.createElement('section');
  el.className = `win ${opts.kind === 'decision' ? 'decision' : ''} ${opts.size || ''}`;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'false');
  const tid = `wt-${Math.random().toString(36).slice(2, 8)}`;
  el.setAttribute('aria-labelledby', tid);
  el.innerHTML = `
    <div class="tb">
      <button class="wbtn" data-act="back" hidden aria-label="Back">${icon('back')}</button>
      <h2 id="${tid}" tabindex="-1">${esc(opts.title)}</h2>
      <span class="leave-hint" aria-hidden="true">Let go to pop out</span>
      <button class="wbtn pop" data-act="pop"></button>
      <button class="wbtn" data-act="min" aria-label="Minimize">${icon('min')}</button>
      ${opts.kind === 'decision' && !opts.closable ? '' : `<button class="wbtn" data-act="close" aria-label="Close">${icon('close')}</button>`}
    </div>
    <div class="wb"></div>`;
  const body = el.querySelector('.wb');
  if (typeof opts.body === 'string') body.innerHTML = opts.body;
  else if (opts.body) body.appendChild(opts.body);

  const w = {
    id: opts.id || tid, el, body, kind: opts.kind || 'normal', title: opts.title, dockLabel: opts.dockLabel, minimized: false,
    sizeKey: sizeKeyOf(opts), pop: null,
    close() {
      w.closing = true;
      clearInterval(w.watch);
      try { w.pop?.close(); } catch {}
      w.pop = null;
      el.remove();
      wins.delete(w.id);
      opts.onClose?.();
      // closing via X / Escape / pop-out close closes the stashed chain completely; use back() to return to parent
      for (const o of [...wins.values()]) if (o.parent === w) { o.parent = null; o.close(); }
      const p = w.parent;
      w.parent = null;
      if (p && wins.has(p.id) && p.stashed) p.close();
      // one decision at a time: the next queued one steps up
      const next = w.kind === 'decision' && [...wins.values()].find(o => o.queued);
      if (next) { next.queued = false; next.restore(); }
      renderDock();
      const t = topWin();
      if (t) focusWin(t);
    },
    back() {
      if (!w.parent || !wins.has(w.parent.id) || !w.parent.stashed) return w.close();
      w.closing = true;
      clearInterval(w.watch);
      try { w.pop?.close(); } catch {}
      w.pop = null;
      el.remove();
      wins.delete(w.id);
      opts.onClose?.();
      for (const o of [...wins.values()]) if (o.parent === w) { o.parent = null; o.close(); }
      unstash(w);
      renderDock();
      const t = topWin();
      if (t) focusWin(t);
    },
    minimize() {
      if (w.pop) return popIn(w, { park: true });
      w.minimized = true; el.hidden = true; renderDock(); const t = topWin(); if (t) focusWin(t);
    },
    restore() {
      if (w.pop) { try { w.pop.focus(); } catch {} return; }
      // asked for again (its top-bar button) while another stands in for it: that one goes Back to it
      const child = w.stashed && [...wins.values()].find(o => o.parent === w);
      if (child) { child.back(); return; }
      w.minimized = false; w.queued = false; el.hidden = false; renderDock(); focusWin(w);
    },
    /** The window now shows something else (a run's follow-up): file it under that id. */
    rekey(id) { if (id === w.id || wins.has(id)) return; wins.delete(w.id); w.id = id; wins.set(id, w); },
    setTitle(t) { w.title = t; el.querySelector('.tb h2').textContent = t; if (w.pop) try { w.pop.document.title = `${t} · Orchy`; } catch {} },
    focus: () => focusWin(w),
    popOut: at => popOut(w, at),
    popIn: () => popIn(w),
    get popped() { return !!w.pop; },
  };
  el.querySelector('[data-act="pop"]').addEventListener('click', () => (w.pop ? popIn(w) : popOut(w)));
  el.querySelector('[data-act="min"]').addEventListener('click', () => w.minimize());
  el.querySelector('[data-act="close"]')?.addEventListener('click', () => w.close());
  el.querySelector('[data-act="back"]').addEventListener('click', () => w.back());
  el.addEventListener('pointerdown', () => { if (!w.pop) focusWin(w); });
  setPopButton(w);

  el.style.visibility = 'hidden';
  const remembered = loadSize(w.sizeKey);
  if (remembered && !mobile()) Object.assign(el.style, { width: `${remembered.w}px`, height: `${remembered.h}px`, maxHeight: 'none' });
  layer().appendChild(el);
  clampToViewport(el);
  wins.set(w.id, w);
  place(el);
  // a page taking another page's place opens where that one was, so it reads as the same window changing page
  if (spot?.left) { el.style.left = spot.left; el.style.top = spot.top; clampToViewport(el); }
  focusWin(w);
  makeDraggable(w);
  makeResizable(w);
  if (parent) stash(parent, w);

  if (opts.queued) { w.queued = true; w.minimize(); el.style.visibility = ''; return w; }
  // (no zoom from the button when it's a page change in place)
  const fromRect = spot ? null : opts.from instanceof Element ? opts.from.getBoundingClientRect() : opts.from;
  zoomRects(fromRect, el.getBoundingClientRect()).then(() => {
    el.style.visibility = '';
    const typing = document.activeElement?.id === 'command' && document.activeElement.value;
    if (opts.focus !== false && !typing) (el.querySelector('[autofocus]') || el.querySelector('textarea, input:not([type=checkbox])') || el.querySelector('.tb h2'))?.focus({ preventScroll: true });
  });
  return w;
}

export function getWindow(id) { return wins.get(id); }
export function closeWindow(id) { wins.get(id)?.close(); }
/** Every decision window, open, parked or popped out (ids are their inbox items'). */
/** Is any window up on this page (not minimized, not away in its own browser window)? Esc belongs to it then. */
export const windowsOpen = () => [...wins.values()].some(w => !w.minimized && !w.pop && !w.stashed);
export function decisionWindows() { return [...wins.values()].filter(w => w.kind === 'decision'); }
export function decisionVisible() { return [...wins.values()].some(w => w.kind === 'decision' && !w.minimized); }
export function focusNextDecision() {
  const ds = [...wins.values()].filter(w => w.kind === 'decision');
  if (!ds.length) return false;
  ds[0].restore();
  return true;
}
/** The document of the popped-out window the owner is using right now, if any (for toasts). */
export function activePopDocument() {
  for (const w of wins.values()) { try { if (w.pop && w.pop.document.hasFocus()) return w.pop.document; } catch {} }
  return null;
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  // Esc in a field (the chat box too) belongs to the field, not to the window around it
  if (e.target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
  const t = topWin();
  if (!t) return;
  if (t.kind === 'decision') t.minimize(); else t.close();
});
