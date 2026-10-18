// Orchy dashboard: state, live events, Orchy's home stage, the split into client panes,
// Orchy's sessions (separate conversations, several busy at once) and the Jev routing card.
//   home: Orchy alone in the middle, hopping, with the chat box under him. Sending from here
//         starts a new session; the chips under the box pick up an open one.
//   work: as soon as the owner sends something, Orchy moves into his pane (session tabs + the
//         conversation on screen) and each client with work opens a pane beside him. About a
//         minute after the last task finishes, it folds back home.
import { icon, orchySVG, orchyTopbarSVG, orchyStageSVG, createEl, hatch } from './pixel.mjs';
import { esc, api, ownerHeaders, md, $, $$, wsName, wsShort, wsClass, wsPlan, wsUsesModelDropdown, pickModels, takesModelId, backendInfo, startModel, dropdownModels, modelChoices, modelIsFree, setWorkspaces, setOwner, ownerName, ownerKnown, setCallNames, agentName, runName, itemName, nameRole, timeShort, dur, clockET, onShift, setTimezone, timezone, zoneShort, clientOwn } from './util.mjs';
import { initWindows, focusNextDecision, zoomRects, activePopDocument, getWindow, decisionWindows } from './windows.mjs';
import { initPopups, openItem, closeItem } from './popups.mjs';
import { initSheets, openRun, openAgent, openBuild, runEvent, runUpdated, runArtifact, recoverButtons, recoverAct, fixText } from './sheets.mjs';
import { openViewer, artifactChanged, kindFor, kindIcon } from './viewer.mjs';
import { initSetup, openSetup, refreshSetup, maybeAutoOpenSetup } from './setup.mjs';
import { initPanels, openLogs, openConnections, openSettings, openAgents, refreshAgents, openHistory, refreshHistory, openAddWorkspace, refreshWorkspaceWindows } from './panels.mjs';
import { initPanes, renderPane, paneEvent } from './panes.mjs';
import * as voice from './voice.mjs';
import { initCalls, startCall, ringIn, callUpdated } from './call.mjs';
import { initHuddles, openHuddle, openProposal, openNewHuddle, openHuddles, huddleUpdated } from './huddles.mjs';
import { initLive, openLive, closeLive, toggleLive, liveOpen, liveNotify } from './live.mjs';
import { initMissions, missionSlotHTML, missionLineHTML, missionUpdated, onMissionClick, onMissionInput, tickMissionCountdowns } from './missions.mjs';
import { pairFromLink, watchPairing } from './pairing.mjs';

const state = {
  workspaces: [], retired: [], runtimes: {}, agents: [], runs: new Map(), inbox: new Map(), chat: [], proposals: new Map(), sessions: new Map(), huddles: new Map(), missions: new Map(),
  clientAsks: new Map(), // questions and app decisions a client answers on their own page (never the owner's pop-ups)
  clients: [], clientPages: {},
  settings: {}, envStatus: {}, jev: {}, workHours: null,
  orchy: { server: 'idle', speaking: false, happyUntil: 0, online: true },
};
const LIVE = new Set(['queued', 'paused-limit', 'starting', 'working', 'waiting', 'stopping']);
const FOLD_MS = 60_000;          // fold back home this long after the last activity
// workspaces in config order; Orchy only routes to the switched-on ones
const wsIds = () => state.workspaces.map(w => w.id);
const enabledIds = () => state.workspaces.filter(w => w.enabled !== false).map(w => w.id);
const defaultWs = () => enabledIds()[0] || wsIds()[0];
const plainClient = w => String(w.client || w.name).replace(/\s*\(.*?\)\s*/g, ' ').trim();
/** "Acme", "Acme or Globex", "Acme, Globex or Initech" */
function clientList() {
  const names = state.workspaces.filter(w => w.enabled !== false).map(plainClient);
  if (!names.length) return 'your agents';
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
}
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const phone = () => matchMedia('(max-width: 900px)').matches;

// what the page is showing. since: when the work view opened. active: the session on screen.
// draft: a new session the owner hasn't said anything in yet (the server learns of it with the first message).
const view = { mode: 'home', since: 0, lastActivity: 0, manualHome: false, folded: new Set(), pinned: new Set(), shown: [], tab: 'spine', active: null, draft: null };
const thinking = new Map(); // sessionId -> 'routing' | 'thinking': Orchy can be busy in several sessions at once

// ── toasts (in a popped-out window when that's where the owner is working) ──
function toast(msg, kind = '') {
  const doc = activePopDocument() || document;
  const el = createEl(`<div class="toast ${kind}">${esc(msg)}</div>`);
  doc.getElementById('toasts')?.appendChild(el);
  setTimeout(() => el.remove(), kind === 'warn' ? 7000 : 4500);
}

// ── theme ──
function applyTheme(t) {
  try { localStorage.setItem('jos-theme', t); } catch {}
  document.documentElement.dataset.theme = t;
}

// ── load ──
async function load() {
  const s = await api('/api/state');
  if (s.events) state.evCursor = s.events; // where the live stream picks up (connectEvents)
  setTimezone(s.timezone);
  setOwner(s.owner);
  Object.assign(state, {
    workspaces: s.workspaces, retired: s.retired || [], runtimes: s.runtimes || {}, approvalKinds: s.approvalKinds || [], agents: s.agents, chat: s.chat, settings: s.settings,
    envStatus: s.envStatus, jev: s.jev, liveJev: s.liveJev, workHours: s.workHours, timezone: s.timezone, clients: s.clients || [], clientPages: s.clientPages || {}, voiceAgents: s.voiceAgents,
  });
  setWorkspaces(state.workspaces, state.retired, s.backend); setCallNames(state.voiceAgents);
  ensurePanes();
  state.runs = new Map(s.runs.map(r => [r.id, r]));
  state.inbox = new Map(s.inbox.filter(i => i.answerer !== 'client').map(i => [i.id, i]));
  state.clientAsks = new Map(s.inbox.filter(i => i.answerer === 'client').map(i => [i.id, i]));
  state.proposals = new Map(s.proposals.map(p => [p.id, p]));
  state.huddles = new Map((s.huddles || []).map(h => [h.id, h]));
  // missions (missions.mjs) light up once the server sends them; until then the dashboard draws none
  state.missionsOn = Array.isArray(s.missions);
  state.missions = new Map((s.missions || []).map(m => [m.id, m]));
  state.sessions = new Map(s.sessions.map(x => [x.id, x]));
  loadedSessions.clear();
  for (const sid of state.sessions.keys()) loadedSessions.add(sid);
  thinking.clear();
  syncOrchy();
  pickActive();
  voice.setVoiceConfig(s.voice);
  voice.setSound(s.settings.sound !== false);
  renderAll();
  // a reload (reconnect, a saved key, Re-check) leaves parked decisions parked; ones answered meanwhile close
  for (const w of decisionWindows()) if (state.inbox.get(w.id)?.status !== 'pending') w.close();
  if (s.ringing) ringIn(s.ringing);
  liveNotify('state');
}

function renderAll() {
  renderConvo();
  renderReadouts();
  renderBubble();
  renderUnder();
  renderSessions();
  layout();
  refreshAgents();
}

