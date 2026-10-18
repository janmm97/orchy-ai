// Live view, left column: every live run and huddle grouped under its client-ink plate, then what finished today.
import { icon } from '../pixel.mjs';
import { esc, wsName, wsClass, timeShort, dateTime, dur, timezone } from '../util.mjs';
import { spriteFor } from '../sheets.mjs';
import { stepWho } from '../missions.mjs';
import { S, activityRows, isLiveRun, runState, huddleState, huddleName, speakerOf, whoOf, selKey, isToday, waitsOnOwner, asksFor, missionState, missionName, ACTIVE_MISSION } from './model.mjs';

/** A time today, or the day too when it's older (an agreement can wait on the owner overnight). */
const day = iso => new Intl.DateTimeFormat('en-US', { timeZone: timezone(), month: 'short', day: 'numeric' }).format(new Date(iso));
const when = iso => `<time title="${esc(dateTime(iso))}">${isToday(iso) ? timeShort(iso) : day(iso)}</time>`;

const stateHTML = st => (st.cls === 'decide' ? `<span class="plate decide lst">${icon('bang')}${esc(st.label)}</span>`
  : st.cls === 'ok' ? `<span class="lst done">${icon('check')}${esc(st.label)}</span>`
  : st.cls === 'fail' || st.cls === 'past' ? `<span class="lst ${st.cls}">${esc(st.label)}</span>`
  : `<span class="lst live"><i aria-hidden="true"></i>${esc(st.label)}</span>`);

function runRow(r, { kid = false } = {}) {
  const w = whoOf(r);
  const live = isLiveRun(r);
  const st = runState(r);
  const tool = live ? S.lastTool.get(r.id) : null;
  const line = tool || (r.instruction ? `Task: ${r.instruction}` : '');
  // waiting on the owner: the clock shows how long it has waited, not how long it has run
  const ask = waitsOnOwner(r) ? asksFor(r.id)[0] : null;
  const time = ask ? `<span class="lwaited" title="Waiting on you since ${esc(timeShort(ask.createdAt))}">waits <span class="timer" data-start="${esc(ask.createdAt)}">${dur(Date.now() - Date.parse(ask.createdAt))}</span></span>`
    : live ? `<span class="timer" data-start="${esc(r.startedAt)}" title="Running for">${dur(Date.now() - Date.parse(r.startedAt))}</span>` : when(r.endedAt || r.startedAt);
  const on = selKey(S.sel) === `run:${r.id}`;
  return `<button type="button" class="lrow${on ? ' on' : ''}${kid ? ' kid' : ''}${live ? '' : ' past'}" data-lsel="run:${esc(r.id)}"${on ? ' aria-current="true"' : ''}>
    <span class="sprite">${spriteFor(r.workspace, w.slug)}</span>
    <span class="lr"><span class="lr1"><b>${esc(w.name)}</b>${w.role !== w.name ? `<span class="role">${esc(w.role)}</span>` : ''}${time}</span>
      <span class="lr2">${stateHTML(st)}</span>
      ${line ? `<span class="lr3${tool ? '' : ' task'}">${esc(line)}</span>` : ''}</span>
  </button>`;
}

function huddleRow(h) {
  const st = huddleState(h);
  const sp = speakerOf(h);
  const live = ['talking', 'wrapping'].includes(h.status);
  const line = live && sp ? `${sp.name} ${h.status === 'wrapping' ? 'is writing the agreement' : 'is speaking'}` : h.topic;
  const on = selKey(S.sel) === `huddle:${h.id}`;
  const lead = sp || h.agents[0];
  return `<button type="button" class="lrow huddle${on ? ' on' : ''}${st.cls && st.cls !== 'decide' ? ' past' : ''}" data-lsel="huddle:${esc(h.id)}"${on ? ' aria-current="true"' : ''}>
    <span class="sprite">${spriteFor(h.workspace, lead?.slug)}</span>
    <span class="lr"><span class="lr1"><b>${esc(huddleName(h))}</b></span>
      <span class="lr2">${stateHTML(st)}${live ? '' : when(h.endedAt || h.createdAt)}</span>
      ${line ? `<span class="lr3">${esc(line)}</span>` : ''}</span>
  </button>`;
}

