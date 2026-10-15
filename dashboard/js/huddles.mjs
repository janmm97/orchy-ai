// Huddle windows (server: huddle.mjs): two agents of one workspace talk a task through, turn by turn.
// the owner reads along, jumps in, stops it, and approves (or keeps them talking on) the agreement they write.
// Also the form that starts one (Workspace window, and the Huddles window in the top bar with every huddle listed).
import { openWindow, getWindow } from './windows.mjs';
import { icon, createEl } from './pixel.mjs';
import { esc, api, md, wsName, wsClass, timeShort, dateTime, nameRole, agentName } from './util.mjs';
import { spriteFor } from './sheets.mjs';

let ctx = null; // { state, toast, openRun, activeSession }
export function initHuddles(c) { ctx = c; }

const TALKING = new Set(['talking', 'wrapping']);
const STATUS = {
  talking: 'Talking', wrapping: 'Writing the agreement', agreed: 'Agreed · waiting for you', approved: 'Approved · at work',
  stopped: 'Stopped', failed: 'Stopped early', closed: 'Closed',
};
const used = h => h.turns.filter(t => t.by !== 'owner' && t.by !== 'orchy' && !t.wrap).length; // the agreement isn't a turn, nor Orchy saying who joined

/** Live updates: the window follows the huddle, and the dashboard's list too. */
export function huddleUpdated(h) {
  ctx.state.huddles.set(h.id, h);
  getWindow(`huddle-${h.id}`)?.render(h);
  getWindow('huddles')?.renderList?.();
}

function turnHTML(h, t) {
  if (t.by === 'owner') return `<div class="hmsg owner"><div class="who"><span class="plate decide">You</span><time>${timeShort(t.at)}</time></div><div class="body">${esc(t.text)}</div></div>`;
  // Orchy: someone joined (or couldn't)
  if (t.by === 'orchy') return `<div class="hjoin" role="note">${t.joined ? `<span class="hsprite">${spriteFor(h.workspace, t.joined)}</span>` : ''}<span>${esc(t.text)}</span><time>${timeShort(t.at)}</time></div>`;
  const side = h.agents[0].slug === t.by ? 'a' : 'b';
  const a = h.agents.find(x => x.slug === t.by);
  return `<div class="hmsg ${side}">
    <div class="who"><span class="hsprite">${spriteFor(h.workspace, t.by)}</span><b>${esc(a?.name || t.name)}</b>${t.ready ? '<span class="plate">ready to agree</span>' : ''}<time>${timeShort(t.at)}</time>${t.runId ? `<button class="linkish" data-run="${esc(t.runId)}" title="What ${esc(a?.name || '')} looked at this turn">steps</button>` : ''}</div>
    <div class="body md">${md(t.text)}</div>
    ${t.questions?.length ? `<div class="hq"><span class="label">For you, later</span>${t.questions.map(q => `<div>${esc(q)}</div>`).join('')}</div>` : ''}
  </div>`;
}

function agreementHTML(h) {
  const g = h.agreement;
  if (!g) return '';
  const nameOf = slug => h.agents.find(a => a.slug === slug)?.name || slug;
  return `<div class="hagree">
    <div class="hh"><span>${icon('check')} What they agreed</span>${h.status === 'approved' ? '<span class="plate">approved</span>' : ''}</div>
    <div class="md">${md(g.summary)}</div>
    ${g.decisions?.length ? `<span class="label">Decisions</span><div class="list">${g.decisions.map(d => `<div>${esc(d)}</div>`).join('')}</div>` : ''}
    <span class="label">Once you approve</span>
    <div class="list">${g.work?.length ? g.work.map(w => `<div><b>${esc(nameOf(w.agent))}</b>: ${esc(w.task)}</div>`).join('') : '<div>Nobody has work. Keep them talking, or close it.</div>'}</div>
    ${g.questions_for_owner?.length ? `<div class="hq big"><span class="label">Questions for you</span>${g.questions_for_owner.map(q => `<div>${esc(q)}</div>`).join('')}</div>` : ''}
  </div>`;
}

