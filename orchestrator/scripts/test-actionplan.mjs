// Tests for Jev's action plan (lib/actionplan.mjs) with Jev and the One CLI faked.
//   node orchestrator/scripts/test-actionplan.mjs
//   node orchestrator/scripts/test-actionplan.mjs --live <workspace> <agent-slug|general> "<task>"
// --live asks the real Jev and One (read-only in the apps: find/load) and prints the plan and its timings.
// It leaves state.json alone, but logs its Jev calls to data/jev-calls.jsonl and may refresh One's app list
// in data/platforms.json.
import { agentActions, safeIntent, choose, budgetDocs, planText, buildPlan, planFor, planLine, demote, skipReason } from '../lib/actionplan.mjs';
import { workspace, workspaces } from '../lib/workspaces.mjs';
import { getAgent } from '../lib/agents.mjs';

if (process.argv[2] === '--live') {
  const [, , , wsId, slug, ...words] = process.argv;
  const ws = workspace(wsId);
  const agent = slug && slug !== 'general' ? getAgent(ws.id, slug) : null;
  const t0 = Date.now();
  const plan = await planFor({ ws, agent, instruction: words.join(' ') }, { budgetMs: 20_000, deps: { remember: () => {} } });
  if (!plan) { console.log('skipped'); process.exit(0); }
  console.log(planLine(plan.summary));
  console.log(JSON.stringify(plan.summary, null, 2));
  console.log(`\nprompt section: ${plan.text.length.toLocaleString()} chars · wall ${Date.now() - t0}ms\n`);
  console.log(plan.text.split('\n').filter(l => l.startsWith('|') || l.startsWith('###')).join('\n'));
  process.exit(0);
}

let fails = 0;
const ok = (cond, label, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : `  ${extra}`}`); if (!cond) fails++; };
const ID = n => `conn_mod_def::GG${n}::abc_${n}-x`;

// ── reading action IDs out of agent files ──
{
  const md = `---
name: x
connections:
  - key: live::gmail::default::1
---
## Tools
| Action | ID | Access |
|---|---|---|
| gmail · List and View Email Threads | \`${ID(1)}\` | read |
| gmail · Create Draft | \`${ID(2)}\` | write |

Notion:
  - Retrieve a Page \`${ID(3)}\`
  - Retrieve a Page as Markdown \`${ID(4)}\`
- List Phone Numbers: \`${ID(5)}\` (twilio; pass the id twice)
- again \`${ID(1)}\`
`;
  const acts = agentActions(md, ['gmail', 'notion', 'twilio']);
  ok(acts.length === 5, 'every ID once (duplicates dropped)', acts.length);
  ok(acts[0].platform === 'gmail' && /List and View Email Threads/.test(acts[0].label) && !/breadb/.test(acts[0].label), 'table row: platform + words, no access cell', JSON.stringify(acts[0]));
  ok(acts[2].platform === 'notion' && acts[3].platform === 'notion', 'bullets under a "Notion:" line take its platform', JSON.stringify(acts.slice(2, 4)));
  ok(acts[4].platform === 'twilio', 'platform named on the line wins', JSON.stringify(acts[4]));
  ok(!agentActions(`---\nconnections: [x]\n---\nuse ${ID(9)}`, []).some(a => a.platform), 'no platform guessed when none is known');
  ok(agentActions(`---\n---\n- Send it \`${ID(9)}\``, ['google-calendar'])[0].platform === 'google-calendar', 'an agent with one platform: that one');
  ok(agentActions('---\n---\nno ids here', ['gmail']).length === 0, 'a file without IDs gives no candidates');
  ok(agentActions(`---\nx: ${ID(7)}\n---\nbody`, ['gmail']).length === 0, 'IDs in the frontmatter are ignored');
}