// a mission: the flag tile, its state, how far it got; its live step runs sit under it as kids
function missionRow(m) {
  const st = missionState(m);
  const live = ACTIVE_MISSION.has(m.status);
  const done = m.steps.filter(s => s.status === 'done').length;
  const cur = m.steps.find(s => ['running', 'fixing', 'retrying', 'checking', 'waiting'].includes(s.status));
  const line = m.status === 'planning' ? 'Planning the steps' : m.steps.length ? `${done}/${m.steps.length} steps done${cur ? ` · ${stepWho(m, cur).name}: ${cur.task}` : ''}` : m.text;
  const on = selKey(S.sel) === `mission:${m.id}`;
  return `<button type="button" class="lrow mission${on ? ' on' : ''}${live ? '' : ' past'}" data-lsel="mission:${esc(m.id)}"${on ? ' aria-current="true"' : ''}>
    <span class="sprite mflag">${icon('flag')}</span>
    <span class="lr"><span class="lr1"><b>${esc(missionName(m))}</b>${live && m.startedAt ? `<span class="timer" data-start="${esc(m.startedAt)}" title="Running for">${dur(Date.now() - Date.parse(m.startedAt))}</span>` : live ? '' : when(m.endedAt || m.createdAt)}</span>
      <span class="lr2">${stateHTML(st)}</span>
      ${line ? `<span class="lr3">${esc(line)}</span>` : ''}</span>
  </button>`;
}

const rowOf = (t, o) => (t.type === 'huddle' ? huddleRow(t.x) : t.type === 'mission' ? missionRow(t.x) : runRow(t.x, o));
const withKids = t => rowOf(t) + t.kids.map(k => rowOf(k, { kid: true })).join('');

export function activityHTML() {
  const { groups, earlier, live } = activityRows();
  const { state } = S.ctx;
  const f = S.filter;
  // the workspace filter lists the switched-on workspaces (and one that's filtered on, even if it went off)
  const wsList = state.workspaces.filter(w => w.enabled !== false || w.id === f.ws).map(w => w.id);
  const chips = `<div class="lfilters" role="group" aria-label="Filter">
      <span class="lwspick"><span class="ws-swatch ${f.ws === 'all' ? 'all' : wsClass(f.ws)}" aria-hidden="true"></span><select class="select lwsel" data-lwsel aria-label="Which workspace">${['all', ...wsList].map(id => `<option value="${esc(id)}"${f.ws === id ? ' selected' : ''}>${id === 'all' ? 'All workspaces' : esc(wsName(id))}</option>`).join('')}</select>${icon('right')}</span>
      <button type="button" class="btn sm lonly" data-lonly aria-pressed="${f.liveOnly}">${icon(f.liveOnly ? 'check' : 'eye')}Live only</button>
    </div>`;
  const body = groups.length
    ? groups.map(g => `<div class="lgroup"><div class="lgh"><span class="plate ${wsClass(g.ws)}">${esc(wsName(g.ws))}</span></div>${g.items.map(withKids).join('')}</div>`).join('')
    : `<div class="empty lquiet"><strong>Nothing running${f.ws === 'all' ? '' : ` in ${esc(wsName(f.ws))}`}</strong><span>Send Orchy a task: each agent's steps show up here as they happen.</span></div>`;
  const past = earlier.length ? `<div class="lgroup earlier"><div class="lgh"><span class="label">Earlier today</span></div>${earlier.map(t => {
    // finished rows say whose they are with a swatch (the plate heads are for what's live)
    return rowOf(t).replace('<span class="lr1">', `<span class="lr1"><span class="ws-swatch ${wsClass(t.ws)}" title="${esc(wsName(t.ws))}"></span>`);
  }).join('')}</div>` : '';
  return { html: `${chips}<div class="lrows" data-lrows>${body}${past}</div>`, live };
}
