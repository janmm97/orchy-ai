// Live view, center column: the selected run (who, its phase, the task, Jev's plan, hand-offs, what's happening with
// each tool turning done in place) or the selected huddle (the talk and the agreement, huddles.mjs renderers).
// Answer / Stop / Run now / Open run / the huddle's buttons are ordinary data-* buttons app.mjs already handles.
import { icon } from '../pixel.mjs';
import { esc, md, wsName, wsClass, timeShort, dur, runResult, agentName } from '../util.mjs';
import { spriteFor, validationHTML, recoveryHTML } from '../sheets.mjs';
import { turnHTML, agreementHTML } from '../huddles.mjs';
import { S, isLiveRun, runState, huddleState, huddleName, phasesOf, asksFor, waitsOnOwner, whoOf, pairedRows, speakerOf, missionState, missionName, missionFocusRun, ACTIVE_MISSION } from './model.mjs';
import { stepWho, afterLine, askHTML, STEP_LABEL } from '../missions.mjs';

const EV_ICON = { system: 'bolt', text: 'chat', tool: 'term', tool_error: 'bang', error: 'bang', note: 'doc', report: 'check', denied: 'x', plan: 'spark' };
const TL_MAX = 300;

function phasesHTML(sel) {
  const ph = phasesOf(sel);
  if (!ph) return '';
  const SHORT = { planning: 'Plan', discussion: 'Talk', execution: 'Work', reviewing: 'Check' };
  const WHY = { past: 'done', now: 'now', next: 'not yet', skipped: 'didn’t happen' };
  return `<ol class="lphases" aria-label="Where it is">${ph.map(p => `<li class="${p.s}${p.k === 'done' && /fail|stop/i.test(p.label) ? ' failed' : ''}"${p.s === 'now' ? ' aria-current="step"' : ''} title="${esc(`${p.label}: ${WHY[p.s]}`)}">${p.s === 'past' ? icon('check') : ''}<span class="lf">${esc(p.label)}</span><span class="ls" aria-hidden="true">${esc(SHORT[p.k] || p.label)}</span></li>`).join('')}</ol>`;
}

/** One timeline row. A tool shows running → done (or failed) in place once its tool_done / tool_error arrives. */
function rowHTML({ e, st, end }) {
  const txt = e.summary || e.text || '';
  const ico = st === 'run' ? icon('play', 'ico blink') : st === 'ok' ? icon('check') : st === 'err' ? icon('bang') : icon(EV_ICON[e.kind] || 'term');
  const brief = st === 'ok' && end?.brief ? `<span class="brief">${esc(end.brief)}</span>` : '';
  const why = st === 'err' && (end?.text || end?.brief) ? `<span class="why">${esc(String(end.text || end.brief).slice(0, 240))}</span>` : '';
  const tag = st === 'run' ? '<span class="chip ltag">Running</span>' : st === 'err' ? '<span class="plate ltag">Failed</span>' : '';
  return `<div class="ev lev ${esc(e.kind)}${st ? ` st-${st}` : ''}">${ico}<span>${tag}${e.kind === 'text' ? md(txt) : esc(txt)}${brief}${why}</span><time>${e.t ? timeShort(e.t) : ''}</time></div>`;
}

export function timelineHTML(r) {
  const evs = S.events.get(r.id);
  if (!evs && S.eventsFailed.has(r.id)) return `<div class="ev placeholder"><span></span><span>Couldn’t load its steps. <button type="button" class="linkish" data-lretry-ev="${esc(r.id)}">Retry</button></span><span></span></div>`;
  if (!evs) return `<div class="ev placeholder"><span></span><span class="blink">Loading its steps…</span><span></span></div>`;
  const rows = pairedRows(evs, isLiveRun(r));
  const cut = rows.length - TL_MAX;
  const head = cut > 0 ? `<div class="ev more"><span></span><span>${cut} earlier step${cut === 1 ? '' : 's'}: <button type="button" class="linkish" data-run="${esc(r.id)}">open the run</button></span><span></span></div>` : '';
  return head + (rows.slice(-TL_MAX).map(rowHTML).join('')
    || `<div class="ev placeholder"><span></span><span>${r.status === 'starting' || r.status === 'queued' ? 'Starting up…' : isLiveRun(r) ? 'Working. Each step shows up here as it happens.' : 'No steps were recorded.'}</span><span></span></div>`);
}

