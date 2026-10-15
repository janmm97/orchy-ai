// Tool windows: Workspace (every workspace: add, switch off, retire, and each team), Logs,
// Connections (One + external MCP), Settings, Sessions history.
import { openWindow, getWindow } from './windows.mjs';
import { icon, createEl, orchySVG } from './pixel.mjs';
import { esc, api, md, wsName, wsShort, wsClass, agentName, nameRole, platformName, dateTime, ownerName } from './util.mjs';
import { voiceConfig, setVoiceConfig, speak, setSound } from './voice.mjs';
import { openAgent, openBuild, spriteFor } from './sheets.mjs';
import { startCall } from './call.mjs';
import { openSetup, openOneGuide, cmdHTML, wireCopy, ONE_SIGN_IN } from './setup.mjs';
import { browserSectionHTML, wireBrowserSection, openPair } from './pairing.mjs';

let ctx = null; // { state, toast, openRun, applyTheme, reload, openSession, activeSession }
export function initPanels(c) { ctx = c; }

// Live events redraw these windows under the owner's hands: the field he's typing in keeps the focus and the caret.
function focusOf(root) {
  const a = root.ownerDocument.activeElement;
  return a?.id && root.contains(a) ? { id: a.id, s: a.selectionStart, e: a.selectionEnd } : null;
}
function restoreFocus(root, at) {
  const el = at && root.querySelector(`#${CSS.escape(at.id)}`);
  if (!el || el === root.ownerDocument.activeElement) return;
  el.focus({ preventScroll: true });
  try { if (at.s != null) el.setSelectionRange(at.s, at.e); } catch {}
}
function redraw(root, draw) { const at = focusOf(root); draw(); restoreFocus(root, at); }

