// Offline checks for validate.mjs (Orchy's deterministic check of a finished run, the optional Jev read with Jev
// faked, the "Orchy is checking" step) and recover.mjs (failure classes from recorded error shapes, the retry gate
// that refuses after any side-effect step, the auto-retry schedule, the owner's cards, the stall flag). Ends with real
// runs through the real runner in a disposable copy (a fake engine): an overloaded API before any tool → one
// automatic retry with retryOf → validated; and a retry the account check refuses (the workspace's account changed)
// → a card for the owner, never another account. No model calls, no harness. Run: node orchestrator/scripts/test-validate.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../lib/env.mjs';
import * as V from '../lib/validate.mjs';
import * as R from '../lib/recover.mjs';

const ok = name => console.log(`ok - ${name}`);
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orchy-validate-test-')));
const wsDir = path.join(tmp, 'Test Workspace');
fs.mkdirSync(path.join(wsDir, 'Tasks', '2026-10-17-recap', 'files'), { recursive: true });
fs.mkdirSync(path.join(wsDir, 'marketing', 'd4a'), { recursive: true });
fs.mkdirSync(path.join(wsDir, '.clients', 'acme', 'Tasks', 't1'), { recursive: true });
fs.mkdirSync(path.join(wsDir, '.claude', 'agents'), { recursive: true });
const put = (rel, s = 'x') => fs.writeFileSync(path.join(wsDir, ...rel.split('/')), s);
put('Tasks/2026-10-17-recap/recap.md'); put('marketing/d4a/sheet-01.png'); put('marketing/d4a/sheet-02.png');
put('.claude/agents/researcher.md'); put('.clients/acme/Tasks/t1/brief.pdf'); put('report.pdf');
const ws = { id: 'test', name: 'Test Workspace', dir: wsDir };
const T = (tool, input = {}, extra = {}) => ({ kind: 'tool', tool, toolUseId: extra.id || `t${Math.random().toString(36).slice(2, 8)}`, summary: extra.summary || '', input });
const done = (e, o = {}) => ({ kind: 'tool_done', toolUseId: e.toolUseId, tool: e.tool, ok: true, brief: 'ok', ...o });
const err = (e, text = 'Exit code 1') => ({ kind: 'tool_error', toolUseId: e.toolUseId, tool: e.tool, text });
const rep = (status = 'completed', more = {}) => ({ status, summary: 'Done.', actions_taken: [], outputs: [], follow_ups: [], ...more });
const runOf = (o = {}) => ({ id: 'run_x', workspace: 'test', instruction: 'Do the thing', outcome: 'completed', status: 'done', taskDir: '2026-10-17-recap', report: rep(), ...o });
const check = (v, name) => v.checks.find(c => c.name === name);
// an absolute path in the workspace, written the way an agent on this OS would
const absIn = rel => path.join(wsDir, ...rel.split('/'));