const askLabel = a => (a.kind === 'approval' ? 'Needs your OK' : a.kind === 'connections' ? 'Pick connections' : 'Asks you');

function planHTML(plan) {
  if (!plan.actions?.length) return esc(plan.note || 'No app actions needed');
  return plan.actions.map(a => `${esc(a.title)}${a.platform ? ` <span class="hint">${esc(a.platform)}</span>` : ''}`).join(', ');
}

function teamRows(r) {
  const { state } = S.ctx;
  const kids = (r.subRuns || []).map(id => state.runs.get(id)).filter(Boolean);
  if (!kids.length) return '';
  return `<div class="field"><span class="label">Handed to</span><div class="lsteps">${kids.map(k => {
    const st = runState(k);
    return `<button type="button" class="lstep" data-lsel="run:${esc(k.id)}"><span class="sprite">${spriteFor(k.workspace, whoOf(k).slug)}</span><span><b>${esc(whoOf(k).name)}</b> <span class="hint">${esc(String(k.instruction || '').slice(0, 140))}</span></span><span class="lst ${st.cls === 'decide' ? 'plate decide' : st.cls}">${esc(st.label)}</span></button>`;
  }).join('')}</div></div>`;
}

// Orchy's check (run.validation, "Orchy is checking" while it runs) and the recovery card (run.recovery) are
// sheets.mjs#validationHTML / recoveryHTML, the same blocks the run window draws; their buttons are global data-* ones.
// Missions (missions.mjs): the plan as a step graph, one row per step with its "after: <step>" line drawn in text, the
// step's state, agent and files; a row opens that step's run. Shown for the mission itself and above a step run's timeline.
function missionSteps(m, { current = null } = {}) {
  return `<ol class="lsteps lgraph" aria-label="The mission's steps">${m.steps.map((s, i) => {
    const w = stepWho(m, s);
    const st = STEP_LABEL[s.status] || s.status;
    const cls = s.status === 'waiting' ? 'plate decide' : s.status === 'done' ? 'done' : ['running', 'fixing', 'retrying', 'checking'].includes(s.status) ? 'live' : ['stopped', 'failed', 'interrupted'].includes(s.status) ? 'fail' : 'past';
    const run = s.runId ? `run:${esc(s.runId)}` : '';
    const inner = `<span class="gn" aria-hidden="true">${s.status === 'done' ? icon('check') : i + 1}</span><span class="sprite">${spriteFor(m.workspace, s.agent === 'general' ? null : s.agent)}</span>
      <span><b>${esc(w.name)}</b> <span class="hint">${esc(s.task.length > 140 ? `${s.task.slice(0, 139)}…` : s.task)}</span>
        <span class="gafter">${s.needs?.length ? `${icon('right')}${esc(afterLine(m, s))}` : esc(afterLine(m, s))}${s.expects?.length ? ` · makes ${esc(s.expects.map(x => x.kind).join(', '))}` : ''}${s.files?.length ? ` · ${s.files.length} file${s.files.length === 1 ? '' : 's'}` : ''}</span></span>
      <span class="lst ${cls}">${cls === 'live' ? '<i aria-hidden="true"></i>' : ''}${esc(st)}</span>`;
    return `<li class="gstep${s.id === current ? ' cur' : ''}">${run ? `<button type="button" class="lstep" data-lsel="${run}">${inner}</button>` : `<div class="lstep">${inner}</div>`}</li>`;
  }).join('')}</ol>`;
}