export async function openHuddle(id, { from } = {}) {
  if (getWindow(`huddle-${id}`)) return getWindow(`huddle-${id}`).restore();
  let h = ctx.state.huddles.get(id);
  try { h = await api(`/api/huddles/${encodeURIComponent(id)}`); } catch (e) { if (!h) return ctx.toast(e.message, 'warn'); }
  const body = createEl(`<div class="huddle" style="display:grid;gap:var(--s4)"></div>`);
  const title = hh => `Huddle · ${hh.agents.map(a => a.name).join(' + ')}`;
  const w = openWindow({ id: `huddle-${id}`, title: title(h), size: 'wide', body, from, dockLabel: 'Huddle' });
  let draft = ''; // what the owner is typing survives live updates
  body.addEventListener('input', e => { if (e.target.matches('[data-h-text]')) draft = e.target.value; });
  w.render = hh => {
    h = hh;
    const talking = TALKING.has(h.status);
    const speaker = h.agents.find(a => a.slug === h.speaking);
    const n = used(h);
    const many = h.agents.length > 2; // someone was brought in: a row of everyone instead of the pair
    if (w.title !== title(h)) w.setTitle(title(h));
    body.innerHTML = `
      <div class="hpair ${many ? 'many' : ''}">
        ${h.agents.map((a, i) => `<div class="hagent ${i && !many ? 'b' : 'a'} ${h.speaking === a.slug ? 'on' : ''}"${a.joinedBy ? ` title="${esc(a.joinedBy.name)} brought ${esc(a.name)} in${a.joinedBy.why ? `: ${esc(a.joinedBy.why)}` : ''}"` : ''}><span class="sprite">${spriteFor(h.workspace, a.slug)}</span><span class="t"><b>${esc(a.name)}</b><span>${esc(a.role)}</span></span></div>`).join(many ? '' : '<span class="hx" aria-hidden="true">⇄</span>')}
      </div>
      <div class="btnrow" style="justify-content:space-between"><span class="btnrow"><span class="plate ${wsClass(h.workspace)}">${esc(wsName(h.workspace))}</span><span class="plate ${h.status === 'agreed' ? 'decide' : ''}">${esc(STATUS[h.status] || h.status)}</span></span>
        <span class="hturns" title="Turns used of the ${h.maxTurns} allowed">${n}/${h.maxTurns} turns<span class="cd">${Array.from({ length: Math.min(h.maxTurns, 40) }, (_, i) => `<i class="${i < n ? 'spent' : ''}"></i>`).join('')}</span></span></div>
      <dl class="kv">${h.startedBy ? `<dt>Started by</dt><dd>${esc(h.startedBy.name)}, from a task${h.startedBy.runId ? ` <button class="linkish" data-run="${esc(h.startedBy.runId)}">open it</button>` : ''}</dd>` : ''}<dt>${h.startedBy ? `${esc(h.startedBy.name)} asked` : 'You asked'}</dt><dd>${esc(h.topic)}</dd>${h.note ? `<dt>Note</dt><dd>${esc(h.note)}</dd>` : ''}${h.taskDir ? `<dt>Transcript</dt><dd>Tasks/${esc(h.taskDir)}/HUDDLE.md</dd>` : ''}</dl>
      <div class="hchat" data-hchat>${h.turns.map(t => turnHTML(h, t)).join('') || ''}
        ${talking ? `<div class="hmsg ${h.agents[0].slug === h.speaking ? 'a' : 'b'} typing"><div class="who"><b>${esc(speaker?.name || 'Next up')}</b>${h.status === 'wrapping' ? ' is writing the agreement' : ' is thinking'}<span class="dots"><i></i><i></i><i></i></span>${h.currentRunId ? `<button class="linkish" data-run="${esc(h.currentRunId)}">watch</button>` : ''}</div></div>` : ''}
      </div>
      ${agreementHTML(h)}
      ${h.workRunIds?.length ? `<div class="btnrow">${h.workRunIds.map(rid => { const r = ctx.state.runs.get(rid); return `<button class="btn sm" data-run="${esc(rid)}">${icon('eye')}${esc(r ? agentName(r.workspace, r.isBuilder ? 'agent-builder' : r.agentSlug, r.agentName) : 'Their work')}</button>`; }).join('')}</div>` : ''}
      ${talking ? `<div class="field"><label for="hj-${h.id}">Jump in</label><textarea class="textarea" id="hj-${h.id}" data-h-text style="min-height:56px" placeholder="${h.agents.length > 2 ? 'They all read' : 'Both of them read'} it on their next turn.">${esc(draft)}</textarea>
          <div class="btnrow end"><button class="btn" data-h="stop">${icon('stop')}Stop the huddle</button><button class="btn primary" data-h="say">${icon('send')}Say it</button></div></div>`
        : h.status === 'agreed' ? `<div class="field"><label for="hj-${h.id}">Your answers and notes</label><textarea class="textarea" id="hj-${h.id}" data-h-text style="min-height:64px" placeholder="${h.agreement?.questions_for_owner?.length ? 'Answer their questions here; they get it with the go-ahead.' : 'Optional: anything they should know before they start.'}">${esc(draft)}</textarea>
          <div class="btnrow end"><button class="btn" data-h="close">${icon('x')}Close it</button><button class="btn" data-h="more">${icon('refresh')}Keep talking</button><button class="btn primary" data-h="approve" ${h.agreement?.work?.length ? '' : 'disabled'}>${icon('check')}Approve</button></div></div>`
        : h.status === 'stopped' || h.status === 'failed' ? `<div class="field"><label for="hj-${h.id}">Pick it up again</label><textarea class="textarea" id="hj-${h.id}" data-h-text style="min-height:56px" placeholder="Optional: steer them.">${esc(draft)}</textarea>
          <div class="btnrow end"><button class="btn primary" data-h="more">${icon('refresh')}Keep talking</button></div></div>` : ''}`;
    // follow the talk while it goes on; an agreement waiting for the owner is what he came for
    if (talking) body.querySelector('[data-hchat]')?.lastElementChild?.scrollIntoView({ block: 'nearest' });
    else if (h.status === 'agreed' && !w.shown) { w.shown = true; requestAnimationFrame(() => body.querySelector('.hagree')?.scrollIntoView({ block: 'start' })); }
    body.querySelectorAll('[data-run]').forEach(b => b.addEventListener('click', () => ctx.openRun(b.dataset.run)));
    body.querySelectorAll('[data-h]').forEach(b => b.addEventListener('click', () => act(b.dataset.h, b)));
  };
  async function act(what, btn) {
    const text = body.querySelector('[data-h-text]')?.value.trim() || '';
    if (what === 'say' && !text) return body.querySelector('[data-h-text]').focus();
    btn.disabled = true;
    try {
      const path = { say: 'say', stop: 'stop', approve: 'approve', more: 'continue', close: 'close' }[what];
      const res = await api(`/api/huddles/${encodeURIComponent(h.id)}/${path}`, { method: 'POST', body: what === 'approve' ? { note: text } : { text } });
      if (['say', 'approve', 'more'].includes(what)) draft = '';
      const hh = res.huddle || res;
      if (hh?.id) huddleUpdated(hh);
      if (what === 'approve') ctx.toast(res.errors?.length ? `Started, but: ${res.errors.join(' · ')}` : 'Approved. They’re on it.', res.errors?.length ? 'warn' : '');
    } catch (e) { ctx.toast(e.message, 'warn'); btn.disabled = false; }
  }
  w.render(h);
  return w;
}