// ─────────────── sessions: separate conversations with Orchy ───────────────
// Each has its own thread, its own Orchy memory and the runs it started; agents' reports land in
// the session that sent the work. Tabs over Orchy's conversation at work, chips under the box at home.
const newSessionId = () => `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const ACTIVE_KEY = 'jos-session', SEEN_KEY = 'jos-seen';
const loadedSessions = new Set(); // sessions whose thread is in state.chat
let seen = {};                    // sessionId -> time of the last message the owner had on screen
try { seen = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}') || {}; } catch {}

const openSessions = () => [...state.sessions.values()].filter(s => !s.closed).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const isDraft = sid => !!sid && sid === view.draft && !state.sessions.has(sid);

function syncOrchy() {
  const v = [...thinking.values()];
  state.orchy.server = v.includes('thinking') ? 'thinking' : v.length ? 'routing' : 'idle';
}

/** After a load: keep the session on screen if it's still open, else the last one the owner used, else a new one. */
function pickActive() {
  const ok = sid => isDraft(sid) || (state.sessions.has(sid) && !state.sessions.get(sid).closed);
  if (ok(view.active)) return;
  let saved = null;
  try { saved = localStorage.getItem(ACTIVE_KEY); } catch {}
  const latest = openSessions().sort((a, b) => b.lastAt.localeCompare(a.lastAt))[0];
  if (ok(saved)) view.active = saved;
  else if (latest) view.active = latest.id;
  else view.active = view.draft = newSessionId();
}

function markSeen(sid) {
  const last = state.chat.findLast(m => m.session === sid);
  if (!last || seen[sid] >= last.at) return;
  seen[sid] = last.at;
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch {}
}

function sessionStatus(sid) {
  const runs = [...state.runs.values()].filter(r => r.session === sid);
  const ids = new Set(runs.map(r => r.id));
  const cards = openProposals().filter(p => p.session === sid);
  if (pendingInbox().some(i => ids.has(i.runId)) || cards.some(p => p.routing?.needsChoice && !p.held)) return { kind: 'needs', word: 'needs you' };
  const live = runs.find(r => LIVE.has(r.status));
  if (live) return { kind: 'live', ws: live.workspace, word: `working in ${wsName(live.workspace)}` };
  if (thinking.has(sid) || cards.length) return { kind: 'busy', word: 'Orchy is on it' };
  const last = state.chat.findLast(m => m.session === sid && m.role === 'orchy');
  const onScreen = sid === view.active && view.mode === 'work';
  if (last && !onScreen && !(seen[sid] >= last.at)) return { kind: 'unread', word: 'new from Orchy' };
  return { kind: 'idle', word: '' };
}
const markHTML = st => `<span class="smark ${st.kind}${st.ws ? ` ${wsClass(st.ws)}` : ''}${['needs', 'live', 'busy'].includes(st.kind) ? ' blink' : ''}" aria-hidden="true"></span>`;

const placeholder = () => (attached.length ? (phone() ? 'Add a note, or just Send' : 'What should Orchy look for? (or just Send)') : view.mode === 'home' || isDraft(view.active) ? (phone() ? 'Start a new session…' : 'New session · tell Orchy what to do…') : 'Tell Orchy what to do…');

function renderSessions() {
  // work: a tab per open session (plus the new one being started)
  const open = openSessions();
  const tabs = open.map(s => ({ s, st: sessionStatus(s.id) }));
  if (isDraft(view.active)) tabs.push({ s: { id: view.active, title: 'New session', draft: true }, st: { kind: 'idle', word: '' } });
  const bar = $('#sessions-tabs');
  const sig = JSON.stringify([view.active, tabs.map(({ s, st }) => [s.id, s.title, st.kind, st.ws])]);
  if (bar.dataset.sig !== sig) {
    bar.dataset.sig = sig;
    bar.innerHTML = tabs.map(({ s, st }) => {
      const on = s.id === view.active;
      return `<span class="stab${on ? ' on' : ''}">
        <button type="button" class="go" data-session="${esc(s.id)}" ${on ? 'aria-current="true"' : ''} title="${esc(s.title)}" aria-label="${esc(s.title)}${st.word ? `, ${st.word}` : ''}">${markHTML(st)}<span class="t">${esc(s.title)}</span></button>
        ${s.draft && !open.length ? '' : `<button type="button" class="x" data-session-close="${esc(s.id)}" aria-label="Close ${esc(s.title)}" title="Close it (History keeps it)">${icon('close')}</button>`}
      </span>`;
    }).join('');
  }
  revealActiveTab();
  // home: sending starts a new session; these pick up an open one instead
  const recent = open.slice().sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, 4).map(s => ({ s, st: sessionStatus(s.id) }));
  const box = $('#resume');
  const rsig = JSON.stringify(recent.map(({ s, st }) => [s.id, s.title, st.kind, st.ws]));
  if (box.dataset.sig !== rsig) {
    box.dataset.sig = rsig;
    box.innerHTML = recent.length ? `<span class="label">Or continue</span>
      ${recent.map(({ s, st }) => `<button type="button" class="schip" data-open-session="${esc(s.id)}" title="${esc(s.title)}" aria-label="Continue ${esc(s.title)}${st.word ? `, ${st.word}` : ''}">${markHTML(st)}<span class="t">${esc(s.title)}</span></button>`).join('')}` : '';
  }
  $('#command').placeholder = placeholder();
}

/** Scroll the session on screen into view when it, the tabs or the strip's width change (the owner's own scrolling is left alone). */
function revealActiveTab() {
  const bar = $('#sessions-tabs');
  const on = bar.querySelector('.stab.on');
  const key = `${view.active}|${bar.childElementCount}|${bar.clientWidth}`;
  if (!on || !bar.clientWidth || bar.dataset.key === key) return;
  bar.dataset.key = key;
  if (on.offsetLeft < bar.scrollLeft || on.offsetLeft + on.offsetWidth > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = Math.max(0, on.offsetLeft - 24);
  syncTabArrows();
}

/** The ‹ › arrows show while the tabs overflow, and grey out at each end. */
function syncTabArrows() {
  const bar = $('#sessions-tabs');
  const over = bar.scrollWidth > bar.clientWidth + 1;
  for (const b of $$('[data-stabs-scroll]')) {
    b.hidden = !over;
    b.disabled = Number(b.dataset.stabsScroll) < 0 ? bar.scrollLeft <= 0 : bar.scrollLeft + bar.clientWidth >= bar.scrollWidth - 1;
  }
}

/** Put a session on screen. Leaving an unused new session drops it. */
function setActive(sid) {
  if (view.draft && sid !== view.draft && !state.sessions.has(view.draft)) view.draft = null;
  view.active = sid;
  if (state.sessions.has(sid)) { try { localStorage.setItem(ACTIVE_KEY, sid); } catch {} }
  if (view.mode === 'work') markSeen(sid);
  renderConvo();
  renderSessions();
  layout();       // its client opens beside it
  renderPanes();
}

/** A fresh session on screen (the others keep running in their tabs). */
function startSession({ focus = true } = {}) {
  if (!isDraft(view.active)) { view.draft = newSessionId(); setActive(view.draft); }
  if (focus) $('#command').focus();
}

function mergeChat(msgs) {
  const have = new Set(state.chat.map(m => m.id));
  const add = msgs.filter(m => !have.has(m.id));
  if (!add.length) return;
  state.chat.push(...add);
  state.chat.sort((a, b) => a.at.localeCompare(b.at));
}

async function loadSession(sid) {
  loadedSessions.add(sid);
  try { mergeChat((await api(`/api/sessions/${encodeURIComponent(sid)}`)).chat); }
  catch { loadedSessions.delete(sid); return; }
  if (sid === view.active) renderConvo();
}

/** Show a session in the work view, reopening it if it was closed. */
async function openSession(sid) {
  const s = state.sessions.get(sid);
  if (!s || s.closed) {
    try { state.sessions.set(sid, await api(`/api/sessions/${encodeURIComponent(sid)}`, { method: 'PATCH', body: { closed: false } })); }
    catch (e) { return toast(e.message, 'warn'); }
  }
  if (!loadedSessions.has(sid)) await loadSession(sid);
  setActive(sid);
  wake();
  layout();
}

/** If this session is on screen, show its neighbour tab instead (or a new session). */
function moveOff(sid) {
  if (sid !== view.active) return;
  const tabs = [...state.sessions.values()].filter(s => !s.closed || s.id === sid).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const at = tabs.findIndex(s => s.id === sid);
  const rest = tabs.filter(s => s.id !== sid);
  const next = rest[Math.min(Math.max(at, 0), rest.length - 1)];
  if (next) setActive(next.id); else startSession({ focus: false });
}

/** Take a session off the tabs. Its agents keep working, and a report reopens it. */
async function closeSession(sid) {
  moveOff(sid);
  const s = state.sessions.get(sid);
  if (!s) return renderSessions();
  const busyNow = ['live', 'needs'].includes(sessionStatus(sid).kind);
  s.closed = true;
  renderSessions();
  try {
    await api(`/api/sessions/${encodeURIComponent(sid)}`, { method: 'PATCH', body: { closed: true } });
    if (busyNow) toast('Closed. Its agent keeps working, and the session comes back when it reports.');
  } catch (e) { s.closed = false; renderSessions(); toast(e.message, 'warn'); }
}

// ─────────────── the view: home ↔ work ───────────────
const liveRuns = () => [...state.runs.values()].filter(r => LIVE.has(r.status));
const openProposals = () => [...state.proposals.values()].filter(p => p.status === 'proposed');
const pendingInbox = () => [...state.inbox.values()].filter(i => i.status === 'pending');
/** Missions holding for the owner (an open ask on the card: a step to check, the cost ceiling, a restart…). */
const missionAsks = () => [...state.missions.values()].filter(m => m.ask && !['done', 'partial', 'stopped', 'fallback'].includes(m.status));
/** Decisions don't open on their own: an open one comes forward, else the oldest waiting one opens. */
function nextDecision(from) {
  if (focusNextDecision()) return true;
  const item = pendingInbox().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
  if (item) { openItem(item, { from }); return true; }
  const m = missionAsks()[0]; // no inbox ask left: a mission waiting on the owner opens in the Live view
  if (!m) return false;
  openLive({ sel: { type: 'mission', id: m.id } });
  return true;
}
const busy = () => liveRuns().length > 0 || openProposals().length > 0 || pendingInbox().length > 0 || ['routing', 'thinking'].includes(state.orchy.server);

function bump() { view.lastActivity = Date.now(); }
/** Something new happened that the owner should see: leave home, and un-hide a client that just got work. */
function wake(wsId) { view.manualHome = false; bump(); if (wsId) view.folded.delete(wsId); }
// The work view is Orchy's chat alone: what each agent is doing lives in the Live view (live.mjs). The pane per
// workspace (panes.mjs) stays in the code, switched off; set this to true to bring the split view back.
const CLIENT_PANES = false;

function activeClients() {
  const set = new Set(view.pinned);
  for (const p of openProposals()) if (p.choice?.workspace) set.add(p.choice.workspace);
  let mine = null; // the latest run of the session on screen: its client stays open beside it
  for (const r of state.runs.values()) {
    if (clientOwn(r)) continue; // a client's own talk with their agent stays on their page
    if (LIVE.has(r.status)) set.add(r.workspace);
    else if (r.endedAt && Date.parse(r.endedAt) >= view.since - 2000) set.add(r.workspace);
    if (r.session === view.active && (!mine || r.startedAt > mine.startedAt)) mine = r;
  }
  if (mine) set.add(mine.workspace);
  for (const i of pendingInbox()) set.add(i.workspace);
  return wsIds().filter(w => set.has(w) && !view.folded.has(w));
}

// ─────────────── a pane per workspace (created as workspaces are added, dropped when retired) ───────────────
const paneEl = id => document.getElementById(`col-${id}`);
function ensurePanes() {
  const stage = $('#stage');
  const ids = wsIds();
  for (const el of $$('#stage > .pane.client')) if (!ids.includes(el.dataset.ws)) el.remove();
  for (const id of ids) {
    let el = paneEl(id);
    if (!el) {
      el = document.createElement('section');
      Object.assign(el, { className: 'pane client', id: `col-${id}`, hidden: true });
      el.dataset.ws = id;
      stage.appendChild(el);
    }
    el.setAttribute('aria-label', wsName(id));
    // its client ink on the pane head (a workspace the owner adds wears its own tint)
    for (const c of [...el.classList]) if (c === 'tint' || c.startsWith('t-')) el.classList.remove(c);
    const ink = wsClass(id);
    if (ink.startsWith('tint')) el.classList.add(...ink.split(' '));
  }
  for (const id of ids) if (stage.lastElementChild !== paneEl(id)) stage.appendChild(paneEl(id)); // config order
}

function layout() {
  // the Live view stands in for home and work while it's open: no split, no folding home (live.mjs)
  if (liveOpen()) { renderReadouts(); renderTabs(); tickDoing(); return; }
  // a half-typed message (or files waiting to go) in the work view keeps it open
  const typing = view.mode === 'work' && ($('#command').value.trim() !== '' || attached.length > 0);
  const wantWork = !view.manualHome && (busy() || typing || Date.now() - view.lastActivity < FOLD_MS);
  const mode = wantWork ? 'work' : 'home';
  if (mode !== view.mode) {
    const from = $('#orchy').getBoundingClientRect();
    view.mode = mode;
    view.since = Date.now();
    if (mode === 'home') { view.folded.clear(); view.pinned.clear(); view.tab = 'spine'; }
    document.body.dataset.view = mode;
    if (mode === 'work' && from.width) requestAnimationFrame(() => zoomRects(from, $('#orchy-mini').getBoundingClientRect()));
    if (mode === 'home') { renderBubble(); renderUnder(); }
    else { markSeen(view.active); scrollConvo(true); }
    renderSessions();
  }
  const shown = CLIENT_PANES && mode === 'work' ? activeClients() : [];
  document.body.dataset.panes = String(shown.length);
  document.body.toggleAttribute('data-panes-many', shown.length > 4);
  for (const w of wsIds()) {
    const col = paneEl(w);
    if (!col) continue;
    const on = shown.includes(w);
    if (on && col.hidden) {
      col.hidden = false;
      renderPane(w, view.since, view.active);
      if (!reduced()) { col.classList.add('enter'); setTimeout(() => col.classList.remove('enter'), 320); }
    } else if (!on && !col.hidden) col.hidden = true;
  }
  view.shown = shown;
  renderReadouts();
  renderTabs();
  revealActiveTab(); // panes opening or closing change the strip's width
  tickDoing();
}

function renderPanes() { for (const w of view.shown) renderPane(w, view.since, view.active); }

// phone: one panel at a time, tabs for Orchy and each client with work
function renderTabs() {
  const bar = $('.mtabs');
  if (view.mode !== 'work' || liveOpen()) { bar.innerHTML = ''; delete bar.dataset.sig; return; }
  if (view.tab !== 'spine' && !view.shown.includes(view.tab)) view.tab = 'spine';
  const tabs = [['spine', 'Orchy'], ...view.shown.map(w => [w, wsShort(w)])];
  const sig = tabs.map(t => t[0]).join() + view.tab;
  if (bar.dataset.sig !== sig) {
    bar.dataset.sig = sig;
    bar.innerHTML = tabs.map(([id, label]) => `<button role="tab" data-tab="${id}" aria-selected="${view.tab === id}">${id === 'spine' ? '' : `<span class="ws-swatch ${wsClass(id)}"></span>`}${label}</button>`).join('');
  }
  $('#spine').classList.toggle('show', view.tab === 'spine');
  for (const w of wsIds()) paneEl(w)?.classList.toggle('show', view.tab === w);
}

function flashPane(wsId) {
  const col = document.getElementById(`col-${wsId}`);
  if (!col || col.hidden || reduced()) return;
  const r = col.getBoundingClientRect();
  if (!r.width) return;
  const fx = document.createElement('div');
  fx.className = `colflash ${wsClass(wsId)}`;
  Object.assign(fx.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  document.body.appendChild(fx);
  const ramp = ['d25', 'd50', 'd75', '', 'd75', 'd50', 'd25'];
  let i = 0;
  const step = () => {
    if (i >= ramp.length) return fx.remove();
    fx.className = `colflash ${wsClass(wsId)} ${ramp[i++]}`;
    setTimeout(step, 70);
  };
  step();
}

// ─────────────── home: Orchy's bubble and what's under the chat box ───────────────
const TAIL = `<svg class="tail px-art" viewBox="0 0 12 11" aria-hidden="true"><path fill="var(--ink)" d="M10 0h2v1h-2zM8 1h4v1h-4zM6 2h6v1h-6zM4 3h8v1h-8zM2 4h10v1h-10zM0 5h12v1h-12zM2 6h10v1h-10zM4 7h8v1h-8zM6 8h6v1h-6zM8 9h4v1h-4zM10 10h2v1h-2z"/><path fill="var(--paper)" d="M10 1h2v1h-2zM8 2h4v1h-4zM6 3h6v1h-6zM4 4h8v1h-8zM2 5h10v1h-10zM4 6h8v1h-8zM6 7h6v1h-6zM8 8h4v1h-4zM10 9h2v1h-2z"/></svg>`;

function greeting() {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone(), hour: 'numeric', hour12: false }).format(new Date())) % 24;
  const who = ownerKnown() ? `, ${ownerName()}` : '';
  return h < 12 ? `Morning${who}.` : h < 17 ? (who ? `Hi${who}.` : 'Hello.') : `Evening${who}.`;
}

// the owner can close the bubble. It stays closed until Orchy says something new or something starts waiting on the owner.
const BUBBLE_CLOSED = 'jos-bubble-closed';
const closedBubble = () => { try { return localStorage.getItem(BUBBLE_CLOSED); } catch { return null; } };
function setClosedBubble(key) { try { key ? localStorage.setItem(BUBBLE_CLOSED, key) : localStorage.removeItem(BUBBLE_CLOSED); } catch {} }

function renderBubble() {
  const box = $('#bubble');
  const last = [...state.chat].reverse().find(m => m.role === 'orchy');
  const fresh = last && Date.now() - Date.parse(last.at) < 3 * 3600_000;
  const waiting = pendingInbox().length;
  const key = `${fresh ? last.id : `hello-${new Date().toDateString()}`}|${waiting}`;
  if (closedBubble() === key) { box.innerHTML = ''; return; }
  const isGreeting = fresh && last.meta?.kind === 'greeting';
  const runId = fresh ? last.meta?.runId : null;
  box.innerHTML = `<div class="bubble">${TAIL}
    <button class="bubble-x" type="button" data-bubble-close="${esc(key)}" aria-label="Close Orchy's message" title="Close">${icon('close')}</button>
    ${isGreeting ? `<h2 class="px2">${esc(greeting())}</h2><div class="said">${md(last.text)}</div>`
    : fresh ? `<div class="who">Orchy <time>${timeShort(last.at)}</time>${last.meta?.workspace ? `<span class="plate ${wsClass(last.meta.workspace)}">${esc(wsShort(last.meta.workspace))}</span>` : ''}</div>
      <div class="said">${md(last.text)}</div>`
    : `<h2 class="px2">${esc(greeting())}</h2><p>What should ${esc(clientList())} get done? Type it below, or press <b>Call</b> and talk it through.</p>`}
    ${state.workspaces.length ? '' : `<p>Nothing is set up yet: add a workspace and your first agent, and Orchy can start routing work.</p><div class="links"><button class="btn primary" type="button" data-setup>${icon('plus')}Set up Orchy</button></div>`}
    ${waiting ? `<button class="btn decide" data-next-decision>${icon('bang')}${waiting === 1 ? '1 thing needs you' : `${waiting} things need you`}</button>` : ''}
    ${isGreeting ? `<div class="links"><button class="btn sm" data-hear>${icon('speaker')}Hear it</button></div>`
    : fresh ? `<div class="links">${last.meta?.huddleId ? `<button class="btn sm" data-huddle="${esc(last.meta.huddleId)}"${last.meta.kind === 'huddle-agreed' ? ' data-proposal="1"' : ''}>${icon(last.meta.kind === 'huddle-agreed' ? 'check' : 'chat')}${last.meta.kind === 'huddle-agreed' ? 'Review the agreement' : 'Open the huddle'}</button>${last.meta.huddleSession && last.meta.huddleSession !== last.session ? `<button class="btn sm ghost" data-open-session="${esc(last.meta.huddleSession)}">${icon('chat')}Its session</button>` : ''}` : ''}${last.meta?.callBack ? callBackHTML(last.meta.callBack) : ''}${runId ? `<button class="btn sm${last.meta?.callBack ? ' ghost' : ''}" data-run="${esc(runId)}">${icon('eye')}${last.meta?.callBack ? 'The task' : 'Full report'}</button>` : ''}${last.meta?.recover && state.runs.get(last.meta.recover.runId) ? recoverButtons(state.runs.get(last.meta.recover.runId)) : ''}<button class="btn sm ghost" data-show-convo="${esc(last.session || '')}">${icon('chat')}Conversation</button></div>` : ''}
  </div>`;
}

// ── the daily greeting: a new funny hello each day, said when Orchy starts at sign-in ──
async function greet({ force = false } = {}) {
  let g;
  try { g = await api('/api/greeting', { method: 'POST' }); } catch { return; }
  let said = null;
  try { said = localStorage.getItem('jos-greeted'); } catch {}
  if (!force && said === g.date) return;
  if (!state.chat.some(m => m.id === g.messageId)) {
    const m = { id: g.messageId, role: 'orchy', text: g.text, at: g.at, meta: { kind: 'greeting' } };
    state.chat.push(m);
    appendMsg(m);
  }
  setClosedBubble(null);
  renderBubble();
  state.orchy.happyUntil = Date.now() + 4500; // a celebratory hop while saying hello
  voice.speak(g.text);
  try { localStorage.setItem('jos-greeted', g.date); } catch {}
}

// Notices under the chat box can be closed; a closed one stays closed in this browser until what it says changes.
const DISMISSED = 'orchy-dismissed';
const dismissedNotices = () => { try { return JSON.parse(localStorage.getItem(DISMISSED) || '[]'); } catch { return []; } };
function dismissNotice(key) { try { localStorage.setItem(DISMISSED, JSON.stringify([...new Set([...dismissedNotices(), key])].slice(-50))); } catch {} }

function renderUnder() {
  const closed = new Set(dismissedNotices());
  const check = (key, title, text, extra = '') => closed.has(key) ? '' : `<div class="check todo"><span class="box"></span><span class="t"><b>${title}</b>${text}</span><span class="btnrow">${extra}<button class="dismiss" type="button" data-dismiss="${esc(key)}" aria-label="Close this notice" title="Close">${icon('close')}</button></span></div>`;
  const problems = [];
  for (const ws of state.workspaces.filter(w => w.enabled !== false)) {
    const a = ws.account || {};
    if (a.ok) continue;
    problems.push(check(`login:${ws.id}:${a.expected || ''}:${a.actual || ''}`, `${esc(ws.name)} runs as ${esc(a.expected || '')}`,
      `${a.loggedIn ? `Its ${esc(a.runtimeLabel || '')} profile is logged in as ${esc(a.actual || 'another account')}.` : a.hint ? esc(a.hint) : `Its ${esc(a.runtimeLabel || '')} profile isn’t logged in yet.`} Paste into a terminal (PowerShell on Windows):<code>${esc(a.fix || '')}</code>`,
      `<button class="btn sm" data-login="${esc(ws.id)}">Log in</button><button class="btn sm" data-copy="${esc(a.fix || '')}">Copy</button>`));
  }
  // voice on but the service it speaks with has no key yet
  const vp = voice.voiceConfig().provider;
  const vName = { elevenlabs: 'ElevenLabs', deepgram: 'Deepgram' }[vp];
  const vKey = vp === 'elevenlabs' ? state.envStatus.ELEVENLABS_API_KEY : vp === 'deepgram' ? state.envStatus.DEEPGRAM_API_KEY : state.envStatus.DEEPGRAM_API_KEY || state.envStatus.ELEVENLABS_API_KEY;
  if (voice.voiceOn() && !vKey) problems.push(check(`voice:${vp || 'any'}`, 'Voice', `Add ${vName ? `your ${vName}` : 'an ElevenLabs or Deepgram'} key in Settings, or switch voice off there. Until then I use the browser’s voice.`, `<button class="btn sm" data-open="settings">Settings</button>`));
  $('#composer-under').innerHTML = `
    <div class="keys"><span><kbd>/</kbd>type</span><span data-voice><kbd>Ctrl</kbd><kbd>Space</kbd>call</span><span><kbd>Enter</kbd>send</span></div>
    ${problems.some(Boolean) ? `<div class="checklist">${problems.join('')}</div>` : ''}`;
}

// ─────────────── Orchy: home stage, his pane head, the top bar mark ───────────────
let tick = 0;
function orchyState() {
  const o = state.orchy;
  if (o.speaking) return 'speaking';
  if (o.server === 'routing' || o.server === 'thinking') return o.server;
  if (pendingInbox().length) return 'alert';
  if (Date.now() < o.happyUntil) return 'happy';
  return 'idle';
}

// Joy, in bursts: three hops with arms up, a landing, then a few seconds of standing and blinking.
const HOP = [
  { pose: 'crouch', dy: 0, floor: 11 },
  { pose: 'up', dy: -2, floor: 7 },
  { pose: 'up', dy: -3, floor: 5, sparkle: true, accentAntenna: true },
  { pose: 'up', dy: -2, floor: 7 },
];
function stageFrame(st, t) {
  if (st !== 'idle' && st !== 'happy') return { state: st, pose: 'stand', floor: 9 };
  if (reduced()) return { state: 'happy', pose: 'stand', floor: 9 };
  const cycle = st === 'happy' ? 13 : 45; // just finished something: hop without resting
  const f = t % cycle;
  if (f < 12) return HOP[f % 4];
  if (f === 12) return HOP[0];
  return { state: 'idle', pose: 'stand', floor: 9 };
}

let lastStage = '', lastMini = '';
function tickOrchy() {
  tick++;
  const st = orchyState();
  if (view.mode === 'home') {
    const svg = orchyStageSVG({ ...stageFrame(st, tick), tick, label: `Orchy is ${st === 'idle' ? 'happy' : st}` });
    if (svg !== lastStage) { $('#orchy').innerHTML = svg; lastStage = svg; }
  } else {
    const svg = orchyTopbarSVG(st, tick);
    if (svg !== lastMini) { $('#orchy-mini').innerHTML = svg; lastMini = svg; }
  }
}

const STATE_WORDS = { idle: 'ready', speaking: 'talking', routing: 'asking Jev', thinking: 'thinking', alert: 'needs you', happy: 'done!', watching: 'watching', offline: 'reconnecting…' };
function doingText() {
  const o = state.orchy;
  if (o.server === 'routing') return 'Asking Jev which client, agent and model this needs…';
  if (o.server === 'thinking') return 'Thinking it through…';
  const p = openProposals().at(-1);
  if (p?.choice?.intent === 'fix_orchy') return 'That’s about me. Press Fix it on the card and I’ll work on my own code.';
  if (p) return p.routing?.needsChoice && !p.held ? 'Jev isn’t sure where this goes. Pick on the card below.' : `Jev picked ${wsName(p.choice.workspace)}. ${p.dispatchAt ? 'Handing it over in a moment.' : 'Press Send now when you’re ready.'}`;
  const waiting = pendingInbox();
  if (waiting.length) return `Waiting on you: ${waiting.length === 1 ? `${itemName(waiting[0])} ${waiting[0].kind === 'approval' ? 'needs your OK' : 'has a question'}` : `${waiting.length} things`}.`;
  const live = liveRuns();
  if (live.length === 1) return `Watching ${runName(live[0])} work in ${wsName(live[0].workspace)}.`;
  if (live.length > 1) return `Watching ${live.length} agents work: ${[...new Set(live.map(r => wsName(r.workspace)))].join(' and ')}.`;
  if (o.speaking) return 'Telling you what happened.';
  const last = [...state.chat].reverse().find(m => m.role === 'orchy');
  if (last && Date.now() - Date.parse(last.at) < FOLD_MS * 2) return String(last.text).replace(/[*_`#>]/g, '').split(/(?<=[.!?])\s/)[0].slice(0, 160);
  return 'Ready for the next thing.';
}
function tickDoing() {
  const st = !state.orchy.online ? 'offline' : view.mode === 'work' && liveRuns().length && orchyState() === 'idle' ? 'watching' : orchyState();
  const s = $('#orchy-status');
  if (s.dataset.state !== st) { s.dataset.state = st; s.querySelector('span').textContent = STATE_WORDS[st] || st; }
  const line = doingText();
  const el = $('#orchy-doing');
  if (el.textContent !== line) el.textContent = line;
}

