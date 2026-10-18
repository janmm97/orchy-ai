// Missions in the dashboard (server: lib/missions.mjs): one ask, several of a workspace's
// agents in a row. Orchy's chat shows the mission card: the steps with agent plates, "after" lines and the files each
// promises; while it waits, the owner can change a step's words, swap its agent or drop it; a sure plan counts down (Stop holds
// it), otherwise it waits for Go. Once it runs the card follows each step (Watch opens its run), says when something
// waits on the owner (one-move answers: Accept / Follow up / Skip / Retry / Give to another agent / Replan / Stop …),
// and ends with the files. The Live view draws the same steps (live/work.mjs#missionWork). Yellow only where the owner acts.
import { icon } from './pixel.mjs';
import { esc, api, wsName, wsClass, dur, agentName } from './util.mjs';
import { kindIcon } from './viewer.mjs';

let ctx = null; // { state, toast, openLive }
export function initMissions(c) { ctx = c; }
const editing = new Map(); // missionId → { steps: { [id]: { task, agent, remove } } } while the owner edits the plan
const typed = new Map();   // missionId → the owner's follow-up text on an open check

export const STEP_LABEL = { pending: 'Not yet', running: 'Working', fixing: 'Fixing', retrying: 'Retrying', checking: 'Orchy checks', waiting: 'Needs you', done: 'Done', skipped: 'Skipped', stopped: 'Stopped', failed: 'Failed', interrupted: 'Cut off' };
export const MISSION_LABEL = { planning: 'Planning', planned: 'Plan ready', running: 'Running', waiting: 'Waiting on you', done: 'Done', partial: 'Partly done', stopped: 'Stopped', failed: 'Failed', fallback: 'Sent as a task' };
export const LIVE_MISSION = new Set(['planning', 'planned', 'running', 'waiting']);
const ENDED = new Set(['done', 'partial', 'stopped', 'failed', 'fallback']);
const ACT_ICON = { accept: 'check', followup: 'send', skip: 'right', retry: 'refresh', reassign: 'user', replan: 'steps', stop: 'stop', raise: 'plus', continue: 'play', resume: 'play', 'use-replan': 'check', 'keep-plan': 'x' };
const money = n => `$${(Number(n) || 0).toFixed(2)}`;

/** The name the owner calls a step's agent by (its role after it). */
export function stepWho(m, s) {
  if (s.agent === 'general') return { name: `${wsName(m.workspace)} generalist`, role: '' };
  const a = ctx?.state.agents.find(x => x.workspace === m.workspace && x.slug === s.agent);
  const role = a?.displayName || '';
  return { name: agentName(m.workspace, s.agent, role || s.agentName), role };
}
const stepName = (m, id) => { const s = m.steps.find(x => x.id === id); return s ? stepWho(m, s).name : id; };
/** "after 1 Research": the dependency line, in text. */
export const afterLine = (m, s) => (s.needs?.length ? `after ${s.needs.map(id => `${m.steps.findIndex(x => x.id === id) + 1} ${stepName(m, id)}`).join(', ')}` : 'starts first');
const expectLine = s => (s.expects?.length ? s.expects.map(x => x.kind).join(', ') : '');
const stCls = st => (st === 'waiting' ? 'decide' : ['running', 'fixing', 'retrying', 'checking'].includes(st) ? 'live' : st === 'done' ? 'ok' : ['stopped', 'failed', 'interrupted'].includes(st) ? 'fail' : st === 'skipped' ? 'skip' : 'past');