/** Agents of a workspace that can join a huddle (the server checks the rest: engine, client sharing). */
const huddlers = wsId => ctx.state.agents.filter(a => a.workspace === wsId && !a.error);
const liveWorkspaces = () => ctx.state.workspaces.filter(x => x.enabled !== false);

let formSeq = 0;
/**
 * The start form: two agents of one workspace and what they should work out. `pickWs` adds a workspace picker
 * (the Huddles window); the Workspace window passes its own workspace instead. `lead` fixes the opener (a C-suite
 * agent's own window): the owner only picks who it huddles with, its team first.
 */
function huddleForm(root, { wsId, pickWs = false, session = null, pre = [], lead = null, onStarted }) {
  let ws = wsId;
  let topic = '';
  const u = `hn${++formSeq}`; // ids unique per form: the Huddles window and an agent window can be open together
  const draw = () => {
    const agents = huddlers(ws);
    const label = a => `${esc(nameRole(agentName(a.workspace, a.slug, a.displayName), a.displayName))}${a.executive ? ' · C-suite' : ''}`;
    const opt = (list, sel) => list.map(a => `<option value="${esc(a.slug)}" ${sel === a.slug ? 'selected' : ''}>${label(a)}</option>`).join('');
    const wsPick = pickWs ? `<div class="btnrow"><label class="label" for="${u}-ws">Where</label><select class="select" id="${u}-ws" style="width:auto">${liveWorkspaces().map(x => `<option value="${esc(x.id)}" ${x.id === ws ? 'selected' : ''}>${esc(wsName(x.id))}</option>`).join('')}</select></div>` : '';
    const me = lead && agents.find(a => a.slug === lead);
    const team = new Set(me?.team || []);
    const others = me ? agents.filter(a => a.slug !== lead).sort((a, b) => team.has(b.slug) - team.has(a.slug)) : agents;
    const who = me
      ? `<div class="btnrow"><label class="label" for="${u}-b">Huddle with</label><select class="select" id="${u}-b" style="width:auto">${team.size ? `<optgroup label="Team">${opt(others.filter(a => team.has(a.slug)), pre[0])}</optgroup>${others.some(a => !team.has(a.slug)) ? `<optgroup label="Others">${opt(others.filter(a => !team.has(a.slug)), pre[0])}</optgroup>` : ''}` : opt(others, pre[0])}</select></div>`
      : `<div class="btnrow"><label class="label" for="${u}-a">Who</label><select class="select" id="${u}-a" style="width:auto">${opt(agents, pre[0] || agents[0]?.slug)}</select><span aria-hidden="true">⇄</span><select class="select" id="${u}-b" style="width:auto" aria-label="and">${opt(agents, pre[1] || agents[1]?.slug)}</select></div>`;
    const name = me ? agentName(me.workspace, me.slug, me.displayName) : '';
    root.innerHTML = `${wsPick}${agents.length < 2
      ? `<p class="hint" style="margin:0">${esc(wsName(ws))} needs two agents for a huddle. It has ${agents.length}.</p>`
      : `${who}
        <div class="field"><label for="${u}-t">${me ? `What should ${esc(name)} work out with them?` : 'What should they work out?'}</label><textarea class="textarea" id="${u}-t" placeholder="${me ? `e.g. ${esc(name)}, agree with them on next month's content plan: what they need from you and who does what.` : 'e.g. Sam, ask Riley what they need to prep faster, then update them.'}">${esc(topic)}</textarea></div>
        <div class="btnrow end"><button class="btn primary" data-act="go">${icon('send')}Start the huddle</button></div>`}`;
    root.querySelector(`#${u}-ws`)?.addEventListener('change', e => { ws = e.target.value; pre = []; draw(); });
    root.querySelector(`#${u}-t`)?.addEventListener('input', e => { topic = e.target.value; });
    root.querySelector('[data-act="go"]')?.addEventListener('click', async e => {
      const a = me ? lead : root.querySelector(`#${u}-a`).value, b = root.querySelector(`#${u}-b`).value, text = root.querySelector(`#${u}-t`).value.trim();
      if (a === b) return ctx.toast('Pick two different agents.', 'warn');
      if (!text) return root.querySelector(`#${u}-t`).focus();
      e.currentTarget.disabled = true;
      try {
        const h = await api('/api/huddles', { method: 'POST', body: { workspace: ws, agents: [a, b], topic: text, session: typeof session === 'function' ? session() : session } });
        huddleUpdated(h);
        topic = '';
        onStarted(h);
      } catch (err) { ctx.toast(err.message, 'warn'); e.currentTarget.disabled = false; }
    });
  };
  draw();
}