// ─────────────── the conversation ───────────────
function miniRoute(r) {
  const bar = (label, v, cls, pick) => `<div class="bar ${cls} ${pick ? 'pick' : ''}"><span class="lbl">${esc(label)}</span><span class="trk"><span class="fill" style="clip-path:inset(0 ${100 - Math.round((v ?? 0) * 100)}% 0 0)"></span></span><span class="pct">${v == null ? '–' : Math.round(v * 100) + '%'}</span></div>`;
  const by = r.source === 'heuristic' ? 'best guess' : r.overridden ? 'Jev, adjusted by you' : r.live ? 'Jev, as you typed' : 'Jev';
  const ids = Object.keys(r.client || {}).length ? Object.keys(r.client) : enabledIds();
  return `<div class="route mini">
    <div class="rh"><span>${icon(r.intent === 'fix_orchy' ? 'term' : 'send')} ${r.intent === 'fix_orchy' ? 'Fix Orchy' : `${esc(wsShort(r.workspace))} · ${esc(/generalist$/.test(r.agentLabel) ? 'generalist' : r.agentLabel)}`} · ${esc(r.model)}</span><span>${esc(by)}${r.ms ? ` ${(r.ms / 1000).toFixed(1)}s` : ''}</span></div>
    ${r.intent === 'fix_orchy' ? '' : `<div class="minibars">${ids.map(w => bar(wsShort(w), r.client?.[w], wsClass(w), r.workspace === w)).join('')}</div>`}
  </div>`;
}

/** A file the owner gave Orchy, as it sits in the conversation: opens in the viewer (Ctrl/middle click: a new tab). */
function fileLinkHTML(f) {
  const href = esc(uploadURL(f.name));
  const view = `data-view-upload="${esc(f.name)}" data-size="${Number(f.size) || ''}"`;
  if (f.kind === 'image') return `<a class="mfile img" href="${href}" target="_blank" rel="noopener" title="${esc(f.name)}" ${view}><img src="${href}" alt="${esc(f.name)}" loading="lazy"></a>`;
  return `<a class="mfile" href="${href}" target="_blank" rel="noopener" title="Open ${esc(f.name)}" ${view}>${icon(kindIcon(kindFor(f.name)))}<span class="t">${esc(f.name)}</span><span class="sz">${fsize(f.size)}</span></a>`;
}

/** A missed call from an agent: ring it back (with the call's reason while it's fresh). */
const callBackHTML = cb => `<button class="btn sm" data-call-back="${esc(cb.callId)}" data-key="${esc(cb.key)}" data-name="${esc(cb.name)}">${icon('phone')}Call back</button>`;