try {
  // ── 1. which runs get checked ──
  assert.equal(V.shouldValidate(runOf(), {}), true);
  assert.equal(V.shouldValidate(runOf({ client: 'acme' }), {}), false, 'a client’s own run');
  assert.equal(V.shouldValidate(runOf({ client: 'acme', ownerReply: true }), {}), true, 'the owner’s follow-up on a client’s task');
  assert.equal(V.shouldValidate(runOf({ huddle: 'h1', huddleTalk: true }), {}), false);
  assert.equal(V.shouldValidate(runOf({ backend: true }), {}), false, 'a fix has its own diff');
  assert.equal(V.shouldValidate(runOf({ outcome: 'failed' }), {}), false, 'failures go to recovery');
  assert.equal(V.shouldValidate(runOf({ outcome: 'stopped' }), {}), false);
  assert.equal(V.shouldValidate(runOf(), { validateRuns: false }), false, 'Settings off');
  ok('shouldValidate: the owner’s own finished runs only (not client-own, huddle turns, fixes, failures; Settings toggle)');

  // ── 2. report + status ──
  let v = V.checkRun(runOf({ report: null, resultText: 'Here is the list…' }), { events: [T('Read', { file_path: 'a.md' }), T('Bash', { command: 'one --agent actions find gmail "list"' })], ws });
  assert.equal(v.verdict, 'ok'); assert.match(check(v, 'Report').note, /last message/);
  v = V.checkRun(runOf({ report: null, resultText: 'Done' }), { events: [T('Write', { file_path: 'x.md' })], ws });
  assert.equal(v.verdict, 'check'); assert.match(check(v, 'Report').note, /without a report after 1 step/);
  const b1 = T('Bash', { command: 'node push.mjs' }), b2 = T('Bash', { command: 'node push.mjs --retry' }), r1 = T('Read', { file_path: 'missing.md' });
  v = V.checkRun(runOf(), { events: [b1, err(b1), { kind: 'report', text: 'done' }], ws });
  assert.equal(v.verdict, 'check'); assert.match(check(v, 'Status').note, /last step \(Bash\) failed: Exit code 1/);
  v = V.checkRun(runOf(), { events: [b1, err(b1), b2, done(b2), { kind: 'report' }], ws });
  assert.equal(check(v, 'Status').ok, true, 'a later success clears it');
  v = V.checkRun(runOf(), { events: [b2, done(b2), r1, err(r1, 'File does not exist'), { kind: 'report' }], ws });
  assert.equal(check(v, 'Status').ok, true, 'a read that found nothing is not the work failing');
  v = V.checkRun(runOf(), { events: [b1, { kind: 'denied', toolUseId: b1.toolUseId, text: 'The owner said no' }, { kind: 'report' }], ws });
  assert.match(check(v, 'Status').note, /was refused/);
  v = V.checkRun(runOf({ report: rep('partial') }), { events: [b1, err(b1)], ws });
  assert.equal(check(v, 'Status'), undefined, 'only a "completed" claim is held to its last step');
  // events from before tool_done existed: a later tool moves past the error
  v = V.checkRun(runOf(), { events: [{ kind: 'tool', tool: 'Bash', input: { command: 'x' } }, { kind: 'tool_error', tool: 'Bash', text: 'Exit code 1' }, { kind: 'tool', tool: 'Write', input: {} }, { kind: 'report' }], ws });
  assert.equal(check(v, 'Status').ok, true);
  ok('report + status: no report after changes → check, a read-only answer is fine; "completed" after a failed or refused last step → check');

  // ── 3. the files it names ──
  const outs = (...o) => runOf({ report: rep('completed', { outputs: o }) });
  v = V.checkRun(outs('Tasks/2026-10-17-recap/recap.md', absIn('report.pdf'), 'Notion page: https://www.notion.so/p/abc'), { ws });
  assert.equal(v.verdict, 'ok', JSON.stringify(v.checks)); assert.match(check(v, 'Files it names').note, /2 found/);
  v = V.checkRun(outs('recap.md'), { ws }); assert.equal(v.verdict, 'ok', 'a bare name in the task folder');
  v = V.checkRun(outs('Task folder: Test Workspace/Tasks/2026-10-17-recap/recap.md'), { ws }); assert.equal(v.verdict, 'ok', 'label and the workspace folder name in front');
  v = V.checkRun(outs('marketing/d4a/sheet-01.png, sheet-02.png'), { ws }); assert.equal(v.verdict, 'ok', 'a sibling named next to a path');
  v = V.checkRun(outs('marketing/d4a/sheet-01.png, sheet-09.png'), { ws });
  assert.equal(v.verdict, 'check'); assert.equal(check(v, 'Files it names').note, "Can't find sheet-09.png");
  v = V.checkRun(outs('Tasks/2026-10-17-recap/final.pdf'), { ws });
  assert.equal(v.verdict, 'failed', 'every file it names is missing'); assert.equal(check(v, 'Files it names').level, 'fail');
  v = V.checkRun(outs('marketing/{d4a,d4b}/BRIEF.md', 'Updated the docs at example.com', 'Built with Node.js', 'v1.2 shipped'), { ws });
  assert.equal(check(v, 'Files it names'), undefined, 'brace lists, domains, prose and versions are not files');
  v = V.checkRun(outs(process.platform === 'win32' ? 'C:\\Users\\someone\\Desktop\\elsewhere.pdf' : '/home/someone/Desktop/elsewhere.pdf'), { ws });
  assert.equal(v.verdict, 'ok'); assert.match(check(v, 'Files it names').note, /outside the workspace, not checked/);
  v = V.checkRun(outs('C:\\Users\\someone\\Desktop\\other.pdf'), { ws });
  assert.equal(v.verdict, 'ok', 'a Windows path is outside on any OS'); assert.match(check(v, 'Files it names').note, /outside the workspace/);
  v = V.checkRun(outs('.claude/agents/researcher.md'), { ws }); assert.equal(v.verdict, 'ok', 'setup files are only stat-ed, never served');
  v = V.checkRun(outs('ghost.pdf'), { ws, arts: [{ rel: 'Tasks/2026-10-17-recap/files/ghost.pdf', status: 'final' }] }); assert.equal(v.verdict, 'ok', 'the registry has it');
  // a client's task: its own folder only; the owner's workspace files are "outside" for it
  const cr = runOf({ client: 'acme', ownerReply: true, taskDir: 't1', report: rep('completed', { outputs: ['Tasks/t1/brief.pdf', absIn('report.pdf')] }) });
  v = V.checkRun(cr, { ws }); assert.equal(v.verdict, 'ok'); assert.match(check(v, 'Files it names').note, /1 found · 1 outside/);
  ok('files: relative/absolute/label/sibling/registry found; missing → check, all missing → failed; globs, domains, prose skipped; outside and other-folder paths not checked; client sandbox only');

  // ── 4. "says it sent, I don't see the send" ──
  const acts = (lines, events = []) => V.checkRun(runOf({ report: rep('completed', { actions_taken: lines }) }), { ws, events });
  v = acts(['Sent the recap to #general in Slack']);
  assert.equal(v.verdict, 'check'); assert.equal(check(v, 'App actions').note, "Says it sent in Slack, but I don't see a Slack step");
  // the post went out through `node -e` calling One; Orchy's summary of the step names the platform
  const slack = T('Bash', { command: 'cd "/work/acme" && node -e "const text=…"' }, { summary: 'Running Send a Message to a Channel (chat.postMessage) on slack' });
  v = acts(['Posted the proposal summary to Slack C0123ABCD via chat.postMessage (the owner approved): ok=true'], [slack, done(slack)]);
  assert.equal(v.verdict, 'ok', JSON.stringify(v.checks));
  v = acts(['Posted the summary in Slack'], [slack, err(slack, 'channel_not_found')]);
  assert.match(check(v, 'App actions').note, /every Slack step failed/);
  const gm = T('Bash', { command: 'one --agent actions execute gmail conn_mod_def::X live::gmail::default::y -d "{}"' });
  v = acts(['Emailed Sam the summary'], [gm, done(gm)]); assert.equal(v.verdict, 'ok');
  v = acts(['Read the hiring thread and emailed Sam the summary']); assert.match(check(v, 'App actions').note, /Says it emailed, but I don't see an email step/);
  v = acts(['Created a Notion page "Weekly plan"'], [T('mcp__notion__create_page', { title: 'x' })]); assert.equal(v.verdict, 'ok', 'an MCP tool of the app');
  for (const line of [
    'Did not send the email; it is ready for the owner to send', // negation
    'Read the 11 assigned threads and extracted the sent emails in them', // "sent" as an adjective
    'Created the weekly email Content row, set it In Review', // a Notion row named "email"
    'Updated researcher.md to v3: Notion row in the connections table', // file work
    "Updated Ada's task 3fa7c1c3: source is now Bea's copy, PR by Oct 27", // "PR" after the head
    'Ran the 3 queue checks: YouTube Approved/Scheduled (0)', // a status, not a verb
    'Drafted the email asking Sam to approve the exception', // a local draft
  ]) assert.equal(check(acts([line]), 'App actions'), undefined, line);
  ok('app claims: a send with no step → check, a failed one → check; One-via-script, MCP and real report lines (negations, adjectives, file work) pass');

  // ── 5. a step that promised kinds of file ──
  v = V.checkRun(runOf(), { ws, expects: [{ kind: 'pdf', note: 'the report' }], arts: [{ rel: 'a.md', kind: 'markdown', status: 'final' }] });
  assert.equal(v.verdict, 'failed'); assert.equal(check(v, 'Expected files').note, 'No pdf (the report) from this step');
  v = V.checkRun(runOf(), { ws, expects: [{ kind: 'document' }], arts: [{ rel: 'a.pdf', kind: 'pdf', status: 'final' }] });
  assert.equal(v.verdict, 'ok');
  ok('expects: a promised pdf that isn’t there → failed; "document" accepts a pdf');

  // ── 6. Jev's read (faked) + Orchy's step around it ──
  const saved = [], emitted = [];
  V.configure({ db: () => ({ settings: {} }), save: () => saved.push(1), emit: (t, d) => emitted.push([t, d.run.activity?.state, !!d.run.validation]), workspace: () => ws, events: () => [], artifactsFor: () => [], sync: () => {} });
  let asked = null;
  const jev = ps => async (state, questions, opts) => { asked = { state, questions, opts }; return { answers: Object.fromEntries(Object.entries(ps).map(([k, p]) => [k, { noul: p }])), ms: 3 }; };
  v = await V.validateRun(runOf(), { semantic: true, ask: jev({ did_task: 0.9, delivered: 0.31, consistent: 0.8 }) });
  assert.equal(v.verdict, 'check'); assert.equal(check(v, "Jev's read").note, 'it may not have delivered what you asked to see (31%)');
  assert.deepEqual(Object.keys(asked.questions), ['did_task', 'delivered', 'consistent']);
  assert.equal(asked.opts.purpose, 'validate');
  assert.ok(asked.state.task_owner_gave && asked.state.orchy_checks.includes('Report'));
  v = await V.validateRun(runOf(), { semantic: true, ask: jev({ did_task: 0.9, delivered: 0.7, consistent: 0.8 }) });
  assert.equal(v.verdict, 'ok'); assert.match(check(v, "Jev's read").note, /70% sure/);
  v = await V.validateRun(runOf(), { semantic: true, ask: async () => { throw new Error('Jev 503'); } });
  assert.equal(v.verdict, 'ok'); assert.match(v.jev.error, /503/);
  asked = null; v = await V.validateRun(runOf(), { semantic: false, ask: jev({ did_task: 0 }) });
  assert.equal(asked, null, 'no Jev call unless the setting is on');
  const run6 = runOf({ report: rep('completed', { outputs: ['Tasks/2026-10-17-recap/final.pdf'] }), activity: { state: 'completed' } });
  V.configure({ workspace: () => ws });
  const out6 = await V.applyValidation(run6, { semantic: false });
  assert.equal(run6.validation, out6); assert.equal(out6.verdict, 'failed');
  assert.deepEqual(emitted.map(e => e.slice(0, 2)), [['run.updated', 'validating'], ['run.updated', 'completed']]);
  assert.equal(emitted[0][2], false, 'the validating update comes before a result'); assert.equal(emitted[1][2], true);
  assert.match(V.fixPrompt(out6), /^Orchy checked your report and found: Files it names: Can't find final.pdf\. Fix only that/);
  assert.equal(V.fixPrompt({ checks: [{ name: 'Report', ok: true }] }), '');
  ok('Jev read: weakest of 3 nouls below 0.4 → check, Jev down → skipped, off → no call; applyValidation: validating → result → outcome, fixPrompt');

  // ── 7. failure classes from recorded error shapes ──
  const failed = (error, events = [], o = {}) => R.classify({ id: 'r', outcome: 'failed', status: 'failed', error, ...o }, { events });
  const reads = [T('Read', { file_path: 'a' }), T('Glob', { pattern: '*' }), T('Bash', { command: 'cd "/work/acme" && one --agent actions find notion "query" --task "t" 2>&1 | head -40' })];
  const table = [
    // [error, events, class, retry]
    ['Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute', [], 'auth_race', 'owner'],
    ["You've hit your session limit · resets 4:10am (UTC)", [], 'session_limit', 'owner'],
    ['You’ve hit your usage limit. Upgrade your plan to purchase more credits or try again at 8:00 AM.', [], 'session_limit', 'owner'],
    ['error_during_execution', [], 'engine_crash_before_tools', 'auto'],
    ['error_during_execution', [T('Write', { file_path: 'x' })], 'engine_crash_after_tools', 'owner'],
    ['error_during_execution: No conversation found with session ID: 499525e7-5548-4f59-abb9-8d6a608615fd', [], 'session_lost', 'owner'],
    ['Failed to authenticate: OAuth session expired and could not be refreshed', [], 'auth', 'owner'],
    ['Invalid params: model not found: some-model-free', [], 'config', 'owner'],
    ["API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)", [T('Bash', { command: 'npm test' })], 'network', 'auto'],
    ['Error: MCP tool mcp__jos__approval (passed via --permission-prompt-tool) not found. Available MCP tools: none', [T('Glob', { pattern: '*' })], 'tool_missing', 'auto'],
    ['The orchestrator stopped while this run was in progress, so the agent was cut off. Re-send the task if it still needs doing.', [T('Write', { file_path: 'x' })], 'interrupted', 'owner'],
    ['The run was not approved.', [], 'denied', 'none'],
    ['API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', reads, 'api_error', 'auto'],
    ['API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}', [], 'rate_limit', 'auto'],
    ["EPERM: operation not permitted, open '/work/acme/y.lock'", [T('Write', { file_path: 'y' })], 'permission', 'owner'],
  ];
  for (const [e, evs, cls, retry] of table) {
    const c = failed(e, evs);
    assert.equal(c?.cls, cls, `${e.slice(0, 50)} → ${c?.cls}`); assert.equal(c.retry, retry, `${cls} retry`);
    if (retry === 'owner') assert.ok(c.options.length >= 2 && c.options.at(-1).action === 'leave', `${cls} has a card with Leave it`);
  }
  assert.equal(R.classify({ outcome: 'stopped', status: 'stopped' }, { events: [] }).cls, 'stopped');
  assert.equal(R.classify({ outcome: 'blocked', report: rep('blocked', { summary: 'The desktop app is not reachable' }) }, { events: [] }).cls, 'blocked');
  assert.deepEqual(R.classify({ outcome: 'blocked', report: rep('blocked') }, { events: [] }).options.map(o => o.action), ['followup', 'huddle', 'leave']);
  assert.equal(R.classify({ outcome: 'failed', report: rep('failed') }, { events: [] }).cls, 'agent_error');
  assert.equal(R.classify({ outcome: 'completed', report: rep(), validation: { verdict: 'failed' } }, { events: [] }).cls, 'bad_output');
  assert.equal(R.classify({ outcome: 'completed', report: rep(), validation: { verdict: 'check' } }, { events: [] }), null, 'a check is flagged by validation, not a failure');
  assert.deepEqual(R.optionsFor('interrupted').map(o => o.label), ['Resume', 'Start over', 'Leave it']);
  // every failed run in this machine's own state.json (if there is one) gets a class
  const D = path.join(ROOT, 'orchestrator', 'data');
  let n = 0;
  try {
    const st = JSON.parse(fs.readFileSync(path.join(D, 'state.json'), 'utf8').replace(/^\uFEFF/, ''));
    for (const r of Object.values(st.runs || {})) {
      if (r.outcome !== 'failed' || r.report) continue;
      let evs = []; try { evs = fs.readFileSync(path.join(D, 'runs', `${r.id}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch {}
      const c = R.classify(r, { events: evs });
      assert.ok(c && R.LABELS[c.cls], `${r.id} unclassified`); n++;
    }
  } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
  ok(`classify: ${table.length} error shapes + blocked/agent_error/bad_output/stopped${n ? `; all ${n} failed runs in this machine's state.json get a class` : ''}`);

  // ── 8. the retry gate: reads only, nothing asked, the owner's own top-level run ──
  const base = { id: 'r', outcome: 'failed', status: 'failed', workspace: 'test', error: 'error_during_execution', endedAt: '2026-10-17T11:59:00Z' };
  const gate = (o = {}, events = [], items = [], s = {}) => R.retryGate({ ...base, ...o }, { events, items, s });
  assert.equal(gate({}, reads).ok, true, 'reads and One lookups only');
  for (const [e, why] of [
    [T('Write', { file_path: 'x' }), /Write/], [T('Edit', { file_path: 'x' }), /Edit/],
    [T('Bash', { command: 'one --agent actions execute gmail conn_mod_def::X live::gmail::y' }), /Bash/],
    [T('Bash', { command: 'one --agent actions find gmail "x" > out.json' }), /Bash/], // a redirect writes a file
    [T('Bash', { command: 'node send.mjs' }), /Bash/], [T('mcp__slack__post_message', {}), /mcp__slack/],
    [T('mcp__jos__ask_user', {}), /ask_user/], [T('Agent', {}), /Agent/], [T('WebFetch', {}), null],
  ]) {
    const g = gate({}, [e]);
    if (why) { assert.equal(g.ok, false, e.tool); assert.match(g.why, why); } else assert.equal(g.ok, true, e.tool);
  }
  assert.match(gate({ client: 'acme' }).why, /client/);
  assert.match(gate({ delegatedBy: 'run_head' }).why, /hand-off/);
  assert.match(gate({ report: rep('failed') }).why, /reported/);
  assert.match(gate({ retries: 2 }).why, /2 times/);
  assert.match(gate({}, [], [{ kind: 'approval', runId: 'r' }]).why, /asked you/);
  assert.match(gate({}, [], [], { autoRetry: false }).why, /off in Settings/);
  assert.match(gate({ huddle: 'h', huddleTalk: true }).why, /not for this kind/);
  assert.match(gate({ backend: true }).why, /not for this kind/);
  assert.equal(R.lookupOnly('one --agent list 2>&1 | head -60'), true);
  assert.equal(R.lookupOnly('cd "/work/acme" && one --agent actions load conn_mod_def::A --section usage'), true);
  assert.equal(R.lookupOnly('one --agent actions find x "y"; rm -rf tmp'), false);
  assert.equal(R.lookupOnly('one --agent actions find x "$(cat q)"'), false);
  for (let i = 0; i < 50; i++) { const d1 = R.retryDelay(1), d2 = R.retryDelay(2); assert.ok(d1 >= 20_000 && d1 <= 60_000 && d2 >= 60_000 && d2 <= 120_000); }
  ok('retry gate: refuses after any write, command, app/MCP call, ask, hand-off, client task, report, 2 tries, or with Settings off; delays 20–60s then 60–120s');

  // ── 9. afterRun / act / boot / stalls with faked runner + timers ──
  const S = { settings: {}, runs: {} };
  const said = [], started = [], stopped = [], followed = [], timers = [];
  let failStart = null;
  R.configure({
    db: () => S, save: () => {}, emit: () => {}, events: id => S.events?.[id] || [], items: () => [],
    startRun: async o => { if (failStart) throw failStart; const r = { id: `run_new${started.length}`, ...o }; started.push(o); return r; },
    stopRun: id => { stopped.push(id); const r = S.runs[id]; r.endedAt = 'now'; r.status = 'stopped'; },
    isLive: id => !S.runs[id]?.endedAt, followUp: async (id, b) => { followed.push([id, b.text]); return { id: 'run_fu' }; },
    say: (text, meta) => said.push({ text, meta }), note: () => {}, who: r => r.agentName || 'Ivy', wsName: () => 'Test Workspace',
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimeout: () => {}, random: () => 0.5, now: () => Date.parse('2026-10-17T12:00:00Z'),
  });
  const parent = { id: 'run_p', sessionId: 'sess-parent' };
  S.runs.run_p = parent;
  const f1 = S.runs.run_f1 = { ...base, id: 'run_f1', agentSlug: 'researcher', model: 'sonnet', instruction: 'Find 3 sources', session: 's1', routing: { source: 'jev' }, parentRunId: 'run_p', error: 'API Error: 529 overloaded_error' };
  S.events = { run_f1: reads };
  let a = R.afterRun(f1);
  assert.match(a.quiet, /stopped because the model’s API was busy, before it changed anything, so I'm trying it again in 40s \(try 1 of 2\)/);
  assert.equal(f1.recovery.state, 'scheduled'); assert.equal(timers.at(-1).ms, 40_000); assert.deepEqual(f1.recovery.options.map(o => o.label), ['Don’t retry']);
  await timers.at(-1).f();
  assert.deepEqual(started.at(-1), { workspace: 'test', agentSlug: 'researcher', kind: 'task', model: 'sonnet', instruction: 'Find 3 sources', routing: { source: 'jev' }, session: 's1', parentRunId: 'run_p', resumeSessionId: 'sess-parent', retryOf: 'run_f1', retries: 1 });
  assert.equal(f1.recovery.state, 'retried'); assert.equal(f1.recovery.retriedBy, 'run_new0');
  // the retry's own retry gets the longer wait; a third failure goes to the owner
  const f2 = S.runs.run_f2 = { ...base, id: 'run_f2', retries: 1, retryOf: 'run_f1', instruction: 'Find 3 sources' };
  a = R.afterRun(f2); assert.match(a.quiet, /try 2 of 2/); assert.equal(timers.at(-1).ms, 90_000);
  const f3 = S.runs.run_f3 = { ...base, id: 'run_f3', retries: 2, instruction: 'x' };
  a = R.afterRun(f3); assert.match(a.tail, /didn't retry it on my own: tried 2 times already/); assert.equal(f3.recovery.state, 'asking');
  // the account check (or anything startRun refuses) turns a scheduled retry into a card; nothing runs elsewhere
  const f4 = S.runs.run_f4 = { ...base, id: 'run_f4', instruction: 'y', session: 's4' };
  R.afterRun(f4);
  failStart = Object.assign(new Error('Test Workspace must run as a@example.com on Claude Code, but its profile is logged in as b@example.com. Not running it.'), { code: 'ACCOUNT_MISMATCH' });
  const before = started.length;
  await timers.at(-1).f();
  failStart = null;
  assert.equal(started.length, before); assert.equal(f4.recovery.state, 'asking'); assert.match(f4.recovery.error, /must run as/);
  assert.match(said.at(-1).text, /couldn't retry/); assert.equal(said.at(-1).meta.recover.runId, 'run_f4');
  // a write before the crash: never automatic
  const f5 = S.runs.run_f5 = { ...base, id: 'run_f5', instruction: 'z', sessionId: 'sess-f5' }; S.events.run_f5 = [T('Write', { file_path: 'a' })];
  a = R.afterRun(f5); assert.equal(f5.recovery.cls, 'engine_crash_after_tools'); assert.deepEqual(f5.recovery.options.map(o => o.action), ['resume', 'restart', 'leave']);
  assert.equal(R.afterRun({ ...base, id: 'run_c', client: 'acme', instruction: 'q' }), null, 'a client’s own run: nothing in the owner’s chat');
  assert.equal(R.afterRun({ ...base, id: 'run_h', huddle: 'h1', huddleTalk: true }), null);
  // the owner's answers
  await assert.rejects(R.act('run_f5', 'delete'), /Unknown choice/);
  let res = await R.act('run_f5', 'resume'); assert.deepEqual(followed.at(-1), ['run_f5', R.RESUME_TEXT]); assert.equal(f5.recovery.answered.action, 'resume');
  await assert.rejects(R.act('run_f5', 'restart'), /Already handled/);
  res = await R.act('run_f3', 'restart'); assert.equal(started.at(-1).retryOf, 'run_f3'); assert.equal(started.at(-1).retries, 0, 'the owner’s restart resets the automatic count');
  // stalls: flag once, card once, moving clears, waiting/queued never, 0 = off, the cap stops
  const now = Date.parse('2026-10-17T12:00:00Z');
  S.runs.run_s1 = { id: 'run_s1', workspace: 'test', status: 'working', startedAt: '2026-10-17T11:00:00Z', lastActivity: '2026-10-17T11:35:00Z', activity: { label: 'Rendering video', toolUseId: 't9' }, session: 's9' };
  S.runs.run_s2 = { id: 'run_s2', workspace: 'test', status: 'waiting', startedAt: '2026-10-17T11:00:00Z', lastActivity: '2026-10-17T11:00:00Z' };
  S.runs.run_s3 = { id: 'run_s3', workspace: 'test', status: 'working', startedAt: '2026-10-17T11:50:00Z', lastActivity: '2026-10-17T11:50:00Z' };
  S.runs.run_s4 = { id: 'run_s4', workspace: 'test', status: 'working', startedAt: '2026-10-17T11:00:00Z', lastActivity: '2026-10-17T11:00:00Z', client: 'acme' };
  for (const id of Object.keys(S.runs)) if (!id.startsWith('run_s')) S.runs[id].endedAt ||= 'x';
  const nSaid = said.length;
  assert.deepEqual(R.checkStalls(now), ['run_s1', 'run_s4']);
  assert.match(said.at(-1).text, /hasn't recorded a step in 25 minutes \(still on: Rendering video\)\. It's still running; I haven't stopped it\./);
  assert.equal(said.length, nSaid + 1, 'a client’s own run is flagged but gets no card in the owner’s chat');
  assert.equal(stopped.length, 0, 'flags only, never stops');
  assert.deepEqual(R.checkStalls(now + 60_000), [], 'once per stall');
  R.moving(S.runs.run_s1); assert.equal(S.runs.run_s1.stalledAt, null); assert.equal(S.runs.run_s1.recovery.state, 'moving');
  S.settings.stallMin = 0; S.runs.run_s1.lastActivity = '2026-10-17T10:00:00Z'; assert.deepEqual(R.checkStalls(now), [], '0 = off');
  S.settings.stopAfterMin = 30; R.checkStalls(now); assert.deepEqual(stopped, ['run_s1', 'run_s4'], 'the cap stops runs past it (not the waiting one)');
  S.settings.stopAfterMin = 0; S.settings.stallMin = 20;
  // stalled live run → Start over: stopped quietly first, then a fresh run
  S.runs.run_s5 = { id: 'run_s5', workspace: 'test', status: 'working', startedAt: '2026-10-17T11:00:00Z', lastActivity: '2026-10-17T11:00:00Z', instruction: 'long', session: 's5' };
  R.checkStalls(now);
  res = await R.act('run_s5', 'restart');
  assert.equal(S.runs.run_s5.quietReport, true); assert.ok(stopped.includes('run_s5')); assert.equal(started.at(-1).retryOf, 'run_s5');
  // boot: runs cut off by a restart get a card; a retry that was waiting when Orchy stopped too
  S.runs.run_i1 = { id: 'run_i1', workspace: 'test', status: 'failed', outcome: 'failed', endedAt: 'x', error: 'The orchestrator stopped while this run was in progress…', session: 's7' };
  S.runs.run_i2 = { id: 'run_i2', workspace: 'test', status: 'failed', outcome: 'failed', endedAt: 'x', client: 'acme' };
  S.runs.run_w1 = { id: 'run_w1', workspace: 'test', status: 'failed', outcome: 'failed', endedAt: 'x', recovery: { cls: 'api_error', state: 'scheduled' } };
  S.events.run_i1 = [T('Read', {}), T('Write', {})];
  const k = said.length;
  S.runs.run_i3 = { id: 'run_i3', workspace: 'test', status: 'failed', outcome: 'failed', endedAt: 'x', stalledAt: 'y', recovery: { cls: 'stalled', state: 'asking' } };
  R.boot(['run_i1', 'run_i2', 'run_i3']);
  assert.equal(S.runs.run_i1.recovery.cls, 'interrupted'); assert.equal(S.runs.run_i2.recovery, undefined);
  assert.equal(S.runs.run_i3.recovery.cls, 'interrupted', 'a stuck run cut off by the restart'); assert.equal(S.runs.run_i3.stalledAt, null);
  assert.match(said[k].text, /was cut off when I restarted \(2 steps in\)/); assert.equal(said[k].meta.session, 's7');
  assert.equal(S.runs.run_w1.recovery.state, 'asking'); assert.match(said.at(-1).text, /about to retry/);
  ok('afterRun/act/boot/stalls: auto retry (retryOf, same agent/model/session) then longer, a third → the owner; account refusal → card; Resume/Start over/Leave; stall flag + card once, cap; boot cards');
} finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }); }

// ── 10. real runs through the real runner (disposable copy, a fake engine) ──
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'orchy-recover-test-'));
try {
  const orch = path.join(tmp2, 'orchestrator');
  fs.mkdirSync(orch);
  fs.cpSync(path.join(ROOT, 'orchestrator/lib'), path.join(orch, 'lib'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'orchestrator/mcp'), path.join(orch, 'mcp'), { recursive: true });
  if (fs.existsSync(path.join(ROOT, 'node_modules'))) fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp2, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(tmp2, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(tmp2, '.env'), 'JEV_PROVIDER=off\n');
  fs.mkdirSync(path.join(tmp2, 'workspaces', 'acme'), { recursive: true });
  fs.writeFileSync(path.join(orch, 'config.json'), JSON.stringify({
    timezone: 'UTC', owner: { name: 'Sam' }, orchy: {},
    workspaces: [{ id: 'acme', name: 'Acme Workspace', folder: 'workspaces/acme', client: 'Acme', runtime: 'fakev', fakevAccount: 'x@example.com', fakevProfile: path.join(tmp2, 'prof') }],
    runtimes: { claude: { label: 'Claude Code', models: ['haiku', 'sonnet', 'opus'] } },
  }));
  fs.writeFileSync(path.join(orch, 'voice-agents.json'), '{"agents":[]}');
  const mod = file => import(pathToFileURL(path.join(orch, 'lib', file)).href);
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const { registerEngine } = await mod('engines/index.mjs');
  // a fake engine: odd launches fail with an overloaded API before any tool; even ones read a file and answer
  let launches = 0;
  registerEngine({
    id: 'fakev', label: 'Fake V', models: ['lo', 'mid', 'hi'], blurb: '', fields: { account: 'fakevAccount', profile: 'fakevProfile' },
    accountModel: 'email', instructionFile: 'AGENTS.md', defaultProfileLabel: '(none)',
    capabilities: { gated: true, mcp: true, resume: true, headless: true, clientSafe: false, huddles: false, notes: '' },
    bin: () => null, version: () => null, available: () => true,
    account: async () => ({ loggedIn: true, email: 'x@example.com' }),
    profileEnv: () => ({}), loginCommand: () => 'fake login', loginAlt: () => null, mcpConfig: () => ({}), protocolNotes: () => '',
    launch(run, ws, opts, rt) {
      const hooks = rt.hooks(run, ws);
      const n = ++launches;
      rt.live.set(run.id, { fingerprint: opts.fingerprint, stop: () => hooks.done({ code: 1, status: 'interrupted' }) });
      hooks.started({ threadId: `thread-${run.id}` });
      setTimeout(() => {
        if (n % 2) return hooks.done({ code: 1, status: 'failed', error: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' });
        hooks.record({ kind: 'tool', tool: 'Read', toolUseId: 'toolu_r1', input: { file_path: 'plan.md' } });
        hooks.record({ kind: 'tool_done', toolUseId: 'toolu_r1', tool: 'Read', ok: true, brief: '2 lines' });
        hooks.done({ code: 0, status: 'completed', resultText: 'Three sources: a, b, c.' });
      }, 20);
    },
  });
  const B = await mod('bus.mjs'), Rn = await mod('runner.mjs'), Vc = await mod('validate.mjs'), Rc = await mod('recover.mjs'), E = await mod('env.mjs'), St = await mod('store.mjs');
  const said2 = [], updates = [];
  B.bus.on('event', e => { if (e.type === 'run.updated') updates.push([e.run.id, e.run.activity?.state, !!e.run.validation]); });
  let retryWait = 10;
  Rc.configure({ startRun: o => Rn.startRun(o), stopRun: id => Rn.stopRun(id), isLive: id => Rn.isLive(id), say: (text, meta) => said2.push({ text, meta }), setTimeout: f => setTimeout(f, retryWait) });
  const ended = new Map();
  // the same order server.mjs#onRunFinished uses: check, then classify (auto-retry or a card), then report
  Rn.onRunFinished(async run => { if (Vc.shouldValidate(run)) await Vc.applyValidation(run); ended.set(run.id, Rc.afterRun(run)); });
  const waitFor = async (pred, ms = 15_000) => { for (let t = 0; t < ms; t += 25) { const x = pred(); if (x) return x; await delay(25); } throw new Error('timed out'); };
  const first = await Rn.startRun({ workspace: 'acme', instruction: 'Find three sources', model: 'lo', session: 'sx' });
  await waitFor(() => ended.has(first.id));
  const f = Rn.getRun(first.id);
  assert.equal(f.outcome, 'failed'); assert.equal(f.recovery.cls, 'api_error'); assert.match(ended.get(first.id).quiet, /trying it again/);
  const second = await waitFor(() => Object.values(St.db().runs).find(r => r.retryOf === first.id));
  await waitFor(() => ended.has(second.id));
  const s = Rn.getRun(second.id);
  assert.equal(s.outcome, 'completed'); assert.equal(s.retries, 1); assert.equal(s.parentRunId, null, 'retryOf, not a follow-up');
  assert.equal(s.validation.verdict, 'ok', JSON.stringify(s.validation)); assert.match(s.validation.checks[0].note, /last message/);
  assert.equal(Rn.getRun(first.id).recovery.retriedBy, second.id);
  assert.ok(updates.some(u => u[0] === second.id && u[1] === 'validating' && !u[2]) && updates.some(u => u[0] === second.id && u[1] === 'completed' && u[2]), 'run.updated: validating, then the result');
  // the account changes before the retry fires: startRun's account check refuses it, the owner gets a card
  retryWait = 400;
  const third = await Rn.startRun({ workspace: 'acme', instruction: 'Again', model: 'lo', session: 'sy' });
  E.config.workspaces[0].fakevAccount = 'someone-else@example.com';
  await waitFor(() => ended.has(third.id));
  assert.equal(Rn.getRun(third.id).recovery.state, 'scheduled');
  await waitFor(() => Rn.getRun(third.id).recovery.state === 'asking');
  assert.match(Rn.getRun(third.id).recovery.error, /someone-else@example\.com/);
  assert.equal(Object.values(St.db().runs).filter(r => r.retryOf === third.id).length, 0, 'no run under another account');
  assert.match(said2.at(-1).text, /couldn't retry/);
  // a step recorded again clears a stall flag (runner.mjs#record → recover.moving)
  E.config.workspaces[0].fakevAccount = 'x@example.com';
  const fourth = await Rn.startRun({ workspace: 'acme', instruction: 'Read it', model: 'lo', session: 'sz' });
  Rn.getRun(fourth.id).stalledAt = new Date().toISOString();
  await waitFor(() => ended.has(fourth.id));
  assert.equal(Rn.getRun(fourth.id).stalledAt, null, 'a new step clears the stall flag');
  ok('runner: overloaded before any tool → one automatic retry (retryOf, retries 1) → completed and checked; an account change refuses the retry → a card; a new step clears a stall flag');
} finally {
  assert.ok(path.resolve(tmp2).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await new Promise(r => setTimeout(r, 400));
  fs.rmSync(tmp2, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
}
console.log('test-validate: all passed');
process.exit(0);