/** A C-suite agent's window (Huddle tab): the owner starts a huddle it opens, with a colleague he picks. */
export function mountLeadHuddle(root, { wsId, slug, onStarted }) {
  huddleForm(root, { wsId, lead: slug, session: () => ctx.activeSession?.() || null, onStarted: h => { onStarted?.(h); openHuddle(h.id); } });
}

/** Start a huddle by hand from the Workspace window: two agents of this workspace and what they should work out. */
export function openNewHuddle(wsId, { from, session = null, agents: pre = [] } = {}) {
  const body = createEl(`<div style="display:grid;gap:var(--s4)"></div>`);
  const w = openWindow({ id: `huddle-new-${wsId}`, title: `New huddle · ${wsName(wsId)}`, body, from });
  body.innerHTML = `<p class="hint" style="margin:0">Two agents talk it through, turn by turn, and write up what they agree. They only talk: nothing changes until you approve. Questions only you can answer wait for the agreement.</p><div data-form style="display:grid;gap:var(--s4)"></div>`;
  huddleForm(body.querySelector('[data-form]'), { wsId, session, pre, onStarted: h => { w.close(); openHuddle(h.id); } });
  return w;
}

// ── the Huddles window (top bar): start one in any workspace, and every huddle going or waiting on the owner ──
const ORDER = { agreed: 0, talking: 1, wrapping: 1, failed: 2, stopped: 2, approved: 3, closed: 4 };
function rowHTML(h) {
  const who = h.agents.map(a => esc(a.name)).join(' ⇄ ');
  const by = h.startedBy ? `${esc(h.startedBy.name)} started it` : 'you started it';
  return `<button class="runrow" data-huddle-open="${esc(h.id)}">
    <span class="l1"><b>${who}</b><span class="hint">${esc(dateTime(h.createdAt))}</span></span>
    <span class="l2">${esc(h.topic)}</span>
    <span class="l3"><span class="plate ${wsClass(h.workspace)}">${esc(wsName(h.workspace))}</span><span class="plate ${h.status === 'agreed' ? 'decide' : ''}${TALKING.has(h.status) ? ' blink' : ''}">${esc(STATUS[h.status] || h.status)}</span><span class="hint">${by} · ${used(h)}/${h.maxTurns} turns</span></span>
  </button>`;
}