// the weekly usage review's one-tap actions (usagereview.mjs): the builder with the change prefilled, a setting, a run
function suggestHTML(list) {
  if (!Array.isArray(list) || !list.length) return '';
  return list.map(s => {
    const a = s.action || {}, label = `${s.n ? `${s.n}. ` : ''}${esc(s.label || 'Do it')}`;
    if (a.type === 'build') return `<button class="btn sm" data-suggest-build="${esc(a.ws)}" data-text="${esc(a.text)}">${icon('spark')}${label}</button>`;
    if (a.type === 'setting') return `<button class="btn sm ghost" data-suggest-set="${esc(a.key)}" data-value="${esc(JSON.stringify(a.value))}">${icon('gear')}${label}</button>`;
    if (a.type === 'run') return `<button class="btn sm ghost" data-run="${esc(a.runId)}">${icon('eye')}${label}</button>`;
    return '';
  }).join('');
}

function msgHTML(m) {
  if (m.role === 'owner') {
    const files = m.meta?.files?.length ? `<div class="mfiles">${m.meta.files.map(fileLinkHTML).join('')}</div>` : '';
    return `<div class="msg owner" data-msg="${esc(m.id)}"><div><div class="who"><time>${timeShort(m.at)}</time>${m.meta?.viaVoice ? icon('mic') : ''}You</div>${files}${m.text ? `<div class="bubble-owner body">${esc(m.text)}</div>` : ''}</div></div>`;
  }
  const run = m.meta?.runId ? state.runs.get(m.meta.runId) : null;
  // Orchy fixed his own code: restart now (it's waiting, or the fix stopped short), reload the page, or undo it
  const fixed = m.meta?.fix?.runId ? state.runs.get(m.meta.fix.runId) : null;
  // what went wrong (recover.mjs): the owner's one-move card; and Orchy's check found something (validate.mjs): Ask it to fix
  const recRun = m.meta?.recover?.runId ? state.runs.get(m.meta.recover.runId) : null;
  const recBtns = recRun ? recoverButtons(recRun) : '';
  const fixAsk = m.meta?.kind === 'report' && run && !m.meta?.recover && ['check', 'failed'].includes(run.validation?.verdict) ? `<button class="btn sm" data-fix-ask="${esc(run.id)}">${icon('edit')}Ask it to fix</button>` : '';
  const fixBtns = recBtns + fixAsk + suggestHTML(m.meta?.suggestions) + (!m.meta?.fix ? '' : [
    fixed && ['queued', 'offer'].includes(fixed.fix?.restart) && !fixed.undoneAt ? `<button class="btn sm primary" data-fix-restart="${esc(fixed.id)}">${icon('refresh')}Restart now</button>` : '',
    m.meta.fix.reload ? `<button class="btn sm" data-reload>${icon('refresh')}Reload the dashboard</button>` : '',
    fixed?.backendChanges?.length && !fixed.undoneAt && fixed.fix?.restart !== 'rolled-back' ? `<button class="btn sm ghost" data-fix-undo="${esc(fixed.id)}">${icon('x')}Undo the fix</button>` : '',
  ].join(''));
  return `<div class="msg ${m.meta?.error ? 'error' : ''}" data-msg="${esc(m.id)}">
    <div class="av">${orchySVG('idle', 1, { label: 'Orchy' })}</div>
    <div>${m.meta?.routing ? miniRoute(m.meta.routing) : ''}<div class="who">Orchy <time>${timeShort(m.at)}</time>${m.meta?.workspace ? `<span class="plate ${wsClass(m.meta.workspace)}">${esc(wsName(m.meta.workspace))}</span>` : ''}</div>
      <div class="body">${md(m.text)}</div>
      ${m.meta?.result ? `<div class="result md">${md(m.meta.result)}</div>` : ''}
      ${m.meta?.missionId ? (m.meta.kind === 'mission' ? missionSlotHTML(m.meta.missionId) : missionLineHTML(state.missions.get(m.meta.missionId), m)) : m.meta?.huddleId ? `<div class="links"><button class="btn sm ${m.meta.kind === 'huddle-agreed' ? 'primary' : ''}" data-huddle="${esc(m.meta.huddleId)}"${m.meta.kind === 'huddle-agreed' ? ' data-proposal="1"' : ''}>${icon(m.meta.kind === 'huddle-agreed' ? 'check' : 'chat')}${m.meta.kind === 'huddle-agreed' ? 'Review the agreement' : 'Open the huddle'}</button>${m.meta.huddleSession && m.meta.huddleSession !== m.session ? `<button class="btn sm ghost" data-open-session="${esc(m.meta.huddleSession)}">${icon('chat')}Go to its session</button>` : ''}</div>` : m.meta?.callBack ? `<div class="links">${callBackHTML(m.meta.callBack)}${m.meta.runId ? `<button class="btn sm ghost" data-run="${esc(m.meta.runId)}">${icon('eye')}The task</button>` : ''}</div>` : m.meta?.runId ? `<div class="links">${m.meta.kind === 'report' ? `<button class="btn sm" data-run="${esc(m.meta.runId)}">${icon('eye')}Full report</button>` : `<button class="btn sm" data-live-run="${esc(m.meta.runId)}">${icon('live')}View live</button>`}${m.meta.kind === 'dispatch' && m.meta.routing?.live && run && LIVE.has(run.status) ? `<button class="btn sm" data-stop="${esc(run.id)}">${icon('stop')}Stop</button>` : ''}${m.meta.kind === 'report' ? `<button class="btn sm ghost" data-open="logs">${icon('logs')}Logs</button>` : ''}${run?.createdAgents?.length ? run.createdAgents.map(a => `<button class="btn sm" data-agent="${esc(a.slug)}" data-ws="${esc(run.workspace)}">${icon('spark')}Meet ${esc(a.slug)}</button>`).join('') : ''}${fixBtns}</div>` : fixBtns ? `<div class="links">${fixBtns}</div>` : ''}
    </div></div>`;
}

// the conversation on screen is the active session's
function renderConvo() {
  const c = $('#convo');
  c.innerHTML = state.chat.filter(m => m.session === view.active).map(msgHTML).join('')
    || `<div class="empty"><strong>New session</strong>Tell Orchy what to do. Your other sessions keep going in their tabs.</div>`;
  for (const p of state.proposals.values()) if (p.session === view.active) c.appendChild(routeCard(p));
  scrollConvo(true);
}

function appendMsg(m) {
  if (m.session !== view.active) return;
  $('#convo > .empty')?.remove();
  $('#convo').insertAdjacentHTML('beforeend', msgHTML(m));
  scrollConvo();
}

function scrollConvo(force) {
  const c = $('#convo');
  const near = c.scrollHeight - c.scrollTop - c.clientHeight < 240;
  if (force || near) requestAnimationFrame(() => { c.scrollTop = c.scrollHeight; });
}

// ── Jev routing card (the signature move) ──
function agentLabel(key) {
  const [ws, slug] = key.split('/');
  if (slug === 'general') return `${wsName(ws)} generalist`;
  return agentName(ws, slug, state.agents.find(a => a.workspace === ws && a.slug === slug)?.displayName);
}

/** On the Fix Orchy card: Orchy has no Claude Code account of his own yet (a fresh install), or it isn't signed in. */
function fixAccountHTML() {
  const a = backendInfo().account;
  if (!a || a.ok) return '';
  if (!a.expected) {
    return `<div class="fixbar"><b>I need a Claude Code account to work on my own code.</b>
      <span>${a.suggested ? `Claude Code on this computer is signed in as <b>${esc(a.suggested)}</b>. Use that account for my fixes?` : 'Sign in to Claude Code on this computer first (in a terminal: claude auth login), then pick the account in Settings → Accounts.'}</span>
      <span class="btnrow">${a.suggested ? `<button class="btn sm primary" type="button" data-backend-use="${esc(a.suggested)}">${icon('check')}Use ${esc(a.suggested)}</button>` : ''}<button class="btn sm" type="button" data-open="settings">Settings</button></span></div>`;
  }
  return `<div class="fixbar"><b>I fix myself as ${esc(a.expected)}, but ${a.loggedIn ? `Claude Code is signed in as ${esc(a.actual || 'another account')}` : 'that Claude Code profile isn’t signed in'}.</b>
    <span class="btnrow"><button class="btn sm" type="button" data-login="orchy">Log in</button><button class="btn sm" type="button" data-open="settings">Settings</button></span></div>`;
}

function routeCard(p) {
  const el = document.createElement('article');
  el.className = 'route';
  el.dataset.proposal = p.id;
  fillRoute(el, p);
  return el;
}

