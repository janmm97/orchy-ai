// Missions (missions.mjs) with everything outside faked: no runner, no Claude, no Jev, no state.json, no LOGS.md.
// Plan checks (cross-workspace, unknown agents, builder, client-shared, loops, order, limits, one-agent downgrade),
// the planner under the workspace's own account with one re-ask, the card (sure → countdown, else Go; edits), the
// supervisor (needs order, 2 live at most, inputs are summaries not transcripts), Orchy's check (one automatic fix
// only when nothing outward ran, at most 2 per mission), recovery through recover.mjs (a safe retry, else the owner's
// card: retry / give to another agent / skip / replan / stop), replan keeps done steps, the $15 ceiling pause,
// a restart (cut-off steps wait for Resume), stop, the end (Jev's objective read, one report, LOGS.md + TASK.md).
// Run: node orchestrator/scripts/test-missions.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as M from '../lib/missions.mjs';
import * as recover from '../lib/recover.mjs';
import { missionLogEntry } from '../lib/logs.mjs';
import { fixPrompt } from '../lib/validate.mjs';

let fail = 0;
const ok = (cond, label, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : `  ${extra}`}`); if (!cond) fail++; };

// ── a made-up setup ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchy-missions-'));
const profile = path.join(tmp, 'profile-acme');
const WS = {
  studio: { id: 'studio', name: 'Studio Workspace', client: 'Studio Co', blurb: 'The studio’s own work.', runtime: 'claude', enabled: true, claudeAccount: 'owner@example.com', claudeConfigDir: null, dir: tmp },
  acme: { id: 'acme', name: 'Acme Workspace', client: 'Acme Corp', blurb: 'Publishing.', runtime: 'claude', enabled: true, claudeAccount: 'ops@example.org', claudeConfigDir: profile, dir: tmp },
  noacct: { id: 'noacct', name: 'Northwind Workspace', client: 'Northwind', blurb: '', runtime: 'codex', enabled: true, claudeAccount: null, codexAccount: 'team@example.net', dir: tmp },
};
const AGENTS = [
  { workspace: 'studio', slug: 'chief-marketing-officer', displayName: 'Chief Marketing Officer', callName: 'Ada', description: 'Research, positioning, marketing.' },
  { workspace: 'studio', slug: 'creative-producer', displayName: 'Creative Producer', callName: 'Ben', description: 'Designs documents, PDFs, video.' },
  { workspace: 'studio', slug: 'web-search-manager', displayName: 'Web Search Manager', callName: 'Cleo', description: 'Searches the web.' },
  { workspace: 'studio', slug: 'agent-builder', displayName: 'AI Agent Builder', isBuilder: true, description: 'Builds agents.' },
  { workspace: 'studio', slug: 'client-helper', displayName: 'Client Helper', description: 'Shared with a client.' },
  { workspace: 'studio', slug: 'broken', displayName: 'Broken', description: 'x', error: 'bad frontmatter' },
  { workspace: 'studio', slug: 'blog-designer', displayName: 'Blog Designer', description: 'An agent on an engine with no account here', engine: 'other-engine' },
  { workspace: 'acme', slug: 'editor', displayName: 'Editor', description: 'Edits manuscripts.' },
];
const state = { runs: {}, missions: {}, settings: {} };
const events = [], said = [], started = [], stopped = [], thinkCalls = [], jevCalls = [], validateCalls = [], logs = [], tasks = [], fallbacks = [], opened = [];
let n = 0, clock = Date.parse('2026-10-17T15:00:00Z');
const timers = [];
const evts = {}, items = {}, arts = [];
let planReplies = [], verdicts = {}, jevAnswers = {}, failStart = null;
const live = new Set();

M.configure({
  db: () => state, save: () => {}, emit: (type, d) => events.push({ type, ...d }), id: p => `${p}_${++n}`, now: () => clock,
  setTimeout: (f, ms) => { const t = { f, ms, done: false }; timers.push(t); return t; }, clearTimeout: t => { if (t) t.done = true; },
  workspace: id => { if (!WS[id]) throw new Error('gone'); return WS[id]; },
  agents: wsId => AGENTS.filter(a => a.workspace === wsId), shared: () => new Set(['client-helper']), allAgents: () => AGENTS,
  engineOk: (_ws, engine) => engine === 'claude' || engine === 'codex', plannerReady: () => true,
  accountCheck: async (ws, o) => ({ ok: o?.runtime === 'claude' && !!ws.claudeAccount, actual: ws.claudeAccount }),
  think: async o => { thinkCalls.push(o); const r = planReplies.shift(); if (r instanceof Error) throw r; return { text: typeof r === 'string' ? r : JSON.stringify(r), costUsd: 0.02 }; },
  ask: async (st, q, o) => { jevCalls.push({ st, q, o }); const a = jevAnswers[o.purpose]; if (a instanceof Error) throw a; return { ms: 5, answers: a || {} }; },
  events: id => evts[id] || [], items: id => items[id] || [],
  validate: async (run, opts) => { validateCalls.push({ runId: run.id, ...opts }); const v = verdicts[run.id] || { verdict: 'ok', checks: [], at: new Date(clock).toISOString() }; run.validation = v; return v; },
  classify: run => recover.classify(run, { events: evts[run.id] || [], items: [] }),
  retryGate: run => recover.retryGate(run, { events: evts[run.id] || [], items: [], s: {} }),
  retryDelay: () => 30_000,
  artifactsFor: run => arts.filter(a => a.runIds.includes(run.id)),
  openTaskDir: (_ws, r) => (opened.push(r), `2026-10-17-${String(r.instruction).toLowerCase().split(/\W+/).slice(0, 3).join('-')}`),
  handFiles: (_ws, names) => names.map(x => `Uploads/${x}`),
  writeTask: (m, ws) => { tasks.push(m.id); return M.writeTask(m, ws); },
  appendLog: (m, ws) => logs.push(missionLogEntry(m, ws)),
  startRun: async opts => {
    if (failStart) { const e = failStart; failStart = null; throw e; }
    const run = { id: `run_${++n}`, ...opts, agentSlug: opts.agentSlug, status: 'working', startedAt: new Date(clock).toISOString(), sessionId: opts.resumeSessionId || `sess_${n}` };
    state.runs[run.id] = run; started.push(run); live.add(run.id);
    return run;
  },
  stopRun: id => { stopped.push(id); live.delete(id); }, isLive: id => live.has(id),
  say: (text, meta) => { said.push({ text, ...meta }); return { id: `m_${said.length}` }; },
  fallback: m => fallbacks.push(m),
  nameOf: () => null, log: () => {},
});

const step = (id, agent, task, needs = [], expects = []) => ({ id, agent, task, needs, expects, done_when: `${task} done` });
const PLAN = { objective: 'AI agent news report', done_when: 'A short PDF report is in the folder', steps: [
  step('s1', 'chief-marketing-officer', 'Research the latest AI agent launches', [], [{ kind: 'markdown', note: 'notes' }]),
  step('s2', 'creative-producer', 'Make a short PDF report from the research', ['s1'], [{ kind: 'pdf', note: 'report' }]),
] };
const end = async (run, { outcome = 'completed', report = { status: 'completed', summary: 'Did it.' }, cost = 0.5, error = null } = {}) => {
  Object.assign(run, { outcome, report, costUsd: cost, error, status: outcome === 'failed' ? 'failed' : 'done', endedAt: new Date(clock).toISOString() });
  live.delete(run.id);
  return M.onRunEnded(run);
};
const fire = async () => { const t = timers.filter(x => !x.done); for (const x of t) { x.done = true; await x.f(); } await new Promise(r => setTimeout(r, 0)); };
const lastStarted = () => started.at(-1);
const R = M.roster(WS.studio);

// ── who can take a step ──
{
  const slugs = R.map(a => a.slug);
  ok(slugs[0] === 'general' && slugs.includes('chief-marketing-officer') && slugs.includes('creative-producer'), 'roster: the generalist and the workspace’s agents');
  ok(!slugs.includes('agent-builder') && !slugs.includes('client-helper') && !slugs.includes('broken') && !slugs.includes('blog-designer') && !slugs.includes('editor'), 'roster: no builder, client-shared, broken, engine-without-account or other workspace’s agent', slugs.join());
}

// ── the plan, checked ──
{
  const v = M.validatePlan(PLAN, { ws: WS.studio, others: AGENTS });
  ok(v.ok && v.plan.steps.length === 2 && v.plan.steps[1].needs[0] === 's1' && v.plan.steps[1].expects[0].kind === 'pdf', 'a good plan passes');
  const cross = M.validatePlan({ steps: [step('s1', 'chief-marketing-officer', 'a'), step('s2', 'editor', 'b', ['s1'])] }, { ws: WS.studio, others: AGENTS });
  ok(!cross.ok && cross.errors.some(e => /acme's agent, not Studio Workspace's/.test(e)), 'another workspace’s agent is refused', cross.errors.join(' | '));
  const crossSlash = M.validatePlan({ steps: [step('s1', 'chief-marketing-officer', 'a'), step('s2', 'acme/editor', 'b', ['s1'])] }, { ws: WS.studio, others: AGENTS });
  ok(!crossSlash.ok && crossSlash.errors.some(e => /another workspace/.test(e)), '"acme/editor" is refused too');
  const unknown = M.validatePlan({ steps: [step('s1', 'nobody', 'a'), step('s2', 'creative-producer', 'b', ['s1'])] }, { ws: WS.studio, others: AGENTS });
  ok(!unknown.ok && unknown.errors.some(e => /no agent "nobody"/.test(e)), 'an unknown agent is refused');
  const builder = M.validatePlan({ steps: [step('s1', 'agent-builder', 'a'), step('s2', 'creative-producer', 'b', ['s1'])] }, { ws: WS.studio, others: AGENTS });
  ok(!builder.ok && builder.errors.some(e => /Builder builds agents/.test(e)), 'the AI Agent Builder is refused');
  const shared = M.validatePlan({ steps: [step('s1', 'client-helper', 'a'), step('s2', 'creative-producer', 'b', ['s1'])] }, { ws: WS.studio, others: AGENTS });
  ok(!shared.ok && shared.errors.some(e => /clients/.test(e)), 'a client-shared agent is refused');
  const engineless = M.validatePlan({ steps: [step('s1', 'blog-designer', 'a'), step('s2', 'creative-producer', 'b', ['s1'])] }, { ws: WS.studio, others: AGENTS });
  ok(!engineless.ok && engineless.errors.some(e => /no account for its engine/.test(e)), 'an agent on an engine the workspace can’t run is refused');
  const loop = M.validatePlan({ steps: [step('a', 'chief-marketing-officer', 'x', ['b']), step('b', 'creative-producer', 'y', ['a'])] }, { ws: WS.studio, others: AGENTS });
  ok(!loop.ok && loop.errors.some(e => /loop/.test(e)), 'a loop is refused', loop.errors.join(' | '));
  const order = M.validatePlan({ steps: [step('a', 'chief-marketing-officer', 'x', ['b']), step('b', 'creative-producer', 'y')] }, { ws: WS.studio, others: AGENTS });
  ok(!order.ok && order.errors.some(e => /comes later/.test(e)), 'a step that needs a later one is refused');
  const self = M.validatePlan({ steps: [step('a', 'chief-marketing-officer', 'x', ['a']), step('b', 'creative-producer', 'y', ['a'])] }, { ws: WS.studio, others: AGENTS });
  ok(!self.ok && self.errors.some(e => /needs itself/.test(e)), 'a step that needs itself is refused');
  const ghost = M.validatePlan({ steps: [step('a', 'chief-marketing-officer', 'x'), step('b', 'creative-producer', 'y', ['zz'])] }, { ws: WS.studio, others: AGENTS });
  ok(!ghost.ok && ghost.errors.some(e => /isn't a step/.test(e)), 'needs that name no step are refused');
  const seven = M.validatePlan({ steps: Array.from({ length: 7 }, (_, i) => step(`s${i + 1}`, i % 2 ? 'creative-producer' : 'chief-marketing-officer', 't')) }, { ws: WS.studio, others: AGENTS });
  ok(!seven.ok && seven.errors.some(e => /at most 6/.test(e)), 'more than 6 steps is refused');
  const one = M.validatePlan({ steps: [step('s1', 'creative-producer', 'all of it')] }, { ws: WS.studio, others: AGENTS });
  ok(!one.ok && one.single && !one.errors.length, 'a single step is downgraded to a task (not an error)');
  const same = M.validatePlan({ steps: [step('s1', 'creative-producer', 'a'), step('s2', 'creative-producer', 'b', ['s1'])] }, { ws: WS.studio, others: AGENTS });
  ok(same.single, 'one agent for every step is downgraded too');
  const dup = M.validatePlan({ steps: [step('s1', 'chief-marketing-officer', 'a'), step('s1', 'creative-producer', 'b')] }, { ws: WS.studio, others: AGENTS });
  ok(!dup.ok && dup.errors.some(e => /two steps are called/.test(e)), 'duplicate step ids are refused');
  const gen = M.validatePlan({ steps: [step('s1', 'generalist', 'a'), step('s2', 'creative-producer', 'b', ['s1'], ['md', { kind: 'nonsense' }])] }, { ws: WS.studio, others: AGENTS });
  ok(gen.ok && gen.plan.steps[0].agent === 'general' && gen.plan.steps[1].expects.length === 1 && gen.plan.steps[1].expects[0].kind === 'markdown', '"generalist" is the generalist; file kinds are normalised, junk kinds dropped');
  ok(M.parseJSON('```json\n{"a":1}\n```').a === 1 && M.parseJSON('nope') === null, 'the planner’s JSON is read with or without a fence');
}

// ── the planner: the workspace's own account, one re-ask ──
{
  thinkCalls.length = 0;
  planReplies = [{ steps: [step('a', 'chief-marketing-officer', 'x', ['b']), step('b', 'creative-producer', 'y', ['a'])] }, '```json\n' + JSON.stringify(PLAN) + '\n```'];
  const r = await M.plan({ ws: WS.studio, text: 'Research AI agents and make a PDF report' });
  ok(r.ok && r.attempts === 2 && !r.firstTry && r.plan.steps.length === 2, 'a refused plan is asked again once with its errors, then passes', JSON.stringify({ ok: r.ok, a: r.attempts }));
  ok(/YOUR LAST PLAN WAS REFUSED: .*loop/.test(thinkCalls[1].prompt), 'the re-ask names what was wrong');
  const c = thinkCalls[0];
  ok(c.purpose === 'mission-plan' && c.workspace === 'studio' && c.tools === '' && c.model === 'sonnet' && c.configDir === null && /orchy-mission/.test(c.cwd), 'planner: tool-less Sonnet, purpose mission-plan, the workspace’s account, a neutral folder', JSON.stringify({ p: c.purpose, w: c.workspace, m: c.model, d: c.configDir }));
  ok(!/editor|acme/i.test(c.prompt.split('ROSTER')[1]) && /creative-producer/.test(c.prompt), 'the roster in the prompt is this workspace’s only');
  thinkCalls.length = 0;
  planReplies = [{}, {}];
  await M.plan({ ws: WS.acme, text: 'x' });
  ok(thinkCalls[0]?.configDir === profile, 'another workspace’s mission plans under that workspace’s own profile', thinkCalls[0]?.configDir);
  thinkCalls.length = 0;
  const none = await M.plan({ ws: WS.noacct, text: 'x' });
  ok(!none.ok && none.noAccount && !thinkCalls.length && /no Claude Code account of its own/.test(none.why), 'no Claude Code account of its own: no planner call, no mission (never the root account)');
  planReplies = ['not json', { steps: [] }];
  const bad = await M.plan({ ws: WS.studio, text: 'x' });
  ok(!bad.ok && bad.attempts === 2 && bad.cost > 0, 'refused twice: no mission (cost still counted)');
  planReplies = [new Error('timed out')];
  const thrown = await M.plan({ ws: WS.studio, text: 'x' });
  ok(!thrown.ok && /planner failed/.test(thrown.why), 'a planner that fails: no mission');
}

// ── a sure mission: card, countdown, steps in order, inputs, the automatic fix, the end ──
{
  said.length = 0; started.length = 0;
  planReplies = [PLAN];
  const m = M.propose({ text: 'Research the latest on AI agents and make a short PDF report', workspace: 'studio', session: 's1', routing: { missionP: 0.82, missionSure: true }, files: ['brief.pdf'] });
  ok(m.status === 'planning' && said[0].kind === 'mission' && said[0].missionId === m.id && events.some(e => e.type === 'mission.created'), 'propose: a planning card in the session');
  await M.whenPlanned(m.id);
  ok(m.status === 'planned' && m.sure && m.startAt && m.steps.length === 2 && m.cost === 0.02, 'planned, sure (plan passed first try): the countdown is armed', JSON.stringify({ s: m.status, sure: m.sure, at: m.startAt }));
  ok(events.some(e => e.type === 'mission.updated' && e.mission.id === m.id && e.mission.status === 'planned') && !('timer' in events.at(-1).mission), 'mission.updated carries the whole mission');
  ok(!started.length, 'nothing runs during the countdown');
  await fire();
  ok(m.status === 'running' && m.autoStarted && m.taskDir && started.length === 1 && lastStarted().stepId === 's1' && lastStarted().missionId === m.id && lastStarted().taskDir === m.taskDir, 'the countdown starts it: only the step with no needs, in the shared folder', JSON.stringify({ s: m.status, n: started.length }));
  ok(opened.length === 1 && opened[0].instruction === 'AI agent news report' && opened[0].client === null, 'one shared folder, named after the objective, never a client’s');
  const r1 = lastStarted();
  ok(r1.agentSlug === 'chief-marketing-officer' && r1.kind === 'task' && r1.session === 's1' && /attached: Uploads\/brief\.pdf/.test(r1.instruction) && /Tasks\/2026-10-17-ai-agent-news\//.test(r1.instruction) && r1.routing.source === 'mission', 'a step is an ordinary task run with the owner’s files and the folder');
  evts[r1.id] = [{ kind: 'text', text: 'SECRET TRANSCRIPT LINE' }, { kind: 'tool', tool: 'WebSearch' }, { kind: 'tool', tool: 'Write', input: { file_path: 'x' } }];
  arts.push({ id: 'a1', rel: `Tasks/${m.taskDir}/notes.md`, runIds: [r1.id], status: 'final', updatedAt: new Date(clock).toISOString() });
  await end(r1, { report: { status: 'completed', summary: 'Found 5 launches.', result: 'R'.repeat(5000) }, cost: 1.2 });
  ok(m.steps[0].status === 'done' && m.steps[0].files.includes(`Tasks/${m.taskDir}/notes.md`), 'step 1 checked ok → done, its files kept');
  ok(validateCalls.at(-1).semantic === true && validateCalls.at(-1).expects[0].kind === 'markdown', 'the check runs with the step’s expected files and Jev’s read on (missions)');
  const r2 = lastStarted();
  ok(r2.stepId === 's2' && started.length === 2, 'step 2 starts once step 1 is done');
  ok(/Inputs from earlier steps/.test(r2.instruction) && /Found 5 launches/.test(r2.instruction) && /notes\.md/.test(r2.instruction) && !/SECRET TRANSCRIPT/.test(r2.instruction), 'step 2 gets step 1’s summary, result and files, never its transcript');
  ok((r2.instruction.match(/R+/g) || []).every(x => x.length < 3000), 'a predecessor’s result is trimmed to ~3k');
  // the PDF step forgot the file, and only wrote locally: one automatic fix in its own session
  evts[r2.id] = [{ kind: 'tool', tool: 'Read' }, { kind: 'tool', tool: 'Write', input: { file_path: 'report.html' } }, { kind: 'tool', tool: 'Bash', input: { command: 'node make-pdf.mjs' } }];
  verdicts[r2.id] = { verdict: 'failed', checks: [{ name: 'Expected files', ok: false, level: 'fail', note: 'No pdf (report) from this step' }], at: 'x' };
  await end(r2, { cost: 0.8 });
  const fix = lastStarted();
  ok(m.steps[1].status === 'fixing' && fix.resumeSessionId === r2.sessionId && fix.parentRunId === r2.id && fix.instruction === fixPrompt(verdicts[r2.id]) && m.autoFixes === 1, 'a failed check with nothing outward → one automatic "fix only that" follow-up in its session', JSON.stringify({ st: m.steps[1].status, a: m.autoFixes }));
  arts.push({ id: 'a2', rel: `Tasks/${m.taskDir}/report.pdf`, runIds: [fix.id], status: 'final', updatedAt: new Date(clock).toISOString() });
  jevAnswers['mission-check'] = { met: { noul: 0.86 } };
  await end(fix, { cost: 0.4 });
  ok(m.status === 'done' && m.result.met === 0.86 && started.length === 3, 'fixed → done; all steps done → Jev reads the objective as met; nothing beyond the plan', JSON.stringify({ s: m.status, n: started.length }));
  ok(m.cost === 2.42 && m.costs.plan === 0.02 && m.costs.steps === 2.4, 'cost = plan + every step run', JSON.stringify(m.costs));
  const rep = said.filter(x => x.kind === 'mission-report');
  ok(rep.length === 1 && /Mission done in Studio Workspace/.test(rep[0].text) && /2 files/.test(rep[0].text), 'Orchy reports once, with the files', rep.map(x => x.text).join(' | '));
  ok(logs.length === 1 && /Mission done · Studio Workspace · Mission: AI agent news report/.test(logs[0]) && logs[0].includes(r1.id) && logs[0].includes(fix.id) && /1 automatic fix/.test(logs[0]), 'one LOGS.md entry linking every run');
  const taskMd = fs.readFileSync(path.join(tmp, 'Tasks', m.taskDir, 'TASK.md'), 'utf8');
  ok(tasks.includes(m.id) && /# Mission · AI agent news report/.test(taskMd) && /## Step 2 · Ben, Creative Producer · Done/.test(taskMd) && /report\.pdf/.test(taskMd), 'TASK.md in the shared folder covers every step');
  ok(said.filter(x => x.kind !== 'mission' && x.kind !== 'mission-report').length === 0, 'steps are muted: no per-step reports in the chat');
  ok(await M.onRunEnded(r1) === false && m.status === 'done', 'a run of a settled step is ignored');
}

// ── not sure: waits for Go; edits; Go ──
{
  started.length = 0;
  planReplies = [PLAN];
  const m = M.propose({ text: 'Research AI agents, then make a PDF', workspace: 'studio', session: 's2', routing: { missionP: 0.6, missionSure: false } });
  await M.whenPlanned(m.id);
  ok(m.status === 'planned' && !m.sure && !m.startAt, 'Jev not sure: the card waits for Go (no countdown)');
  planReplies = [{ steps: [step('a', 'chief-marketing-officer', 'x', ['b']), step('b', 'creative-producer', 'y', ['a'])] }, PLAN];
  const m2 = M.propose({ text: 'Research AI agents, then make a PDF', workspace: 'studio', session: 's2', routing: { missionP: 0.9, missionSure: true } });
  await M.whenPlanned(m2.id);
  ok(m2.status === 'planned' && !m2.sure && !m2.startAt, 'Jev sure but the plan failed validation once: waits for Go');
  M.patch(m.id, { steps: [{ id: 's1', task: 'Research only this week’s AI agent launches' }, { id: 's2', agent: 'general' }] });
  ok(m.steps[0].task.startsWith('Research only') && m.steps[1].agent === 'general' && m.held, 'the owner edits a step’s words and swaps an agent');
  let err = null;
  try { M.patch(m.id, { steps: [{ id: 's2', agent: 'editor' }] }); } catch (e) { err = e; }
  ok(err?.status === 400 && /acme/.test(err.message), 'swapping in another workspace’s agent is refused', err?.message);
  err = null;
  try { M.patch(m.id, { steps: [{ id: 's1', remove: true }] }); } catch (e) { err = e; }
  ok(err?.single && m.steps.length === 2, 'removing down to one step is refused (send it as a task instead)');
  err = null;
  try { await M.act(m.id, { action: 'accept' }); } catch (e) { err = e; }
  ok(err?.status === 409, 'an answer while the card waits for Go is refused');
  await M.act(m.id, { action: 'go' });
  ok(m.status === 'running' && started.length === 1, 'Go starts it');
  err = null;
  try { M.patch(m.id, { steps: [] }); } catch (e) { err = e; }
  ok(err?.status === 409, 'a running mission can’t be edited');
  M.stop(m.id);
  ok(m.status === 'stopped' && stopped.includes(started[0].id) && state.runs[started[0].id].quietReport, 'Stop stops its live steps quietly');
  ok(said.filter(x => x.missionId === m.id && x.kind === 'mission-report').length === 1, 'a stopped mission reports once');
  await M.act(m2.id, { action: 'as-task' });
  ok(m2.status === 'fallback' && fallbacks.at(-1) === m2, '"Send as a task" turns the card into a task card');
}

// ── the downgrade: one agent can do it ──
{
  planReplies = [{ steps: [step('s1', 'creative-producer', 'Make the PDF')] }];
  const m = M.propose({ text: 'Make a PDF and then a PNG', workspace: 'studio', session: 's3', routing: { missionP: 0.75, missionSure: true } });
  await M.whenPlanned(m.id);
  ok(m.status === 'fallback' && m.fallback.single && m.fallback.agent === 'creative-producer' && fallbacks.at(-1) === m, 'a one-step plan falls back to a task card with that agent');
  const noAcct = M.propose({ text: 'Research then PDF', workspace: 'noacct', session: 's3', routing: { missionSure: true } });
  await M.whenPlanned(noAcct.id);
  ok(noAcct.status === 'fallback' && /no Claude Code account/.test(noAcct.fallback.why) && fallbacks.at(-1) === noAcct, 'a workspace with no planner account of its own: a task card, no mission');
  let err = null;
  WS.studio.enabled = false;
  try { M.propose({ text: 'x', workspace: 'studio', session: 's3' }); } catch (e) { err = e; }
  WS.studio.enabled = true;
  ok(err?.status === 409, 'a switched-off workspace gets no mission');
}

// ── parallel cap, outward steps, failures, recovery, replan, ceiling ──
const PAR = { objective: 'Three sources, one brief', steps: [
  step('s1', 'chief-marketing-officer', 'Read source A'), step('s2', 'web-search-manager', 'Read source B'), step('s3', 'general', 'Read source C'),
  step('s4', 'creative-producer', 'Write the brief', ['s1', 's2', 's3'], [{ kind: 'document' }]),
] };
{
  started.length = 0;
  planReplies = [PAR];
  const m = M.propose({ text: 'Read A, B and C, then write a brief from them', workspace: 'studio', session: 's4', routing: { missionSure: false } });
  await M.whenPlanned(m.id);
  await M.go(m.id);
  ok(started.length === 2 && m.steps.filter(s => s.status === 'running').length === 2 && m.steps[2].status === 'pending', 'at most 2 live steps per mission (the third waits)');
  const [a, b] = started;
  // A: did something outward (a One send) and then failed its check → no automatic fix, the owner decides
  evts[a.id] = [{ kind: 'tool', tool: 'Bash', input: { command: 'one --agent actions execute gmail conn_x key -d {}' }, summary: 'Running Send Email on gmail' }];
  verdicts[a.id] = { verdict: 'check', checks: [{ name: 'Report', ok: false, level: 'warn', note: 'Finished without a report' }], at: 'x' };
  await end(a);
  ok(m.steps[0].status === 'waiting' && m.ask?.kind === 'check' && /outward/.test(m.ask.text) && m.ask.options.map(o => o.action).join() === 'accept,followup,skip,stop' && m.autoFixes === 0, 'a step that did something outward gets no automatic fix: Accept / Follow up / Skip / Stop', m.ask?.text);
  ok(started.length === 3 && started[2].stepId === 's3', 'an independent step still starts while the owner decides');
  let err = null;
  try { await M.act(m.id, { action: 'raise' }); } catch (e) { err = e; }
  ok(err?.status === 400, 'a choice the open ask doesn’t offer is refused');
  await M.act(m.id, { action: 'accept' });
  ok(m.steps[0].status === 'done' && m.steps[0].accepted && !m.ask, 'Accept as is → done');
  // B: overloaded before doing anything → a safe retry through recover.mjs
  evts[b.id] = [{ kind: 'tool', tool: 'WebSearch' }];
  await end(b, { outcome: 'failed', report: null, error: 'API Error: 529 overloaded_error' });
  ok(m.steps[1].status === 'retrying' && m.steps[1].attempts.retries === 1 && !m.ask, 'overloaded before anything but reads → retried on its own (recover.classify + retryGate)');
  await fire();
  const b2 = lastStarted();
  ok(b2.stepId === 's2' && b2.retryOf === b.id && m.steps[1].status === 'running', 'the retry is a fresh run with retryOf');
  // B again: crashed after writing → the owner's failure card
  evts[b2.id] = [{ kind: 'tool', tool: 'Write', input: { file_path: 'b.md' } }];
  await end(b2, { outcome: 'failed', report: null, error: 'claude exited with code 1' });
  ok(m.ask?.kind === 'failed' && m.ask.options.map(o => o.action).join() === 'retry,reassign,skip,replan,stop', 'a crash after a write → Retry / Give to another agent / Skip / Replan / Stop', m.ask?.options?.map(o => o.action).join());
  jevAnswers['mission-reassign'] = { agent: { choice: 'general', confidence: 0.7 } };
  await M.act(m.id, { action: 'reassign' });
  ok(m.ask?.suggest?.agent === 'general' && jevCalls.at(-1).o.purpose === 'mission-reassign' && !jevCalls.at(-1).q.agent.criteria['web-search-manager'], 'Give to another agent: Jev suggests one (not the same), the owner confirms');
  err = null;
  try { await M.act(m.id, { action: 'reassign', agent: 'editor' }); } catch (e) { err = e; }
  ok(err?.status === 400, 'another workspace’s agent can’t take the step');
  await M.act(m.id, { action: 'reassign', agent: 'creative-producer' });
  const b3 = lastStarted();
  ok(b3.stepId === 's2' && b3.agentSlug === 'creative-producer' && m.steps[1].agent === 'creative-producer', 'confirmed: the step starts again with the other agent');
  err = null;
  try { await M.act(m.id, { action: 'skip' }); } catch (e) { err = e; }
  ok(err?.status === 409, 'no open ask: an answer is refused');
  // C fails as blocked → replan keeps the done step
  const c = started.find(r => r.stepId === 's3');
  await end(c, { outcome: 'blocked', report: { status: 'blocked', summary: 'Source C needs a login' } });
  ok(m.ask?.kind === 'failed' && /blocked/.test(m.ask.text), 'a blocked step → the owner’s card');
  planReplies = [{ steps: [step('s5', 'web-search-manager', 'Find a public copy of source C'), step('s6', 'creative-producer', 'Write the brief', ['s1', 's5'], [{ kind: 'document' }])] }];
  thinkCalls.length = 0;
  await M.act(m.id, { action: 'replan' });
  ok(thinkCalls[0]?.purpose === 'mission-replan' && /ALREADY DONE[\s\S]*s1 · chief-marketing-officer/.test(thinkCalls[0].prompt), 'Replan: the planner gets the done steps frozen');
  ok(m.ask?.kind === 'replan' && m.replan.steps.length === 2, 'the new tail waits for the owner’s OK');
  const doneBefore = JSON.stringify(m.steps[0]);
  await M.act(m.id, { action: 'use-replan' });
  ok(JSON.stringify(m.steps[0]) === doneBefore && m.steps.map(s => s.id).join() === 's1,s5,s6' && stopped.includes(b3.id), 'Use the new plan: done steps kept as they were, live ones stopped, the tail replaced', m.steps.map(s => s.id).join());
  const s5 = lastStarted();
  ok(s5.stepId === 's5', 'the new tail starts where its needs are met');
  // the ceiling: a $16 step pauses the mission before the next one
  await end(s5, { cost: 16 });
  ok(m.ask?.kind === 'ceiling' && m.status === 'waiting' && !started.some(r => r.stepId === 's6'), 'past the $15 ceiling: paused and asked before the next step', JSON.stringify({ k: m.ask?.kind, c: m.cost }));
  await M.act(m.id, { action: 'raise' });
  ok(m.ceiling === 30 && lastStarted().stepId === 's6', 'Raise the ceiling → it goes on');
  M.stop(m.id);
}

// ── at most 2 automatic fixes per mission ──
{
  started.length = 0;
  planReplies = [PLAN];
  const m = M.propose({ text: 'Research then PDF', workspace: 'studio', session: 's5', routing: {} });
  await M.whenPlanned(m.id);
  await M.go(m.id);
  m.autoFixes = 2;
  const r = lastStarted();
  verdicts[r.id] = { verdict: 'check', checks: [{ name: 'Files it names', ok: false, level: 'warn', note: 'notes.md is missing' }], at: 'x' };
  await end(r);
  ok(m.ask?.kind === 'check' && /used its automatic fixes/.test(m.ask.text) && started.length === 1, 'the mission’s 2 automatic fixes are used up: the owner decides');
  let err = null;
  try { await M.act(m.id, { action: 'followup', text: '  ' }); } catch (e) { err = e; }
  ok(err?.status === 400, 'Follow up needs words');
  await M.act(m.id, { action: 'followup', text: 'Save the notes as notes.md' });
  const fu = lastStarted();
  ok(fu.instruction === 'Save the notes as notes.md' && fu.resumeSessionId === r.sessionId, 'Follow up sends the owner’s words into the step’s session');
  M.stop(m.id);
}

// ── a step that can't start (account check, switched off) ──
{
  started.length = 0;
  planReplies = [PLAN];
  const m = M.propose({ text: 'Research then PDF', workspace: 'studio', session: 's6', routing: {} });
  await M.whenPlanned(m.id);
  failStart = Object.assign(new Error('Studio Workspace must run as owner@example.com, but its profile is logged in as someone else'), { status: 409 });
  await M.go(m.id);
  ok(m.ask?.kind === 'failed' && /logged in as someone else/.test(m.ask.text) && m.steps[0].status === 'waiting', 'startRun’s account check refuses → the owner’s card, nothing bypasses it');
  M.stop(m.id);
}

// ── a restart ──
{
  started.length = 0;
  planReplies = [PLAN, PLAN, PLAN];
  const running = M.propose({ text: 'Research then PDF', workspace: 'studio', session: 's7', routing: {} });
  await M.whenPlanned(running.id);
  await M.go(running.id);
  const cut = lastStarted();
  const counting = M.propose({ text: 'Research then PDF', workspace: 'studio', session: 's7', routing: { missionSure: true } });
  await M.whenPlanned(counting.id);
  const planningM = M.propose({ text: 'Research then PDF', workspace: 'studio', session: 's7', routing: {} });
  ok(planningM.status === 'planning' && counting.startAt, 'setup: one running, one counting down, one still planning');
  M.boot();
  ok(running.status === 'waiting' && running.steps[0].status === 'interrupted' && running.ask?.kind === 'restart' && running.ask.options.map(o => o.action).join() === 'resume,stop', 'restart mid-mission: cut-off steps wait, the owner gets Resume / Stop');
  ok(!counting.startAt && counting.held && counting.status === 'planned', 'a counting-down card waits for Go after a restart');
  ok(planningM.status === 'stopped', 'a mission still planning is stopped (send it again)');
  const before = started.length;
  await M.tick(running);
  ok(started.length === before, 'nothing starts on its own while the restart ask is open');
  await M.act(running.id, { action: 'resume' });
  const res = lastStarted();
  ok(res.stepId === 's1' && res.resumeSessionId === cut.sessionId && res.instruction === recover.RESUME_TEXT && running.status === 'running', 'Resume picks the cut-off step up in its own conversation');
  M.stop(running.id); M.stop(counting.id);
  await M.whenPlanned(planningM.id);
  ok(planningM.status === 'stopped', 'a plan landing after a restart doesn’t revive a stopped mission');
}

// ── the switch-off fence mid-mission, and outwardSteps ──
{
  started.length = 0;
  planReplies = [PLAN];
  const m = M.propose({ text: 'Research then PDF', workspace: 'studio', session: 's8', routing: {} });
  await M.whenPlanned(m.id);
  await M.go(m.id);
  WS.studio.enabled = false;
  await end(lastStarted());
  ok(m.ask?.kind === 'off' && started.length === 1, 'workspace switched off mid-mission: no next step, the owner is told');
  await M.tick(m);
  ok([m.ask, ...m.asks].filter(x => x?.kind === 'off').length === 1, 'told once, not on every tick');
  WS.studio.enabled = true;
  M.stop(m.id);
  const O = M.outwardSteps;
  ok(!O([{ kind: 'tool', tool: 'Read' }, { kind: 'tool', tool: 'Write' }, { kind: 'tool', tool: 'Bash', input: { command: 'node make-pdf.mjs' } }, { kind: 'tool', tool: 'mcp__exa__web_search_exa' }, { kind: 'tool', tool: 'Bash', input: { command: 'one --agent actions find gmail "send"' } }]).length, 'outward: reads, file writes, local scripts, search tools and One lookups aren’t');
  ok(O([{ kind: 'tool', tool: 'Bash', input: { command: 'one --agent actions execute slack conn key -d {}' } }]).length === 1 && O([{ kind: 'tool', tool: 'mcp__slack__send_message' }]).length === 1 && O([{ kind: 'tool', tool: 'Bash', input: { command: 'curl -X POST https://hooks.example.com' } }]).length === 1, 'outward: One executes, writing MCP tools, network commands are');
  ok(O([], [{ kind: 'approval', title: 'Send email' }]).length === 1 && O([], [], { subRuns: ['r'] }).length === 1, 'outward: an approval the owner was asked, or a hand-off, counts');
}

// ── settings ──
{
  const s = M.missionSettings({});
  ok(s.autoStart && s.ceiling === 15 && s.maxLive === 2 && s.jev && s.maxMin === 0, 'defaults: start when sure, $15, 2 live, Jev reads steps, no time cap');
  ok(!M.missionSettings({ autoDispatch: false }).autoStart && !M.missionSettings({ missionAutoStart: false }).autoStart && M.missionSettings({ missionMaxLive: 9 }).maxLive === 3, 'auto-dispatch off or the mission switch off → waits for Go; at most 3 live');
  ok(M.ACTIONS.includes('go') && M.ACTIONS.includes('use-replan') && !M.ACTIONS.includes('delete'), 'the card’s answers are a fixed list');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n${fail} FAILED` : '\nall mission checks passed');
process.exit(fail ? 1 : 0);