// ── small pieces ──
{
  ok(safeIntent(`Reply to "Maria" & $(rm -rf /) | tee; <x> 100%`) === 'Reply to Maria rm -rf / tee x 100', 'shell characters stripped from the find intent', safeIntent(`Reply to "Maria" & $(rm -rf /) | tee; <x> 100%`));
  ok(safeIntent('x'.repeat(900)).length === 300, 'find intent capped');
  const picked = choose([{ n: 'a' }, { n: 'b' }, { n: 'c' }, { n: 'd' }], { a0: { noul: 0.2 }, a1: { noul: 0.9 }, a2: { noul: 0.5 }, a3: { noul: 0.7 } }, 'a', { max: 2 });
  ok(picked.map(x => x.n).join() === 'b,d', 'choose: threshold, most likely first, capped', JSON.stringify(picked));
  ok(choose([{ n: 'a' }], {}, 'a').length === 0, 'choose: an unanswered question is a no');
  const b = budgetDocs([{ docs: 'x'.repeat(20) }, { docs: 'x'.repeat(20) }, { docs: 'x'.repeat(5) }, { docs: null }], 30);
  ok(b.map(a => a.withDocs).join() === 'true,false,true,false', 'docs budget: fill in order, skip what does not fit', JSON.stringify(b.map(a => a.withDocs)));
  const text = planText([{ actionId: ID(1), title: 'Send Email', platform: 'gmail', kind: 'write', withDocs: true, docs: '# Send Email\nbody: to, subject' }, { actionId: ID(2), title: 'Big', platform: 'gmail', withDocs: false }],
    [{ key: 'live::gmail::default::1', platform: 'gmail', name: 'Alpha Support' }]);
  ok(/count as found and read/.test(text) && text.includes('`live::gmail::default::1` (Alpha Support)') && text.includes('# Send Email') && text.includes(`actions load ${ID(2)}`), 'prompt section: keys, docs, load hint for the rest');
  ok(planText([], []) === '', 'no picks, no section');
  const doc = ['# Get', '## Body', '```bash', '# a comment', '```', '##### deep'].join('\n');
  ok(demote(doc) === ['### Get', '#### Body', '```bash', '# a comment', '```', '##### deep'].join('\n'), 'doc headings pushed under the action, code left alone', JSON.stringify(demote(doc)));
}

// ── buildPlan with fakes (a made-up workspace: nothing here depends on the owner's setup) ──
const ws = { id: 'alpha', name: 'Alpha Studio', client: 'Alpha Studio Ltd', dir: 'C:/orchy-test/Alpha Studio', runtime: 'claude', enabled: true };
const fakeAsk = yes => async (state, questions) => ({ ms: 5, answers: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, { type: 'noul', noul: yes(q.instructions, state) }])) });
const calls = [];
const fakeOne = handlers => async (args, opts) => { calls.push({ args, cwd: opts.cwd }); const h = handlers[args[1]]; if (!h) throw new Error('unexpected one ' + args.join(' ')); return h(args); };
const loadAll = args => ({ loaded: args.slice(2).map(id => ({ actionId: id, title: `T ${id.slice(-5)}`, method: 'POST', knowledge: `docs for ${id}` })) });

{
  calls.length = 0;
  const agent = {
    slug: 'support', displayName: 'Support Agent', description: 'support inbox',
    connections: [{ key: 'live::gmail::default::1', platform: 'gmail', name: 'Alpha Support' }, { key: 'live::notion::default::2', platform: 'notion', name: 'Alpha Notion' }],
    markdown: `---\nname: s\n---\n| gmail · List Threads | \`${ID(1)}\` | read |\n| gmail · Create Draft | \`${ID(2)}\` | write |\n| notion · Create Page | \`${ID(3)}\` | write |`,
  };
  const p = await buildPlan({ ws, agent, instruction: 'draft a reply to the latest thread' }, {
    ask: fakeAsk(q => /List Threads|Create Draft/.test(q) ? 0.8 : 0.1),
    oneFn: fakeOne({ load: loadAll }),
    cache: { [ID(1)]: { title: 'List Threads', method: 'POST' } },
    remember: () => {},
  });
  ok(p.summary.status === 'planned' && p.summary.source === 'agent-file', 'agent file: planned from its own IDs', JSON.stringify(p.summary));
  ok(p.summary.actions.map(a => a.actionId).join() === [ID(1), ID(2)].join(), 'agent file: only what Jev said yes to', JSON.stringify(p.summary.actions));
  ok(calls.length === 1 && calls[0].args[1] === 'load' && calls[0].cwd === ws.dir, 'agent file: one load, in the workspace folder, no find', JSON.stringify(calls));
  ok(p.text.includes('`live::gmail::default::1` (Alpha Support)') && !p.text.includes('live::notion'), 'agent file: keys for the picked platform only');
}

