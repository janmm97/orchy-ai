// The Live view's shared state and the derivations its three columns draw from (live.mjs).
// Everything here is read from recorded state: runs (status, run.activity), huddles, the inbox, run events,
// the artifact registry. Nothing is guessed: a state with no event behind it isn't shown.
import { api, clientOwn, timezone, agentName, nameRole, stageOf } from '../util.mjs';

export const S = {
  ctx: null,            // { state, LIVE, toast, openRun, openHuddle, openProposal, onOpen, onClose }
  open: false,
  sel: null,            // { type: 'run' | 'huddle' | 'mission', id }
  tab: 'activity',      // phone: which column shows
  filter: { ws: 'all', liveOnly: false },
  events: new Map(),    // runId -> recorded events (fetched on demand, then kept live)
  lastTool: new Map(),  // runId -> the latest tool line (summary)
  files: new Map(),     // selection key -> { list (deliverables only), at, failed }
  eventsFailed: new Set(), // runIds whose steps didn't load (the timeline offers Retry, never "no steps")
  agentFilter: null,    // Output: one agent's files only (when several agents made some)
};

export const isPreview = id => String(id || '').startsWith('preview-');
export const selKey = sel => (sel ? `${sel.type}:${sel.id}` : '');
export const ACTIVE_HUDDLE = new Set(['talking', 'wrapping', 'agreed']);
export const isLiveRun = r => S.ctx.LIVE.has(r?.status);
const todayET = iso => new Intl.DateTimeFormat('en-CA', { timeZone: timezone() }).format(new Date(iso));
export const isToday = iso => !!iso && todayET(iso) === todayET(new Date().toISOString());

/** What the owner owes this run: the pending inbox items for it (client-answered ones live on their page). */
export const asksFor = runId => [...S.ctx.state.inbox.values()].filter(i => i.runId === runId && i.status === 'pending');
export const waitsOnOwner = r => r?.status === 'waiting' && asksFor(r.id).length > 0;

/** The name the owner calls the run's agent by, and its role. */
export function whoOf(r) {
  const slug = r.isBuilder ? 'agent-builder' : r.agentSlug;
  const a = S.ctx.state.agents.find(x => x.workspace === r.workspace && x.slug === slug);
  const role = r.isBuilder ? 'AI Agent Builder' : a?.displayName || r.agentName || 'Generalist';
  const name = agentName(r.workspace, slug, role);
  return { slug, name, role, label: nameRole(name, role) };
}

/** The plate a run wears: run.activity's label (activity.mjs) while live, its outcome after. `cls` decide = the owner owes it. */
export function runState(r) {
  if (waitsOnOwner(r)) return { label: 'Waiting on you', cls: 'decide' };
  if (r.status === 'waiting') return { label: r.activity?.label || (r.clientName ? `Waiting on ${r.clientName}` : 'Waiting'), cls: '' };
  // the agent is done; Orchy checks its report (validate.mjs) before Orchy reports
  if (r.activity?.state === 'validating') return { label: r.activity.label || 'Orchy is checking', cls: '' };
  if (r.stalledAt && isLiveRun(r)) return { label: 'No new step', cls: '' };
  if (isLiveRun(r)) return { label: r.activity?.label || stageOf(r).label, cls: '' };
  const o = r.outcome || (r.status === 'done' ? 'completed' : r.status);
  // cls: ok (done), fail (failed or stopped: struck through), past (anything else that ended)
  return { label: o === 'completed' ? 'Done' : o === 'partial' ? 'Partly done' : o === 'failed' ? 'Failed' : o === 'stopped' ? 'Stopped' : o, cls: o === 'completed' ? 'ok' : o === 'failed' || o === 'stopped' ? 'fail' : 'past' };
}

const H_STATE = { talking: 'Talking', wrapping: 'Writing the agreement', agreed: 'Agreed · waiting for you', approved: 'Approved', stopped: 'Stopped', failed: 'Stopped early', closed: 'Closed' };
export function huddleState(h) {
  if (h.status === 'agreed') return { label: H_STATE.agreed, cls: 'decide' };
  return { label: H_STATE[h.status] || h.status, cls: ACTIVE_HUDDLE.has(h.status) ? '' : h.status === 'approved' ? 'ok' : h.status === 'closed' ? 'past' : 'fail' };
}
export const huddleName = h => `Huddle · ${h.agents.map(a => a.name).join(' + ')}`;