function fillRoute(el, p) {
  const r = p.routing || {};
  const ch = p.choice || {};
  const pr = r.probabilities || {};
  const done = p.status !== 'proposed';
  el.classList.toggle('done', done);
  el.classList.toggle('needs', !done && !!r.needsChoice && !p.held);
  const intentLabel = { task: 'Task', build_agent: 'Build an agent', chat: 'Chat', status: 'Status', huddle: 'Huddle', fix_orchy: 'Fix Orchy', mission: 'Mission' }[ch.intent] || ch.intent;
  const huddle = ch.intent === 'huddle';
  const fix = ch.intent === 'fix_orchy'; // Orchy works on his own code (server: backend.mjs)
  const pair = huddle ? (ch.huddle || []) : [];
  // every agent of the picked workspace can huddle, its AI Agent Builder included
  const huddlers = state.agents.filter(a => a.workspace === ch.workspace && !a.error);
  const wsBars = enabledIds().map(w => ({ w, v: pr.workspace?.[w] ?? (ch.workspace === w ? 1 : 0) }));
  const agentsInWs = state.agents.filter(a => a.workspace === ch.workspace && !a.isBuilder);
  // an agent pinned to its own engine (e.g. Codex in a Claude workspace) offers that engine's models
  const pinned = ch.intent === 'task' && ch.agent ? agentsInWs.find(a => a.slug === ch.agent && a.engine) : null;
  const wsId = ch.workspace || defaultWs();
  const models = pickModels(wsId, pinned);
  const useDropdown = wsUsesModelDropdown(wsId, pinned);
  const typeable = takesModelId(wsId, pinned); // Hermes, OpenCode: any provider/model id, listed or not
  const plan = wsPlan(wsId, pinned);
  const agentBars = Object.entries(pr.agent || {}).sort((a, b) => b[1] - a[1]).slice(0, 3);

  if (done) {
    const head = p.missionId ? `Planning it as a mission in ${wsName(ch.workspace)}` : p.huddleId ? `Huddle started in ${wsName(ch.workspace)}` : p.status === 'dispatched' && fix ? `Orchy is fixing himself · ${ch.model}` : p.status === 'dispatched' ? `Sent to ${wsName(ch.workspace)} · ${ch.intent === 'build_agent' ? 'AI Agent Builder' : ch.agent ? agentLabel(`${ch.workspace}/${ch.agent}`) : 'generalist'} · ${ch.model}`
      : p.status === 'cancelled' ? 'Cancelled' : p.status === 'answered' ? 'Answered in the chat instead' : p.status === 'dispatching' ? 'Sending…' : `Couldn't send: ${p.error || ''}`;
    el.innerHTML = `<div class="rh"><span>${icon(p.status === 'cancelled' || p.status === 'error' ? 'x' : p.status === 'answered' ? 'chat' : 'send')} ${esc(head)}</span>${p.runId ? `<button class="btn sm" style="border-color:var(--paper);background:var(--ink);color:var(--paper)" data-run="${esc(p.runId)}">Watch</button>` : ''}</div>`;
    return;
  }

  // why Jev left the card for the owner (router.mjs#finalize holdReason)
  const unsureHead = { fix: 'Fix Orchy? · your go', huddle: 'Which agents? · pick two or more', 'chat-or-task': 'Answer, or get it done? · pick one', agent: 'Jev isn’t sure which agent · pick one', workspace: 'Jev isn’t sure which client · pick one' }[r.holdReason] || 'Jev isn’t sure · pick one';
  const prev = ch.followUp ? state.runs.get(ch.followUp) : null;
  const choices = modelChoices(models);
  // the dropdown shows exactly what will be sent: the card's model, else "default"
  const pickedModel = startModel(ch.model);
  el.innerHTML = `
    <div class="rh"><span>${r.needsChoice && !p.held ? unsureHead : `Jev routed${r.jev ? ` · ${(r.jev.ms / 1000).toFixed(1)}s` : ''}`}</span><span>${esc(ch.followUp ? 'Follow-up' : intentLabel)}</span></div>
    <div class="rb">
      <q>${esc(p.text)}</q>
      ${p.files?.length && !fix ? `<p class="hint">${icon('clip')} ${p.files.length === 1 ? 'Your file goes' : `Your ${p.files.length} files go`} along: ${esc(p.files.join(', '))}</p>` : ''}
      ${ch.followUp ? `<div class="btnrow" style="justify-content:space-between;align-items:center"><span class="hint">${icon('refresh')} Continues ${fix ? 'my last fix' : `${esc(prev ? runName(prev) : 'an earlier run')}’s run`}${prev ? `: “${esc(prev.instruction.length > 90 ? `${prev.instruction.slice(0, 89)}…` : prev.instruction)}”` : ''}, in the same conversation${fix ? '' : ' and task folder'}</span><button type="button" class="btn sm" data-route-act="fresh">Start fresh</button></div>` : ''}
      ${fix ? `<p class="hint">${icon('term')} I’d work on my own code: the server, the dashboard and the scripts. I snapshot it first, I can’t touch clients’ folders, and changes to my safety rules wait for your OK. If the fix needs a restart I do it myself, and if I wouldn’t start I put the old code back.${p.files?.length ? ` ${p.files.length === 1 ? 'Your file comes' : 'Your files come'} along.` : ''}</p>${fixAccountHTML()}` : `<div class="bars"><div class="bh"><span>Client</span><span>${r.source === 'heuristic' ? 'best guess (Jev offline)' : ''}</span></div>
        ${wsBars.map(({ w, v }) => `<div class="bar ${wsClass(w)} ${ch.workspace === w ? 'pick' : ''}"><span class="lbl">${esc(wsName(w))}</span><span class="trk"><span class="fill" data-w="${Math.round(v * 100)}"></span></span><span class="pct">${Math.round(v * 100)}%</span></div>`).join('')}
      </div>
      ${agentBars.length && ch.intent === 'task' && !ch.followUp ? `<div class="bars"><div class="bh"><span>Agent</span></div>
        ${agentBars.map(([k, v]) => `<div class="bar ${k === `${ch.workspace}/${ch.agent || 'general'}` ? 'pick' : ''}"><span class="lbl">${esc(agentLabel(k))}</span><span class="trk"><span class="fill" data-w="${Math.round(v * 100)}"></span></span><span class="pct">${Math.round(v * 100)}%</span></div>`).join('')}</div>` : ''}`}
      <div class="choose">
        <div class="rowc"><span class="label">Client</span><div class="seg" role="group" aria-label="Client">${enabledIds().map(w => `<button type="button" data-set="workspace" data-v="${esc(w)}" aria-pressed="${ch.workspace === w}" title="${esc(wsName(w))}">${esc(wsShort(w))}</button>`).join('')}</div>
          <span class="label">Do</span><div class="seg" role="group" aria-label="Intent">${[['task', 'Task'], ...(state.missionsOn ? [['mission', 'Mission']] : []), ['build_agent', 'Build agent'], ['huddle', 'Huddle'], ['fix_orchy', 'Fix Orchy']].map(([v, l]) => `<button type="button" data-set="intent" data-v="${v}" aria-pressed="${ch.intent === v}">${l}</button>`).join('')}</div></div>
        <div class="rowc">${huddle ? `<span class="label">Who</span>${Array.from({ length: Math.min(huddlers.length, Math.max(2, pair.length + 1)) }, (_, i) => `<select class="select" data-hpick="${i}" style="width:auto;min-height:32px;padding:2px 8px" aria-label="Huddle agent ${i + 1}"><option value="">${i < 2 ? 'pick an agent' : '+ add an agent'}</option>${huddlers.filter(a => a.slug === pair[i] || !pair.includes(a.slug)).map(a => `<option value="${esc(a.slug)}" ${pair[i] === a.slug ? 'selected' : ''}>${esc(nameRole(agentName(a.workspace, a.slug, a.displayName), a.displayName))}</option>`).join('')}</select>`).join('<span aria-hidden="true">⇄</span>')}` : ''}${ch.intent === 'task' ? `<span class="label">Agent</span><select class="select" data-set-select="agent" style="width:auto;min-height:32px;padding:2px 8px" aria-label="Agent"><option value="">${esc(wsName(ch.workspace || ''))} generalist</option>${agentsInWs.map(a => `<option value="${esc(a.slug)}" ${ch.agent === a.slug ? 'selected' : ''}>${esc(nameRole(agentName(a.workspace, a.slug, a.displayName), a.displayName))}</option>`).join('')}</select>` : ''}
          ${huddle ? '' : `<span class="label">${pinned ? `${esc(pinned.engineLabel)} model` : 'Model'}</span>${useDropdown
            ? `<select class="select" data-set-model-select style="width:auto;min-height:32px;padding:2px 8px" aria-label="Model">${dropdownModels(choices, pickedModel).map(m => `<option value="${esc(m)}" ${pickedModel === m ? 'selected' : ''}>${esc(m === 'default' ? 'Default (tier automatic)' : m)}</option>`).join('')}</select>${typeable ? `<input class="input" data-set-model type="text" spellcheck="false" autocomplete="off" placeholder="or type a model id, e.g. provider/model" aria-label="Model id" title="${choices.some(m => m !== 'default') ? 'Any model this harness takes, listed or not' : 'Orchy found no model list for this account yet (sign it in, then Re-check accounts). Any model id it takes works here.'}" style="min-width:14ch;max-width:26ch">` : ''}${plan ? `<span class="chip" title="Detected account plan / tier">${esc(plan)}</span>` : ''}`
            : `<div class="seg" role="group" aria-label="Model">${choices.map(m => `<button type="button" data-set="model" data-v="${esc(m)}" aria-pressed="${ch.model === m}" title="${esc(m)}">${esc(m.replace(/^gpt-/, ''))}</button>`).join('')}</div>${modelIsFree(models) ? `<input class="input" data-set-model type="text" spellcheck="false" autocomplete="off" placeholder="or a model id, e.g. provider/model" aria-label="Model id" value="${ch.model && ch.model !== 'default' ? esc(ch.model) : ''}" style="min-width:14ch;max-width:26ch">` : ''}`}`}</div>
      </div>
    </div>
    <div class="rf"><span class="countdown" data-cd>${p.dispatchAt ? '' : p.held ? 'Held · press send' : r.needsChoice ? 'Waiting for you' : 'Press send'}</span>
      <span class="btnrow"><button class="btn sm" data-route-act="cancel">${icon('x')}Cancel</button>${r.askChat ? `<button class="btn sm" data-route-act="answer">${icon('chat')}Just answer</button>` : ''}<button class="btn sm primary" data-route-act="send" ${ch.workspace && (!huddle || (pair.length >= 2 && new Set(pair).size === pair.length)) ? '' : 'disabled'}>${icon(fix ? 'term' : 'send')}${huddle ? 'Start the huddle' : fix ? 'Fix it' : 'Send now'}</button></span></div>`;

  requestAnimationFrame(() => requestAnimationFrame(() => el.querySelectorAll('.fill').forEach(f => { f.style.clipPath = `inset(0 ${100 - Number(f.dataset.w)}% 0 0)`; })));

  el.querySelectorAll('[data-set]').forEach(b => b.addEventListener('click', () => patchRoute(p.id, { [b.dataset.set]: b.dataset.v })));
  el.querySelector('[data-set-model]')?.addEventListener('change', e => patchRoute(p.id, { model: e.target.value.trim() || 'default' }));
  el.querySelector('[data-set-model-select]')?.addEventListener('change', e => patchRoute(p.id, { model: e.target.value }));
  el.querySelector('[data-set-select]')?.addEventListener('change', e => patchRoute(p.id, { agent: e.target.value || null }));
  el.querySelector('[data-backend-use]')?.addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const b = await api('/api/backend/account', { method: 'POST', body: { account: btn.dataset.backendUse } });
      setWorkspaces(null, null, b);
      fillRoute(el, state.proposals.get(p.id) || p);
      toast(b.account?.ok ? `I’ll fix myself as ${b.account.expected}.` : `Saved. ${b.account?.error || 'Sign that account in to Claude Code, then press Fix it.'}`, b.account?.ok ? '' : 'warn');
    } catch (err) { toast(err.message, 'warn'); btn.disabled = false; }
  });
  el.querySelectorAll('[data-hpick]').forEach(sel => sel.addEventListener('change', () => patchRoute(p.id, { huddle: [...el.querySelectorAll('[data-hpick]')].map(x => x.value).filter(Boolean) })));
  el.querySelector('[data-route-act="send"]').addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try { await api(`/api/routing/${p.id}/dispatch`, { method: 'POST', body: {} }); } catch (err) { toast(err.message, 'warn'); btn.disabled = false; }
  });
  el.querySelector('[data-route-act="cancel"]').addEventListener('click', () => api(`/api/routing/${p.id}/cancel`, { method: 'POST' }).catch(err => toast(err.message, 'warn')));
  el.querySelector('[data-route-act="answer"]')?.addEventListener('click', () => api(`/api/routing/${p.id}/answer`, { method: 'POST' }).then(upsertProposal).catch(err => toast(err.message, 'warn')));
  el.querySelector('[data-route-act="fresh"]')?.addEventListener('click', () => patchRoute(p.id, { followUp: null }));
}

async function patchRoute(id, body) {
  try { const p = await api(`/api/routing/${id}`, { method: 'PATCH', body }); upsertProposal(p); } catch (e) { toast(e.message, 'warn'); }
}

function upsertProposal(p) {
  const before = state.proposals.get(p.id);
  state.proposals.set(p.id, p);
  let el = document.querySelector(`[data-proposal="${CSS.escape(p.id)}"]`);
  if (!el && p.session === view.active) { $('#convo > .empty')?.remove(); el = routeCard(p); $('#convo').appendChild(el); scrollConvo(true); }
  else if (el) fillRoute(el, p);
  if (p.status !== 'proposed') state.proposals.delete(p.id);
  if (p.status === 'dispatched') el?.remove();
  wake(p.choice?.workspace);
  layout();
  renderPanes();
  renderSessions();
  if (p.choice?.workspace && before?.choice?.workspace !== p.choice.workspace) flashPane(p.choice.workspace);
}

function tickCountdowns() {
  tickMissionCountdowns();
  for (const p of state.proposals.values()) {
    if (!p.dispatchAt || p.status !== 'proposed') continue;
    const el = document.querySelector(`[data-proposal="${CSS.escape(p.id)}"] [data-cd]`);
    if (!el) continue;
    const total = p.routing.autoDispatchSeconds || 5;
    const left = Math.max(0, Math.ceil((Date.parse(p.dispatchAt) - Date.now()) / 1000));
    el.innerHTML = `Sending in <b class="num">${left}</b><span class="cd">${Array.from({ length: total }, (_, i) => `<i class="${i >= left ? 'spent' : ''}"></i>`).join('')}</span>`;
  }
}

// ─────────────── readouts, clock ───────────────
function renderReadouts() {
  const waiting = pendingInbox().length + missionAsks().length;
  const running = liveRuns().length;
  $('#waiting-n').textContent = waiting;
  $('#running-n').textContent = running;
  $('#waiting').classList.toggle('hot', waiting > 0);
  document.title = waiting ? `(${waiting}) Orchy` : 'Orchy';
}

function tickClock() {
  $('#clock').textContent = clockET();
  $('#shift').textContent = `${zoneShort()} · ${onShift(state.workHours) ? 'on shift' : 'off shift'}`;
  document.querySelectorAll('.timer[data-start]').forEach(t => { t.textContent = dur(Date.now() - Date.parse(t.dataset.start)); });
  layout(); // folds back home once things have been quiet for a minute
}

// ─────────────── files for Orchy: each lands in Uploads as soon as it's picked ───────────────
const attached = []; // { key, name, size, status: 'uploading' | 'ready' | 'error', file (its name in Uploads), kind }
const MAX_FILES = 10, MAX_BYTES = 50 * 1024 * 1024;
const fsize = n => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const uploadURL = name => `/api/uploads/${encodeURIComponent(name)}`;