function missionWork(m) {
  const st = missionState(m);
  const live = ACTIVE_MISSION.has(m.status);
  const r = missionFocusRun(m);
  const files = [...new Set(m.steps.flatMap(s => s.files || []))];
  return `<div class="lhead">
      <div class="lwho"><span class="sprite mflag">${icon('flag')}</span>
        <span class="t"><b>${esc(missionName(m))}</b><span><span class="plate ${wsClass(m.workspace)}">${esc(wsName(m.workspace))}</span> ${m.steps.length} steps · ${esc(money(m.cost))} of ${esc(money(m.ceiling))}${m.startedAt ? ` · started ${timeShort(m.startedAt)}` : ''}</span>
          <span><span class="${st.cls === 'decide' ? 'plate decide' : 'lst'}">${esc(st.label)}</span></span></span>
        <span class="timer"${live && m.startedAt ? ` data-start="${esc(m.startedAt)}"` : ''}>${m.startedAt ? dur((m.endedAt ? Date.parse(m.endedAt) : Date.now()) - Date.parse(m.startedAt)) : ''}</span></div>
      ${phasesHTML(S.sel)}
    </div>
    <div class="lbody" data-lbody>
      <dl class="kv"><dt>You asked</dt><dd>${esc(m.text)}</dd>${m.done_when ? `<dt>Done when</dt><dd>${esc(m.done_when)}</dd>` : ''}${m.taskDir ? `<dt>Folder</dt><dd>Tasks/${esc(m.taskDir)}/</dd>` : ''}</dl>
      ${m.ask ? `<div data-mission-scope="${esc(m.id)}">${askHTML(m)}</div>` : ''}
      <div class="field"><span class="label">The plan${m.status === 'planning' ? ' · <span class="blink">planning…</span>' : ''}</span>${m.steps.length ? missionSteps(m, { current: r?.stepId }) : '<p class="hint">Orchy is writing the steps.</p>'}</div>
      ${r ? `<div class="field"><span class="label">What's happening (${esc(stepWho(m, m.steps.find(s => s.id === r.stepId) || { agent: r.agentSlug || 'general' }).name)})${isLiveRun(r) ? ` · <span class="lnow">${esc(runState(r).label)}</span>` : ''}</span><div class="timeline ltl" data-ltl="${esc(r.id)}">${timelineHTML(r)}</div></div>` : ''}
      ${m.notes?.length ? `<div class="field"><span class="label">Orchy's notes</span><ul class="lnotes">${m.notes.slice(-6).map(n => `<li><time>${timeShort(n.at)}</time> ${esc(n.text)}</li>`).join('')}</ul></div>` : ''}
      ${!live && files.length ? `<div class="field"><span class="label">What it made</span><p class="hint">${files.map(f => esc(f.split('/').pop())).join(', ')}</p></div>` : ''}
    </div>
    <div class="lfoot btnrow">
      ${live && !m.ask?.options?.some(o => o.action === 'stop') ? `<button class="btn" data-mact="stop" data-mission="${esc(m.id)}">${icon('stop')}Stop the mission</button>` : ''}
      ${m.status === 'planned' ? `<button class="btn decide" data-mact="go" data-mission="${esc(m.id)}">${icon('play')}Go</button>` : ''}
      ${r ? `<button class="btn" data-run="${esc(r.id)}">${icon('eye')}Open the step’s run</button>` : ''}
    </div>`;
}
const money = n => `$${(Number(n) || 0).toFixed(2)}`;

function runWork(r) {
  const w = whoOf(r);
  const live = isLiveRun(r);
  const asks = asksFor(r.id);
  const st = runState(r);
  const mission = r.missionId ? S.ctx.state.missions?.get(r.missionId) || null : null;
  const from = r.delegatedBy ? `${esc(r.delegatedByName || 'Its head')} handed over` : r.fromHuddle ? 'From the huddle' : mission ? `Step ${esc(r.stepId || '')} of the mission` : r.routing?.source === 'schedule' ? 'On its schedule' : 'You asked';
  const rep = r.report;
  const result = !live ? runResult(r) : '';
  return `<div class="lhead">
      <div class="lwho"><span class="sprite">${spriteFor(r.workspace, w.slug)}</span>
        <span class="t"><b>${esc(w.label)}</b><span><span class="plate ${wsClass(r.workspace)}">${esc(wsName(r.workspace))}</span> ${esc(r.model || '')} · started ${timeShort(r.startedAt)}</span></span>
        <span class="timer"${live ? ` data-start="${esc(r.startedAt)}"` : ''}>${dur((r.endedAt ? Date.parse(r.endedAt) : Date.now()) - Date.parse(r.startedAt))}</span></div>
      ${phasesHTML(S.sel)}
    </div>
    <div class="lbody" data-lbody>
      <dl class="kv"><dt>${from}</dt><dd>${esc(r.instruction)}</dd>
        ${r.plan ? `<dt>Jev's plan</dt><dd>${planHTML(r.plan)}</dd>` : ''}
        ${r.delegatedBy ? `<dt>Head</dt><dd><button type="button" class="linkish" data-lsel="run:${esc(r.delegatedBy)}">${esc(r.delegatedByName || 'its head')}</button></dd>` : ''}
        ${r.fromHuddle && S.ctx.state.huddles.has(r.fromHuddle) ? `<dt>Huddle</dt><dd><button type="button" class="linkish" data-lsel="huddle:${esc(r.fromHuddle)}">${esc(huddleName(S.ctx.state.huddles.get(r.fromHuddle)))}</button></dd>` : ''}
        ${mission ? `<dt>Mission</dt><dd><button type="button" class="linkish" data-lsel="mission:${esc(mission.id)}">${esc(missionName(mission))}</button></dd>` : ''}
      </dl>
      ${mission ? `<div class="field"><span class="label">Its mission's steps</span>${missionSteps(mission, { current: r.stepId })}</div>` : ''}
      ${asks.length ? `<div class="asks"><span class="stage">${esc(askLabel(asks[0]))}</span><p>${esc(asks[0].kind === 'approval' ? asks[0].title || asks[0].message : asks[0].message || asks[0].title || '')}</p></div>` : ''}
      ${teamRows(r)}
      ${live ? '' : validationHTML(r)}${recoveryHTML(r)}
      <div class="field"><span class="label">What's happening${live || r.activity?.state === 'validating' ? ` · <span class="lnow">${esc(st.label)}</span>` : ''}</span><div class="timeline ltl" data-ltl="${esc(r.id)}">${timelineHTML(r)}</div></div>
      ${result ? `<div class="field"><span class="label">${rep?.result ? 'Result' : 'Its last message'}</span><div class="result md">${md(result)}</div></div>` : ''}
      ${!live && rep?.summary ? `<div class="field"><span class="label">Report to Orchy</span><div class="md lrep">${md(rep.summary)}</div></div>` : ''}
      ${r.error ? `<pre class="cmd">${esc(r.error)}</pre>` : ''}
    </div>
    <div class="lfoot btnrow">
      ${waitsOnOwner(r) ? `<button class="btn decide" data-answer="${esc(asks[0].id)}">${icon('bang')}Answer</button>` : ''}
      ${r.status === 'queued' || r.status === 'paused-limit' ? `<button class="btn primary" data-run-now="${esc(r.id)}">${icon('play')}Run now</button>` : ''}
      ${live ? `<button class="btn" data-stop="${esc(r.id)}">${icon('stop')}Stop</button>` : ''}
      <button class="btn${live ? '' : ' primary'}" data-run="${esc(r.id)}">${icon(live ? 'eye' : 'send')}${live ? 'Open the run' : 'Follow up'}</button>
    </div>`;
}

function huddleWork(h) {
  const st = huddleState(h);
  const talking = ['talking', 'wrapping'].includes(h.status);
  const sp = speakerOf(h);
  const used = h.turns.filter(t => t.by !== 'owner' && t.by !== 'jan' && t.by !== 'orchy' && !t.wrap).length;
  const work = (h.workRunIds || []).map(id => S.ctx.state.runs.get(id)).filter(Boolean);
  const qn = (h.agreement?.questions_for_owner || h.agreement?.questions_for_jan)?.length || 0;
  return `<div class="lhead">
      <div class="lwho huddle"><span class="lpair">${h.agents.map(a => `<span class="sprite" title="${esc(a.name)}">${spriteFor(h.workspace, a.slug)}</span>`).join('')}</span>
        <span class="t"><b>${esc(huddleName(h))}</b><span><span class="plate ${wsClass(h.workspace)}">${esc(wsName(h.workspace))}</span> ${used}/${h.maxTurns} turns · started ${timeShort(h.createdAt)}</span></span>
        <span class="${st.cls === 'decide' ? 'plate decide' : 'lst'}">${esc(st.label)}</span></div>
      ${phasesHTML(S.sel)}
    </div>
    <div class="lbody" data-lbody>
      <dl class="kv"><dt>${h.startedBy ? `${esc(h.startedBy.name)} asked` : 'You asked'}</dt><dd>${esc(h.topic)}</dd></dl>
      <div class="hchat">${h.turns.map(t => turnHTML(h, t)).join('')}
        ${talking ? `<div class="hmsg ${h.speaking === 'orchy' ? 'orchy' : h.agents[0].slug === h.speaking ? 'a' : 'b'} typing"><div class="who"><b>${esc(sp?.name || 'Next up')}</b>${h.speaking === 'orchy' ? ' is weighing in' : h.status === 'wrapping' ? ' is writing the agreement' : ' is thinking'}<span class="dots"><i></i><i></i><i></i></span></div></div>` : ''}
      </div>
      ${agreementHTML(h)}
      ${work.length ? `<div class="field"><span class="label">Their work</span><div class="lsteps">${work.map(k => { const s = runState(k); return `<button type="button" class="lstep" data-lsel="run:${esc(k.id)}"><span class="sprite">${spriteFor(k.workspace, whoOf(k).slug)}</span><span><b>${esc(agentName(k.workspace, whoOf(k).slug, k.agentName))}</b> <span class="hint">${esc(String(k.instruction || '').slice(0, 140))}</span></span><span class="lst ${s.cls === 'decide' ? 'plate decide' : s.cls}">${esc(s.label)}</span></button>`; }).join('')}</div></div>` : ''}
    </div>
    <div class="lfoot btnrow">
      ${h.status === 'agreed' ? `<button class="btn decide" data-huddle="${esc(h.id)}" data-proposal="1">${icon('check')}View proposal${qn ? ` · ${qn} question${qn === 1 ? '' : 's'}` : ''}</button>` : ''}
      <button class="btn" data-huddle="${esc(h.id)}">${icon('chat')}${talking ? 'Jump in' : 'Open the huddle'}</button>
    </div>`;
}

export function workHTML() {
  const { state } = S.ctx;
  const sel = S.sel;
  if (sel?.type === 'huddle' && state.huddles.has(sel.id)) return huddleWork(state.huddles.get(sel.id));
  if (sel?.type === 'mission' && state.missions?.has(sel.id)) return missionWork(state.missions.get(sel.id));
  if (sel?.type === 'run' && state.runs.has(sel.id)) return runWork(state.runs.get(sel.id));
  return `<div class="lbody"><div class="empty"><strong>Pick something on the left</strong><span>A run's steps, plan and answers show here; a huddle shows its talk.</span></div></div>`;
}