// missions (missions.mjs): a parent row over its step runs, its plan as the Work column's step graph
export const ACTIVE_MISSION = new Set(['planning', 'planned', 'running', 'waiting']);
const M_STATE = { planning: 'Planning', planned: 'Plan ready', running: 'Running', waiting: 'Waiting on you', done: 'Done', partial: 'Partly done', stopped: 'Stopped', failed: 'Failed', fallback: 'Sent as a task' };
export function missionState(m) {
  if (m.status === 'waiting' || (m.status === 'planned' && !m.startAt)) return { label: m.status === 'planned' ? 'Waiting for your Go' : M_STATE.waiting, cls: 'decide' };
  return { label: M_STATE[m.status] || m.status, cls: ACTIVE_MISSION.has(m.status) ? '' : m.status === 'done' ? 'ok' : m.status === 'partial' || m.status === 'fallback' ? 'past' : 'fail' };
}
export const missionName = m => `Mission · ${m.objective || m.text}`;
export const missionRunIds = m => [...new Set((m?.steps || []).flatMap(s => s.runIds || []))];
/** The step run to follow in the Work column: a live one, else the latest. */
export function missionFocusRun(m) {
  const { state } = S.ctx;
  const runs = missionRunIds(m).map(id => state.runs.get(id)).filter(Boolean);
  return runs.filter(isLiveRun).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] || runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] || null;
}
export const speakerOf = h => (h.speaking === 'orchy' ? { slug: 'orchy', name: 'Orchy' } : h.agents.find(a => a.slug === h.speaking) || null);

/**
 * Planning · Discussion · Execution · (Reviewing) · Done for a run or a huddle, from status alone;
 * Reviewing is Orchy's check of the report (validate.mjs), shown only for runs it ran on.
 * Each step is 'past', 'now', 'next' or 'skipped' (it didn't happen, e.g. no huddle before this run).
 */
export function phasesOf(sel) {
  const { state } = S.ctx;
  let cur, talked, worked, reviewed = false, end = '';
  if (sel?.type === 'mission') {
    const m = state.missions?.get(sel.id);
    if (!m) return null;
    talked = false;
    worked = !!m.startedAt;
    reviewed = m.steps.some(s => s.validation || s.status === 'checking');
    cur = ['planning', 'planned'].includes(m.status) ? 'planning' : ACTIVE_MISSION.has(m.status) ? (m.steps.some(s => s.status === 'checking') && !m.steps.some(s => ['running', 'fixing', 'retrying'].includes(s.status)) ? 'reviewing' : 'execution') : 'done';
    if (cur === 'done') end = missionState(m).label;
  } else if (sel?.type === 'huddle') {
    const h = state.huddles.get(sel.id);
    if (!h) return null;
    const work = (h.workRunIds || []).map(id => state.runs.get(id)).filter(Boolean);
    talked = true;
    worked = h.status === 'approved' || work.length > 0;
    cur = ACTIVE_HUDDLE.has(h.status) ? 'discussion' : h.status === 'approved' && work.some(isLiveRun) ? 'execution' : 'done';
    if (cur === 'done') end = h.status === 'approved' ? 'Done' : huddleState(h).label;
  } else {
    const r = state.runs.get(sel?.id);
    if (!r) return null;
    const st = r.activity?.state;
    talked = !!r.fromHuddle || st === 'huddle';
    worked = !['queued', 'paused-limit'].includes(r.status) && !(r.status === 'starting' && !(S.events.get(r.id) || []).some(e => e.kind === 'tool'));
    // Reviewing shows only when Orchy's check really ran (or is running) on this run
    reviewed = !!r.validation?.verdict || st === 'validating';
    cur = st === 'validating' ? 'reviewing' : !isLiveRun(r) ? 'done' : ['queued', 'paused-limit', 'starting'].includes(r.status) || st === 'planning' ? 'planning' : st === 'huddle' ? 'discussion' : 'execution';
    if (cur === 'done') end = runState(r).label;
  }
  const order = reviewed ? ['planning', 'discussion', 'execution', 'reviewing', 'done'] : ['planning', 'discussion', 'execution', 'done'];
  const at = order.indexOf(cur);
  return order.map((k, i) => {
    let s = i < at ? 'past' : i === at ? 'now' : 'next';
    if (k === 'discussion' && s === 'past' && !talked) s = 'skipped';
    if (k === 'execution' && s === 'past' && !worked) s = 'skipped';
    return { k, s, label: k === 'done' && end ? end : k };
  });
}

/**
 * The Activity column's rows: live runs and huddles grouped by workspace (waiting on the owner first), each with its
 * hand-offs (delegatedBy) and a huddle's approved work (fromHuddle) indented under it; then up to 20 finished today.
 */