function attachFiles(list) {
  for (const f of list) {
    if (attached.length >= MAX_FILES) { toast(`Up to ${MAX_FILES} files per message.`, 'warn'); break; }
    if (f.size > MAX_BYTES) { toast(`${f.name} is over 50 MB.`, 'warn'); continue; }
    // pasted screenshots all arrive as "image.png"
    const name = f.name && f.name !== 'image.png' ? f.name : `pasted-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
    const a = { key: Math.random().toString(36).slice(2), name, size: f.size, status: 'uploading' };
    attached.push(a);
    fetch('/api/uploads', { method: 'POST', headers: { ...ownerHeaders(), 'X-File-Name': encodeURIComponent(name), 'Content-Type': 'application/octet-stream' }, body: f })
      .then(async res => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
        Object.assign(a, { status: 'ready', file: data.name, kind: data.kind });
      })
      .catch(e => { a.status = 'error'; toast(`${name}: ${e.message}`, 'warn'); })
      .finally(renderAttachments);
  }
  renderAttachments();
  wake();
  layout();
  $('#command').focus();
}

function renderAttachments() {
  const box = $('#attachments');
  box.innerHTML = attached.map(a => `<span class="fchip ${a.status}">
    ${a.status === 'ready' && a.kind === 'image' ? `<img src="${esc(uploadURL(a.file))}" alt="">` : icon(a.status === 'error' ? 'bang' : 'doc')}
    <span class="t" title="${esc(a.file || a.name)}">${esc(a.file || a.name)}</span>
    <span class="sz">${a.status === 'uploading' ? 'saving…' : a.status === 'error' ? 'failed' : fsize(a.size)}</span>
    <button type="button" class="x" data-unattach="${esc(a.key)}" aria-label="Take ${esc(a.name)} off this message" title="Take it off this message (it stays in Uploads)">${icon('close')}</button>
  </span>`).join('');
  $('#command-form').classList.toggle('has-files', attached.length > 0);
  $('#command').placeholder = placeholder();
  renderLive();
}

// ─────────────── chat box + voice ───────────────
async function send(text, { viaVoice = false } = {}) {
  const clean = text.trim();
  if (attached.some(a => a.status === 'uploading')) return toast('Still saving your files. Send again in a moment.');
  const files = attached.filter(a => a.status === 'ready');
  if (!clean && !files.length) return;
  // from home it's a new session; in the work view it goes to the session on screen
  if (view.mode === 'home') startSession({ focus: false });
  const sid = view.active;
  const held = attached.splice(0);
  $('#command').value = '';
  renderAttachments();
  const busyWord = clean ? 'routing' : 'thinking'; // files with no words go straight to Orchy, not to Jev
  thinking.set(sid, busyWord);
  syncOrchy();
  wake();
  layout();
  renderSessions();
  // Jev's read of this very text as the owner typed it (made without the files, so not with them), and the client the owner picked on the live line, if any
  const read = !viaVoice && !files.length && live.res?.routing && liveNorm(live.res.text) === liveNorm(clean) ? live.res.slot : undefined;
  const pick = !viaVoice && clean ? live.pick : null;
  clearLive();
  try {
    const res = await api('/api/chat', { method: 'POST', body: { text: clean, viaVoice, session: sid, files: files.map(a => a.file), live: read, pick } });
    if (res.kind === 'proposal') { voice.chirp('route'); upsertProposal(res.proposal); }
  } catch (e) {
    toast(e.message, 'warn');
    if (thinking.get(sid) === busyWord) thinking.delete(sid);
    if (view.active === sid) { $('#command').value = clean; attached.push(...held); renderAttachments(); }
  } finally {
    // the server may already have moved Orchy on to 'thinking' (a reply in progress); keep that
    if (thinking.get(sid) === 'routing') thinking.delete(sid);
    syncOrchy();
    renderSessions();
    bump();
  }
}

// ── Jev reads as the owner types (server: livejev.mjs) ──
// After a pause (longer mid-word) the draft goes to /api/chat/live and Jev's pick shows under the box. Enter
// hands the read back (`live`), so a sure pick starts at once. Clicking the line picks the client yourself.
const live = { timer: null, settle: null, seq: 0, res: null, reading: false, pick: null, choosing: false };
const liveNorm = s => String(s || '').replace(/\s+/g, ' ').trim().replace(/[\s.!?…]+$/u, '');
const liveWords = s => (liveNorm(s).match(/[\p{L}\p{N}@]+/gu) || []).length;
const liveOn = () => state.settings.liveJev !== false;

function clearLive() {
  clearTimeout(live.timer); clearTimeout(live.settle);
  live.seq++;
  Object.assign(live, { res: null, reading: false, pick: null, choosing: false });
  renderLive();
}

function onDraft() {
  clearTimeout(live.timer); clearTimeout(live.settle);
  const text = $('#command').value;
  if (!text.trim()) return clearLive();
  renderLive();
  if (!liveOn() || attached.length || live.pick || liveWords(text) < (state.liveJev?.minWords || 3)) return;
  if (live.res && liveNorm(live.res.text) === liveNorm(text)) return;
  // a finished word reads sooner than a pause in the middle of one
  live.timer = setTimeout(() => readDraft(text), /[\p{L}\p{N}]$/u.test(text) ? 1000 : 550);
}

async function readDraft(text) {
  const seq = ++live.seq;
  const session = view.mode === 'home' ? null : view.active;
  live.reading = true;
  renderLive();
  try {
    const r = await api('/api/chat/live', { method: 'POST', body: { text, session } });
    if (seq !== live.seq || r.superseded || r.off || r.short || r.long) return;
    live.res = r;
    // still the same draft a moment later: Orchy warms the action plan for it
    if (r.routing) live.settle = setTimeout(() => {
      if (liveNorm($('#command').value) === liveNorm(text)) api('/api/chat/live', { method: 'POST', body: { text, session, settle: true } }).catch(() => {});
    }, 900);
  } catch { /* the line just stays as it was; Enter routes as usual */ }
  finally {
    if (seq === live.seq) { live.reading = false; renderLive(); }
  }
}

function liveWho(ch) {
  if (ch.intent === 'build_agent') return 'AI Agent Builder';
  return ch.agent ? agentLabel(`${ch.workspace}/${ch.agent}`) : 'generalist';
}

function renderLive() {
  const el = $('#jevline');
  const text = $('#command').value;
  if (!liveOn() || attached.length || !text.trim()) { el.hidden = true; el.innerHTML = ''; delete el.dataset.state; return; }
  el.hidden = false;
  const r = live.res;
  const rt = r?.routing;
  const stale = !!r && liveNorm(r.text) !== liveNorm(text);
  const meter = v => `<span class="jmeter" title="Jev is ${Math.round((v ?? 0) * 100)}% sure"><span class="trk"><span class="fill" style="clip-path:inset(0 ${100 - Math.round((v ?? 0) * 100)}% 0 0)"></span></span><span class="pct">${Math.round((v ?? 0) * 100)}%</span></span>`;
  const plate = ws => `<span class="plate ${wsClass(ws)}">${esc(wsShort(ws))}</span>`;
  let st = 'idle', body, tail = '', faint = false;

  if (live.pick) {
    st = 'pick';
    body = `${plate(live.pick.workspace)}<span class="who">${esc(liveWho({ intent: rt?.intent === 'build_agent' ? 'build_agent' : 'task', ...live.pick }))}</span><span class="by">your pick</span>`;
    tail = `<span class="go">${state.settings.liveStart === false ? 'Enter → card' : 'Enter<span class="long"> starts it</span>'}</span>`;
  } else if (r?.capped) {
    st = 'capped';
    body = `<span class="who">Jev stopped reading: ${r.capped === 'day' ? `${r.limits?.perDay} reads today` : `${r.limits?.perMessage} reads for this message`}</span>`;
    tail = `<button type="button" class="jlink" data-open="settings">Limits</button>`;
  } else if (!rt) {
    st = live.reading ? 'reading' : 'listening';
    body = `<span class="who">${live.reading ? 'reading…' : liveWords(text) < (state.liveJev?.minWords || 3) ? 'keep typing…' : 'listening…'}</span>`;
  } else {
    const sure = rt.confidence ?? 0;
    const prev = r.followUp ? state.runs.get(r.followUp.runId) : null;
    if (rt.intent === 'ignored') {
      st = 'held';
      body = `<span class="who">${esc(rt.switchedOff?.name || 'That workspace')} is switched off · left alone</span>`;
    } else if (rt.intent === 'chat' || rt.intent === 'status') {
      st = 'chat';
      body = `<span class="who">${r.quick ? 'status · answer ready' : rt.intent === 'status' ? 'status · Orchy answers' : 'chat · Orchy answers'}</span>`;
      tail = `<span class="go">Enter</span>`;
    } else if (rt.intent === 'huddle') {
      st = r.startsNow && rt.workspace ? 'go' : 'held';
      const who = (rt.huddle || []).map(s => agentLabel(`${rt.workspace}/${s}`));
      body = `${rt.workspace ? plate(rt.workspace) : ''}<span class="who">huddle · ${esc(who.length >= 2 ? who.join(' + ') : who[0] ? `${who[0]} + ?` : 'which agents?')}</span>${meter(sure)}`;
    } else if (rt.intent === 'mission' && rt.workspace) {
      // several agents in a row (missions.mjs): Enter plans it; the card shows the steps before anything runs
      st = 'go';
      body = `${plate(rt.workspace)}<span class="who">mission · several agents</span>${meter(sure)}`;
      tail = `<span class="go">Enter<span class="long"> plans it</span></span>`;
    } else if (rt.intent === 'fix_orchy') {
      st = 'held';
      body = `${plate(rt.workspace)}<span class="who">${r.followUp ? 'continues my last fix' : 'fix Orchy · my own code'}</span>${meter(sure)}`;
    } else if (r.followUp) {
      st = r.startsNow ? 'go' : 'held';
      body = `${plate(r.followUp.workspace)}<span class="who">continues ${esc(prev ? runName(prev) : 'an earlier run')}</span>${meter(sure)}`;
    } else if (rt.workspace) {
      st = r.startsNow ? 'go' : 'held';
      body = `${plate(rt.workspace)}<span class="who">${esc(liveWho(rt))}</span><span class="model">${esc(rt.model || '')}</span>${rt.askChat ? '' : meter(sure)}`;
    } else {
      st = 'held';
      body = `<span class="who">which client?</span>${meter(sure)}`;
    }
    if (st === 'go' && rt.intent !== 'mission') tail = `<span class="go">Enter<span class="long"> starts it</span></span>`;
    else if (st === 'held' && rt.intent !== 'ignored') {
      const why = { fix: 'you press Fix it', huddle: 'which agents?', workspace: 'pick a client', 'chat-or-task': 'answer or do it?', unsure: 'Jev isn’t sure', agent: 'which agent?' }[rt.holdReason] || (state.settings.autoDispatch === false ? 'you send it' : 'card first');
      tail = `<span class="plate decide">Waits · ${esc(why)}</span>`;
    }
    faint = sure < 0.6 && st !== 'chat';
  }
  if (faint) el.dataset.faint = ''; else delete el.dataset.faint;
  if (stale || live.reading) el.dataset.stale = ''; else delete el.dataset.stale;
  el.dataset.state = st;

  const canPick = enabledIds().length > 0 && st !== 'capped';
  const pickWs = live.pick?.workspace || rt?.workspace || r?.followUp?.workspace || defaultWs();
  const chooser = live.choosing ? `<div class="jchoose">
      <div class="seg" role="group" aria-label="Client">${enabledIds().map(w => `<button type="button" data-live-ws="${esc(w)}" aria-pressed="${live.pick?.workspace === w}">${esc(wsShort(w))}</button>`).join('')}</div>
      <select class="select" data-live-agent aria-label="Agent"><option value="">${esc(wsName(pickWs))} generalist</option>${state.agents.filter(a => a.workspace === pickWs && !a.isBuilder).map(a => `<option value="${esc(a.slug)}" ${live.pick?.workspace === pickWs && live.pick?.agent === a.slug ? 'selected' : ''}>${esc(nameRole(agentName(a.workspace, a.slug, a.displayName), a.displayName))}</option>`).join('')}</select>
      ${live.pick ? `<button type="button" class="btn sm" data-live-reset>Jev’s pick</button>` : ''}
    </div>` : '';
  el.innerHTML = `<div class="jbar"><button type="button" class="jrow" ${canPick ? 'data-live-choose' : 'disabled'} aria-expanded="${live.choosing}" title="${canPick ? 'Pick the client and agent yourself' : ''}">
      <span class="jev">Jev</span><span class="arr" aria-hidden="true">→</span>${body}</button>${tail ? `<span class="jtail">${tail}</span>` : ''}</div>${chooser}`;
}

function setLivePick(workspace, agent = null) {
  live.pick = { workspace, agent };
  clearTimeout(live.timer); clearTimeout(live.settle);
  renderLive();
}

$('#jevline').addEventListener('click', e => {
  const t = e.target.closest('button');
  if (!t || t.matches('[data-open]')) return;
  if (t.hasAttribute('data-live-choose')) { live.choosing = !live.choosing; return renderLive(); }
  if (t.dataset.liveWs) return setLivePick(t.dataset.liveWs);
  if (t.hasAttribute('data-live-reset')) { live.pick = null; live.choosing = false; renderLive(); return onDraft(); }
});
$('#jevline').addEventListener('change', e => {
  if (!e.target.matches('[data-live-agent]')) return;
  const ws = live.pick?.workspace || live.res?.routing?.workspace || live.res?.followUp?.workspace || defaultWs();
  setLivePick(ws, e.target.value || null);
});

voice.onSpeaking(on => { state.orchy.speaking = on; });

// ─────────────── live events ───────────────
function notify(title, body) {
  if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  try { const n = new Notification(title, { body, icon: '/assets/images/lilorchy.png', tag: title }); n.onclick = () => { window.focus(); n.close(); }; } catch {}
}

// The stream is replayable (bus.mjs): it starts where load() left off and the browser's reconnects resume by
// Last-Event-ID. Frames this page already applied are dropped (same boot, seq not newer); a `hello` with
// resync means the server couldn't replay (it restarted, or too much was missed), so the page reloads its state.
const applied = { boot: null, seq: 0 };
function connectEvents() {
  const c = state.evCursor;
  const es = new EventSource(c ? `/api/events?last=${encodeURIComponent(`${c.boot}:${c.seq}`)}` : '/api/events');
  if (c) { applied.boot = c.boot; applied.seq = c.seq; }
  const on = (type, fn) => es.addEventListener(type, e => {
    const [boot, n] = String(e.lastEventId || '').split(':');
    if (boot && boot === applied.boot && Number(n) <= applied.seq) return;
    if (boot && n) { applied.boot = boot; applied.seq = Number(n); }
    let d;
    try { d = JSON.parse(e.data); fn(d); } catch (err) { console.error(type, err); }
    try { if (d) liveNotify(type, d); } catch (err) { console.error('live', type, err); } // the Live view follows every event
  });
  es.addEventListener('hello', e => {
    let d; try { d = JSON.parse(e.data); } catch { return; }
    state.orchy.online = true; tickDoing();
    if (d.resync) {
      applied.boot = d.boot; applied.seq = d.seq;
      if (state.loadedOnce || c) load().catch(() => {});
    }
    state.loadedOnce = true; // a clean replay needs no reload
  });

  on('chat.message', ({ message, speak }) => {
    if (state.chat.some(m => m.id === message.id)) return;
    state.chat.push(message);
    const s = state.sessions.get(message.session);
    if (s) s.lastAt = message.at;
    appendMsg(message);
    if (message.session) bump(); // the daily greeting stays home
    if (message.session === view.active && view.mode === 'work') markSeen(message.session);
    if (view.mode === 'home') renderBubble();
    renderSessions();
    tickDoing();
    if (message.role === 'orchy' && message.meta?.kind !== 'greeting' && (speak || state.settings.voiceReplies)) voice.speak(message.text);
  });
  on('orchy.state', ({ state: s, session }) => {
    if (session) { if (s === 'idle') thinking.delete(session); else thinking.set(session, s); }
    syncOrchy();
    if (s !== 'idle') bump();
    tickDoing();
    renderSessions();
  });
  on('session.updated', ({ session }) => {
    state.sessions.set(session.id, { ...state.sessions.get(session.id), ...session });
    if (session.id === view.draft) view.draft = null; // the owner's new session is real now
    if (!session.closed && !loadedSessions.has(session.id)) loadSession(session.id); // reopened: fetch its thread
    if (session.closed) moveOff(session.id); // closed in another window
    renderSessions();
    refreshHistory();
  });
  on('routing.proposed', ({ proposal }) => upsertProposal(proposal));
  on('routing.updated', ({ proposal }) => upsertProposal(proposal));
  on('huddle.updated', ({ huddle }) => huddleUpdated(huddle));
  // a mission's card follows it in place; its later lines (an ask, the end) point back to the card
  const missionChanged = ({ mission }) => {
    if (!mission?.id) return;
    state.missionsOn = true;
    state.missions.set(mission.id, mission);
    missionUpdated(mission);
    for (const msg of state.chat) if (msg.meta?.missionId === mission.id && msg.meta.kind !== 'mission') { const el = $(`#convo [data-msg="${CSS.escape(msg.id)}"]`); if (el) el.outerHTML = msgHTML(msg); }
    renderSessions();
    renderReadouts();
  };
  on('mission.created', missionChanged);
  on('mission.updated', missionChanged);
  on('run.started', ({ run }) => {
    state.runs.set(run.id, run);
    if (clientOwn(run)) { renderReadouts(); return; } // a client's talk with their agent: no pane, no flash
    wake(run.workspace);
    layout(); renderPanes(); renderReadouts(); renderSessions();
    flashPane(run.workspace);
  });
  on('run.updated', ({ run }) => {
    state.runs.set(run.id, { ...state.runs.get(run.id), ...run });
    renderPanes(); renderReadouts(); renderSessions(); runUpdated(state.runs.get(run.id)); tickDoing();
    // a fix's Restart / Undo buttons follow its state (restarted, undone); a recovery card's follow the run's recovery
    for (const m of state.chat) if ((run.backend && m.meta?.fix?.runId === run.id) || m.meta?.recover?.runId === run.id) { const el = $(`#convo [data-msg="${CSS.escape(m.id)}"]`); if (el) el.outerHTML = msgHTML(m); }
  });
  on('run.event', ({ runId, event }) => { runEvent(runId, event); paneEvent(runId, event); });
  // files agents made (artifacts.mjs): open run windows refresh their list, the viewer follows versions and media states
  on('artifact.created', ({ artifact }) => { runArtifact(artifact); artifactChanged(artifact); });
  on('artifact.updated', ({ artifact }) => { runArtifact(artifact); artifactChanged(artifact); });
  on('run.ended', ({ run }) => {
    state.runs.set(run.id, run);
    $$(`#convo [data-stop="${CSS.escape(run.id)}"]`).forEach(b => b.remove());
    bump();
    renderPanes(); renderReadouts(); renderSessions(); runUpdated(run); refreshAgents();
    if (clientOwn(run)) return; // the client sees it finish on their page
    if (run.outcome === 'completed') { state.orchy.happyUntil = Date.now() + 3500; voice.chirp('done'); }
    else voice.chirp('error');
    tickDoing();
    notify(`${runName(run)} ${run.outcome === 'completed' ? 'finished' : run.outcome}`, run.instruction.slice(0, 120));
  });
  on('inbox.created', ({ item }) => {
    if (item.answerer === 'client') { state.clientAsks.set(item.id, item); renderPanes(); return; } // theirs to answer, on their page
    state.inbox.set(item.id, item);
    wake(item.workspace);
    layout(); renderPanes(); renderReadouts(); renderSessions();
    if (view.mode === 'home') renderBubble();
    voice.chirp('ask');
    // no window pops up: "Waiting on you" in the top bar blinks, and opens it when the owner is ready
    notify(item.kind === 'connections' ? `A message from ${nameRole(itemName(item), 'AI Agent Builder')}` : `From: ${itemName(item)}`, item.title || item.message || '');
  });
  const answered = ({ item }) => { state.clientAsks.delete(item.id); state.inbox.delete(item.id); closeItem(item.id); bump(); renderPanes(); renderReadouts(); renderSessions(); if (view.mode === 'home') renderBubble(); tickDoing(); };
  on('inbox.answered', answered);
  on('inbox.expired', answered);
  const reloadAgents = async (wsId, slug, isNew) => {
    state.agents = await api('/api/agents');
    renderPanes(); refreshAgents();
    if (isNew) {
      voice.chirp('hatch');
      const tile = document.querySelector(`#col-${CSS.escape(wsId)} [data-sprite="${CSS.escape(slug)}"]`);
      tile?.closest('.mate')?.classList.add('new');
      hatch(tile?.querySelector('svg'));
      openAgent(wsId, slug, { from: tile || undefined, isNew: true });
    }
  };
  on('agent.created', ({ workspace, slug }) => reloadAgents(workspace, slug, true));
  on('agent.updated', ({ workspace }) => reloadAgents(workspace));
  on('agent.retired', ({ workspace }) => reloadAgents(workspace));
  on('call.ringing', ({ call }) => ringIn(call));
  on('call.updated', ({ call }) => callUpdated(call));
  on('voice.agents', d => { state.voiceAgents = d.voiceAgents; setCallNames(d.voiceAgents); refreshAgents(); renderPanes(); });
  on('settings.updated', d => {
    if (d.settings) { state.settings = d.settings; renderLive(); }
    if (d.voice) { voice.setVoiceConfig(d.voice); renderUnder(); }
    if (d.jev) state.jev = { ...state.jev, ...d.jev };
    if (d.envStatus) { state.envStatus = d.envStatus; renderUnder(); }
  });
  on('clients.changed', d => { state.clients = d.clients || []; state.clientPages = d.clientPages || {}; refreshAgents(); });
  // a workspace was added, switched on/off, retired, restored, or its accounts changed
  on('workspaces.changed', d => {
    if (d.workspaces) state.workspaces = d.workspaces;
    if (d.retired) state.retired = d.retired;
    setWorkspaces(state.workspaces, state.retired, d.backend);
    ensurePanes();
    if (d.added) api('/api/agents').then(a => { state.agents = a; refreshAgents(); }).catch(() => {});
    renderAll();
    renderPanes();
    refreshWorkspaceWindows();
    refreshSetup();
  });
  // an MCP server added, removed or signed in (mcpauth.mjs), or an app connected: the open Connections/Workspaces windows redraw
  on('connections.changed', () => refreshWorkspaceWindows());
  // the status word says so while the live feed is down, and goes back to Orchy's state when it's up
  es.onerror = () => { state.orchy.online = false; tickDoing(); };
  es.onopen = () => { state.orchy.online = true; tickDoing(); }; // the hello that follows says whether to reload
}

