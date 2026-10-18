// Offline checks for usage and cost (logs.mjs#computeUsage, claude.mjs's cost line, usagereview.mjs), in a disposable
// copy of Orchy with made-up runs: totals per workspace/agent/model/kind, follow-up chains, the costliest runs, Orchy's
// own calls, spend at 4+ live runs, this week vs a usual week (and the routing line), the weekly review with a fake
// model (only actions the dashboard can take survive), its schedule, and the brief a builder's review gets.
// No model calls, no network. Run: node orchestrator/scripts/test-usage.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../lib/env.mjs';

const ok = name => console.log(`ok - ${name}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchy-usage-test-'));
try {
  const orch = path.join(tmp, 'orchestrator');
  fs.mkdirSync(orch);
  fs.cpSync(path.join(ROOT, 'orchestrator/lib'), path.join(orch, 'lib'), { recursive: true });
  if (fs.existsSync(path.join(ROOT, 'node_modules'))) fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(orch, 'config.json'), JSON.stringify({
    timezone: 'UTC', owner: { name: 'Sam' }, orchy: {},
    workspaces: [{ id: 'acme', name: 'Acme Workspace', folder: 'workspaces/acme', client: 'Acme', runtime: 'claude', claudeAccount: 'x@example.com' },
      { id: 'northwind', name: 'Northwind Workspace', folder: 'workspaces/northwind', client: 'Northwind', runtime: 'claude', claudeAccount: 'x@example.com' }],
    runtimes: { claude: { label: 'Claude Code', models: ['haiku', 'sonnet', 'opus'] } },
  }));
  fs.writeFileSync(path.join(orch, 'voice-agents.json'), '{"agents":[]}');
  const mod = file => import(pathToFileURL(path.join(orch, 'lib', file)).href);
  const { db } = await mod('store.mjs');
  const { computeUsage, appendCostLine } = await mod('logs.mjs');
  const U = await mod('usagereview.mjs');

  const DAY = 86400_000, now = Date.now();
  const iso = ms => new Date(ms).toISOString();
  let n = 0;
  const mk = (over) => {
    const startedAt = iso(over.at ?? now - DAY - n * 3600_000); // an hour apart: no two overlap
    const r = { id: `run_t${++n}`, workspace: 'acme', agentSlug: 'writer', agentName: 'Writer', model: 'sonnet', instruction: `task ${n}`, status: 'done', outcome: 'completed', startedAt, endedAt: iso(Date.parse(startedAt) + 60_000), numTurns: 4, costUsd: 1, tokens: { input: 1000, output: 100, total: 1100, cacheRead: 800 }, ...over };
    delete r.at;
    db().runs[r.id] = r;
    return r;
  };
  // this week: acme writer ×3 (one a 2-round follow-up chain), a scheduled run, a hand-off, a build, a huddle turn,
  // a client's run and a fix (both left out of the review); two weeks ago and before: the usual weeks
  const a = mk({ costUsd: 2 });
  mk({ parentRunId: a.id, costUsd: 3, numTurns: 10 });
  mk({ costUsd: 0.5, outcome: 'partial' });
  mk({ workspace: 'northwind', agentSlug: 'ops', agentName: 'Ops', routing: { source: 'schedule' }, costUsd: 1.5 });
  mk({ delegatedBy: a.id, agentSlug: 'researcher', agentName: 'Researcher', model: 'haiku', costUsd: 0.25 });
  mk({ isBuilder: true, kind: 'build', agentSlug: 'agent-builder', agentName: 'AI Agent Builder', model: 'opus', costUsd: 4 });
  mk({ huddle: 'h_1', huddleTalk: true, costUsd: 0.75 });
  mk({ client: 'c_1', clientName: 'Client', costUsd: 9 });
  mk({ backend: true, workspace: 'orchy', agentSlug: null, agentName: 'Orchy', costUsd: 7, liveAtStart: 4 });
  for (const w of [2, 3, 4]) mk({ at: now - w * 7 * DAY + DAY, costUsd: 3 });
  // Orchy's own calls
  fs.mkdirSync(path.join(orch, 'data'), { recursive: true });
  fs.writeFileSync(path.join(orch, 'data', 'orchy-costs.jsonl'), [
    { t: iso(now - DAY), purpose: 'chat', costUsd: 0.02, model: 'haiku', tokens: { input: 500, output: 50, total: 550 } },
    { t: iso(now - DAY), purpose: 'report', costUsd: 0.01, model: 'haiku', workspace: 'acme' },
    { t: iso(now - 60 * DAY), purpose: 'chat', costUsd: 5, model: 'haiku' },
  ].map(x => JSON.stringify(x)).join('\n') + '\nnot json\n');

  const u = computeUsage('week');
  assert.equal(u.totals.runs, 9);
  assert.equal(u.totals.runCostUsd, 2 + 3 + 0.5 + 1.5 + 0.25 + 4 + 0.75 + 9 + 7);
  assert.equal(u.totals.orchyCalls, 2); assert.equal(u.totals.orchyCostUsd, 0.03);
  assert.equal(u.totals.totalCostUsd, Math.round((28 + 0.03) * 10000) / 10000);
  const kind = k => u.byKind.find(x => x.kind === k);
  assert.equal(kind('follow-up').costUsd, 3); assert.equal(kind('schedule').costUsd, 1.5); assert.equal(kind('delegated').costUsd, 0.25);
  assert.equal(kind('build').costUsd, 4); assert.equal(kind('huddle').costUsd, 0.75); assert.equal(kind('fix').costUsd, 7); assert.equal(kind('orchy').runs, 2);
  assert.equal(u.byWorkspace[0].ws, 'acme');
  assert.equal(u.byModel.find(m => m.model === 'opus').costUsd, 4);
  assert.ok(u.byAgent.some(x => x.slug === 'agent-builder'));
  assert.equal(u.chains[0].rootId, a.id); assert.equal(u.chains[0].runs, 2); assert.equal(u.chains[0].costUsd, 5); // a hand-off isn't a follow-up
  assert.equal(u.topRuns[0].costUsd, 9);
  assert.equal(u.totals.ge4CostUsd, 7); // the fix started with 4 live
  assert.equal(computeUsage('all').totals.runs, 12);
  ok('computeUsage: totals, kinds, workspaces, models, agents, chains, top runs, Orchy\'s own calls, spend at 4+ live');

  // ── appendCostLine: one line per finished run in <workspace>/.jos/costs.jsonl; client and fix runs stay out ──
  const ws = { id: 'acme', dir: path.join(tmp, 'workspaces', 'acme') };
  appendCostLine({ ...a, report: { status: 'completed', summary: 'Wrote   the\nbrief' } }, ws);
  appendCostLine({ ...a, client: 'c_1' }, ws);
  appendCostLine({ ...a, backend: true }, ws);
  const lines = fs.readFileSync(path.join(ws.dir, '.jos', 'costs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, 1); assert.equal(lines[0].summary, 'Wrote the brief'); assert.equal(lines[0].source, 'owner'); assert.equal(lines[0].costUsd, 2);
  ok('appendCostLine: the workspace\'s own cost log, without clients\' or fix runs');

  // ── this week vs a usual week, and the routing line ──
  const pace = U.budgetPace(now);
  // counted this week: everything but the client's run and the fix = 2+3+0.5+1.5+0.25+4+0.75 = 12; usual = 3
  assert.equal(pace.week, 12); assert.equal(pace.usual, 3); assert.equal(pace.pace, 4); assert.equal(pace.tight, true);
  const line = U.budgetLine(now);
  assert.match(line, /400% of a usual week/); assert.match(line, /Never override an agent Sam names/);
  db().settings.budgetRouting = false;
  assert.equal(U.budgetLine(now), null);
  db().settings.budgetRouting = true;
  ok('budgetPace: this week vs the mean of the 4 before (clients and fixes left out); the routing line, off with budgetRouting');

  // ── the weekly review with a fake model: only actions the dashboard can take survive ──
  const said = [];
  const think = async ({ prompt, purpose }) => {
    assert.equal(purpose, 'usage-review');
    assert.match(prompt, /Sam's AI agents/); assert.ok(!/client/i.test(JSON.stringify(U.weekNumbers(now).agents)));
    return { text: '```json\n' + JSON.stringify({ headline: 'A busy week.', suggestions: [
      { text: 'Put the Writer on haiku: $5.50 for 2.5 finished tasks.', label: 'Slim Writer', action: { type: 'build', ws: 'acme', text: 'Move the writer to haiku' } },
      { text: 'Run fewer at once.', label: 'Cap at 2', action: { type: 'setting', key: 'maxLivePerAccount', value: 2 } },
      { text: 'Turn approvals off.', action: { type: 'setting', key: 'approvals', value: 'none' } },
      { text: 'Open the costly chain.', action: { type: 'run', runId: a.id } },
      { text: 'A workspace that does not exist.', action: { type: 'build', ws: 'nope', text: 'x' } },
    ] }) + '\n```' };
  };
  const res = await U.weeklyReview({ say: (text, meta) => said.push({ text, meta }), now, think });
  assert.equal(res.suggestions.length, 5);
  assert.deepEqual(res.suggestions.map(s => s.action?.type ?? null), ['build', 'setting', null, 'run', null]);
  assert.equal(said.length, 1); assert.match(said[0].text, /^\*\*Weekly usage review\.\*\* A busy week\./);
  assert.equal(said[0].meta.kind, 'usage-review'); assert.equal(said[0].meta.suggestions.length, 3);
  assert.equal(U.cleanAction({ type: 'setting', key: 'maxLivePerAccount', value: 99 }).value, 6);
  ok('weeklyReview: the model\'s suggestions, keeping only builder/known-setting/real-run actions');

  // ── when it runs: a day and hour in Settings, or off ──
  assert.deepEqual(U.reviewSchedule({}), { day: 'Fri', hour: 15 });
  assert.deepEqual(U.reviewSchedule({ usageReviewDay: 'Mon', usageReviewHour: 9 }), { day: 'Mon', hour: 9 });
  assert.deepEqual(U.reviewSchedule({ usageReviewDay: 'off' }), { day: 'off', hour: 15 });
  assert.deepEqual(U.reviewSchedule({ usageReviewDay: 'Someday', usageReviewHour: 40 }), { day: 'Fri', hour: 15 });
  ok('reviewSchedule: Friday 15:00 by default, any day and hour from Settings, or off');

  // ── a builder's scheduled review gets its agents' week ──
  const brief = U.usageBrief('acme', now);
  assert.match(brief, /\| Writer \(writer\) \| 3 \| 2\.5 \| \$5\.50 \|/);
  assert.ok(!brief.includes('agent-builder (agent-builder)'));
  assert.match(brief, /Ask Sam with ask_user before changing any agent/);
  assert.equal(U.usageBrief('northwind', now - 30 * DAY), '');
  ok('usageBrief: the workspace\'s agents, cost per finished task, and the ask-first rule');
} finally {
  assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
}
console.log('test-usage: all passed');
process.exit(0);