{
  calls.length = 0;
  const pool = [{ key: 'live::gmail::default::a', platform: 'gmail', name: 'Alpha Support' }, { key: 'live::gmail::default::b', platform: 'gmail', name: 'Sam personal' }, { key: 'live::stripe::default::c', platform: 'stripe', name: 'One Stripe' }];
  const p = await buildPlan({ ws, agent: null, instruction: `check the Alpha Support inbox for "refund" emails` }, {
    ask: fakeAsk(q => /Alpha Support/.test(q) ? 0.9 : /connection/.test(q) ? 0.1 : /Get Emails|Draft/.test(q) ? 0.7 : 0.2),
    conns: async () => pool, blurbs: () => ({ gmail: "Email" }),
    oneFn: fakeOne({
      find: () => ({ answers: [{ platform: 'gmail', selected: [{ actionId: ID(10), title: 'Get Emails', method: 'POST', knowledge: 'emails docs' }], alternatives: [{ actionId: ID(11), title: 'Create Draft', method: 'POST' }, { actionId: ID(12), title: 'Delete Label', method: 'DELETE' }] }] }),
      load: loadAll,
    }),
    cache: {}, remember: () => {},
  });
  const find = calls.find(c => c.args[1] === 'find');
  ok(p.summary.source === 'find' && p.summary.connections.join() === 'Alpha Support', 'generalist: Jev picks the account the task is about', JSON.stringify(p.summary));
  ok(find && find.args.filter(a => a === 'gmail').length === 1 && !find.args.includes('stripe') && !find.args.join(' ').includes('"'), 'generalist: find only on picked platforms, intent cleaned', JSON.stringify(find?.args));
  ok(p.summary.actions.map(a => a.title).join() === 'Get Emails,Create Draft', 'generalist: Jev filters One\'s results', JSON.stringify(p.summary.actions));
  const load = calls.find(c => c.args[1] === 'load');
  ok(load && load.args.slice(2).join() === ID(11), 'generalist: docs loaded only for picks One gave none for', JSON.stringify(load?.args));
  ok(p.text.includes('live::gmail::default::a') && !p.text.includes('live::gmail::default::b'), 'generalist: only the picked account\'s key');
}

{
  const p = await buildPlan({ ws, agent: { slug: 'x', displayName: 'X', connections: [], markdown: '---\n---\nbody' }, instruction: 'x', client: { id: 'c1' } }, { ask: fakeAsk(() => 1), oneFn: fakeOne({}), blurbs: () => ({}), conns: async () => { throw new Error('must not list the workspace for a client'); } });
  ok(p.summary.status === 'none' && p.text === '', 'client run: an agent without connections gets no plan');
  const q = await buildPlan({ ws, agent: null, instruction: 'write a poem' }, { ask: fakeAsk(() => 0.05), blurbs: () => ({}), conns: async () => [{ key: 'live::gmail::default::a', platform: 'gmail', name: 'G' }], oneFn: fakeOne({}) });
  ok(q.summary.status === 'none' && q.text === '', 'nothing needed: no plan, no find', JSON.stringify(q.summary));
}

{
  // planFor only plans when Settings allow it and the workspace has its own One login (still all faked below)
  const live = workspaces().find(w => w.enabled && !skipReason({ ws: w }));
  if (live) {
    const t0 = Date.now();
    const slowAsk = () => new Promise(r => setTimeout(() => r({ answers: {}, ms: 0 }), 5_000));
    const p = await planFor({ ws: live, agent: null, instruction: `slow ${Date.now()}` }, { budgetMs: 300, deps: { ask: slowAsk, blurbs: () => ({}), conns: async () => [{ key: 'live::gmail::default::a', platform: 'gmail', name: 'G' }], oneFn: fakeOne({}), remember: () => {} } });
    ok(p?.summary.status === 'slow' && Date.now() - t0 < 2_500, 'a slow plan is dropped at the deadline', `${p?.summary.status} ${Date.now() - t0}ms`);
  } else console.log('skip a slow plan is dropped at the deadline (action plans are off in Settings, or no workspace has its own One login)');
  ok(await planFor({ ws, agent: null, instruction: 'x', isBuilder: true }) === null, 'builds get no plan');
  ok(await planFor({ ws, agent: null, instruction: 'x', resume: true }) === null, 'resumed follow-ups get no plan');
}

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