/** The first-run setup guide (also reachable from Settings and the home empty state). */
export function openSetupGuide({ from, step } = {}) { return openSetup({ from, step }); }

// ─────────────── clicks & keys (the dashboard and any popped-out window) ───────────────
async function onClick(e) {
  const t = e.target.closest('button, [data-run], [data-agent], [data-view-upload]');
  if (!t) return;
  if (t.dataset.viewUpload) {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button) return; // a new tab, as before
    e.preventDefault();
    const chips = [...(t.closest('.mfiles')?.querySelectorAll('[data-view-upload]') || [t])].map(x => ({ name: x.dataset.viewUpload, size: Number(x.dataset.size) || null }));
    return openViewer({ upload: { name: t.dataset.viewUpload, size: Number(t.dataset.size) || null }, list: chips, from: t });
  }
  // a mission card (missions.mjs): in the chat or the Live view
  if (t.dataset.mact || t.dataset.mlive || t.dataset.mjump || t.dataset.meditRemove) return onMissionClick(t);
  if (t.closest('.win') && !t.matches('[data-open]')) return; // windows wire their own buttons
  if (t.hasAttribute('data-setup')) return openSetupGuide({ from: t });
  if (t.dataset.huddle) return (t.dataset.proposal ? openProposal : openHuddle)(t.dataset.huddle, { from: t });
  if (t.dataset.open) {
    const from = t;
    if (t.dataset.open === 'live') return toggleLive();
    if (t.dataset.open === 'agents') openAgents(defaultWs(), { from });
    if (t.dataset.open === 'huddles') openHuddles({ from, session: () => view.active });
    if (t.dataset.open === 'logs') openLogs({ from });
    if (t.dataset.open === 'connections') openConnections(defaultWs(), { from });
    if (t.dataset.open === 'settings') openSettings({ from });
    if (t.dataset.open === 'history') openHistory({ from });
    return;
  }
  if (t.dataset.unattach) { attached.splice(attached.findIndex(a => a.key === t.dataset.unattach), 1); renderAttachments(); return $('#command').focus(); }
  if (t.dataset.session) { bump(); return setActive(t.dataset.session); }
  if (t.dataset.sessionClose) return closeSession(t.dataset.sessionClose);
  if (t.dataset.openSession) return openSession(t.dataset.openSession);
  if (t.hasAttribute('data-session-new')) { bump(); return startSession(); }
  if (t.dataset.callBack) return startCall(t.dataset.key, t.dataset.name, { callId: t.dataset.callBack, fallback: true });
  // Orchy's check found something: the run window opens with the fix-it follow-up written (the owner sends it)
  if (t.dataset.fixAsk) return openRun(t.dataset.fixAsk, { from: t, prefill: fixText(state.runs.get(t.dataset.fixAsk)) });
  if (t.dataset.recover) { t.disabled = true; try { await recoverAct(t.dataset.recover, t.dataset.recoverAct, { from: t, run: state.runs.get(t.dataset.recover), toast }); } finally { t.disabled = false; } return; }
  if (t.dataset.liveRun) return openLive({ sel: { type: 'run', id: t.dataset.liveRun } }); // a run Orchy sent off: watch it in Live
  if (t.dataset.run) return openRun(t.dataset.run, { from: t });
  if (t.dataset.agent) return openAgent(t.dataset.ws, t.dataset.agent, { from: t });
  if (t.dataset.build) return openBuild(t.dataset.build, { from: t });
  if (t.dataset.suggestBuild) return openBuild(t.dataset.suggestBuild, { from: t, prompt: t.dataset.text });
  if (t.dataset.suggestSet) {
    try { state.settings = await api('/api/settings', { method: 'POST', body: { [t.dataset.suggestSet]: JSON.parse(t.dataset.value) } }); toast('Done. It’s in Settings if you want it back.'); t.disabled = true; }
    catch (err) { toast(err.message, 'warn'); }
    return;
  }
  if (t.dataset.conns) return openConnections(t.dataset.conns, { from: t });
  if (t.dataset.agents) return openAgents(t.dataset.agents, { from: t });
  if (t.dataset.fold) { view.folded.add(t.dataset.fold); bump(); return layout(); }
  if (t.dataset.stop) { try { await api(`/api/runs/${t.dataset.stop}/stop`, { method: 'POST' }); } catch (err) { toast(err.message, 'warn'); } return; }
  if (t.dataset.runNow) { try { await api(`/api/runs/${t.dataset.runNow}/run-now`, { method: 'POST' }); } catch (err) { toast(err.message, 'warn'); } return; }
  // a fix of Orchy's own code (server: backend.mjs)
  if (t.dataset.fixRestart || t.dataset.fixUndo) {
    const n = liveRuns().length;
    const ask = t.dataset.fixUndo ? 'Put Orchy’s code back the way it was before this fix?' : n ? `Restart Orchy now? It stops the ${n} task${n === 1 ? '' : 's'} running.` : null;
    if (ask && !confirm(ask)) return;
    t.disabled = true;
    try { await api(`/api/backend/${t.dataset.fixRestart || t.dataset.fixUndo}/${t.dataset.fixUndo ? 'undo' : 'restart'}`, { method: 'POST' }); }
    catch (err) { toast(err.message, 'warn'); t.disabled = false; }
    return;
  }
  if (t.hasAttribute('data-reload')) return location.reload();
  if (t.dataset.tab) { view.tab = t.dataset.tab; bump(); return renderTabs(); }
  if (t.hasAttribute('data-show-convo')) { if (t.dataset.showConvo) return openSession(t.dataset.showConvo); wake(); return layout(); }
  if (t.dataset.answer) { const w = getWindow(t.dataset.answer); if (w) w.restore(); else if (state.inbox.get(t.dataset.answer)) openItem(state.inbox.get(t.dataset.answer), { from: t }); return; }
  if (t.dataset.bubbleClose !== undefined) { setClosedBubble(t.dataset.bubbleClose); return renderBubble(); }
  if (t.hasAttribute('data-hear')) { const g = [...state.chat].reverse().find(m => m.meta?.kind === 'greeting'); if (g) voice.speak(g.text); return; }
  if (t.hasAttribute('data-next-decision')) { if (!nextDecision(t)) toast('Nothing is waiting on you.'); return; }
  if (t.dataset.dismiss) { dismissNotice(t.dataset.dismiss); return renderUnder(); }
  if (t.dataset.copy !== undefined) { try { await navigator.clipboard.writeText(t.dataset.copy); toast('Copied. Paste it into PowerShell.'); } catch { toast('Copy failed: select the text instead.', 'warn'); } return; }
  if (t.hasAttribute('data-recheck')) {
    let ws;
    try { ws = await api('/api/accounts/refresh', { method: 'POST' }); } catch (err) { return toast(err.message, 'warn'); }
    state.workspaces = ws;
    setWorkspaces(ws);
    renderAll();
    renderPanes();
    const ok = ws.filter(w => w.enabled !== false).every(w => w.account.ok);
    toast(ok ? 'Every account checks out.' : 'Still not logged in. Run the command, sign in, then re-check.', ok ? '' : 'warn');
    return;
  }
  if (t.dataset.login) {
    try { await api(`/api/workspaces/${encodeURIComponent(t.dataset.login)}/login`, { method: 'POST' }); toast('A login window opened. Sign in there, then press Re-check.'); }
    catch (err) { toast(err.message, 'warn'); }
    return;
  }
}