function stepRow(m, s, i, edit) {
  const w = stepWho(m, s);
  const cls = stCls(s.status);
  const e = edit?.steps[s.id] || {};
  const agents = ctx.state.agents.filter(a => a.workspace === m.workspace && !a.isBuilder && !a.error);
  const state = cls === 'decide' ? `<span class="plate decide">${icon('bang')}${esc(STEP_LABEL[s.status])}</span>`
    : cls === 'live' ? `<span class="lst live"><i aria-hidden="true"></i>${esc(STEP_LABEL[s.status])}</span>`
    : cls === 'ok' ? `<span class="lst done">${icon('check')}${esc(STEP_LABEL[s.status])}</span>`
    : `<span class="lst ${cls}">${esc(STEP_LABEL[s.status] || s.status)}</span>`;
  if (edit) {
    return `<li class="mstep editing${e.remove ? ' removed' : ''}" data-mstep="${esc(s.id)}">
      <span class="mn">${i + 1}</span>
      <span class="mt">
        <span class="mrow"><select class="select" data-medit-agent="${esc(s.id)}" aria-label="Agent for step ${i + 1}"><option value="general"${(e.agent ?? s.agent) === 'general' ? ' selected' : ''}>${esc(wsName(m.workspace))} generalist</option>${agents.map(a => `<option value="${esc(a.slug)}"${(e.agent ?? s.agent) === a.slug ? ' selected' : ''}>${esc(agentName(a.workspace, a.slug, a.displayName))} · ${esc(a.displayName)}</option>`).join('')}</select>
          <button type="button" class="btn sm ghost" data-medit-remove="${esc(s.id)}" aria-pressed="${!!e.remove}">${icon(e.remove ? 'refresh' : 'trash')}${e.remove ? 'Keep it' : 'Remove'}</button></span>
        <textarea class="textarea" rows="2" data-medit-task="${esc(s.id)}" aria-label="Step ${i + 1}">${esc(e.task ?? s.task)}</textarea>
        <span class="mmeta">${esc(afterLine(m, s))}${expectLine(s) ? ` · makes ${esc(expectLine(s))}` : ''}</span>
      </span></li>`;
  }
  return `<li class="mstep st-${esc(s.status)}" data-mstep="${esc(s.id)}">
    <span class="mn">${s.status === 'done' ? icon('check') : i + 1}</span>
    <span class="mt"><span class="mrow"><b>${esc(w.name)}</b>${w.role && w.role !== w.name ? `<span class="hint">${esc(w.role)}</span>` : ''}</span>
      <span class="mtask">${esc(s.task)}</span>
      <span class="mmeta">${esc(afterLine(m, s))}${expectLine(s) ? ` · makes ${esc(expectLine(s))}` : ''}${s.attempts?.fixes ? ' · had its automatic fix' : ''}${s.cost ? ` · ${money(s.cost)}` : ''}</span>
      ${s.validation && s.validation.verdict !== 'ok' && s.status !== 'done' ? `<span class="mcheck">Orchy's check: ${esc(s.validation.checks.map(c => c.note || c.name).join('; '))}</span>` : ''}
      ${s.files?.length ? `<span class="mfilesrow">${s.files.slice(0, 6).map(f => `<span class="chip">${icon(kindIcon(kindOf(f)))}${esc(f.split('/').pop())}</span>`).join('')}</span>` : ''}
    </span>
    <span class="ms">${state}${s.runId ? `<button type="button" class="btn sm ghost" data-run="${esc(s.runId)}" title="Open its run">${icon('eye')}<span class="wl">Watch</span></button>` : ''}</span>
  </li>`;
}
const kindOf = f => { const x = String(f).split('.').pop().toLowerCase(); return x === 'pdf' ? 'pdf' : /^(png|jpe?g|gif|webp|avif|svg)$/.test(x) ? 'image' : /^(mp4|mov|webm|m4v)$/.test(x) ? 'video' : /^(csv|xlsx?)$/.test(x) ? 'csv' : /^(md|markdown)$/.test(x) ? 'markdown' : 'other'; };

/** The owner's open ask on a mission: what Orchy found and the one-move answers (the first in decision yellow). */
export function askHTML(m) {
  const a = m.ask;
  if (!a) return '';
  const s = a.stepId ? m.steps.find(x => x.id === a.stepId) : null;
  const pick = a.suggest ? `<div class="btnrow"><span class="hint">Jev suggests ${esc(a.suggest.agentName)}${a.suggest.p != null ? ` (${Math.round(a.suggest.p * 100)}%)` : ''}:</span>
      <select class="select" data-mreassign="${esc(m.id)}" aria-label="Give it to">${ctx.state.agents.filter(x => x.workspace === m.workspace && !x.isBuilder && !x.error && x.slug !== s?.agent).map(x => `<option value="${esc(x.slug)}"${x.slug === a.suggest.agent ? ' selected' : ''}>${esc(agentName(x.workspace, x.slug, x.displayName))}</option>`).join('')}${s?.agent !== 'general' ? `<option value="general"${a.suggest.agent === 'general' ? ' selected' : ''}>${esc(wsName(m.workspace))} generalist</option>` : ''}</select>
      <button type="button" class="btn sm decide" data-mact="reassign" data-mission="${esc(m.id)}" data-mconfirm>${icon('user')}Give it</button></div>` : '';
  const follow = a.options.some(o => o.action === 'followup') ? `<textarea class="textarea" rows="2" data-mfollow="${esc(m.id)}" placeholder="What should ${esc(s ? stepWho(m, s).name : 'it')} do? (Follow up)" aria-label="Follow-up for the step">${esc(typed.get(m.id) || '')}</textarea>` : '';
  const tail = a.kind === 'replan' && m.replan ? `<ol class="msteps mini">${m.replan.steps.map((x, i) => `<li class="mstep"><span class="mn">${m.steps.filter(y => ['done', 'skipped'].includes(y.status)).length + i + 1}</span><span class="mt"><span class="mrow"><b>${esc(stepWho(m, x).name)}</b></span><span class="mtask">${esc(x.task)}</span><span class="mmeta">${esc(afterLine({ ...m, steps: [...m.steps, ...m.replan.steps] }, x))}</span></span></li>`).join('')}</ol>` : '';
  return `<div class="asks mask">
    <span class="stage">${esc({ check: 'Orchy checked a step', failed: 'A step needs you', stopped: 'A step was stopped', ceiling: 'Cost ceiling', time: 'Time cap', restart: 'Orchy restarted', replan: 'New plan', off: 'Switched off', gone: 'Workspace gone' }[a.kind] || 'Needs you')}</span>
    <p>${esc(a.text)}</p>${a.replanError ? `<p>Replan didn’t work: ${esc(a.replanError)}</p>` : ''}${a.planning ? '<p class="blink">Planning the rest…</p>' : ''}
    ${tail}${follow}${pick}
    <div class="btnrow">${a.options.map((o, i) => `<button type="button" class="btn sm${i === 0 ? ' primary' : ''}" data-mact="${esc(o.action)}" data-mission="${esc(m.id)}"${a.planning ? ' disabled' : ''}>${icon(ACT_ICON[o.action] || 'play')}${esc(o.action === 'raise' ? `Raise to ${money(m.ceiling + (ctx.state.settings.missionCeiling || 15))}` : o.label)}</button>`).join('')}</div>
  </div>`;
}

/** The mission card in Orchy's chat (an article like the routing card; data-mission-card for live updates). */
export function missionCardHTML(m) {
  if (!m) return '';
  const edit = editing.get(m.id);
  const planned = m.status === 'planned';
  const ended = ENDED.has(m.status);
  const needs = m.status === 'waiting' || (planned && !m.startAt);
  const files = [...new Set(m.steps.flatMap(s => s.files || []))];
  const head = `<div class="rh"><span>${icon('flag')} Mission · <span class="plate ${wsClass(m.workspace)}">${esc(wsName(m.workspace))}</span></span><span>${esc(MISSION_LABEL[m.status] || m.status)}${m.status === 'planned' && m.sure ? ' · Jev’s sure' : ''}</span></div>`;
  if (m.status === 'fallback') return `<article class="route mission done" data-mission-card="${esc(m.id)}">${head}<div class="mfoot hint">${icon('send')} Sent as a task card instead: ${esc(m.fallback?.why || '')}</div></article>`;
  const body = m.status === 'planning'
    ? `<p class="hint blink">${icon('steps')} Planning the steps with ${esc(wsName(m.workspace))}’s own account…</p>`
    : `${m.objective ? `<p class="mobj"><span class="label">Goal</span> ${esc(m.objective)}${m.done_when ? `<span class="hint"> · done when ${esc(m.done_when)}</span>` : ''}</p>` : ''}
       <ol class="msteps">${m.steps.map((s, i) => stepRow(m, s, i, edit)).join('')}</ol>`;
  const cost = m.status === 'planning' ? '' : `<p class="hint mcost">Cost ${money(m.cost)} of ${money(m.ceiling)}${m.taskDir ? ` · Tasks/${esc(m.taskDir)}/` : ''}${m.autoFixes ? ` · ${m.autoFixes} automatic fix${m.autoFixes === 1 ? '' : 'es'}` : ''}${m.startedAt ? ` · ${dur((m.endedAt ? Date.parse(m.endedAt) : Date.now()) - Date.parse(m.startedAt))}` : ''}</p>`;
  let foot;
  if (planned && edit) foot = `<span class="countdown">Editing</span><span class="btnrow"><button type="button" class="btn sm" data-mact="edit-cancel" data-mission="${esc(m.id)}">${icon('x')}Cancel</button><button type="button" class="btn sm primary" data-mact="edit-save" data-mission="${esc(m.id)}">${icon('check')}Save the plan</button></span>`;
  else if (planned) foot = `<span class="countdown" data-mcd="${esc(m.id)}">${m.startAt ? '' : m.held ? 'Held · press Go' : 'Waiting for your Go'}</span>
      <span class="btnrow">${m.startAt ? `<button type="button" class="btn sm" data-mact="hold" data-mission="${esc(m.id)}">${icon('stop')}Stop</button>` : ''}<button type="button" class="btn sm" data-mact="edit" data-mission="${esc(m.id)}">${icon('edit')}Edit</button><button type="button" class="btn sm" data-mact="as-task" data-mission="${esc(m.id)}">${icon('send')}As a task</button><button type="button" class="btn sm" data-mact="stop" data-mission="${esc(m.id)}">${icon('x')}Cancel</button><button type="button" class="btn sm ${m.startAt ? 'primary' : 'decide'}" data-mact="go" data-mission="${esc(m.id)}">${icon('play')}Go</button></span>`;
  else if (m.status === 'planning') foot = `<span class="countdown">Planning…</span><span class="btnrow"><button type="button" class="btn sm" data-mact="stop" data-mission="${esc(m.id)}">${icon('x')}Cancel</button></span>`;
  else foot = `<span class="countdown">${ended ? `${esc(MISSION_LABEL[m.status])}${m.result?.met != null && m.status !== 'stopped' ? ` · objective ${Math.round(m.result.met * 100)}%` : ''}` : `${m.steps.filter(s => s.status === 'done').length}/${m.steps.length} done`}</span>
      <span class="btnrow"><button type="button" class="btn sm" data-mlive="${esc(m.id)}">${icon('live')}Open in Live</button>${ended || m.ask?.options?.some(o => o.action === 'stop') ? '' : `<button type="button" class="btn sm" data-mact="stop" data-mission="${esc(m.id)}">${icon('stop')}Stop the mission</button>`}</span>`;
  return `<article class="route mission${needs ? ' needs' : ''}${ended ? ' ended' : ''}" data-mission-card="${esc(m.id)}">
    ${head}
    <div class="rb"><q>${esc(m.text)}</q>${body}${askHTML(m)}${ended && files.length ? `<div class="mfilesrow">${files.slice(0, 10).map(f => `<span class="chip">${icon(kindIcon(kindOf(f)))}${esc(f.split('/').pop())}</span>`).join('')}</div>` : ''}${cost}</div>
    <div class="rf">${foot}</div>
  </article>`;
}

/** The card for a chat line: from state, or (an older mission) a slot filled once /api/missions/:id answers. */
const fetching = new Set();
export function missionSlotHTML(id) {
  const m = ctx.state.missions.get(id);
  if (m) return missionCardHTML(m);
  if (!fetching.has(id)) { fetching.add(id); api(`/api/missions/${encodeURIComponent(id)}`).then(x => missionUpdated(x)).catch(() => {}); }
  return `<article class="route mission ended" data-mission-card="${esc(id)}"><div class="rh"><span>${icon('flag')} Mission</span><span>…</span></div></article>`;
}

/** A later line about the mission (an ask, the end): the card lives on the first line; these point back to it. */
export function missionLineHTML(m, msg) {
  if (!m) return '';
  const open = m.ask && msg.meta?.askAt && m.ask.at === msg.meta.askAt;
  return `<div class="links">${open ? `<button type="button" class="btn sm decide" data-mjump="${esc(m.id)}">${icon('bang')}Answer on the card</button>` : ''}<button type="button" class="btn sm${open ? ' ghost' : ''}" data-mlive="${esc(m.id)}">${icon('live')}Open in Live</button></div>`;
}

/** The countdown on a sure card (app.mjs ticks it with the routing cards'). */
export function tickMissionCountdowns(root = document) {
  for (const m of ctx?.state.missions?.values() || []) {
    if (m.status !== 'planned' || !m.startAt) continue;
    const el = root.querySelector(`[data-mcd="${CSS.escape(m.id)}"]`);
    if (!el) continue;
    const total = 10, left = Math.max(0, Math.ceil((Date.parse(m.startAt) - Date.now()) / 1000));
    el.innerHTML = `Starts in <b class="num">${left}</b><span class="cd">${Array.from({ length: total }, (_, i) => `<i class="${i >= Math.min(left, total) ? 'spent' : ''}"></i>`).join('')}</span>`;
  }
}

/** A mission changed (mission.created / mission.updated): every card for it redraws in place. */
export function missionUpdated(m, root = document) {
  ctx.state.missions.set(m.id, m);
  if (m.status !== 'planned') editing.delete(m.id);
  for (const el of root.querySelectorAll(`[data-mission-card="${CSS.escape(m.id)}"]`)) {
    const f = document.activeElement;
    const keep = f && el.contains(f) && (f.matches('textarea, select')) ? { sel: f.dataset.mfollow ? `[data-mfollow]` : f.dataset.meditTask ? `[data-medit-task="${CSS.escape(f.dataset.meditTask)}"]` : null, start: f.selectionStart } : null;
    el.outerHTML = missionCardHTML(m);
    if (keep?.sel) { const n = root.querySelector(`[data-mission-card="${CSS.escape(m.id)}"] ${keep.sel}`); if (n) { n.focus(); try { n.setSelectionRange(keep.start, keep.start); } catch {} } }
  }
}

/** Clicks on a mission card (app.mjs passes every click on a data-mact / data-mlive / data-mjump / data-medit-* button). */
export async function onMissionClick(t) {
  const mid = t.dataset.mission || t.dataset.mlive || t.dataset.mjump || t.closest('[data-mission-card]')?.dataset.missionCard;
  const m = ctx.state.missions.get(mid);
  if (!m) return ctx.toast('That mission is gone', 'warn');
  if (t.dataset.mlive) return ctx.openLive({ type: 'mission', id: m.id });
  if (t.dataset.mjump) { const el = document.querySelector(`#convo [data-mission-card="${CSS.escape(m.id)}"]`); el?.scrollIntoView({ block: 'center' }); el?.querySelector('.asks .btn')?.focus(); return; }
  if (t.dataset.meditRemove) {
    const d = editing.get(m.id); if (!d) return;
    const e = d.steps[t.dataset.meditRemove] ||= {};
    e.remove = !e.remove;
    return missionUpdated(m);
  }
  const act = t.dataset.mact;
  if (act === 'edit') {
    editing.set(m.id, { steps: {} });
    // editing stops a countdown, like touching a routing card does
    if (m.startAt) { try { return missionUpdated(await api(`/api/missions/${encodeURIComponent(m.id)}/act`, { method: 'POST', body: { action: 'hold' } })); } catch (err) { ctx.toast(err.message, 'warn'); } }
    return missionUpdated(m);
  }
  if (act === 'edit-cancel') { editing.delete(m.id); return missionUpdated(m); }
  const card = t.closest('[data-mission-card], [data-mission-scope]'); // the chat card, or the Live view's ask block
  t.disabled = true;
  try {
    if (act === 'edit-save') {
      const d = editing.get(m.id) || { steps: {} };
      card?.querySelectorAll('[data-medit-task]').forEach(x => { (d.steps[x.dataset.meditTask] ||= {}).task = x.value; });
      card?.querySelectorAll('[data-medit-agent]').forEach(x => { (d.steps[x.dataset.meditAgent] ||= {}).agent = x.value; });
      const steps = Object.entries(d.steps).map(([id, e]) => ({ id, ...e }));
      const res = await api(`/api/missions/${encodeURIComponent(m.id)}`, { method: 'PATCH', body: { steps } });
      editing.delete(m.id);
      return missionUpdated(res);
    }
    const body = { action: act };
    if (act === 'followup') {
      const text = card?.querySelector('[data-mfollow]')?.value.trim() || '';
      if (!text) { card?.querySelector('[data-mfollow]')?.focus(); return ctx.toast('Write what it should do first', 'warn'); }
      body.text = text;
    }
    if (act === 'reassign' && t.hasAttribute('data-mconfirm')) body.agent = card?.querySelector('[data-mreassign]')?.value || null;
    if (act === 'stop' && !['planned', 'planning'].includes(m.status) && !confirm('Stop the whole mission? Steps that are running stop too.')) return;
    const res = await api(`/api/missions/${encodeURIComponent(m.id)}/act`, { method: 'POST', body });
    if (act === 'followup') typed.delete(m.id);
    missionUpdated(res);
  } catch (err) { ctx.toast(err.message, 'warn'); }
  finally { t.disabled = false; }
}

/** Typing in a card (a follow-up) survives redraws. */
export function onMissionInput(t) {
  if (t.dataset.mfollow) typed.set(t.dataset.mfollow, t.value);
  if (t.dataset.meditTask) { const mid = t.closest('[data-mission-card]')?.dataset.missionCard; const d = mid && editing.get(mid); if (d) (d.steps[t.dataset.meditTask] ||= {}).task = t.value; }
  if (t.dataset.meditAgent) { const mid = t.closest('[data-mission-card]')?.dataset.missionCard; const d = mid && editing.get(mid); if (d) (d.steps[t.dataset.meditAgent] ||= {}).agent = t.value; }
}