// ── Sessions history: every conversation with Orchy, open or closed ──
export function openHistory({ from } = {}) {
  const existing = getWindow('history');
  if (existing) { existing.restore(); existing.refresh(); return existing; }
  const body = createEl(`<div style="display:grid;gap:var(--s3)"></div>`);
  const w = openWindow({ id: 'history', title: 'Sessions', size: 'wide', body, from });
  w.refresh = async () => {
    let list;
    try { list = await api('/api/sessions'); } catch (e) { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    body.innerHTML = `
      <span class="hint">Newest first. Closing a tab only takes it off the bar, and a session goes quiet after a day. Open any of them to pick it up again: Orchy remembers it.</span>
      ${list.length ? `<div class="runs">${list.map(s => `
        <button class="runrow" data-open-session="${esc(s.id)}">
          <span class="l1"><b>${esc(s.title)}</b><span class="hint">${esc(dateTime(s.lastAt))}</span></span>
          <span class="l3">${s.workspaces.map(x => `<span class="plate ${wsClass(x)}">${esc(wsShort(x))}</span>`).join('')}
            <span class="hint">${s.runs ? `${s.runs} run${s.runs === 1 ? '' : 's'}` : 'Orchy only'}${s.live ? ' · working now' : ''} · ${s.closed ? 'closed' : 'open'}</span></span>
        </button>`).join('')}</div>`
      : '<div class="empty"><strong>No sessions yet</strong>Everything you tell Orchy from home starts one.</div>'}`;
    body.querySelectorAll('[data-open-session]').forEach(b => b.addEventListener('click', () => ctx.openSession(b.dataset.openSession)));
  };
  w.refresh();
  return w;
}
/** Re-draw the history window after a session changes. */
export function refreshHistory() { getWindow('history')?.refresh?.(); }

const LIVE = new Set(['starting', 'working', 'waiting', 'stopping']);

// ── Workspace: each workspace (an "agent" to its owner), its Chief of AI Agents and its team ──
const RETIRED_TAB = '__retired';
export function openAgents(wsId, { from } = {}) {
  const existing = getWindow('agents');
  if (existing) { existing.restore(); existing.show(wsId); return existing; }
  const body = createEl(`<div style="display:grid;gap:var(--s4)"></div>`);
  const w = openWindow({ id: 'agents', title: 'Workspace', size: 'wide', body, from });
  let current = wsId;
  // Client access: the open add/edit form (with what the owner typed in it), the page address typed, and a link made just now (shown once)
  const access = { form: null, fresh: null, url: null };
  w.show = id => { if (id) current = id; redraw(body, render); };
  const render = () => {
    if (body.querySelector('.tabs.sorting')) return; // mid-drag: the drop redraws it
    const { state } = ctx;
    if (current !== RETIRED_TAB && !state.workspaces.some(x => x.id === current)) current = state.workspaces[0]?.id || '';
    const tabs = `<div class="tabs" role="tablist">${state.workspaces.map(x => `<button role="tab" data-ws="${esc(x.id)}" aria-selected="${x.id === current}" class="${x.enabled === false ? 'off' : ''}" title="${x.enabled === false ? `${esc(wsName(x.id))} is switched off` : esc(wsName(x.id))}"><span class="ws-swatch ${wsClass(x.id)}"></span>${esc(wsName(x.id))}${x.enabled === false ? ' · off' : ''}</button>`).join('')}
        ${state.retired?.length ? `<button role="tab" data-ws="${RETIRED_TAB}" aria-selected="${current === RETIRED_TAB}">Retired · ${state.retired.length}</button>` : ''}
        <button type="button" class="add" data-a="add" title="Add a new agent: Orchy sets up its folder">${icon('plus')}Add</button></div>`;
    if (!state.workspaces.length && current !== RETIRED_TAB) { // nothing set up yet: land on the Add tab
      body.innerHTML = tabs.replace('class="add"', 'class="add" aria-pressed="true"') + `<div class="empty"><strong>Set up your first workspace</strong>A workspace is a folder on this PC that one or more AI agents work in, with its own login and apps. Add one and Orchy sets up the folder, the first agent and the account checks for you.</div><div class="btnrow"><button class="btn primary" type="button" data-a="add">${icon('plus')}Add a workspace</button><button class="btn" type="button" data-a="guide">${icon('spark')}Open the setup guide</button></div>`;
      body.querySelector('[data-a="guide"]').addEventListener('click', e => openSetup({ from: e.currentTarget }));
      wireTabs(); return;
    }
    if (current === RETIRED_TAB) { body.innerHTML = tabs + retiredHTML(state.retired || []); wireRetired(); wireTabs(); return; }
    const ws = state.workspaces.find(x => x.id === current);
    const acct = ws.account || {};
    const agents = state.agents.filter(a => a.workspace === current && !a.isBuilder);
    const chief = state.agents.find(a => a.workspace === current && a.isBuilder);
    const busy = slug => [...state.runs.values()].some(r => r.workspace === current && LIVE.has(r.status) && (r.isBuilder ? 'agent-builder' : r.agentSlug) === slug);
    const on = ws.enabled !== false;
    const voiceOf = slug => state.voiceAgents?.agents.find(v => v.workspace === current && v.slug === slug && v.ready);
    const callName = a => voiceOf(a.slug)?.name;
    const builder = voiceOf('agent-builder');
    body.innerHTML = `${tabs}
      <div class="wshead">
        <div class="facts">
          <span>Client <b>${esc(wsName(ws.id))}</b> · on <b>${esc(ws.runtimeLabel || 'Claude Code')}</b> · runs as ${acct.ok ? `<b>${esc(acct.actual)}</b>` : `<b>${esc(acct.expected || '')}</b> <span class="plate decide">${acct.loggedIn ? 'wrong account' : 'needs login'}</span>`}</span>
          ${(ws.extraAccounts || []).map(x => `<span>${esc(x.agents.join(', '))} on <b>${esc(x.runtimeLabel)}</b> · runs as ${x.ok ? `<b>${esc(x.actual)}</b>` : `<b>${esc(x.expected || 'no account set')}</b> <span class="plate decide">${x.loggedIn ? 'wrong account' : 'needs login'}</span>`}</span>`).join('')}
          <span class="hint">One: ${ws.oneScoped !== false ? 'its own account' : '<b>not signed in</b> (One is off here until it is)'} · folder ${esc(ws.folder)}</span>
        </div>
        <div class="ctl">
          <label class="btnrow" title="${on ? 'Orchy routes work here' : 'Orchy ignores it'}"><span class="switch"><input type="checkbox" role="switch" data-a="toggle" ${on ? 'checked' : ''} aria-label="${esc(wsName(ws.id))} switched ${on ? 'on' : 'off'}"><span class="track"><span class="knob"></span></span></span><span class="label">${on ? 'On' : 'Off'}</span></label>
          <button class="btn sm" data-a="conns">${icon('plug')}Connections</button>
          <button class="btn sm" data-a="edit">${icon('edit')}Edit</button>
          <button class="btn sm" data-a="retire">${icon('trash')}Retire</button>
        </div>
      </div>
      ${on ? '' : `<div class="offbar"><b>Switched off</b><span>Orchy ignores ${esc(wsName(ws.id))}: nothing is routed here (even when you name it), its scheduled runs are skipped, and nothing new starts. Its agents and files stay as they are. Switch it on to bring it back.</span></div>`}
      ${setupHTML(ws)}
      <div class="chief">
        <div class="sprite">${spriteFor(current, 'agent-builder')}</div>
        <div class="t"><strong>${builder ? `${esc(builder.name)} · ` : ''}AI Agent Builder</strong><span>Chief of AI Agents for ${esc(wsName(ws.id))}. Knows every connection here and writes new agents as Markdown.</span></div>
        <div class="btnrow">${builder ? callBtn(builder, 'btn sm') : ''}<button class="btn sm" data-a="build">${icon('plus')}New agent</button>${on ? `<button class="btn sm" data-a="huddle" title="Two agents talk a task through and write up what they agree; nothing changes until you approve">${icon('chat')}Start a huddle</button>` : ''}${chief ? `<button class="btn sm" data-a="chief">${icon('edit')}Edit instructions</button>` : ''}${busy('agent-builder') ? '<span class="plate decide blink">building</span>' : ''}</div>
      </div>
      <div class="section-h"><h3>Agents <span class="count">${agents.length}</span></h3></div>
      ${agents.length ? `<div class="roster">${agents.map(a => `
        <div class="agentcell${voiceOf(a.slug) ? ' callable' : ''}"><button class="agent${busy(a.slug) ? ' busy' : ''}" data-slug="${esc(a.slug)}" aria-label="${esc(a.displayName)}, ${esc(a.role)}">
          <span class="top"><span class="sprite">${spriteFor(current, a.slug)}</span></span>
          <span>${callName(a) ? `<span class="nm">${esc(callName(a))}</span><br><span class="rl">${esc(a.displayName)}</span>` : `<span class="nm">${esc(a.displayName)}</span><br><span class="rl">${esc(a.role || a.description.slice(0, 60))}</span>`}${a.scheduleText ? `<br><span class="rl">${icon('clock')} ${esc(a.scheduleText)}</span>` : ''}${a.error ? `<br><span class="plate decide">broken file</span>` : ''}</span>
          <span class="ft"><span class="chip" title="${esc(a.engineLabel || '')}${a.effort ? ` · ${esc(a.effort)} effort` : ''}">${esc(a.model)}</span>${a.executive ? '<span class="chip" title="C-suite: can start a huddle with another agent from its own tasks">C-suite</span>' : ''}${busy(a.slug) ? '<span class="plate blink">working</span>' : ''}<span class="pips" title="${a.connections.length} connections">${a.connections.slice(0, 10).map(() => '<i></i>').join('')}</span></span>
        </button>${voiceOf(a.slug) ? callBtn(voiceOf(a.slug), 'callbtn') : ''}</div>`).join('')}</div>`
      : `<div class="empty"><strong>No agents yet</strong>Ask the Chief to build ${esc(wsName(ws.id))}'s first specialist. Until then, the ${esc(wsName(ws.id))} generalist handles everything routed here.</div>`}
      ${clientAccessHTML(ws, agents, access)}`;
    wireTabs();
    wireSetup(body, ws);
    wireClientAccess(body, ws, access, render);
    body.querySelector('[data-a="conns"]').addEventListener('click', e => openConnections(current, { from: e.currentTarget }));
    body.querySelector('[data-a="build"]').addEventListener('click', e => openBuild(current, { from: e.currentTarget }));
    body.querySelector('[data-a="huddle"]')?.addEventListener('click', e => ctx.openNewHuddle(current, { from: e.currentTarget, session: ctx.activeSession?.() || null }));
    body.querySelector('[data-a="chief"]')?.addEventListener('click', e => openAgent(current, 'agent-builder', { from: e.currentTarget }));
    body.querySelector('[data-a="edit"]').addEventListener('click', e => openAddWorkspace({ edit: ws, from: e.currentTarget }));
    body.querySelector('[data-a="retire"]').addEventListener('click', e => openRetire(ws, { from: e.currentTarget }));
    body.querySelector('[data-a="toggle"]').addEventListener('change', async e => {
      const want = e.target.checked;
      e.target.disabled = true;
      try {
        const r = await api(`/api/workspaces/${encodeURIComponent(ws.id)}`, { method: 'PATCH', body: { enabled: want } });
        ctx.toast(want ? `${wsName(ws.id)} is back on. Orchy routes work there again.` : `${wsName(ws.id)} is switched off. Orchy ignores it until you switch it back on.${r.liveRuns ? ' What it’s doing right now still finishes.' : ''}`);
      } catch (err) { e.target.checked = !want; e.target.disabled = false; ctx.toast(err.message, 'warn'); }
    });
    body.querySelectorAll('[data-slug]').forEach(b => b.addEventListener('click', () => openAgent(current, b.dataset.slug, { from: b })));
    body.querySelectorAll('[data-call]').forEach(b => b.addEventListener('click', () => startCall(b.dataset.call, b.dataset.name)));
  };
  const wireTabs = () => {
    body.querySelectorAll('[data-ws]').forEach(b => b.addEventListener('click', () => w.show(b.dataset.ws)));
    body.querySelectorAll('[data-a="add"]').forEach(b => b.addEventListener('click', e => openAddWorkspace({ from: e.currentTarget })));
    movableTabs(body, id => w.show(id));
  };
  const wireRetired = () => {
    body.querySelectorAll('[data-restore]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      try { const ws = await api(`/api/workspaces-retired/${encodeURIComponent(b.dataset.restore)}/restore`, { method: 'POST' }); ctx.toast(`${wsName(ws.id)} is back, with its folder and agents.`); w.show(ws.id); }
      catch (err) { b.disabled = false; ctx.toast(err.message, 'warn'); }
    }));
    body.querySelectorAll('[data-purge]').forEach(b => b.addEventListener('click', e => {
      const r = ctx.state.retired.find(x => x.id === b.dataset.purge);
      if (r) openRetire(r, { purge: true, from: e.currentTarget });
    }));
  };
  render();
  return w;
}
// Each agent is also a voice agent (ElevenLabs) the owner calls by name.
function callBtn(v, cls) {
  return `<button class="${cls}" type="button" data-call="${esc(v.key)}" data-name="${esc(v.name)}" aria-pressed="false" aria-label="Call ${esc(v.name)}" title="Call ${esc(v.name)}, the ${esc(v.role)} (voice: ${esc(v.voice)})">${icon('phone')}Call</button>`;
}
// Workspace tabs move: drag one along the bar, or Ctrl+Shift+←/→ on a focused tab. The order is saved to
// config.json, so every tab bar and the split view's panes follow it. A dragged tab is also opened, like a browser's.
let refocus = null; // a keyboard move redraws the window: keep the moved tab focused through it
function movableTabs(root, select) {
  const bar = root.querySelector('.tabs');
  if (!bar) return;
  const doc = bar.ownerDocument; // a popped-out window has its own
  const tabs = () => [...bar.querySelectorAll('[data-ws]')].filter(b => b.dataset.ws !== RETIRED_TAB);
  const order = () => tabs().map(b => b.dataset.ws);
  for (const t of tabs()) {
    t.title = `${t.title || t.textContent.trim()} · drag to move`;
    t.setAttribute('aria-keyshortcuts', 'Control+Shift+ArrowLeft Control+Shift+ArrowRight');
  }
  if (refocus?.root === root && Date.now() < refocus.until && doc.activeElement === doc.body) bar.querySelector(`[data-ws="${CSS.escape(refocus.id)}"]`)?.focus();
  bar.addEventListener('pointerdown', e => {
    const tab = e.target.closest('[data-ws]');
    if (!tab || tab.dataset.ws === RETIRED_TAB || e.button !== 0) return;
    const sx = e.clientX, sy = e.clientY;
    let moving = false;
    const move = ev => {
      if (ev.pointerId !== e.pointerId) return;
      if (!moving) {
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 6) return; // a click, not a drag
        moving = true;
        tab.classList.add('moving');
        bar.classList.add('sorting');
      }
      const over = doc.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-ws]');
      if (!over || over === tab || over.parentElement !== bar || over.dataset.ws === RETIRED_TAB) return;
      // past the middle of the tab it's heading for, in the direction it's heading: no flicker between tabs of different widths
      const r = over.getBoundingClientRect();
      const ahead = tab.compareDocumentPosition(over) & Node.DOCUMENT_POSITION_FOLLOWING;
      if (ahead && ev.clientX > r.left + r.width / 2) over.after(tab);
      else if (!ahead && ev.clientX < r.left + r.width / 2) over.before(tab);
    };
    const end = ev => {
      if (ev.pointerId !== e.pointerId) return;
      doc.removeEventListener('pointermove', move);
      doc.removeEventListener('pointerup', end);
      doc.removeEventListener('pointercancel', end);
      if (!moving) return;
      tab.classList.remove('moving');
      bar.classList.remove('sorting');
      const eat = c => { c.stopPropagation(); c.preventDefault(); }; // the click that ends a drag isn't a click
      doc.addEventListener('click', eat, true);
      setTimeout(() => {
        doc.removeEventListener('click', eat, true);
        saveOrder(order());
        if (ev.type === 'pointerup') select(tab.dataset.ws);
      });
    };
    doc.addEventListener('pointermove', move);
    doc.addEventListener('pointerup', end);
    doc.addEventListener('pointercancel', end);
  });
  bar.addEventListener('keydown', e => {
    const tab = e.target.closest('[data-ws]');
    if (!tab || tab.dataset.ws === RETIRED_TAB || !e.ctrlKey || !e.shiftKey || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const list = tabs();
    const next = list[list.indexOf(tab) + (e.key === 'ArrowLeft' ? -1 : 1)];
    if (!next) return;
    if (e.key === 'ArrowLeft') next.before(tab); else next.after(tab);
    tab.focus();
    refocus = { root, id: tab.dataset.ws, until: Date.now() + 1500 };
    saveOrder(order());
  });
}
// The new order shows at once; the server's echo redraws the panes and every other window.
function saveOrder(order) {
  const before = ctx.state.workspaces;
  if (order.join() === before.map(x => x.id).join()) return;
  const at = x => { const i = order.indexOf(x.id); return i < 0 ? order.length : i; };
  ctx.state.workspaces = [...before].sort((a, b) => at(a) - at(b));
  api('/api/workspaces-order', { method: 'PUT', body: { order } }).catch(err => {
    ctx.state.workspaces = before;
    refreshWorkspaceWindows();
    ctx.toast(`Couldn’t save the new order: ${err.message}`, 'warn');
  });
}

/** Re-draw the Workspace window after agents or runs change. */
export function refreshAgents() { getWindow('agents')?.show?.(); }
/** A workspace was added, switched, retired or signed in: redraw every window that shows workspaces. */
export function refreshWorkspaceWindows() {
  refreshAgents();
  getWindow('settings')?.render?.();
  const c = getWindow('connections');
  if (c?.current) c.show(c.current);
  getWindow('logs')?.refresh?.();
}

function retiredHTML(list) {
  return `<p class="hint" style="margin:0">Retired agents are off Orchy's list. Their folders wait in Retired/ until you bring them back or delete them for good.</p>
    ${list.length ? `<div>${list.map(r => `<div class="retired">
      <span><b>${esc(r.name)}</b> <span class="chip">${esc(r.runtimeLabel || r.runtime)}</span><br><span class="hint">Client ${esc(r.client)} · retired ${esc(dateTime(r.retiredAt))} · ${r.dirExists ? `Retired/${esc(r.archivedFolder)}` : 'folder already gone'}</span></span>
      <span class="btnrow"><button class="btn sm" data-restore="${esc(r.id)}">${icon('refresh')}Restore</button><button class="btn sm" data-purge="${esc(r.id)}">${icon('trash')}Delete for good</button></span>
    </div>`).join('')}</div>` : '<div class="empty"><strong>Nothing retired</strong></div>'}`;
}

// The checklist a new (or unconfigured) workspace shows until it can work: its engine account, and One.
function setupHTML(ws) {
  const acct = ws.account || {};
  const extra = (ws.extraAccounts || []).filter(x => !x.ok);
  if (acct.ok && ws.oneScoped !== false && !extra.length) return '';
  const one = ws.oneLogin || {};
  const row = (done, title, text, buttons) => `<div class="check ${done ? 'ok' : 'todo'}"><span class="box">${done ? icon('check') : ''}</span><span class="t"><b>${title}</b>${text}</span><span class="btnrow">${done ? '' : buttons}</span></div>`;
  const loginRow = (a, whose) => row(a.ok, `${esc(a.runtimeLabel || 'Claude Code')} runs as ${esc(a.expected || '')}${whose}`,
    a.ok ? `Logged in as ${esc(a.actual)}.`
      : `${a.error && /install|account set/i.test(a.error) ? esc(a.error) : a.loggedIn ? `Its profile is logged in as ${esc(a.actual || 'another account')}, so Orchy won't run ${whose ? 'those agents' : 'anything here'}.` : 'Its profile isn’t logged in yet. Log in once, as that account, in the browser.'}${a.fix ? `<code>${esc(a.fix)}</code>` : ''}`,
    `${a.expected ? `<button class="btn sm primary" data-setup="login" data-rt="${esc(a.runtime || '')}">Log in</button><button class="btn sm" data-setup="copy" data-fix="${esc(a.fix || '')}">Copy</button>` : ''}<button class="btn sm" data-setup="recheck">${icon('refresh')}Re-check</button>`);
  return `<div class="setup"><span class="h">Get ${esc(wsName(ws.id))} ready</span>
    ${loginRow(acct, '')}
    ${extra.map(x => loginRow(x, ` (for ${esc(x.agents.join(', '))})`)).join('')}
    ${row(ws.oneScoped !== false, 'Its own One account',
      ws.oneScoped !== false ? 'Signed in.' : one.status === 'waiting' ? 'Waiting for you to finish signing in, in the browser window One opened…'
        : `${one.status === 'failed' ? `Last try didn’t finish: ${esc(one.error || '')}. ` : ''}Sign it in to the One account (and org) with ${esc(wsName(ws.id))}’s connections. Until then One is off here, so it can’t borrow another client’s apps.`,
      one.status === 'waiting' ? '<span class="plate blink">waiting</span>' : `<button class="btn sm primary" data-setup="one">Sign in to One</button>`)}
  </div>`;
}
function wireSetup(root, ws) {
  root.querySelectorAll('[data-setup="login"]').forEach(b => b.addEventListener('click', async () => {
    try { await api(`/api/workspaces/${encodeURIComponent(ws.id)}/login`, { method: 'POST', body: { runtime: b.dataset.rt || null } }); ctx.toast('A login window opened. Sign in there, then press Re-check.'); }
    catch (e) { ctx.toast(e.message, 'warn'); }
  }));
  root.querySelectorAll('[data-setup="copy"]').forEach(b => b.addEventListener('click', async () => { try { await navigator.clipboard.writeText(b.dataset.fix || ws.account?.fix || ''); ctx.toast('Copied. Paste it into PowerShell.'); } catch { ctx.toast('Copy failed: select the text instead.', 'warn'); } }));
  root.querySelectorAll('[data-setup="recheck"]').forEach(b => b.addEventListener('click', async e => {
    e.currentTarget.disabled = true;
    try { await api('/api/accounts/refresh', { method: 'POST' }); } catch (err) { ctx.toast(err.message, 'warn'); }
  }));
  root.querySelector('[data-setup="one"]')?.addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try { await api(`/api/workspaces/${encodeURIComponent(ws.id)}/one-login`, { method: 'POST' }); ctx.toast('One opened a sign-in window in your browser. Pick the account and org for this client.'); }
    catch (err) { btn.disabled = false; ctx.toast(err.message, 'warn'); }
  });
}

// ── Client access: a private link that lets a client (Alex at Beta Labs, …) work with chosen agents from their own page ──
// The page is served on its own port (portal.mjs) and goes online through Cloudflare Tunnel + Access.
// A link is shown once, when it's made: a lost link is replaced, and the old one stops working.
function clientAccessHTML(ws, agents, access) {
  const list = (ctx.state.clients || []).filter(c => c.workspace === ws.id);
  const pages = ctx.state.clientPages || {};
  const name = slug => { const role = agents.find(a => a.slug === slug)?.displayName; return nameRole(agentName(ws.id, slug, role), role); };
  const f = access.form?.ws === ws.id ? access.form : null;
  const editing = f?.id ? list.find(c => c.id === f.id) : null;
  const picked = new Set(f?.agents ?? editing?.agents ?? []);
  const form = f ? `<div class="cform">
      <div class="field"><label for="ca-name">Client’s name</label><input class="input" id="ca-name" value="${esc(f.name ?? editing?.name ?? '')}" placeholder="e.g. Alex"></div>
      <div class="field"><label for="ca-email">Their email</label><input class="input" id="ca-email" type="email" value="${esc(f.email ?? editing?.email ?? '')}" placeholder="the address they sign in to Cloudflare with">
        <span class="hint">Only this address can open the link once it’s online.</span></div>
      <fieldset class="field cpicks"><legend class="label">Agents they can use</legend>
        ${agents.length ? agents.map(a => { const eid = a.engine || ws.runtime, codex = ctx.state.runtimes?.[eid]?.capabilities?.clientSafe === false, elabel = ctx.state.runtimes?.[eid]?.label || eid; return `<label class="cpick"${codex ? ` title="Runs on ${esc(elabel)}, which Orchy can’t keep inside a client’s folder"` : ''}><input type="checkbox" value="${esc(a.slug)}" ${picked.has(a.slug) && !codex ? 'checked' : ''} ${codex ? 'disabled' : ''}><span>${esc(nameRole(agentName(ws.id, a.slug, a.displayName), a.displayName))}${codex ? ` <span class="hint">(${esc(elabel)}: can’t be shared yet)</span>` : ''}</span></label>`; }).join('') : '<span class="hint">No agents here yet.</span>'}</fieldset>
      ${editing ? `<label class="cpick"><input type="checkbox" id="ca-calls" ${(f.calls ?? editing.calls !== false) ? 'checked' : ''}><span>They can call their agents from the page <span class="hint">(their own voice agents: no transfers, 15-minute calls, no audio kept, transcripts deleted after 30 days; uses your ElevenLabs credits)</span></span></label>` : ''}
      ${editing ? `<div class="field"><label for="ca-brief">Brief for their agents</label>
        <textarea class="textarea" id="ca-brief" rows="6" placeholder="Who ${esc(editing.name)} is, their business, preferences, tone… Their agents read this instead of ${esc(wsName(ws.id))}’s own notes, and ${esc(editing.name)} may see what the agents say, so keep it client-safe.">${esc(f.brief ?? editing.brief ?? '')}</textarea>
        <span class="btnrow" style="justify-content:space-between"><span class="hint">Their agents never see ${esc(wsName(ws.id))}’s CLAUDE.md. Read every line before saving.</span><button type="button" class="btn sm" data-ca="draft">${icon('spark')}Draft from ${esc(wsName(ws.id))}’s notes</button></span></div>` : ''}
      <div class="btnrow end"><button class="btn sm" data-ca="cancel">Cancel</button><button class="btn sm primary" data-ca="save">${editing ? 'Save' : `${icon('key')}Make the link`}</button></div>
    </div>` : '';
  const fresh = access.fresh && list.some(c => c.id === access.fresh.id) ? access.fresh : null;
  return `<div class="section-h"><h3>Client access <span class="count">${list.length}</span></h3>${f && !editing ? '' : `<button class="btn sm" data-ca="add">${icon('plus')}Share agents</button>`}</div>
    <p class="hint" style="margin:0">A private link for a client to work with chosen agents from their own page, as ${esc(wsName(ws.id))}’s accounts. Their agents’ questions and decisions in ${esc(wsName(ws.id))}’s apps go to them; anything that touches this PC still comes to you.</p>
    ${pages.online ? '' : `<div class="offbar"><b>Only on this PC so far</b><span>Links open at ${esc(pages.base || 'http://localhost:8009')} until the client page is online. Put port ${esc(pages.port || 8009)} (never the dashboard’s own port) behind a Cloudflare Tunnel with Access, then enter its address below. README → Client pages has the steps.</span></div>`}
    ${fresh ? `<div class="cfresh"><b>Link for ${esc(list.find(c => c.id === fresh.id).name)}</b><span>Shown only now. Copy it and send it to them. Lost it? Make a new one; the old one then stops working.</span>
      <div class="crow"><input class="input" readonly value="${esc(fresh.link)}" aria-label="The link" data-ca="link"><button class="btn sm primary" data-ca="copy">Copy</button></div></div>` : ''}
    ${form && !editing ? form : ''}
    ${list.length ? `<div class="list clients">${list.map(c => `<div class="client-row${c.enabled === false ? ' off' : ''}">
        <span class="t"><span class="nm"><b>${esc(c.name)}</b>${c.enabled === false ? '<span class="plate">off</span>' : ''}</span><span>${c.email ? esc(c.email) : '<span class="plate decide">no email</span> add one before the page goes online'}</span>
          <span class="chips">${c.agents.map(s => `<span class="chip">${esc(name(s))}</span>`).join('')}</span>
          <span class="hint">Link made ${c.linkAt ? esc(dateTime(c.linkAt)) : '—'} · ${c.brief ? 'brief set' : 'no brief yet (Edit adds one)'}</span></span>
        <span class="btnrow"><button class="btn sm" data-ca="rotate" data-id="${esc(c.id)}">${icon('refresh')}New link</button><button class="btn sm" data-ca="edit" data-id="${esc(c.id)}">${icon('edit')}Edit</button>
          <button class="btn sm" data-ca="toggle" data-id="${esc(c.id)}">${c.enabled === false ? 'Switch on' : 'Switch off'}</button><button class="btn sm" data-ca="remove" data-id="${esc(c.id)}">${icon('trash')}Remove</button></span>
        ${editing?.id === c.id ? form : ''}
      </div>`).join('')}</div>` : f ? '' : '<div class="empty"><strong>Nobody yet</strong>Share agents to give a client their own page.</div>'}
    <div class="field"><label for="ca-url">Client page address (public)</label>
      <div class="crow"><input class="input" id="ca-url" value="${esc(access.url ?? (pages.online ? pages.base : ''))}" placeholder="https://clients.your-domain.com"><button class="btn sm" data-ca="url">Save</button></div>
      <span class="hint">The Cloudflare hostname that points at port ${esc(pages.port || 8009)}. New links use it.</span></div>
    <div class="field"><label for="ca-team">Cloudflare Access team</label>
      <div class="crow"><input class="input data" id="ca-team" value="${esc(ctx.state.envStatus?.CF_ACCESS_TEAM_DOMAIN || '')}" placeholder="your-team.cloudflareaccess.com"><button class="btn sm" data-ca="team">Save</button></div></div>
    <div class="field"><label for="ca-aud">Access application audience (AUD) tag</label>
      <div class="crow"><input class="input data" id="ca-aud" value="${esc(ctx.state.envStatus?.CF_ACCESS_AUD || '')}" placeholder="From Zero Trust → Access → Applications → your app"><button class="btn sm" data-ca="aud">Save</button></div>
      <span class="hint">Orchy checks the token Cloudflare signs on every visit against these two. Until both are set, the page stays closed online.</span></div>`;
}

function wireClientAccess(root, ws, access, rerender) {
  const q = s => root.querySelector(`[data-ca="${s}"]`);
  const busy = async (btn, fn) => { if (btn) btn.disabled = true; try { await fn(); } catch (e) { ctx.toast(e.message, 'warn'); if (btn) btn.disabled = false; } };
  // what the owner types lives in `access`, which the next draw reads: a run ending mid-sentence keeps it
  const form = root.querySelector('.cform');
  form?.addEventListener('input', () => Object.assign(access.form || {}, {
    name: form.querySelector('#ca-name').value, email: form.querySelector('#ca-email').value,
    agents: [...form.querySelectorAll('.cpicks input:checked')].map(i => i.value),
    ...(form.querySelector('#ca-brief') ? { brief: form.querySelector('#ca-brief').value } : {}),
    ...(form.querySelector('#ca-calls') ? { calls: form.querySelector('#ca-calls').checked } : {}),
  }));
  root.querySelector('#ca-url')?.addEventListener('input', e => { access.url = e.target.value; });
  q('add')?.addEventListener('click', () => { access.form = { ws: ws.id }; access.fresh = null; rerender(); root.querySelector('#ca-name')?.focus(); });
  q('cancel')?.addEventListener('click', () => { access.form = null; rerender(); });
  q('save')?.addEventListener('click', e => busy(e.currentTarget, async () => {
    const body = {
      name: root.querySelector('#ca-name').value, email: root.querySelector('#ca-email').value,
      agents: [...root.querySelectorAll('.cpicks input:checked')].map(i => i.value), workspace: ws.id,
      ...(root.querySelector('#ca-brief') ? { brief: root.querySelector('#ca-brief').value } : {}),
      ...(root.querySelector('#ca-calls') ? { calls: root.querySelector('#ca-calls').checked } : {}),
    };
    if (access.form?.id) {
      await api(`/api/clients/${encodeURIComponent(access.form.id)}`, { method: 'PATCH', body });
      ctx.toast(`Saved. ${body.name.trim()}’s page shows the change right away.`);
      access.form = null;
    } else {
      const r = await api('/api/clients', { method: 'POST', body });
      access.form = null;
      access.fresh = { id: r.client.id, link: r.link };
    }
    ctx.state.clients = await api('/api/clients');
    rerender();
  }));
  root.querySelectorAll('[data-ca="edit"]').forEach(b => b.addEventListener('click', () => { access.form = { ws: ws.id, id: b.dataset.id }; access.fresh = null; rerender(); }));
  // Orchy drafts a client-safe brief from the workspace's notes; it lands in the box, unsaved, for the owner to read
  q('draft')?.addEventListener('click', e => { const btn = e.currentTarget; busy(btn, async () => {
    btn.innerHTML = `${icon('spark')}Drafting…`;
    const r = await api(`/api/clients/${encodeURIComponent(access.form.id)}/brief-draft`, { method: 'POST' });
    access.form.brief = r.draft;
    root.querySelector('#ca-brief').value = r.draft;
    ctx.toast('Drafted. Read it, change what you like, then Save.');
    btn.disabled = false; btn.innerHTML = `${icon('spark')}Draft again`;
  }); });
  root.querySelectorAll('[data-ca="rotate"]').forEach(b => b.addEventListener('click', e => busy(e.currentTarget, async () => {
    const c = ctx.state.clients.find(x => x.id === b.dataset.id);
    if (!confirm(`Make a new link for ${c.name}? Their current link stops working right away.`)) { b.disabled = false; return; }
    const r = await api(`/api/clients/${encodeURIComponent(b.dataset.id)}/link`, { method: 'POST' });
    access.fresh = { id: r.client.id, link: r.link };
    ctx.state.clients = await api('/api/clients');
    rerender();
  })));
  root.querySelectorAll('[data-ca="toggle"]').forEach(b => b.addEventListener('click', e => busy(e.currentTarget, async () => {
    const c = ctx.state.clients.find(x => x.id === b.dataset.id);
    await api(`/api/clients/${encodeURIComponent(c.id)}`, { method: 'PATCH', body: { enabled: c.enabled === false } });
    ctx.toast(c.enabled === false ? `${c.name}’s link works again.` : `${c.name}’s link is off. What’s already running finishes.`);
    ctx.state.clients = await api('/api/clients');
    rerender();
  })));
  root.querySelectorAll('[data-ca="remove"]').forEach(b => b.addEventListener('click', e => busy(e.currentTarget, async () => {
    const c = ctx.state.clients.find(x => x.id === b.dataset.id);
    if (!confirm(`Remove ${c.name}’s access? Their link stops working. Their earlier tasks stay in Logs.`)) { b.disabled = false; return; }
    const wipe = confirm(`Also delete ${c.name}’s folder (their tasks, the files they gave, what the agents made)?

OK deletes it for good. Cancel keeps it in ${wsName(ws.id)}/.clients.`);
    await api(`/api/clients/${encodeURIComponent(c.id)}${wipe ? '?files=delete' : ''}`, { method: 'DELETE' });
    if (access.fresh?.id === c.id) access.fresh = null;
    ctx.state.clients = await api('/api/clients');
    rerender();
  })));
  q('copy')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(q('link').value); ctx.toast('Link copied. Send it to them directly (not in a group chat).'); }
    catch { q('link').select(); ctx.toast('Copy failed: the link is selected, copy it with Ctrl+C.', 'warn'); }
  });
  for (const [act, key, id] of [['team', 'CF_ACCESS_TEAM_DOMAIN', '#ca-team'], ['aud', 'CF_ACCESS_AUD', '#ca-aud']]) {
    q(act)?.addEventListener('click', e => { const btn = e.currentTarget; busy(btn, async () => {
      await api('/api/settings/env', { method: 'POST', body: { key, value: root.querySelector(id).value } });
      ctx.toast('Saved.');
      btn.disabled = false;
    }); });
  }
  q('url')?.addEventListener('click', e => { const btn = e.currentTarget; busy(btn, async () => {
    await api('/api/settings/env', { method: 'POST', body: { key: 'CLIENT_URL', value: root.querySelector('#ca-url').value } });
    ctx.toast('Saved. Links you make from now on use this address; for an existing client, make a new link.');
    btn.disabled = false;
  }); });
}

// ── Add (or edit) a workspace: Orchy asks for its name, then sets the folder up ──
export async function openAddWorkspace({ edit = null, from } = {}) {
  const id = edit ? `ws-edit-${edit.id}` : 'ws-add';
  if (getWindow(id)) return getWindow(id).restore();
  const body = createEl(`<div style="display:grid;gap:var(--s4)"><div class="empty">Checking which engines this PC has…</div></div>`);
  const w = openWindow({ id, title: edit ? `Edit ${edit.name}` : 'A message from Orchy', size: 'wide', body, from, dockLabel: edit ? `Edit ${edit.name}` : 'New agent' });
  let rt;
  try { rt = await api('/api/runtimes'); } catch (e) { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return w; }
  let engine = edit?.runtime || 'claude';
  const ownNow = () => !!edit?.ownProfile;
  const currentEmail = () => edit?.accounts?.[engine]?.account || '';
  const render = () => {
    const r = rt[engine] || {};
    const profileOnly = r.accountModel === 'profile'; // no email: provider logins in a profile folder of its own
    const ungated = r.capabilities?.gated === false;
    const def = profileOnly ? null : r.defaultAccount;
    const mine = currentEmail();
    const pickOwn = edit ? (ownNow() || (mine && mine !== def)) : !def;
    body.innerHTML = `
      <div class="from"><div class="sprite">${orchySVG('happy', 1, { label: 'Orchy' })}</div><div class="t"><b>Orchy</b><span>${edit ? `Changing ${esc(edit.name)}` : 'New agent · I set up its folder like your other workspaces'}</span></div></div>
      ${edit ? '' : `<p class="ask" style="margin:0">What should I call it?</p>`}
      <div style="display:grid;gap:var(--s3)">
        ${edit ? '' : `<div class="field"><label for="wa-name">Name</label><input class="input" id="wa-name" placeholder="e.g. Acme Agent" maxlength="48" autofocus><span class="hint" data-folder>Becomes the folder …</span></div>`}
        <div class="field"><label for="wa-client">Client</label><input class="input" id="wa-client" placeholder="Who it works for, e.g. Acme Inc." value="${esc(edit?.client || '')}"></div>
        <div class="field"><label for="wa-blurb">What it’s for</label><textarea class="textarea" id="wa-blurb" style="min-height:64px" placeholder="The work it does and the apps it uses. Jev reads this to route tasks here.">${esc(edit?.blurb || '')}</textarea></div>
        <div class="field"><label for="wa-aliases">Also called</label><input class="input" id="wa-aliases" placeholder="e.g. Acme, ACM" value="${esc((edit?.aliases || []).join(', '))}"><span class="hint">Other names you use for it, comma separated. Its own name already counts: “for ${esc(edit ? (edit.handles?.[0] || edit.name) : 'Acme')} …” sends work here.</span></div>
        <div class="field"><span class="label">Runs on</span>
          <div class="seg" role="group" aria-label="Engine">${Object.keys(rt).map(k => `<button type="button" data-engine="${esc(k)}" aria-pressed="${engine === k}" ${rt[k]?.available || k === engine ? '' : 'disabled'} title="${rt[k]?.available ? '' : 'Not installed on this PC yet'}">${esc(rt[k]?.label || k)}</button>`).join('')}</div>
          <span class="hint">${esc(r.blurb || '')} ${[...new Set(r.models || [])].filter(m => m !== 'default').length ? `Models: ${esc([...new Set(r.models || [])].join(', '))}.` : 'Uses the model its own config picks.'}${r.sandbox && r.sandbox !== 'ready' ? ' This PC hasn’t set up Codex’s Windows sandbox, so Orchy checks every single command first.' : ''}${r.available ? '' : ` ${esc(r.label || engine)} isn’t installed on this PC yet.`}</span>
          ${ungated ? `<div class="fixbar"><b>${esc(r.label)} can’t be held behind your approvals.</b><span>It could change files and run commands without asking you. Orchy won’t start it unless you allow that here.</span>
            <label class="choice"><input type="checkbox" id="wa-ungated" ${edit?.allowUngated ? 'checked' : ''}><span>I understand: let it run without approvals</span></label></div>` : ''}</div>
        ${profileOnly ? `<div class="field"><span class="label">Runs as</span>
          <span class="hint">Its own ${esc(r.label || '')} profile folder, made for it so its provider logins never mix with another agent’s. You log it in once (a sign-in window opens after you set it up).</span>
          <input class="input" id="wa-email" type="text" maxlength="80" placeholder="Provider it uses, e.g. anthropic (optional note)" value="${esc(mine)}"></div>` : `<div class="field"><span class="label">Runs as</span>
          ${def ? `<label class="choice"><input type="radio" name="wa-acct" value="default" ${pickOwn ? '' : 'checked'}><span>Your default ${esc(r.label || '')} profile · <b>${esc(def)}</b></span><span class="hint">Same login as your other ${esc(r.label || '')} work.</span></label>` : ''}
          <label class="choice"><input type="radio" name="wa-acct" value="own" ${pickOwn ? 'checked' : ''}><span>Its own account</span><span class="hint">Gets its own profile folder so it never mixes with your others. You log it in once.</span></label>
          <input class="input" id="wa-email" type="email" placeholder="the account’s email" value="${esc(mine && mine !== def ? mine : '')}" ${pickOwn ? '' : 'hidden'}></div>`}
        ${edit ? '' : `<label style="display:grid;grid-template-columns:auto 1fr;gap:var(--s3);align-items:center"><span class="switch"><input type="checkbox" role="switch" id="wa-signin" checked><span class="track"><span class="knob"></span></span></span><span>Open the sign-in windows it needs right away (One, and its own account if it has one)</span></label>`}
      </div>
      <div class="btnrow end"><button class="btn" data-a="cancel">Cancel</button><button class="btn primary" data-a="go">${icon(edit ? 'check' : 'spark')}${edit ? 'Save' : 'Set it up'}</button></div>`;
    const name = body.querySelector('#wa-name');
    const folder = body.querySelector('[data-folder]');
    name?.addEventListener('input', () => { folder.textContent = `Becomes the folder ${name.value.trim() || '…'}`; });
    body.querySelectorAll('[data-engine]').forEach(b => b.addEventListener('click', () => { keep(); engine = b.dataset.engine; render(); restore(); }));
    body.querySelectorAll('[name="wa-acct"]').forEach(r => r.addEventListener('change', () => { body.querySelector('#wa-email').hidden = body.querySelector('[name="wa-acct"]:checked').value !== 'own'; }));
    body.querySelector('[data-a="cancel"]').addEventListener('click', () => w.close());
    body.querySelector('[data-a="go"]').addEventListener('click', submit);
  };
  let kept = {};
  const keep = () => { kept = { name: body.querySelector('#wa-name')?.value, client: body.querySelector('#wa-client')?.value, blurb: body.querySelector('#wa-blurb')?.value, aliases: body.querySelector('#wa-aliases')?.value }; };
  const restore = () => { for (const [k, v] of Object.entries(kept)) { const el = body.querySelector(`#wa-${k}`); if (el && v != null) el.value = v; } body.querySelector('#wa-name')?.dispatchEvent(new Event('input')); };
  const submit = async e => {
    const btn = e.currentTarget;
    const profileOnly = rt[engine]?.accountModel === 'profile';
    const own = profileOnly || body.querySelector('[name="wa-acct"]:checked')?.value === 'own';
    const account = own ? body.querySelector('#wa-email').value.trim() : rt[engine]?.defaultAccount;
    const payload = { client: body.querySelector('#wa-client').value.trim(), blurb: body.querySelector('#wa-blurb').value.trim(), aliases: body.querySelector('#wa-aliases').value, runtime: engine, account, ownProfile: own, allowUngated: rt[engine]?.capabilities?.gated === false && !!body.querySelector('#wa-ungated')?.checked };
    if (!edit && !body.querySelector('#wa-name').value.trim()) { body.querySelector('#wa-name').focus(); return ctx.toast('Give it a name first.', 'warn'); }
    if (own && !profileOnly && !account) { body.querySelector('#wa-email').focus(); return ctx.toast('Which account should it run as?', 'warn'); }
    btn.disabled = true;
    try {
      if (edit) {
        await api(`/api/workspaces/${encodeURIComponent(edit.id)}`, { method: 'PATCH', body: payload });
        ctx.toast(`${edit.name} saved.`);
        w.close();
        return;
      }
      const signin = body.querySelector('#wa-signin').checked;
      const r = await api('/api/workspaces', { method: 'POST', body: { ...payload, name: body.querySelector('#wa-name').value.trim(), session: ctx.activeSession?.() } });
      const ws = r.workspace;
      w.close();
      openAgents(ws.id);
      if (signin) {
        if (!ws.oneScoped) api(`/api/workspaces/${encodeURIComponent(ws.id)}/one-login`, { method: 'POST' }).catch(err => ctx.toast(err.message, 'warn'));
        if (!ws.account?.ok) api(`/api/workspaces/${encodeURIComponent(ws.id)}/login`, { method: 'POST' }).catch(err => ctx.toast(err.message, 'warn'));
      }
      ctx.toast(`${wsName(ws.id)} is set up in ${ws.folder}.${signin ? ' Finish signing in, in the windows that just opened.' : ''}`);
    } catch (err) { btn.disabled = false; ctx.toast(err.message, 'warn'); }
  };
  render();
  return w;
}

// ── Retire a workspace (archive its folder), or delete a retired one for good ──
function openRetire(ws, { purge = false, from } = {}) {
  const id = `${purge ? 'purge' : 'retire'}-${ws.id}`;
  if (getWindow(id)) return getWindow(id).restore();
  const live = [...ctx.state.runs.values()].filter(r => r.workspace === ws.id && LIVE.has(r.status)).length;
  const body = createEl(`<div style="display:grid;gap:var(--s4)">
    <p class="ask" style="margin:0">${purge ? `Delete ${esc(ws.name)} for good?` : `Retire ${esc(ws.name)}?`}</p>
    <div class="list">${(purge ? [
      `Deletes Retired/${esc(ws.archivedFolder || ws.folder)}: its agents, notes and files. This can’t be undone.`,
      'LOGS.md keeps its history. Remembered approvals for it are cleared.',
      `Its ${ws.runtimeLabel || 'harness'} login and One connections stay on those accounts; remove them there if you want.`,
    ] : [
      `Moves its folder to Retired/, so nothing is lost. You can restore it from Workspace → Retired.`,
      'Orchy stops routing to it, its scheduled runs stop, and its panel goes away.',
      'LOGS.md keeps its history. Its logins and One connections are left alone.',
    ]).map(x => `<div class="limit">${icon(purge ? 'bang' : 'check')}<span>${x}</span></div>`).join('')}</div>
    ${live && !purge ? `<div class="fixbar"><b>It’s working right now</b><span>Stop its run${live === 1 ? '' : 's'} (or let ${live === 1 ? 'it' : 'them'} finish) before retiring it.</span></div>` : ''}
    <div class="field"><label for="${id}-c">Type <b>${esc(ws.name)}</b> to confirm</label><input class="input" id="${id}-c" autocomplete="off" autofocus></div>
    <div class="btnrow end"><button class="btn" data-a="cancel">Cancel</button><button class="btn primary" data-a="go" disabled>${icon('trash')}${purge ? 'Delete for good' : 'Retire it'}</button></div>
  </div>`);
  const w = openWindow({ id, title: purge ? `Delete ${ws.name}` : `Retire ${ws.name}`, body, from });
  const input = body.querySelector('input');
  const go = body.querySelector('[data-a="go"]');
  input.addEventListener('input', () => { go.disabled = input.value.trim().toLowerCase() !== ws.name.toLowerCase() || (!!live && !purge); });
  body.querySelector('[data-a="cancel"]').addEventListener('click', () => w.close());
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      if (purge) { await api(`/api/workspaces-retired/${encodeURIComponent(ws.id)}`, { method: 'DELETE', body: { confirm: input.value } }); ctx.toast(`${ws.name} is deleted.`); }
      else { const r = await api(`/api/workspaces/${encodeURIComponent(ws.id)}/retire`, { method: 'POST', body: { confirm: input.value } }); ctx.toast(`${ws.name} is retired. Its folder is in Retired/${r.archivedFolder}.`); }
      w.close();
    } catch (err) { go.disabled = false; ctx.toast(err.message, 'warn'); }
  });
  return w;
}