export function activityRows() {
  const { state } = S.ctx;
  const f = S.filter;
  const okWs = ws => f.ws === 'all' || f.ws === ws;
  const runs = [...state.runs.values()].filter(r => !clientOwn(r) && !r.huddleTalk && okWs(r.workspace));
  const huddles = [...state.huddles.values()].filter(h => okWs(h.workspace));
  const item = (type, x) => ({ type, id: x.id, ws: x.workspace, x, kids: [] });
  const liveRuns = runs.filter(isLiveRun);
  const liveH = huddles.filter(h => ACTIVE_HUDDLE.has(h.status) || (h.status === 'approved' && (h.workRunIds || []).some(id => isLiveRun(state.runs.get(id)))));
  const missions = [...(state.missions?.values() || [])].filter(m => okWs(m.workspace) && m.status !== 'fallback');
  const liveM = missions.filter(m => ACTIVE_MISSION.has(m.status));
  const top = [...liveH.map(h => item('huddle', h)), ...liveM.map(m => item('mission', m))];
  const byId = new Map(top.map(t => [`${t.type}:${t.id}`, t]));
  const runItems = liveRuns.map(r => item('run', r));
  for (const t of runItems) byId.set(`run:${t.id}`, t);
  for (const t of runItems) {
    const parent = (t.x.missionId && byId.get(`mission:${t.x.missionId}`)) || (t.x.delegatedBy && byId.get(`run:${t.x.delegatedBy}`)) || (t.x.fromHuddle && byId.get(`huddle:${t.x.fromHuddle}`));
    if (parent && parent !== t) parent.kids.push(t); else top.push(t);
  }
  const rank = t => (t.type === 'run' ? (waitsOnOwner(t.x) ? 0 : 2) : t.type === 'mission' ? (missionState(t.x).cls === 'decide' ? 0 : 1) : t.x.status === 'agreed' ? 0 : 1);
  const started = t => t.x.startedAt || t.x.createdAt || '';
  top.sort((a, b) => rank(a) - rank(b) || started(b).localeCompare(started(a)));
  const order = [...state.workspaces.map(w => w.id)];
  for (const t of top) if (!order.includes(t.ws)) order.push(t.ws);
  const groups = order.map(ws => ({ ws, items: top.filter(t => t.ws === ws) })).filter(g => g.items.length);
  let earlier = [];
  if (!f.liveOnly) {
    const doneRuns = runs.filter(r => !isLiveRun(r) && isToday(r.endedAt)).map(r => item('run', r));
    const doneH = huddles.filter(h => !liveH.includes(h) && isToday(h.endedAt || h.createdAt)).map(h => item('huddle', h));
    const doneM = missions.filter(m => !liveM.includes(m) && isToday(m.endedAt || m.createdAt)).map(m => item('mission', m));
    const endOf = t => t.x.endedAt || t.x.createdAt || '';
    earlier = [...doneRuns, ...doneH, ...doneM].sort((a, b) => endOf(b).localeCompare(endOf(a))).slice(0, 20);
  }
  return { groups, earlier, live: liveRuns.length + liveH.length + liveM.length };
}

/** The run or huddle to show when nothing (or something gone) is selected: what waits on the owner, then what's live, then the latest. */
export function defaultSel() {
  const { groups, earlier } = activityRows();
  const first = groups[0]?.items[0] || earlier[0];
  return first ? { type: first.type, id: first.id } : null;
}
export function selExists(sel) {
  if (!sel) return false;
  const { state } = S.ctx;
  return sel.type === 'huddle' ? state.huddles.has(sel.id) : sel.type === 'mission' ? !!state.missions?.has(sel.id) : state.runs.has(sel.id);
}

/** A run's recorded events (once), kept live by run.event afterwards. */
const loading = new Map();
export function loadEvents(runId) {
  if (S.events.has(runId) || isPreview(runId)) return Promise.resolve(S.events.get(runId) || []);
  if (loading.has(runId)) return loading.get(runId);
  const p = api(`/api/runs/${encodeURIComponent(runId)}`).then(d => {
    const evs = d.events || [];
    // events that streamed in while this was on its way (deduped by n where they have one)
    const early = S.events.get(runId) || [];
    const seen = new Set(evs.map(e => e.n).filter(n => n != null));
    S.events.set(runId, [...evs, ...early.filter(e => e.n == null || !seen.has(e.n))]);
    const tool = evs.findLast(e => e.kind === 'tool');
    if (tool && !S.lastTool.has(runId)) S.lastTool.set(runId, tool.summary || tool.tool || '');
    return S.events.get(runId);
  }).catch(() => { S.eventsFailed.add(runId); return S.events.get(runId) || null; }).finally(() => loading.delete(runId));
  loading.set(runId, p);
  return p;
}

/**
 * The timeline as rows with each tool paired to its end (toolUseId): 'run' while it's open in a live run,
 * 'ok' once tool_done came, 'err' on tool_error/denied. Tools from before toolUseId existed stay plain.
 */
export function pairedRows(events, live) {
  const ends = new Map();
  for (const e of events) if (e.toolUseId && ['tool_done', 'tool_error', 'denied'].includes(e.kind)) ends.set(e.toolUseId, e);
  const toolIds = new Set(events.filter(e => e.kind === 'tool' && e.toolUseId).map(e => e.toolUseId));
  // the agent wrote again after a tool: that tool is over even if no end was recorded, so it isn't "running"
  const lastText = events.findLastIndex(e => e.kind === 'text' || e.kind === 'report');
  const rows = [];
  for (const [i, e] of events.entries()) {
    if (e.kind === 'tool_done') continue;
    if ((e.kind === 'tool_error' || e.kind === 'denied') && e.toolUseId && toolIds.has(e.toolUseId)) continue; // shown on its tool's row
    if (e.kind === 'system' && !/Finished|Started|Stopped/i.test(e.text || '')) continue;
    if (e.kind === 'tool' && e.toolUseId) {
      const end = ends.get(e.toolUseId);
      rows.push({ e, st: end ? (end.kind === 'tool_done' && end.ok !== false ? 'ok' : 'err') : live && i > lastText ? 'run' : '', end });
    } else rows.push({ e, st: '' });
  }
  return rows;
}