export function openHuddles({ from, wsId = null, session = null } = {}) {
  const existing = getWindow('huddles');
  if (existing) { existing.restore(); existing.renderList(); return existing; }
  const body = createEl(`<div style="display:grid;gap:var(--s4)"></div>`);
  const w = openWindow({ id: 'huddles', title: 'Huddles', size: 'wide', body, from });
  const first = liveWorkspaces().find(x => x.id === wsId) || liveWorkspaces()[0];
  body.innerHTML = `
    <p class="hint" style="margin:0">Two agents of one workspace talk a task through, turn by turn, and write up what they agree. They only talk: nothing changes until you approve. C-suite agents (a Chief, a CxO or a department head) can also start one from their own tasks.</p>
    ${first ? '<div data-form style="display:grid;gap:var(--s4)"></div>' : '<div class="empty"><strong>No agents switched on</strong>Switch a workspace on in Workspace to start a huddle.</div>'}
    <div class="section-h"><h3>Huddles <span class="count" data-count>0</span></h3></div>
    <div data-list></div>`;
  if (first) huddleForm(body.querySelector('[data-form]'), { wsId: first.id, pickWs: true, session, onStarted: h => { openHuddle(h.id); w.renderList(); } });
  w.renderList = () => {
    const list = [...ctx.state.huddles.values()].sort((a, b) => (ORDER[a.status] ?? 5) - (ORDER[b.status] ?? 5) || b.createdAt.localeCompare(a.createdAt)).slice(0, 30);
    body.querySelector('[data-count]').textContent = list.length;
    body.querySelector('[data-list]').innerHTML = list.length ? `<div class="runs">${list.map(rowHTML).join('')}</div>`
      : '<div class="empty"><strong>No huddles yet</strong>Start one above, or ask Orchy ("get Sam and Riley to talk through the launch").</div>';
    body.querySelectorAll('[data-huddle-open]').forEach(b => b.addEventListener('click', () => openHuddle(b.dataset.huddleOpen, { from: b })));
  };
  w.renderList();
  return w;
}