// ── Logs ── (LOGS.md names workspaces, so map names back to ids, retired ones included)
const wsByName = () => [...ctx.state.workspaces, ...(ctx.state.retired || [])].map(w => [w.name, w.id]);
const idOf = name => wsByName().find(([n]) => n === name)?.[1] || null;
export async function openLogs({ from } = {}) {
  const existing = getWindow('logs');
  if (existing) { existing.restore(); existing.refresh?.(); return existing; }
  const body = createEl(`<div style="display:grid;gap:var(--s3)"></div>`);
  const w = openWindow({ id: 'logs', title: 'Logs · LOGS.md', size: 'wide', body, from });
  let filter = 'all';
  w.refresh = async () => {
    let data;
    try { data = await api('/api/logs'); } catch (e) { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    const entries = data.entries.slice().reverse().filter(e => filter === 'all' || e.workspace === filter);
    body.innerHTML = `
      <div class="btnrow" style="justify-content:space-between">
        <div class="seg" role="group" aria-label="Filter by workspace">${[['all', 'All'], ...wsByName().filter(([n]) => data.entries.some(e => e.workspace === n)).map(([n, id]) => [n, wsShort(id)])].map(([v, l]) => `<button type="button" data-f="${esc(v)}" aria-pressed="${filter === v}">${esc(l)}</button>`).join('')}</div>
        <span class="hint">${data.entries.length} finished task${data.entries.length === 1 ? '' : 's'} · newest first · file: LOGS.md</span>
      </div>
      <div class="loglist">${entries.map(e => `
        <div class="logent"><button type="button" aria-expanded="false">
          <span class="plate ${idOf(e.workspace) ? wsClass(idOf(e.workspace)) : ''}">${esc(idOf(e.workspace) ? wsShort(idOf(e.workspace)) : e.workspace || '?')}</span>
          <span class="lt"><b>${icon(e.kind === 'ok' ? 'check' : e.kind === 'bad' ? 'bang' : 'clock')} ${esc(e.agent)} · ${esc(e.status || '')}</b><span>${esc(e.when)} · ${esc(e.task)}</span></span>${icon('play')}</button>
          <div class="lb md" hidden>${md(e.markdown.replace(/^###.*\n/, ''))}${e.runId ? `<p><button class="btn sm" data-run="${esc(e.runId)}">${icon('eye')}Open run</button></p>` : ''}</div></div>`).join('') || '<div class="empty"><strong>Nothing logged yet</strong>Every task an agent finishes lands here, with its workspace, agent and a detailed summary.</div>'}</div>`;
    body.querySelectorAll('[data-f]').forEach(b => b.addEventListener('click', () => { filter = b.dataset.f; w.refresh(); }));
    body.querySelectorAll('.logent > button').forEach(b => b.addEventListener('click', () => {
      const lb = b.nextElementSibling; lb.hidden = !lb.hidden; b.setAttribute('aria-expanded', String(!lb.hidden));
    }));
    body.querySelectorAll('[data-run]').forEach(b => b.addEventListener('click', () => ctx.openRun(b.dataset.run)));
  };
  w.refresh();
  return w;
}

// ── Impact ── (what the agents did, against what people would have cost: estimates, assumptions shown)
export async function openImpact({ from } = {}) {
  const existing = getWindow('impact');
  if (existing) { existing.restore(); existing.refresh?.(); return existing; }
  const body = createEl(`<div style="display:grid;gap:var(--s3)"></div>`);
  const w = openWindow({ id: 'impact', title: 'Impact · agents vs a team of people', size: 'wide', body, from });
  let period = 'month', rate = 45, speedup = 6;
  const money = n => `$${Math.round(n).toLocaleString('en-US')}`;
  w.refresh = async () => {
    let d;
    try { d = await api(`/api/impact?period=${period}&rate=${rate}&speedup=${speedup}`); } catch (e) { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    const t = d.totals;
    // Per role: what a VA would cost against what the agent cost (the AI Agent Builder isn't counted, workspaces show as Business A, B, C)
    const top = Math.max(1, ...d.agents.map(a => a.humanCost), ...d.agents.map(a => a.apiCost));
    const bar = (label, v, cls) => `<div style="display:grid;grid-template-columns:8.5em 1fr 5em;gap:8px;align-items:center"><span class="hint">${label}</span><span class="${cls}" style="display:block;height:12px;width:${v ? Math.max(v / top * 100, 1) : 0}%;background:${cls === 'dith' ? 'repeating-linear-gradient(45deg,var(--ink) 0 2px,transparent 2px 4px)' : 'var(--ink)'};border:2px solid var(--ink)"></span><b class="data">${money(v)}</b></div>`;
    const vsVa = list => list.map(a => `<div style="display:grid;gap:4px"><div><b>${esc(a.name)}</b> <span class="hint">${esc(wsName(a.ws))} · ${a.done}/${a.tasks} done · ${a.humanHours} h of work</span></div>${bar('A VA would cost', a.humanCost, 'dith')}${bar('The agent cost', a.apiCost, 'solid')}</div>`).join('');
    body.innerHTML = `
      <div class="btnrow" style="justify-content:space-between">
        <div class="seg" role="group" aria-label="Period">${[['week', 'Last 7 days'], ['month', 'Last 30 days'], ['all', 'Everything']].map(([v, l]) => `<button type="button" data-p="${v}" aria-pressed="${period === v}">${l}</button>`).join('')}</div>
        <span class="hint">${t.tasks} finished task${t.tasks === 1 ? '' : 's'}: ${t.done} done, ${t.partial} partly, ${t.notDone} not done</span>
      </div>
      ${t.tasks ? `<div class="ctx"><b>${money(t.saved)} saved</b>: the agents did about ${t.humanHours} hours of work (${t.fteWeeks} full-time weeks) that would cost ${money(t.humanCost)} in people, for ${money(t.apiCost)} in Claude use${t.times ? ` (${t.times}x cheaper)` : ''}. They worked ${t.agentHours} hours by the clock.</div>` : '<div class="empty"><strong>Nothing finished in this period</strong>Pick a longer one.</div>'}
      ${t.tasks ? `<div class="field"><span class="label">Each agent vs hiring a VA</span><div class="list" style="gap:var(--s3)">${vsVa(d.agents)}</div></div>` : ''}
      <div class="btnrow">
        <button type="button" class="btn sm" data-month title="Opens a page you can keep or print. Orchy writes last month's on the 1st.">Monthly report</button>
        <label class="hint">A person costs $/hour <input type="number" min="1" max="1000" value="${rate}" data-rate style="width:5em"></label>
        <label class="hint">People take x as long as the agent <input type="number" min="1" max="100" value="${speedup}" data-speed style="width:4em"></label>
      </div>
      <ul class="hint">${d.assumptions.map(a => `<li>${esc(a)}</li>`).join('')}</ul>`;
    body.querySelectorAll('[data-p]').forEach(b => b.addEventListener('click', () => { period = b.dataset.p; w.refresh(); }));
    body.querySelector('[data-month]').addEventListener('click', async e => {
      e.target.disabled = true;
      try { const r = await api('/api/reports', { method: 'POST', body: { month: new Date().toLocaleDateString('en-CA', { timeZone: ctx.state.timezone || undefined }).slice(0, 7), rate, speedup } }); window.open(r.url, '_blank'); } catch (err) { ctx.toast(err.message, 'warn'); }
      e.target.disabled = false;
    });
    body.querySelector('[data-rate]').addEventListener('change', e => { rate = Number(e.target.value) || 45; w.refresh(); });
    body.querySelector('[data-speed]').addEventListener('change', e => { speedup = Number(e.target.value) || 6; w.refresh(); });
  };
  w.refresh();
  return w;
}

// ── Connections ──
// Each workspace's app list comes from its own One login, so each is loaded (and kept) on its own
const platforms = new Map(); // wsId -> [apps]
const loadPlatforms = async wsId => { // { list, error }: a failure isn't remembered
  if (!platforms.has(wsId)) {
    try { platforms.set(wsId, await api(`/api/workspaces/${encodeURIComponent(wsId)}/one/platforms`)); }
    catch (e) { return { list: [], error: e.message }; }
  }
  return { list: platforms.get(wsId), error: null };
};

/** Where the last "Add app" for this workspace stands. */
function appStatusHTML(d) {
  const a = d.oneAdd;
  if (!a) return '';
  const name = platformName(a.platform);
  if (a.status === 'waiting') return `<div class="ctx"><span class="plate blink">waiting</span> Finish connecting <b>${esc(name)}</b> in the browser window One opened (signed in as ${esc(wsName(current))}’s One account). One gives up after 5 minutes.</div>`;
  if (a.status === 'done') return `<div class="ctx">${icon('check')} Added ${a.added.map(c => `<b>${esc(c.name)}</b>`).join(', ')}.</div>`;
  if (a.status === 'none') return `<div class="ctx">One finished, but no new ${esc(name)} connection showed up in ${esc(wsName(current))}’s One account. If the browser was signed in to a different One account, switch to ${esc(wsName(current))}’s and try again.</div>`;
  return `<div class="ctx"><b>${esc(name)} didn’t connect:</b> ${esc(a.error || 'unknown error')}</div>`;
}

export async function openConnections(wsId, { from, edit } = {}) {
  const existing = getWindow('connections');
  if (existing) { existing.restore(); existing.edit?.(edit); existing.show?.(wsId); return existing; }
  const body = createEl(`<div style="display:grid;gap:var(--s4)"></div>`);
  const w = openWindow({ id: 'connections', title: 'Connections', size: 'wide', body, from });
  let current = wsId;
  let adding = false, draft = { type: 'stdio' }; // the MCP server form and what the owner typed in it, kept through redraws
  let editing = null, pendingEdit = edit || null; // the MCP server being edited (its name stays: agents name it in mcp_servers)
  // A saved server as the form's fields
  const toDraft = (name, s) => ({
    type: s.type || 'stdio', mn: name, on: s.enabled !== false, md: s.description || '',
    mc: s.command || '', ma: (s.args || []).join('\n'), me: Object.entries(s.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'),
    mu: s.url || '', mh: Object.entries(s.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n'),
  });
  const closeForm = () => { adding = false; editing = null; draft = { type: 'stdio' }; };
  w.edit = name => { if (name) pendingEdit = name; };
  // A browser the owner hasn't paired gets each server's values as •••••• (orchestrator/lib/workspaces.mjs hideMcp).
  // They never go into the form or back to Orchy: it pairs first, and once it is paired the real values load.
  let paired = false;
  const pairFirst = async name => { // true: this click stops here
    if (paired) return false;
    const o = await api('/api/owner').catch(() => ({}));
    if (!o.paired) { openPair(); return true; }
    if (name) pendingEdit = name;
    w.show(current);
    return true;
  };
  let seq = 0; // only the latest show() draws: a slower, older answer is dropped
  const tabsHTML = () => `<div class="tabs" role="tablist">${ctx.state.workspaces.map(x => `<button role="tab" data-ws="${esc(x.id)}" aria-selected="${x.id === current}">${esc(wsName(x.id))}</button>`).join('')}</div>`;
  w.show = async (id, { refresh = false } = {}) => {
    if (body.querySelector('.tabs.sorting')) return; // mid-drag: the drop redraws it
    if (!ctx.state.workspaces.some(x => x.id === id)) id = ctx.state.workspaces[0]?.id;
    if (!id) { // no workspace yet: nothing to connect to
      seq++;
      body.innerHTML = `<div class="empty"><strong>Add a workspace first</strong>Connections (apps and MCP servers) belong to a workspace. Add one and they show up here.</div><div class="btnrow"><button class="btn primary" type="button" data-act="add-ws">${icon('plus')}Add a workspace</button></div>`;
      body.querySelector('[data-act="add-ws"]').addEventListener('click', e => openAddWorkspace({ from: e.currentTarget }));
      return;
    }
    const mine = ++seq;
    const quiet = id === current && !refresh && body.querySelector('[data-form]'); // a live redraw keeps the page up until the new data is in
    if (id !== current && editing) closeForm(); // that server belongs to the other workspace
    current = w.current = id;
    const say = text => {
      body.innerHTML = `${tabsHTML()}<div class="empty">${esc(text)}</div>`;
      body.querySelectorAll('[data-ws]').forEach(b => b.addEventListener('click', () => w.show(b.dataset.ws)));
    };
    if (!quiet) say(`Loading ${wsName(id)}…`);
    let d, mcp, own;
    try { [d, mcp, own] = await Promise.all([api(`/api/workspaces/${encodeURIComponent(id)}${refresh ? '?refresh=1' : ''}`), api(`/api/workspaces/${encodeURIComponent(id)}/mcp`), api('/api/owner').then(o => !!o.paired, () => false)]); }
    catch (e) { if (mine === seq) say(e.message); return; }
    if (mine !== seq) return;
    paired = own;
    const groups = {};
    for (const c of d.connections.one) (groups[c.platform] ||= []).push(c);
    // friendly versions of the ways One can be unavailable: not signed in, CLI missing, or some other error
    let oneNote = '';
    const oneErr = d.connections.oneError;
    if (d.oneScoped === false) {
      oneNote = `<div class="empty"><strong>${esc(wsName(current))} isn’t signed in to One</strong>Each workspace uses its own One account, so its apps stay separate from your other businesses. Create an account if you don’t have one, make an organization for this business, then sign in.<div class="btnrow"><button class="btn" type="button" data-act="create-one">${icon('plug')}Create a One account</button><button class="btn primary" type="button" data-act="one-login">${icon('key')}Sign in to One</button></div></div>`;
    } else if (oneErr) {
      let one = null;
      try { one = (await api('/api/setup')).tools.find(t => t.id === 'one'); } catch {}
      if (mine !== seq) return;
      oneNote = one && !one.found
        ? `<div class="empty"><strong>The One CLI isn’t installed</strong>One is how agents reach Gmail, Slack, Notion and 750+ other apps. Install it, then press Re-check.${cmdHTML(one.installCmd)}<div class="btnrow"><button class="btn" type="button" data-act="cli-recheck">${icon('refresh')}Re-check</button><button class="btn ghost" type="button" data-act="one-guide">How One works</button></div></div>`
        : `<div class="empty"><strong>One didn’t answer</strong>Orchy couldn’t read this workspace’s apps. Press Refresh to try again; if it keeps failing, sign in to One again.<pre class="cmd">${esc(oneErr)}</pre></div>`;
    }
    const at = focusOf(body);
    body.innerHTML = `
      ${tabsHTML()}
      <dl class="kv"><dt>Client</dt><dd>${esc(wsName(current))}</dd><dt>One account</dt><dd>${d.oneScoped !== false ? `${esc(d.identity.oneUser || '?')}${d.identity.oneOrg ? ` · org ${esc(d.identity.oneOrg)}` : ''}` : `<span class="plate decide">not signed in</span> <button class="btn sm" data-act="one-login">Sign in to One</button>`}</dd>
        <dt>${esc(d.runtimeLabel || 'Claude Code')}</dt><dd>${d.account.ok ? `${icon('check')} ${esc(d.account.actual)}` : `<span class="plate decide">needs login</span> expects ${esc(d.account.expected || '')}`}</dd>
        ${(d.extraAccounts || []).map(x => `<dt>${esc(x.runtimeLabel)}</dt><dd>${x.ok ? `${icon('check')} ${esc(x.actual)}` : `<span class="plate decide">needs login</span> expects ${esc(x.expected || 'an account')}`} · for ${esc(x.agents.join(', '))}</dd>`).join('')}</dl>
      <div class="field"><div class="section-h"><span class="label">External connections · MCP servers (${Object.keys(mcp).length})</span><button class="btn sm" data-act="add">${icon('plus')}Add</button></div>
        <div class="list">${Object.entries(mcp).map(([n, s]) => `<div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center">
          <span><b>${esc(n)}</b> <span class="chip">${esc(s.type)}</span>${s.enabled ? '' : ' <span class="chip">off</span>'}<br><span class="data muted">${esc(s.type === 'stdio' ? `${s.command} ${[].concat(s.args || []).join(' ')}` : s.url)}</span>${s.description ? `<br><span class="hint">${esc(s.description)}</span>` : ''}</span>
          <span class="btnrow"><button class="btn sm" data-test="${esc(n)}">Test</button><button class="btn sm" data-edit="${esc(n)}" aria-pressed="${editing === n}">${icon('edit')}Edit</button><button class="btn sm icon" data-del="${esc(n)}" aria-label="Remove ${esc(n)}">${icon('trash')}</button></span></div>`).join('') || '<div class="hint">None yet. Add an MCP server and the Agent Builder can hand it to agents.</div>'}</div>
        ${!paired && Object.keys(mcp).length ? `<div class="btnrow"><span class="hint" style="flex:1">This browser isn’t paired, so the values in these servers show as ••••••. Pair it to see, test or change them.</span><button class="btn sm" data-act="pair">${icon('key')}Pair this browser</button></div>` : ''}
        <div data-form></div></div>
      <div class="field"><div class="section-h"><span class="label">One connections (${d.connections.one.length})</span><span class="btnrow">${d.oneScoped !== false && !oneErr ? `<button class="btn sm" data-act="app">${icon('plus')}Add app</button>` : ''}<button class="btn sm ghost" data-act="one-guide">How One works</button><button class="btn sm" data-act="refresh">${icon('refresh')}Refresh</button></span></div>
        ${oneNote}
        ${appStatusHTML(d)}
        <div data-appform hidden style="display:grid;gap:var(--s3);padding:var(--s3);border:var(--rule) dashed var(--ink)">
          <div class="field"><label for="app-${esc(current)}">Which app?</label>
            <div class="btnrow"><input class="input" id="app-${esc(current)}" list="apps-${esc(current)}" placeholder="Search 900+ apps: Gmail, Slack, HubSpot…" autocomplete="off" style="flex:1;min-width:200px"><button class="btn primary" data-act="app-go">${icon('plug')}Connect</button><button class="btn" data-act="app-cancel">Cancel</button></div>
            <datalist id="apps-${esc(current)}"></datalist>
            <div class="ctx" data-platformerr hidden></div>
            <div class="ctx" data-noplatforms hidden><b>The app list is empty.</b> One may not be reachable, or the app isn’t switched on yet. In the One dashboard: Developers (bottom left) → Embeddable Auth → search the app → turn on <b>Visible</b>. Make sure the environment at the top right is the one you want.</div>
            <span class="hint">One opens its connect page in your browser. Sign in there as ${esc(wsName(current))}’s One account${d.identity?.oneUser ? ` (${esc(d.identity.oneUser)})` : ''}, then approve the app. It shows up here by itself.</span></div>
          <div class="examples">${[['gmail', 'Gmail'], ['google-calendar', 'Google Calendar'], ['google-drive', 'Google Drive'], ['slack', 'Slack'], ['notion', 'Notion'], ['hubspot', 'HubSpot']].map(([s, n]) => `<button type="button" data-app="${s}">${n}</button>`).join('')}</div>
        </div>
        <div class="list">${Object.entries(groups).map(([p, cs]) => `<div style="display:grid;grid-template-columns:150px 1fr;gap:8px"><b>${esc(platformName(p))}</b><span>${cs.map(c => esc(c.name)).join(' · ')}</span></div>`).join('') || (d.oneScoped === false || oneErr ? '' : '<div class="hint">No apps connected yet. Press <b>Add app</b> to connect Gmail, Slack, Notion and more. If an app is missing from the list, switch it on in Embeddable Auth (see How One works).</div>')}</div></div>`;
    wireCopy(body);
    body.querySelectorAll('[data-ws]').forEach(b => b.addEventListener('click', () => w.show(b.dataset.ws)));
    movableTabs(body, id => w.show(id));
    body.querySelector('[data-act="refresh"]').addEventListener('click', () => w.show(current, { refresh: true }));
    body.querySelectorAll('[data-act="create-one"]').forEach(b => b.addEventListener('click', () => window.open(ONE_SIGN_IN, '_blank', 'noopener')));
    body.querySelectorAll('[data-act="one-guide"]').forEach(b => b.addEventListener('click', () => openOneGuide({ from: b })));
    body.querySelector('[data-act="cli-recheck"]')?.addEventListener('click', async () => { try { await api('/api/setup?force=1'); } catch {} w.show(current, { refresh: true }); });
    body.querySelectorAll('[data-act="one-login"]').forEach(b => b.addEventListener('click', async e => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try { await api(`/api/workspaces/${encodeURIComponent(current)}/one-login`, { method: 'POST' }); ctx.toast('One opened a sign-in window in your browser. Pick the account and org for this client.'); }
      catch (err) { btn.disabled = false; ctx.toast(err.message, 'warn'); }
    }));
    body.querySelector('[data-act="add"]').addEventListener('click', () => { if (editing) closeForm(); adding = true; renderForm(); });
    body.querySelector('[data-act="pair"]')?.addEventListener('click', () => pairFirst());
    body.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', async () => {
      if (await pairFirst(b.dataset.edit)) return;
      editing = b.dataset.edit; adding = true; draft = toDraft(editing, mcp[editing]);
      body.querySelectorAll('[data-edit]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      renderForm();
    }));
    // Add app: connect Gmail, Slack, … to this workspace's own One account
    const appForm = body.querySelector('[data-appform]');
    const appInput = appForm.querySelector('input');
    body.querySelector('[data-act="app"]')?.addEventListener('click', async () => {
      appForm.hidden = false;
      appInput.focus();
      const forWs = current;
      const { list, error } = await loadPlatforms(forWs);
      if (forWs !== current) return; // another workspace's tab is up now
      appForm.querySelector('[data-platformerr]').hidden = !error;
      appForm.querySelector('[data-platformerr]').textContent = error || '';
      appForm.querySelector('[data-noplatforms]').hidden = !!error || list.length > 0;
      appForm.querySelector('datalist').innerHTML = list.map(p => `<option value="${esc(p.platform)}">${esc(p.name)}${p.category ? ` · ${esc(p.category)}` : ''}</option>`).join('');
    });
    appForm.querySelector('[data-act="app-cancel"]').addEventListener('click', () => { appForm.hidden = true; });
    const connectApp = async (raw, btn) => {
      const q = String(raw || '').trim().toLowerCase();
      if (!q) { appInput.focus(); return ctx.toast('Pick an app first.', 'warn'); }
      const { list, error } = await loadPlatforms(current);
      if (error) return ctx.toast(error, 'warn');
      const hit = list.find(p => p.platform === q) || list.find(p => p.name.toLowerCase() === q);
      if (!hit) return ctx.toast(`One has no app called “${raw}”. Pick one from the list.`, 'warn');
      if (btn) btn.disabled = true;
      try {
        await api(`/api/workspaces/${encodeURIComponent(current)}/one-add`, { method: 'POST', body: { platform: hit.platform } });
        ctx.toast(`One opened ${hit.name} in your browser. Connect it there; it shows up here when it’s done.`);
        w.show(current);
      } catch (err) { if (btn) btn.disabled = false; ctx.toast(err.message, 'warn'); }
    };
    appForm.querySelector('[data-act="app-go"]').addEventListener('click', e => connectApp(appInput.value, e.currentTarget));
    appInput.addEventListener('keydown', e => { if (e.key === 'Enter') connectApp(appInput.value, appForm.querySelector('[data-act="app-go"]')); });
    appForm.querySelectorAll('[data-app]').forEach(b => b.addEventListener('click', () => connectApp(b.dataset.app, b)));
    body.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
      if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.classList.add('decide'); b.setAttribute('aria-label', 'Click again to remove'); return; }
      b.disabled = true;
      try { await api(`/api/workspaces/${current}/mcp/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' }); w.show(current); }
      catch (err) { b.disabled = false; delete b.dataset.confirm; b.classList.remove('decide'); b.setAttribute('aria-label', `Remove ${b.dataset.del}`); ctx.toast(err.message, 'warn'); }
    }));
    body.querySelectorAll('[data-test]').forEach(b => b.addEventListener('click', async () => {
      if (await pairFirst()) return;
      b.disabled = true; b.textContent = 'Testing…';
      const r = await api(`/api/workspaces/${current}/mcp-test`, { method: 'POST', body: mcp[b.dataset.test] }).catch(e => ({ ok: false, error: e.message }));
      b.disabled = false; b.textContent = 'Test';
      ctx.toast(r.ok ? `${b.dataset.test}: works · ${r.tools.length} tools (${r.tools.slice(0, 4).map(t => t.name).join(', ')}${r.tools.length > 4 ? '…' : ''})` : `${b.dataset.test}: ${r.error}`, r.ok ? '' : 'warn');
    }));
    if (pendingEdit && mcp[pendingEdit] && !paired) { pendingEdit = null; openPair(); } // its values are hidden here
    else if (pendingEdit) { // opened from an agent's window: that server's form, or a new one under its name if it isn't here yet
      const n = pendingEdit; pendingEdit = null;
      if (mcp[n]) { editing = n; draft = toDraft(n, mcp[n]); body.querySelector(`[data-edit="${CSS.escape(n)}"]`)?.setAttribute('aria-pressed', 'true'); }
      else { editing = null; draft = { type: 'stdio', mn: n }; ctx.toast(`${n} isn't set up in ${wsName(id)} yet. Add it here.`, 'warn'); }
      adding = true;
      renderForm();
      body.querySelector('[data-form]').scrollIntoView({ block: 'nearest' });
    } else if (adding) renderForm();
    restoreFocus(body, at);
  };
  const renderForm = () => {
    const slot = body.querySelector('[data-form]');
    const v = id => esc(draft[id] || '');
    const stdio = draft.type === 'stdio';
    slot.innerHTML = `<div style="display:grid;gap:var(--s3);padding:var(--s3);border:var(--rule) dashed var(--ink)">
      ${editing ? `<span class="label">Editing ${esc(editing)}</span>` : ''}
      <div class="btnrow"><div class="field" style="flex:1"><label for="mn">Name</label><input class="input" id="mn" placeholder="e.g. hubspot-mcp" value="${v('mn')}"${editing ? ' readonly title="Agents name this server in their file, so it keeps its name. Remove it and add a new one to rename."' : ''}></div>
        ${editing ? `<div class="field"><span class="label">Agents can use it</span><div class="seg" role="group" data-on>${[['on', true], ['off', false]].map(([l, x]) => `<button type="button" data-on="${l}" aria-pressed="${(draft.on !== false) === x}">${l}</button>`).join('')}</div></div>` : ''}
        <div class="field"><span class="label">Type</span><div class="seg" role="group" data-type>${['stdio', 'http', 'sse'].map(t => `<button type="button" data-t="${t}" aria-pressed="${draft.type === t}">${t}</button>`).join('')}</div></div></div>
      <div data-stdio ${stdio ? '' : 'hidden'} style="display:grid;gap:var(--s3)"><div class="field"><label for="mc">Command</label><input class="input data" id="mc" placeholder="npx" value="${v('mc')}"></div>
        <div class="field"><label for="ma">Arguments (one per line)</label><textarea class="textarea data" id="ma" style="min-height:64px" placeholder="-y&#10;@some/mcp-server">${v('ma')}</textarea></div>
        <div class="field"><label for="me">Environment (KEY=value per line)</label><textarea class="textarea data" id="me" style="min-height:56px" placeholder="API_KEY=...">${v('me')}</textarea></div></div>
      <div data-http ${stdio ? 'hidden' : ''} style="display:grid;gap:var(--s3)"><div class="field"><label for="mu">URL</label><input class="input data" id="mu" placeholder="https://example.com/mcp" value="${v('mu')}"></div>
        <div class="field"><label for="mh">Headers (Name: value per line)</label><textarea class="textarea data" id="mh" style="min-height:56px" placeholder="Authorization: Bearer ...">${v('mh')}</textarea></div></div>
      <div class="field"><label for="md">What it's for</label><input class="input" id="md" placeholder="Shown to the Agent Builder when it picks connections" value="${v('md')}"></div>
      <div class="btnrow end"><button class="btn" data-act="cancel">Cancel</button><button class="btn" data-act="test">Test</button><button class="btn primary" data-act="save">${icon('check')}Save</button></div></div>`;
    slot.firstElementChild.addEventListener('input', e => { if (e.target.id) draft[e.target.id] = e.target.value; });
    slot.querySelectorAll('[data-on] [data-on]').forEach(b => b.addEventListener('click', () => {
      draft.on = b.dataset.on === 'on';
      slot.querySelectorAll('[data-on] [data-on]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    }));
    slot.querySelectorAll('[data-t]').forEach(b => b.addEventListener('click', () => {
      draft.type = b.dataset.t;
      slot.querySelectorAll('[data-t]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      slot.querySelector('[data-stdio]').hidden = draft.type !== 'stdio';
      slot.querySelector('[data-http]').hidden = draft.type === 'stdio';
    }));
    const lines = id => slot.querySelector(id).value.split('\n').map(s => s.trim()).filter(Boolean);
    const def = () => ({ enabled: draft.on !== false, ...(draft.type === 'stdio'
      ? { type: draft.type, command: slot.querySelector('#mc').value.trim(), args: lines('#ma'), env: Object.fromEntries(lines('#me').map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])), description: slot.querySelector('#md').value.trim() }
      : { type: draft.type, url: slot.querySelector('#mu').value.trim(), headers: Object.fromEntries(lines('#mh').map(l => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()])), description: slot.querySelector('#md').value.trim() }) });
    slot.querySelector('[data-act="cancel"]').addEventListener('click', () => { closeForm(); slot.innerHTML = ''; body.querySelectorAll('[data-edit]').forEach(x => x.setAttribute('aria-pressed', 'false')); });
    slot.querySelector('[data-act="test"]').addEventListener('click', async e => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const r = await api(`/api/workspaces/${current}/mcp-test`, { method: 'POST', body: def() }).catch(err => ({ ok: false, error: err.message }));
      btn.disabled = false;
      ctx.toast(r.ok ? `Works · ${r.tools.length} tools` : `Didn't connect: ${r.error}`, r.ok ? '' : 'warn');
    });
    slot.querySelector('[data-act="save"]').addEventListener('click', async () => {
      const name = slot.querySelector('#mn').value.trim();
      const was = editing;
      try { await api(`/api/workspaces/${current}/mcp/${encodeURIComponent(name)}`, { method: 'PUT', body: def() }); closeForm(); ctx.toast(was ? `${name} saved. Agents use it from their next run.` : `${name} added to ${wsName(current)}.`); w.show(current); }
      catch (err) { ctx.toast(err.message, 'warn'); }
    });
  };
  w.show(current);
  return w;
}

// ── Settings ──
export async function openSettings({ from } = {}) {
  const existing = getWindow('settings');
  if (existing) { existing.restore(); existing.render?.(); return existing; }
  const body = createEl(`<div style="display:grid;grid-template-columns:minmax(0,1fr);gap:var(--s5)"></div>`);
  const w = openWindow({ id: 'settings', title: 'Settings', size: 'wide', body, from });
  const keys = {}; // API keys pasted but not saved yet: a redraw (a workspace changing) puts them back
  body.addEventListener('input', e => { if (e.target.id?.startsWith('k-')) keys[e.target.id.slice(2)] = e.target.value; });
  body.addEventListener('click', e => { const b = e.target.closest('[data-act="setup-guide"]'); if (b) openSetup({ from: b }); });
  const keyRow = (k, label, hint) => {
    const set = ctx.state.envStatus?.[k];
    return `<div class="field"><label for="k-${k}">${label} ${set ? `<span class="plate">set</span>` : `<span class="plate decide">not set</span>`}</label>
      <div class="btnrow"><input class="input data" id="k-${k}" type="password" autocomplete="off" placeholder="${set ? 'Paste a new key to replace it' : 'Paste key'}" style="flex:1;min-width:200px"><button class="btn" data-save="${k}">Save</button></div>
      <span class="hint">${hint}</span></div>`;
  };
  const draw = () => {
    const s = ctx.state.settings || {};
    const v = voiceConfig();
    const theme = localStorage.getItem('jos-theme') || 'auto';
    body.innerHTML = `
      <section style="display:grid;gap:var(--s3)"><h3 class="px caps" style="margin:0">Behavior</h3>
        ${[['autoDispatch', 'Auto-dispatch when Jev is confident', 'The routing card counts down and sends. Off: you press Send every time.'],
           ['actionPlan', 'Jev plans each task’s app actions', 'Agents start with the One actions Jev picked and their docs. Off: they look them up.'],
           ['voiceReplies', 'Orchy speaks every reply', 'Off: Orchy only speaks when you talked to it.'],
           ['sound', '8-bit sounds', 'A chirp when an agent needs you or finishes.']].map(([k, l, h]) => `
          <label style="display:grid;grid-template-columns:auto 1fr;gap:var(--s3);align-items:center"><span class="switch"><input type="checkbox" role="switch" data-set="${k}" ${s[k] !== false ? 'checked' : ''}><span class="track"><span class="knob"></span></span></span><span><b>${l}</b><br><span class="hint">${h}</span></span></label>`).join('')}
        <div class="btnrow"><span class="label">Huddles</span><label class="hint">two agents talk for up to <select class="select" data-huddleturns aria-label="Turns per huddle" style="width:auto;padding:2px 6px">${[6, 8, 10, 12, 16, 20].map(n => `<option value="${n}" ${(Number(s.huddleTurns) || 10) === n ? 'selected' : ''}>${n}</option>`).join('')}</select> turns, then write up what they agree (Keep talking adds 6)</label></div>
        <div class="btnrow"><span class="label">Theme</span><div class="seg" role="group" aria-label="Theme">${[['auto', 'Auto'], ['day', 'Day'], ['night', 'Night']].map(([t, l]) => `<button type="button" data-theme="${t}" aria-pressed="${theme === t}">${l}</button>`).join('')}</div>
          <button class="btn sm" data-act="notify">${icon('bang')}Desktop alerts</button><button class="btn sm" data-act="setup-guide">${icon('spark')}Setup guide</button></div>
      </section>
      ${browserSectionHTML()}
      <section data-voice style="display:grid;gap:var(--s3)"><h3 class="px caps" style="margin:0">Agents call you</h3>
        <p class="hint" style="margin:0">They ring right here in Orchy, never your phone: answer and you’re talking to the agent by name. One call at a time, at most 12 a day. A missed call lands in Orchy’s chat with Call back. Turn on Desktop alerts to see calls while this tab is in the background.</p>
        ${[['callStuck', s.callStuck !== false, 'When an agent is stuck on you', `A question or approval waited <select class="select" data-callmin aria-label="Minutes before an agent calls" style="width:auto;padding:2px 6px">${[5, 10, 15, 30, 60].map(m => `<option value="${m}" ${(Number(s.callStuckMin) || 10) === m ? 'selected' : ''}>${m}</option>`).join('')}</select> minutes: its agent rings to ask you.`],
           ['callAsk', s.callAsk !== false, 'When an agent asks to', 'For something urgent that can’t wait, at most twice per task. Never from a client’s task.'],
           ['callDone', s.callDone === true, 'When a task finishes', 'The agent rings to tell you how it went, scheduled tasks too. Can get busy.']].map(([k, on, l, h]) => `
          <div style="display:grid;grid-template-columns:auto 1fr;gap:var(--s3);align-items:center"><span class="switch"><input type="checkbox" role="switch" id="cs-${k}" data-setcall="${k}" ${on ? 'checked' : ''}><span class="track"><span class="knob"></span></span></span><span><label for="cs-${k}"><b>${l}</b></label><br><span class="hint">${h}</span></span></div>`).join('')}
        ${ctx.state.envStatus?.ELEVENLABS_API_KEY ? '' : '<div class="ctx">Calls need the ElevenLabs API key (Voice, below).</div>'}
      </section>
      <section style="display:grid;gap:var(--s3)"><h3 class="px caps" style="margin:0">Accounts</h3>
        <div class="list">${ctx.state.workspaces.map(x => `<div style="display:grid;gap:4px"><b>${esc(wsName(x.id))}${x.enabled === false ? ' · off' : ''}</b>
          <span class="hint">${esc(x.account.runtimeLabel || 'Claude Code')} must run as <b>${esc(x.account.expected || '')}</b> · profile ${esc(x.account.configDir)} · ${x.account.ok ? `${icon('check')} logged in as ${esc(x.account.actual)}` : `<span class="plate decide">${x.account.loggedIn ? `wrong account: ${esc(x.account.actual || '?')}` : 'not logged in'}</span>`}</span>
          ${x.account.ok ? '' : `<span class="hint">Paste into a terminal (PowerShell on Windows):</span><code class="data" style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(x.account.fix)}</code><span class="btnrow"><button class="btn sm" data-loginws="${esc(x.id)}">Log in</button><button class="btn sm" data-copycmd="${esc(x.account.fix)}">Copy command</button>${x.account.fixAlt ? `<span class="hint">${esc(x.account.fixAlt)}</span>` : ''}</span>`}
          ${(x.extraAccounts || []).map(e => `<span class="hint">${esc(e.runtimeLabel)} for ${esc(e.agents.join(', '))} must run as <b>${esc(e.expected || 'an account (none set)')}</b> · profile ${esc(e.configDir)} · ${e.ok ? `${icon('check')} logged in as ${esc(e.actual)}` : `<span class="plate decide">${e.loggedIn ? `wrong account: ${esc(e.actual || '?')}` : 'not logged in'}</span>`}</span>
          ${e.ok || !e.fix ? '' : `<span class="btnrow"><button class="btn sm" data-loginws="${esc(x.id)}" data-rt="${esc(e.runtime)}">Log in</button><button class="btn sm" data-copycmd="${esc(e.fix)}">Copy command</button></span>`}`).join('')}</div>`).join('')}</div>
        <div class="btnrow"><button class="btn sm" data-act="accounts">${icon('refresh')}Re-check accounts</button></div>
      </section>
      <section style="display:grid;gap:var(--s3)"><h3 class="px caps" style="margin:0">Routing · TypeSafe Jev</h3>
        <p class="hint" style="margin:0">${ctx.state.jev?.label ? `Jev is reached through ${esc(ctx.state.jev.label)}.${['openrouter', 'opencode'].includes(ctx.state.jev.mode) ? ' This is a chat model answering Jev’s questions, an approximation of the native Jev.' : ''}` : 'Jev is off. Until a provider is set, routing uses keyword matching.'}</p>
        <div class="btnrow"><span class="label">Provider</span><select class="select" data-jevprovider aria-label="Jev provider" style="width:auto">${[['', 'Automatic (the first key set)'], ['typesafe', 'TypeSafe'], ['openrouter', 'OpenRouter'], ['vercel', 'Vercel AI Gateway'], ['opencode', 'OpenCode Zen'], ['off', 'Off (keyword routing)']].map(([v, l]) => `<option value="${v}" ${String(ctx.state.envStatus?.JEV_PROVIDER || '').toLowerCase() === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        ${keyRow('TYPESAFE_API_KEY', 'TypeSafe API key', 'Stored in .env, never shown again.')}
        ${keyRow('OPENROUTER_API_KEY', 'OpenRouter API key', 'openrouter.ai → Keys. Jev runs as ~typesafe/jev-latest.')}
        ${keyRow('AI_GATEWAY_API_KEY', 'Vercel AI Gateway API key', 'vercel.com → AI Gateway → API keys. Jev runs as typesafe-ai/jev.')}
        ${keyRow('OPENCODE_API_KEY', 'OpenCode Zen API key', 'opencode.ai → Zen → API keys. Jev runs as jev-1.13. (OpenCode’s free tier only works inside the OpenCode app.)')}
        ${[['liveJev', 'Jev reads as you type', 'Its pick shows under the chat box before you send. Drafts reach Jev too, even ones you delete; they’re never saved.'],
           ['liveStart', 'Start right away when Jev’s sure', 'You saw the pick, so Enter starts the task with no countdown (Stop is on the run). Off: the card counts down as usual.']].map(([k, l, h]) => `
          <label style="display:grid;grid-template-columns:auto 1fr;gap:var(--s3);align-items:center"><span class="switch"><input type="checkbox" role="switch" data-set="${k}" ${s[k] !== false ? 'checked' : ''}><span class="track"><span class="knob"></span></span></span><span><b>${l}</b><br><span class="hint">${h}</span></span></label>`).join('')}
        <div class="btnrow"><span class="label">Jev reads</span>
          <label class="hint">per message <input class="input data" type="number" min="0" max="200" step="1" data-livecap="liveReadsPerMessage" value="${esc(ctx.state.liveJev?.perMessage ?? 12)}" style="width:80px;margin-left:4px"></label>
          <label class="hint">per day <input class="input data" type="number" min="0" max="100000" step="50" data-livecap="liveReadsPerDay" value="${esc(ctx.state.liveJev?.perDay ?? 1000)}" style="width:96px;margin-left:4px"></label></div>
        <p class="hint" style="margin:0">0 means no limit. Each read is about 5k Jev tokens; ${esc(ctx.state.liveJev?.today ?? 0)} so far today.</p>
      </section>
      <section style="display:grid;gap:var(--s3)"><h3 class="px caps" style="margin:0">Voice</h3>
        <label style="display:grid;grid-template-columns:auto 1fr;gap:var(--s3);align-items:center"><span class="switch"><input type="checkbox" role="switch" data-voiceenabled ${v.enabled !== false ? 'checked' : ''}><span class="track"><span class="knob"></span></span></span><span><b>Voice</b><br><span class="hint">Orchy speaks, and you can call Orchy and your agents. Off: chat only, and nothing is sent to ElevenLabs or Deepgram.</span></span></label>
        <div data-voice style="display:grid;gap:var(--s3)">
        <p class="hint" style="margin:0">Speaking: <b>${{ elevenlabs: 'ElevenLabs', deepgram: 'Deepgram Aura (backup voice)' }[v.tts] || 'browser (fallback)'}</b></p>
        ${v.ttsIssue ? `<div class="ctx"><b>Voice:</b> ${esc(v.ttsIssue)}</div>` : ''}
        ${keyRow('DEEPGRAM_API_KEY', 'Deepgram API key', 'Orchy’s backup voice (Aura). console.deepgram.com → API keys.')}
        ${keyRow('ELEVENLABS_API_KEY', 'ElevenLabs API key', 'Orchy’s voice, and calls. elevenlabs.io → Settings → API keys.')}
        <div class="field"><label for="voice-sel">ElevenLabs voice</label><div class="btnrow"><select class="select" id="voice-sel" style="flex:1;min-width:200px"><option value="${esc(v.voiceId)}">Current: ${esc(v.voiceId)}</option></select><button class="btn" data-act="test-voice">${icon('speaker')}Test</button></div></div>
        </div>
      </section>
      <section style="display:grid;gap:var(--s3)"><h3 class="px caps" style="margin:0">Approvals</h3>
        <div class="seg" role="group" aria-label="When agents ask you">${[['decisions', 'Only decisions'], ['all', 'Every change']].map(([v, l]) => `<button type="button" data-approvals="${v}" aria-pressed="${(s.approvals || 'decisions') === v}">${l}</button>`).join('')}</div>
        <p class="hint" style="margin:0">${(s.approvals || 'decisions') === 'all'
          ? 'Agents stop for your OK before anything that creates, changes, sends, deletes or spends.'
          : 'Agents work on their own (reading, drafting, labelling, notes, docs, files in their folder) and only stop for the decisions switched on below. ' + (s.scriptsFree !== false ? 'Scripts run too, unless they look like one of those decisions. Network tools, deleting files and other folders still ask.' : 'Running scripts, network tools, deleting files and other folders ask.') + ' Connection limits and read-only access still hold.'}</p>
        ${(s.approvals || 'decisions') === 'all' ? '' : `<label style="display:grid;grid-template-columns:auto 1fr;gap:var(--s3);align-items:center"><span class="switch"><input type="checkbox" role="switch" data-set="scriptsFree" ${s.scriptsFree !== false ? 'checked' : ''}><span class="track"><span class="knob"></span></span></span><span><b>Scripts</b><br><span class="hint">${s.scriptsFree !== false ? 'Run on their own (node build.mjs, python, npm…), unless one looks like a decision switched on below, like a refund, an email or a calendar invite' : 'Asks you before every script: node build.mjs, python, npm and the like'}</span></span></label>` + (ctx.state.approvalKinds || []).map(k => `
          <label style="display:grid;grid-template-columns:auto 1fr;gap:var(--s3);align-items:center"><span class="switch"><input type="checkbox" role="switch" data-askfor="${esc(k.key)}" ${s.askFor?.[k.key] !== false ? 'checked' : ''}><span class="track"><span class="knob"></span></span></span><span><b>${esc(k.label)}</b><br><span class="hint">${s.askFor?.[k.key] !== false ? 'Asks you' : 'Runs on its own'}: ${esc(k.hint)}</span></span></label>`).join('')}
      </section>
      <section style="display:grid;gap:var(--s3)"><h3 class="px caps" style="margin:0">Remembered approvals</h3><div data-rules class="list"><div class="hint">Loading…</div></div></section>`;
    for (const [k, val] of Object.entries(keys)) { const i = body.querySelector(`#k-${k}`); if (i) i.value = val; }
    body.querySelectorAll('[data-approvals]').forEach(b => b.addEventListener('click', async () => {
      try { ctx.state.settings = await api('/api/settings', { method: 'POST', body: { approvals: b.dataset.approvals } }); w.render(); }
      catch (e) { ctx.toast(e.message, 'warn'); }
    }));
    body.querySelectorAll('[data-askfor]').forEach(i => i.addEventListener('change', async () => {
      try { ctx.state.settings = await api('/api/settings', { method: 'POST', body: { askFor: { [i.dataset.askfor]: i.checked } } }); w.render(); }
      catch (e) { i.checked = !i.checked; ctx.toast(e.message, 'warn'); }
    }));

    body.querySelectorAll('[data-set]').forEach(i => i.addEventListener('change', async () => {
      try { const st = await api('/api/settings', { method: 'POST', body: { [i.dataset.set]: i.checked } }); ctx.state.settings = st; setSound(st.sound !== false); }
      catch (e) { i.checked = !i.checked; ctx.toast(e.message, 'warn'); }
    }));
    body.querySelectorAll('[data-setcall]').forEach(i => i.addEventListener('change', async () => {
      try { ctx.state.settings = await api('/api/settings', { method: 'POST', body: { [i.dataset.setcall]: i.checked } }); }
      catch (e) { i.checked = !i.checked; ctx.toast(e.message, 'warn'); }
    }));
    body.querySelector('[data-huddleturns]').addEventListener('change', async e => {
      try { ctx.state.settings = await api('/api/settings', { method: 'POST', body: { huddleTurns: Number(e.target.value) } }); }
      catch (err) { ctx.toast(err.message, 'warn'); }
    });
    body.querySelectorAll('[data-livecap]').forEach(i => i.addEventListener('change', async () => {
      try {
        const st = await api('/api/settings', { method: 'POST', body: { [i.dataset.livecap]: Number(i.value) } });
        ctx.state.settings = st;
        ctx.state.liveJev = { ...ctx.state.liveJev, perMessage: st.liveReadsPerMessage ?? ctx.state.liveJev?.perMessage, perDay: st.liveReadsPerDay ?? ctx.state.liveJev?.perDay };
        i.value = st[i.dataset.livecap];
      } catch (e) { ctx.toast(e.message, 'warn'); }
    }));
    body.querySelector('[data-callmin]').addEventListener('change', async e => {
      try { ctx.state.settings = await api('/api/settings', { method: 'POST', body: { callStuckMin: Number(e.target.value) } }); }
      catch (err) { ctx.toast(err.message, 'warn'); }
    });
    body.querySelectorAll('[data-theme]').forEach(b => b.addEventListener('click', () => { ctx.applyTheme(b.dataset.theme); w.render(); }));
    wireBrowserSection(body, ctx.toast);
    body.querySelector('[data-act="notify"]').addEventListener('click', async () => {
      if (!('Notification' in window)) return ctx.toast('This browser has no desktop notifications.', 'warn');
      const p = await Notification.requestPermission();
      ctx.toast(p === 'granted' ? 'Desktop alerts on: you’ll get one when an agent needs you and this tab is in the background.' : 'Desktop alerts are blocked in the browser settings.', p === 'granted' ? '' : 'warn');
    });
    body.querySelectorAll('[data-copycmd]').forEach(b => b.addEventListener('click', async () => { try { await navigator.clipboard.writeText(b.dataset.copycmd); ctx.toast('Copied. Paste it into PowerShell.'); } catch { ctx.toast('Copy failed: select the text instead.', 'warn'); } }));
    body.querySelectorAll('[data-loginws]').forEach(b => b.addEventListener('click', async () => {
      try { await api(`/api/workspaces/${encodeURIComponent(b.dataset.loginws)}/login`, { method: 'POST', body: { runtime: b.dataset.rt || null } }); ctx.toast('A login window opened. Sign in there, then re-check.'); } catch (e) { ctx.toast(e.message, 'warn'); }
    }));
    body.querySelector('[data-act="accounts"]').addEventListener('click', async e => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try { ctx.state.workspaces = await api('/api/accounts/refresh', { method: 'POST' }); }
      catch (err) { btn.disabled = false; return ctx.toast(err.message, 'warn'); }
      ctx.reload(); w.render();
    });
    body.querySelectorAll('[data-save]').forEach(b => b.addEventListener('click', async () => {
      const input = body.querySelector(`#k-${b.dataset.save}`);
      try {
        await api('/api/settings/env', { method: 'POST', body: { key: b.dataset.save, value: input.value } });
        ctx.state.envStatus[b.dataset.save] = !!input.value.trim();
        delete keys[b.dataset.save];
        input.value = '';
        await ctx.reload();
        ctx.toast('Saved to .env.');
        w.render();
      } catch (err) { ctx.toast(err.message, 'warn'); }
    }));
    body.querySelector('[data-voiceenabled]')?.addEventListener('change', async e => {
      try {
        await api('/api/settings/env', { method: 'POST', body: { key: 'VOICE_ENABLED', value: e.target.checked ? '1' : '0' } });
        setVoiceConfig(await api('/api/voice/config'));
        ctx.toast(e.target.checked ? 'Voice is on.' : 'Voice is off: chat only.');
        w.render();
      } catch (err) { e.target.checked = !e.target.checked; ctx.toast(err.message, 'warn'); }
    });
    body.querySelector('[data-jevprovider]')?.addEventListener('change', async e => {
      try {
        await api('/api/settings/env', { method: 'POST', body: { key: 'JEV_PROVIDER', value: e.target.value } });
        await ctx.reload();
        ctx.toast('Saved to .env.');
        w.render();
      } catch (err) { ctx.toast(err.message, 'warn'); }
    });
    const sel = body.querySelector('#voice-sel');
    api('/api/voice/voices').then(vs => {
      if (!vs.length) return;
      // the voice in use may be a premade one that isn't in the account's library (Rachel, the default)
      const current = vs.some(x => x.id === v.voiceId) ? '' : `<option value="${esc(v.voiceId)}" selected>${v.voiceId === '21m00Tcm4TlvDq8ikWAM' ? 'Rachel (default)' : `Current: ${esc(v.voiceId)}`}</option>`;
      sel.innerHTML = current + vs.map(x => `<option value="${esc(x.id)}" ${x.id === v.voiceId ? 'selected' : ''}>${esc(x.name)} · ${esc(x.category || '')}</option>`).join('');
    }).catch(() => {});
    sel.addEventListener('change', async () => {
      const was = voiceConfig().voiceId;
      try { await api('/api/settings/env', { method: 'POST', body: { key: 'ELEVENLABS_VOICE_ID', value: sel.value } }); setVoiceConfig({ voiceId: sel.value }); }
      catch (e) { sel.value = was; ctx.toast(e.message, 'warn'); }
    });
    body.querySelector('[data-act="test-voice"]').addEventListener('click', () => speak(`Hi ${ownerName()}, Orchy here. Ready when you are.`));
    // the server forgets a rule by its place in the list: find where the one shown is now (the list may have changed), then redraw from a fresh list
    const ruleId = r => [r.workspace, r.agent, r.ruleKey, r.at].join('|');
    api('/api/rules').then(rules => {
      const box = body.querySelector('[data-rules]');
      box.innerHTML = rules.map(r => `<div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center"><span><b>${esc(r.summary || r.ruleKey)}</b><br><span class="hint">${esc(wsName(r.workspace))} · ${esc(r.agent || 'generalist')}</span></span><button class="btn sm icon" data-rule="${esc(ruleId(r))}" aria-label="Forget this approval">${icon('trash')}</button></div>`).join('') || '<div class="hint">None. When you tick “Always allow” on an approval, it shows up here.</div>';
      box.querySelectorAll('[data-rule]').forEach(b => b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          const i = (await api('/api/rules')).findIndex(r => ruleId(r) === b.dataset.rule);
          if (i >= 0) await api(`/api/rules/${i}`, { method: 'DELETE' });
          w.render();
        } catch (e) { b.disabled = false; ctx.toast(e.message, 'warn'); }
      }));
    }).catch(e => { body.querySelector('[data-rules]').innerHTML = `<div class="hint">Couldn’t load them: ${esc(e.message)}</div>`; });
  };
  w.render = () => redraw(body, draw);
  w.render();
  return w;
}
