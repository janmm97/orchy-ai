// What Orchy does with Jev's routing answers, with Jev faked: follow-ups to earlier runs, quick status
// answers, and when a card waits for the owner instead of counting down. Run: node orchestrator/scripts/test-jev-routing.mjs
import { route as realRoute, earlierRuns, earlierRunQuestion, ceilingTierModel, unroutedModel } from '../lib/router.mjs';
import { quickStatus } from '../lib/status.mjs';
import { db } from '../lib/store.mjs';
import { tierModel } from '../lib/workspaces.mjs';

let fail = 0;
const ok = (cond, label, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : `  ${extra}`}`); if (!cond) fail++; };

// a made-up setup, so the test doesn't depend on which workspaces and agents the owner has switched on
const W = {
  alpha: { id: 'alpha', name: 'Alpha Studio', client: 'Alpha Studio Ltd', blurb: 'Support inbox and invoices.', aliases: [], runtime: 'claude', enabled: true },
  beta: { id: 'beta', name: 'Beta Labs', client: 'Beta Labs Inc', blurb: 'Lab notebooks and sample orders.', aliases: [], runtime: 'codex', enabled: true },
  acme: { id: 'acme', name: 'Acme Agent', client: 'Acme Corp', blurb: 'Acme.', aliases: [], runtime: 'claude', enabled: false },
};
const AGENTS = [
  { workspace: 'alpha', slug: 'support', displayName: 'Support Agent', description: 'Answers the support inbox' },
  { workspace: 'beta', slug: 'editor', displayName: 'Editor', description: 'Edits lab reports' },
];
// budget: null keeps this week's real usage on this PC out of the test
const route = (text, opts) => realRoute(text, { workspaces: Object.values(W), agents: AGENTS, budget: null, ...opts });
const agent = 'support';
let asked = null;
const jev = ({ intent = 'task', intentP = { task: 0.9, chat: 0.05, status: 0.05 }, agentConf = 0.8, status = ['other', 0.9], earlier = null, ws = 'alpha', pick = `alpha/${agent}`, effort = 1 } = {}) => async (state, questions, opts) => {
  asked = { state, questions, opts };
  return {
    model: 'fake', ms: 1,
    answers: {
      intent: { choice: intent, confidence: intentP[intent] ?? 0.9, probabilities: intentP },
      workspace: { choice: ws, confidence: 0.9, probabilities: { [ws]: 0.9 } },
      agent: { choice: pick, confidence: agentConf, probabilities: { [pick]: agentConf } },
      effort: { score: effort },
      status_about: { choice: status[0], confidence: status[1] },
      ...(earlier ? { earlier_run: { choice: earlier[0], confidence: earlier[1] } } : {}),
    },
  };
};
const runs = [
  { id: 'r_new', session: 's1', startedAt: '2026-10-09T10:00:00Z', agentName: 'Support Agent', workspace: 'alpha', instruction: 'check the inbox', status: 'done' },
  { id: 'r_old', session: 's1', startedAt: '2026-10-09T09:00:00Z', agentName: 'Support Agent', workspace: 'alpha', instruction: 'older', status: 'done' },
  { id: 'r_client', session: 's1', startedAt: '2026-10-09T11:00:00Z', client: 'c1', workspace: 'alpha', instruction: 'x', status: 'done' },
  { id: 'r_team', session: 's1', startedAt: '2026-10-09T11:00:00Z', delegatedBy: 'r_head', workspace: 'alpha', instruction: 'x', status: 'done' },
  { id: 'r_other', session: 's2', startedAt: '2026-10-09T12:00:00Z', workspace: 'alpha', instruction: 'x', status: 'done' },
];

// ── which earlier runs Jev may pick from ──
{
  const e = earlierRuns(runs, 's1');
  ok(e.map(r => r.id).join() === 'r_new,r_old', 'earlier runs: this session only, newest first, no client or hand-off runs', e.map(r => r.id).join());
  const q = earlierRunQuestion(e);
  ok(q.criteria.none && q.criteria.r0.includes('check the inbox') && Object.keys(q.criteria).length === 3, 'earlier-run question: none + one option per run');
}

// ── when a card waits for the owner ──
{
  const r = await route('check the support inbox for Alpha', { recent: [], ask: jev() });
  ok(!r.needsChoice && !r.holdReason && r.agent === agent, 'a sure pick counts down', JSON.stringify({ n: r.needsChoice, h: r.holdReason, a: r.agent }));
  ok(!('earlier_run' in asked.questions) && 'status_about' in asked.questions, 'no earlier runs, no earlier-run question');
  const low = await route('check the support inbox for Alpha', { recent: [], ask: jev({ agentConf: 0.2 }) });
  ok(low.needsChoice && low.holdReason === 'agent', 'a very unsure agent pick waits for Sam', JSON.stringify({ n: low.needsChoice, h: low.holdReason }));
  const mid = await route('check the support inbox for Alpha', { recent: [], ask: jev({ agentConf: 0.45 }) });
  ok(!mid.needsChoice, 'a middling agent pick still counts down (Sam rarely changed those)');
  const close = await route('what about the refund emails', { recent: [], ask: jev({ intent: 'chat', intentP: { chat: 0.55, task: 0.45 } }) });
  ok(close.intent === 'task' && close.askChat && close.holdReason === 'chat-or-task' && close.needsChoice, 'chat vs task close call: a card with "Just answer"', JSON.stringify({ i: close.intent, a: close.askChat, h: close.holdReason }));
  const chat = await route('how are you', { recent: [], ask: jev({ intent: 'chat', intentP: { chat: 0.9, task: 0.1 } }) });
  ok(chat.intent === 'chat' && !chat.askChat && !chat.needsChoice, 'a clear chat is just answered');
}

// ── the builder in the agent list, and Jev's primer ──
{
  const withBuilder = [{ workspace: 'alpha', slug: 'agent-builder', displayName: 'AI Agent Builder', isBuilder: true }, ...AGENTS];
  const r = await route('give the support agent access to Zendesk', { recent: [], agents: withBuilder, names: (w, s) => (s === 'agent-builder' ? 'Quinn' : null), primer: 'primer text', ask: jev({ pick: 'alpha/agent-builder' }) });
  ok(asked.questions.agent.criteria['alpha/agent-builder']?.startsWith('Quinn, AI Agent Builder'), 'the builder is an agent Jev can pick, by name');
  ok(r.intent === 'build_agent' && r.agent === 'agent-builder' && r.workspace === 'alpha', 'picking the builder for a task makes it agent work', JSON.stringify({ i: r.intent, a: r.agent, w: r.workspace }));
  ok(asked.state.how_orchy_works === 'primer text' && asked.state.agents_named_in_instruction === 'Support Agent in Alpha Studio (alpha/support)', 'the primer rides along, with the agent Sam named by role', asked.state.agents_named_in_instruction);
  await route('check the inbox for Alpha', { recent: [], ask: jev() });
  ok(asked.state.agents_named_in_instruction === '(none)', 'no agent named: none');
  const { jevPrimer } = await import('../lib/router.mjs');
  ok(/AI Agent Builder/.test(jevPrimer()) && jevPrimer().length < 4000 && !jevPrimer().startsWith('#'), 'jev-primer.md is there, short, without its heading', String(jevPrimer().length));
}

// ── follow-ups ──
{
  const e = earlierRuns(runs, 's1');
  const f = await route('now draft replies to those', { recent: [], runs: e, ask: jev({ earlier: ['r0', 0.85] }) });
  ok(f.earlierRun?.runId === 'r_new' && 'earlier_run' in asked.questions && asked.state.runs_earlier_in_this_conversation?.includes('r0:'), 'a sure follow-up names its run', JSON.stringify(f.earlierRun));
  const unsure = await route('now draft replies to those', { recent: [], runs: e, ask: jev({ earlier: ['r0', 0.6] }) });
  ok(unsure.earlierRun === null, 'an unsure follow-up starts a new task');
  const none = await route('find leads in Austin', { recent: [], runs: e, ask: jev({ earlier: ['none', 0.95] }) });
  ok(none.earlierRun === null, 'none means a new task');
  // continuing a Beta run while Jev's own pick was Alpha: Beta's workspace, no Alpha agent, a Beta model
  const rBeta = [{ id: 'r_beta', session: 's3', startedAt: '2026-10-09T10:00:00Z', agentName: 'Editor', workspace: 'beta', instruction: 'edit chapter 3', status: 'done' }];
  const mixed = await route('now do chapter 4', { recent: [], runs: rBeta, ask: jev({ earlier: ['r0', 0.9] }) });
  ok(mixed.workspace === 'beta' && mixed.agent === null && mixed.model === tierModel(W.beta, 1), 'a follow-up keeps its own workspace, without another workspace\'s agent or model', JSON.stringify({ w: mixed.workspace, a: mixed.agent, m: mixed.model }));
  const same = await route('now do chapter 4', { recent: [], runs: rBeta, ask: jev({ earlier: ['r0', 0.9], pick: 'beta/editor' }) });
  ok(same.workspace === 'beta' && same.agent === 'editor', 'a follow-up keeps Jev\'s agent when it belongs there', JSON.stringify({ w: same.workspace, a: same.agent }));
}

// ── Jev slow or down ──
{
  await route('check the support inbox for Alpha', { recent: [], ask: jev() });
  ok(asked.opts?.fallback === false && asked.opts?.timeoutMs <= 20_000, 'routing asks Jev with a short timeout and no One fallback', JSON.stringify(asked.opts));
  const down = async () => { throw new Error('Jev 503'); };
  const h = async text => (await route(text, { recent: [], ask: down })).workspace;
  ok(await h('reply about the sample orders for chapter 2') === 'beta' && await h('send the invoices') === 'alpha', 'heuristic: tell-tale words still pick the client');
  ok(await h('authorize the typical Facebook notebook sync') === null, 'heuristic: words inside other words don\'t ("authorize", "typical", "Facebook")');
  const alphaOff = [{ ...W.alpha, enabled: false }, W.beta];
  ok((await route('Build one agent that triages email', { recent: [], ask: jev({ intent: 'build_agent', ws: 'beta', pick: 'beta/general' }), workspaces: alphaOff })).intent === 'build_agent', '"one agent" isn\'t the switched-off Alpha Studio');
  ok((await route('ask Acme Agent for the numbers', { recent: [], ask: jev() })).intent === 'ignored', 'a switched-off workspace Sam names is left alone');
}

// ── Orchy fixing himself (backend.mjs) ──
{
  const { fixRouting } = await import('../lib/router.mjs');
  const fix = { intent: 'fix_orchy', intentP: { fix_orchy: 0.92, task: 0.05, chat: 0.03 } };
  const r = await route('the Logs window in Orchy is blank, fix it', { recent: [], ask: jev(fix) });
  ok('fix_orchy' in asked.questions.intent.criteria, 'Jev is offered "fix Orchy" as an intent');
  ok(r.intent === 'fix_orchy' && r.workspace === 'orchy' && r.agent === null && r.model === 'opus', 'a fix goes to Orchy himself, no agent, a strong model', JSON.stringify({ i: r.intent, w: r.workspace, a: r.agent, m: r.model }));
  ok(r.needsChoice && r.holdReason === 'fix', 'a fix always waits for Sam’s go, however sure Jev is', JSON.stringify({ n: r.needsChoice, h: r.holdReason }));
  const named = await route('the Alpha pane in Orchy shows the wrong agent', { recent: [], ask: jev(fix) });
  ok(named.intent === 'fix_orchy' && named.workspace === 'orchy', 'naming a client inside a fix keeps it a fix');
  const backendRuns = [{ id: 'r_fix', session: 's1', startedAt: '2026-10-09T12:00:00Z', agentName: 'Orchy (fixing himself)', workspace: 'orchy', backend: true, instruction: 'Logs blank', status: 'done' }];
  const again = await route('still blank, try again', { recent: [], runs: backendRuns, ask: jev({ ...fix, earlier: ['r0', 0.9] }) });
  ok(again.earlierRun?.runId === 'r_fix', 'a follow-up to a fix continues it');
  const notFix = await route('still blank, try again', { recent: [], runs: runs.slice(0, 1), ask: jev({ ...fix, earlier: ['r0', 0.9] }) });
  ok(!notFix.earlierRun, 'a fix never continues a client’s run');
  const down = async () => { throw new Error('Jev down'); };
  ok((await route('Orchy’s dashboard is broken: the Logs button does nothing', { recent: [], ask: down })).intent === 'fix_orchy', 'Jev offline: Orchy named with something broken is a fix');
  ok(fixRouting('the dashboard crashes when I open this, fix it')?.intent === 'fix_orchy' && fixRouting('what does this contract say') === null, 'a screenshot with "fix" in it makes a fix card; other files go to Jev');
}

// ── files the owner attached: Jev routes them like any message ──
{
  const r = await route('give this to the support agent to add to the help center', { recent: [], files: ['faq.pdf', 'logo.png'], ask: jev() });
  ok(asked.state.files_owner_attached?.startsWith('faq.pdf, logo.png.') && r.intent === 'task' && r.agent === agent, 'Jev is told about the files, and work with them is a task card', asked.state.files_owner_attached);
  await route('check the support inbox for Alpha', { recent: [], ask: jev() });
  ok(!('files_owner_attached' in asked.state), 'no files, no files line');
}

// ── quick status answers ──
{
  ok(/^Nothing's running right now\./.test(quickStatus({ intent: 'status', statusAbout: { kind: 'running', confidence: 0.9 } })?.text || ''), 'running: answered from records (nothing live in a test)');
  const w = quickStatus({ intent: 'status', statusAbout: { kind: 'waiting', confidence: 0.9 } })?.text || '';
  ok(/^Nothing's waiting on you\.$|waiting on you: /.test(w), 'waiting: answered from the inbox', w);
  ok(quickStatus({ intent: 'status', statusAbout: { kind: 'running', confidence: 0.4 } }) === null, 'an unsure reading goes to Orchy');
  ok(quickStatus({ intent: 'status', statusAbout: { kind: 'other', confidence: 0.9 } }) === null, '"other" goes to Orchy');
  ok(quickStatus({ intent: 'chat', statusAbout: { kind: 'running', confidence: 0.9 } }) === null, 'only status questions');
  const done = Object.values(db().runs).find(r => r.endedAt && r.report?.summary);
  if (done) {
    const a = quickStatus({ intent: 'status', statusAbout: { kind: 'run', confidence: 0.9 }, earlierRun: { runId: done.id } });
    ok(a?.runId === done.id && /finished|trouble|stopped|blocked/.test(a.text) && a.text.includes(done.report.summary.slice(0, 30).replace(/\s+/g, ' ')), 'a run: its report, with a link to it', a?.text?.slice(0, 120));
  }
  ok(quickStatus({ intent: 'status', statusAbout: { kind: 'run', confidence: 0.9 } }) === null, 'a run question without a run Jev is sure of goes to Orchy');
}

// ── budget-aware routing (usagereview.mjs): a high week takes the cheaper tier on a close call only ──
{
  const tight = { line: 'Agent runs in the last 7 days: $900, 200% of a usual week ($450). Usage is running high.', pace: 2, tight: true };
  const calm = { line: 'Agent runs in the last 7 days: $400, 90% of a usual week ($450). Usage is within the usual range.', pace: 0.9, tight: false };
  const close = await route('draft the support reply for Alpha', { ask: jev({ effort: 1.55 }), budget: tight });
  ok(close.tier === 1 && close.budget?.leaned === true, 'high week: a score just over the top boundary takes the middle tier', JSON.stringify({ t: close.tier, b: close.budget }));
  ok(asked.state.usage_this_week === tight.line && /generalist is the cheaper fit/.test(asked.questions.agent.instructions), 'Jev is told the week, and to prefer the generalist for small asks');
  const clear = await route('draft the support reply for Alpha', { ask: jev({ effort: 1.9 }), budget: tight });
  ok(clear.tier === 2 && !clear.budget.leaned, 'high week: a clearly complex task keeps the top tier', JSON.stringify({ t: clear.tier }));
  const lowEdge = await route('check the support inbox for Alpha', { ask: jev({ effort: 0.65 }), budget: tight });
  ok(lowEdge.tier === 0, 'high week: just over the low boundary takes the cheapest tier', String(lowEdge.tier));
  const normal = await route('draft the support reply for Alpha', { ask: jev({ effort: 1.55 }), budget: calm });
  ok(normal.tier === 2 && !normal.budget.leaned && !/cheaper fit/.test(asked.questions.agent.instructions), 'usual week: no lean', JSON.stringify({ t: normal.tier }));
  const none = await route('draft the support reply for Alpha', { ask: jev({ effort: 1.55 }), budget: null });
  ok(none.tier === 2 && !('usage_this_week' in asked.state) && !('budget' in none), 'no history: no budget line, no lean');
}

// ── missions (missions.mjs): several agents of one workspace in a row; most messages stay tasks ──
{
  const team = [...AGENTS, { workspace: 'alpha', slug: 'designer', displayName: 'Designer', description: 'Makes PDFs and one-pagers' }, { workspace: 'alpha', slug: 'ops-head', displayName: 'Head of Ops', description: 'Runs ops', team: ['support'] }];
  const mj = (p, extra = {}) => jev({ intent: 'mission', intentP: { mission: p, task: 1 - p }, pick: 'alpha/general', ...extra });
  const two = 'Research the latest on AI agents for Alpha and make a short PDF report from it';
  const sure = await route(two, { recent: [], agents: team, ask: mj(0.82) });
  ok('mission' in asked.questions.intent.criteria && /not a mission when one agent/i.test(asked.questions.intent.criteria.mission), 'Jev is offered "mission", with "one agent can do it → not a mission"');
  ok(sure.intent === 'mission' && sure.workspace === 'alpha' && sure.agent === null && sure.missionSure && sure.missionP === 0.82 && !sure.needsChoice, 'a sure mission: its workspace, no agent, sure', JSON.stringify({ i: sure.intent, w: sure.workspace, s: sure.missionSure, n: sure.needsChoice }));
  const unsure = await route(two, { recent: [], agents: team, ask: mj(0.6) });
  ok(unsure.intent === 'mission' && !unsure.missionSure && unsure.holdReason === 'unsure', 'a mission Jev is less sure of: the card waits for Go', JSON.stringify({ i: unsure.intent, h: unsure.holdReason }));
  const weak = await route(two, { recent: [], agents: team, ask: mj(0.45) });
  ok(weak.intent === 'task', 'under 50%: a task');
  const single = await route('check the support inbox for Alpha', { recent: [], agents: team, ask: mj(0.8) });
  ok(single.intent === 'task', 'one piece of work stays a task even when Jev says mission (no "work in a row" in the words)');
  const named = await route('research AI agents for Alpha, then have the Designer make a PDF from it', { recent: [], agents: team, ask: mj(0.8) });
  ok(named.intent === 'mission', 'the owner names the agent for one part: still a mission (the planner gives it that step)');
  const namedTask = await route('have the Support Agent research AI agents for Alpha and make a PDF from it', { recent: [], agents: team, ask: jev({ pick: 'alpha/support' }) });
  ok(namedTask.intent === 'task' && namedTask.agent === 'support', 'the owner names one agent for all of it and Jev reads a task: a task for that agent');
  const head = await route(two, { recent: [], agents: team, ask: mj(0.8, { pick: 'alpha/ops-head' }) });
  ok(head.intent === 'task' && head.agent === 'ops-head', 'Jev’s pick is a head with a team: a task (it hands work on itself)', JSON.stringify({ i: head.intent, a: head.agent }));
  const headLater = await route('For Alpha: research the latest on AI agents this week, then have the Head of Ops turn it into a short PDF report.', { recent: [], agents: team, ask: mj(0.99, { pick: 'alpha/ops-head' }) });
  ok(headLater.intent === 'mission', 'the owner names the head only for a later step ("…then have the Head of Ops make the PDF"): still a mission', JSON.stringify({ i: headLater.intent, a: headLater.agent }));
  const headAll = await route('Have the Head of Ops research the latest on AI agents for Alpha, then turn it into a short PDF report.', { recent: [], agents: team, ask: mj(0.9, { pick: 'alpha/ops-head' }) });
  ok(headAll.intent === 'task' && headAll.agent === 'ops-head', 'the owner gives the head the whole ask: a task for the head (its team takes parts)', JSON.stringify({ i: headAll.intent, a: headAll.agent }));
  const e = earlierRuns(runs, 's1');
  const cont = await route('now research AI agents and make a PDF from it', { recent: [], runs: e, agents: team, ask: mj(0.8, { earlier: ['r0', 0.9] }) });
  ok(cont.intent === 'task' && cont.earlierRun?.runId === 'r_new', 'a follow-up to an earlier run stays a follow-up task');
  const jevTask = await route(two, { recent: [], agents: team, ask: jev({ pick: 'alpha/designer' }) });
  ok(jevTask.intent === 'task' && jevTask.agent === 'designer', 'Jev says task for a two-step ask: a task (Jev decides, the words only veto)');
  for (const t of ['draft a reply to the supplier and send it', 'write a blog post about agents for Alpha', 'summarise yesterday\'s payouts', 'what’s running?']) {
    const r = await route(t, { recent: [], agents: team, ask: mj(0.9) });
    ok(r.intent === 'task', `stays a task: "${t}"`, r.intent);
  }
  const noWs = await route('Research the latest on AI agents and make a short PDF report from it', { recent: [], agents: team, ask: mj(0.85, { ws: 'none' }) });
  ok(noWs.intent === 'mission' && noWs.workspace === 'alpha' && noWs.needsChoice, 'Jev reads no client: its agent’s workspace is offered, and the card waits', JSON.stringify({ w: noWs.workspace, n: noWs.needsChoice, h: noWs.holdReason }));
}

// ── models: an agent's own model is exact; tiers only for the generalist and agents without one ──
{
  const ws = W.alpha;
  const own = { workspace: 'alpha', slug: 'writer', model: 'haiku' };
  ok(ceilingTierModel(ws, own, 2) === 'haiku' && ceilingTierModel(ws, null, 2) === tierModel(ws, 2) && ceilingTierModel(ws, { model: 'inherit' }, 0) === tierModel(ws, 0), 'ceilingTierModel: the agent’s model exactly, else the tier');
  const routed = await route('draft the support reply for Alpha', { agents: [...AGENTS, { workspace: 'alpha', slug: 'writer', displayName: 'Writer', description: 'Writes', model: 'haiku' }], ask: jev({ effort: 1.9, pick: 'alpha/writer' }) });
  ok(routed.agent === 'writer' && routed.model === 'haiku', 'a routed task to an agent with a model runs on that model', JSON.stringify({ a: routed.agent, m: routed.model }));
  ok(unroutedModel(ws, null, 'what is the link to the deck?') === tierModel(ws, 0), 'unrouted: a short lookup takes the light tier');
  ok(unroutedModel(ws, null, 'Draft the reply to the supplier about the late order') === tierModel(ws, 1), 'unrouted: ordinary work takes the middle tier');
  ok(unroutedModel(ws, null, 'Write a comprehensive strategy for next year') === tierModel(ws, 2), 'unrouted: big strategy work takes the top tier');
  ok(unroutedModel(ws, null, 'Write a comprehensive strategy for next year', { isFollowUp: true }) === tierModel(ws, 1), 'unrouted: a follow-up never jumps to the top tier on its words alone');
  ok(unroutedModel(ws, own, 'Write a comprehensive strategy') === 'haiku' && unroutedModel(ws, { isBuilder: true }, 'x') === tierModel(ws, 2), 'unrouted: the agent’s own model wins; the builder works on the top tier');
  ok(unroutedModel(ws, null, 'check the inbox', { isScheduled: true }) === tierModel(ws, 0) && unroutedModel(ws, null, 'Prepare the weekly numbers', { isDelegated: true }) === tierModel(ws, 1), 'unrouted: schedules and hand-offs stay light or middle');
}

console.log(fail ? `\n${fail} failing` : '\nall pass');
process.exit(fail ? 1 : 0);