function onKey(e) {
  const typing = /INPUT|TEXTAREA|SELECT/.test(e.target?.tagName);
  if (e.key === '/' && !typing && e.target?.ownerDocument === document) { e.preventDefault(); $('#command').focus(); }
  if (e.code === 'Space' && e.ctrlKey) { e.preventDefault(); callOrchy(); }
}

document.addEventListener('click', onClick);
document.addEventListener('keydown', onKey);
$('#command-form').addEventListener('submit', e => { e.preventDefault(); send($('#command').value); });
// typing at home stays home (sending opens the new session); typing at work keeps the work view up
$('#command').addEventListener('input', () => { if (view.mode === 'work') bump(); onDraft(); });
// Orchy is a live call now: the Call button, the Orchy sprite, or Ctrl+Space (again to hang up)
const callOrchy = () => startCall('orchy', 'Orchy');
$('#call').addEventListener('click', callOrchy);
$('#orchy').addEventListener('click', callOrchy);
$('#orchy-mini').addEventListener('click', callOrchy);
// files for Orchy: the Files button, dropped anywhere outside a window, or pasted into the chat box
$('#attach').addEventListener('click', () => $('#attach-input').click());
$('#attach-input').addEventListener('change', e => { attachFiles([...e.target.files]); e.target.value = ''; });
$('#command').addEventListener('paste', e => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); attachFiles(files); }
});
let dragDepth = 0;
const dragsFiles = e => [...(e.dataTransfer?.types || [])].includes('Files') && !e.target.closest?.('.win');
document.addEventListener('dragenter', e => { if (dragsFiles(e)) { dragDepth++; document.body.dataset.drop = ''; } });
document.addEventListener('dragleave', () => { if (dragDepth && !--dragDepth) delete document.body.dataset.drop; });
document.addEventListener('dragover', e => { if (dragsFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
document.addEventListener('drop', e => {
  dragDepth = 0;
  delete document.body.dataset.drop;
  if (!dragsFiles(e)) return;
  e.preventDefault();
  attachFiles([...e.dataTransfer.files]);
});
$('#go-home').addEventListener('click', () => { view.manualHome = true; layout(); });
$('#waiting').addEventListener('click', e => { if (!nextDecision(e.currentTarget)) toast('Nothing is waiting on you.'); });
$('#running').addEventListener('click', () => {
  const live = liveRuns();
  if (!CLIENT_PANES) { // what's running lives in the Live view
    if (!live.length) return toast('Nothing is running right now.');
    return openLive({ sel: { type: 'run', id: live[0].id } });
  }
  if (liveOpen()) closeLive(); // Running keeps its job: the split onto what's running
  if (!live.length && view.mode === 'work') return toast('Nothing is running right now.');
  for (const r of live) { view.pinned.add(r.workspace); view.folded.delete(r.workspace); }
  wake();
  layout();
});
// the session tabs scroll sideways with an ordinary mouse wheel
$('#sessions-tabs').addEventListener('wheel', e => {
  const bar = e.currentTarget;
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || bar.scrollWidth <= bar.clientWidth) return;
  e.preventDefault();
  bar.scrollLeft += e.deltaY;
}, { passive: false });
$('#sessions-tabs').addEventListener('scroll', syncTabArrows, { passive: true });
new ResizeObserver(syncTabArrows).observe($('#sessions-tabs'));
$$('[data-stabs-scroll]').forEach(b => b.addEventListener('click', () => {
  const bar = $('#sessions-tabs');
  bar.scrollBy({ left: Number(b.dataset.stabsScroll) * Math.max(160, bar.clientWidth * 0.7), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}));
// reading or scrolling the work view counts as activity: don't fold away under the owner
for (const ev of ['pointerdown', 'wheel', 'keydown']) $('#stage').addEventListener(ev, () => { if (view.mode === 'work') bump(); }, { passive: true });

// icons in static chrome
$('#brandmark').innerHTML = orchySVG('idle', 1, { label: 'Orchy' });
$('[data-session-new] .i').outerHTML = icon('plus');
$('[data-open="history"] .i').outerHTML = icon('clock');
$('[data-stabs-scroll="-1"] .i').outerHTML = icon('left');
$('[data-stabs-scroll="1"] .i').outerHTML = icon('right');
$('#waiting').insertAdjacentHTML('afterbegin', icon('bang', 'ico mob'));
$('#send .i').outerHTML = icon('send', 'ico lg');
$('#call .i').outerHTML = icon('phone', 'ico lg');
$('#attach .i').outerHTML = icon('clip', 'ico lg');
$('#go-home .i').outerHTML = icon('home');
$$('.tools .tbtn').forEach(b => { b.querySelector('.i').innerHTML = icon({ agents: 'team', huddles: 'huddle', live: 'live', logs: 'logs', connections: 'plug', settings: 'gear' }[b.dataset.open], 'ico lg'); });

// boot
initWindows({
  toast,
  onPopDocument: doc => { doc.addEventListener('click', onClick); doc.addEventListener('keydown', onKey); },
});
initPopups({ toast, openRun });
initSheets({ toast });
initHuddles({ state, toast, openRun, activeSession: () => view.active });
initSetup({ state, toast, reload: load });
initPanels({ state, toast, openRun, openNewHuddle, applyTheme, reload: load, openSession, activeSession: () => view.active });
initPanes({ state, LIVE, toast });
initCalls({ toast });
initMissions({ state, toast: (m, k) => toast(m, k), openLive: sel => openLive({ sel }) });
// typing on a mission card (a follow-up, an edited step) survives its redraws
document.addEventListener('input', e => { if (e.target?.closest?.('[data-mission-card], [data-mission-scope]')) onMissionInput(e.target); });
document.addEventListener('change', e => { if (e.target?.closest?.('[data-mission-card], [data-mission-scope]')) onMissionInput(e.target); });
initLive({
  state, LIVE, toast,
  onOpen: () => { document.body.dataset.view = 'live'; renderTabs(); },
  // back to the view it was in; a minute's grace before it folds home
  onClose: () => { document.body.dataset.view = view.mode; bump(); layout(); renderPanes(); renderTabs(); },
});
setInterval(tickOrchy, 150);
setInterval(tickClock, 1000);
setInterval(tickCountdowns, 250);
setInterval(tickDoing, 1000);
tickClock();
tickOrchy();
const PARAMS = new URLSearchParams(location.search);
if (PARAMS.get('theme')) document.documentElement.dataset.theme = PARAMS.get('theme');
pairFromLink(PARAMS).then(load).then(async () => {
  if (!PARAMS.has('still')) { connectEvents(); watchPairing({ toast, reload: load }); }
  if (PARAMS.has('hello') || !PARAMS.has('still')) greet({ force: PARAMS.has('hello') });
  if (PARAMS.has('hello')) { PARAMS.delete('hello'); history.replaceState(null, '', location.pathname + (PARAMS.size ? `?${PARAMS}` : '')); }
  if (PARAMS.has('preview')) (await import('./preview.mjs')).runPreview({ state, view, upsertProposal, toast, mode: PARAMS.get('preview'), wake, layout, ensurePanes, renderPanes, paneEvent, setActive });
  const open = PARAMS.get('open');
  if (open === 'agents') openAgents(PARAMS.get('ws') || defaultWs());
  if (open === 'logs') openLogs({ tab: PARAMS.get('tab') });
  if (open === 'usage') openLogs({ tab: 'usage' });
  if (open === 'settings') openSettings();
  if (open === 'connections') openConnections(PARAMS.get('ws') || defaultWs());
  if (open === 'build') openBuild(PARAMS.get('ws') || defaultWs());
  if (open === 'add') openAddWorkspace();
  if (open === 'setup') openSetup({ step: PARAMS.get('step') });
  else if (!PARAMS.has('still')) maybeAutoOpenSetup(state);
  if (open === 'run' && PARAMS.get('run')) openRun(PARAMS.get('run'));
  if (open === 'huddle' && PARAMS.get('huddle')) openHuddle(PARAMS.get('huddle'));
  if (open === 'huddle-new') openNewHuddle(PARAMS.get('ws') || defaultWs());
  if (open === 'huddles') openHuddles({ wsId: PARAMS.get('ws'), session: () => view.active });
  if (open === 'proposal' && PARAMS.get('huddle')) openProposal(PARAMS.get('huddle'));
  // the Live view: &open=live (with &run=<id> or &huddle=<id> to pick what it shows)
  if (open === 'live') openLive({ sel: PARAMS.get('run') ? { type: 'run', id: PARAMS.get('run') } : PARAMS.get('huddle') ? { type: 'huddle', id: PARAMS.get('huddle') } : null });
  // the viewer for screenshots: &open=viewer&artifact=<id> (with its run's files), &upload=<name>, &embed=<url>
  if (open === 'viewer' && PARAMS.get('artifact')) {
    api(`/api/artifacts/${encodeURIComponent(PARAMS.get('artifact'))}`).then(async ({ artifact }) => {
      let list = null;
      if (artifact.runId) { try { list = (await api(`/api/artifacts?run=${encodeURIComponent(artifact.runId)}`)).artifacts; } catch {} }
      openViewer({ artifact, list });
    }).catch(e => toast(e.message, 'warn'));
  }
  if (open === 'viewer' && PARAMS.get('upload')) openViewer({ upload: { name: PARAMS.get('upload') } });
  if (open === 'viewer' && PARAMS.get('embed')) openViewer({ embed: PARAMS.get('embed') });

}).catch(e => {
  $('#bubble').innerHTML = `<div class="bubble"><h2 class="px2">Can't reach my server</h2><p>${esc(e.message)}. Start it with <code class="data">npm start</code> in the Orchy folder.</p></div>`;
});

// expose for the screenshot script
window.__jos = { state, view, layout, renderPanes, wake, getWindow, setActive, startSession, openSession };
