// Orchy in huddles (huddlecoach.mjs) with Jev, Claude, the runner and the account check faked: hard skips make no
// call, the gate decides observe/challenge/advise/withdraw with its thresholds, a challenge makes everyone say ready
// again (readyFrom), advice doesn't, the cap and cooldown hold, a point is never raised twice, an agent pushing back
// gets a withdrawal, Orchy's take only comes with dissent, the writer runs under the huddle workspace's own Claude
// Code account (none set → no coaching at all, never another account), its spend is kept as huddle-coach, and
// Settings off means no calls. Nothing is saved or written, no model runs, no network.
// Uses two made-up workspaces in a throwaway folder under workspaces/. Run: node orchestrator/scripts/test-coach.mjs
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/huddle.mjs';
import * as C from '../lib/huddlecoach.mjs';
import { db } from '../lib/store.mjs';
import { ROOT, config } from '../lib/env.mjs';

config.owner = { name: 'Sam' };
const FOLDER = 'workspaces/__coach-test';
const agentMd = (slug, display, role, call) => `---\nname: ${slug}\ndescription: "${display} for the test workspace"\ndisplay_name: ${display}\nrole: ${role}\ncall_name: ${call}\n---\n\n## Identity\nYou are ${call}.\n`;
for (const [ws, list] of [['acme', [['agent-builder', 'AI Agent Builder', 'Chief of AI Agents', 'Iris'], ['ops-advisor', 'Ops Advisor', 'Advisor', 'Nora']]], ['studio', [['agent-builder', 'AI Agent Builder', 'Chief of AI Agents', 'Juno'], ['chief-marketing-officer', 'Chief Marketing Officer', 'CMO', 'Mira']]]]) {
  const dir = path.join(ROOT, FOLDER, ws, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  for (const [slug, display, role, call] of list) fs.writeFileSync(path.join(dir, `${slug}.md`), agentMd(slug, display, role, call));
}
// acme has a Claude Code profile folder of its own; studio uses the default profile, logged in as its own account.
// They go first in the list, so an install's own "acme" or "studio" workspace is never the one found (and nothing of
// the install's is taken out of the list, in case anything saves it).
const FIXTURES = [
  { id: 'acme', name: 'Acme Workspace', client: 'Acme Inc', blurb: '', folder: `${FOLDER}/acme`, runtime: 'claude', enabled: true, aliases: [], color: 'jade', claudeAccount: 'ops@example.com', claudeConfigDir: '~/.claude-acme' },
  { id: 'studio', name: 'Studio Workspace', client: 'Studio Ltd', blurb: '', folder: `${FOLDER}/studio`, runtime: 'claude', enabled: true, aliases: [], color: 'violet', claudeAccount: 'studio@example.com' },
];
config.workspaces.unshift(...FIXTURES);

let fail = 0;
const ok = (cond, label, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : `  ${extra}`}`); if (!cond) fail++; };

// ── fakes ──
const started = [];
let n = 0;
const fake = {
  startRun: async opts => {
    const run = { id: `run_coach_${++n}`, workspace: opts.workspace, agentSlug: opts.agentSlug, huddle: opts.huddle || null, huddleTalk: !!opts.huddleTalk, sessionId: `sess_${opts.agentSlug}`, instruction: opts.instruction, status: 'working' };
    db().runs[run.id] = run;
    started.push({ opts, run });
    return run;
  },
  stopRun: () => {}, isLive: () => false,
};
const said = [];
H._testIO({ runner: fake, save: () => {}, log: () => {}, files: false, session: () => `s_coach_${++n}`, post: () => {}, preAnswer: async (_w, q) => q, addRule: () => {} });
H.initHuddles({ say: (text, meta) => said.push({ text, meta }) });

let settings = {};
const gates = [];   // every Jev gate call: { state, criteria }
const thinks = [];  // every Claude call: its options
const logs = [];
let gateAnswer = () => ({ choice: 'observe', probabilities: { observe: 0.9 } });
let line = () => ({ speak: false });
const checks = [];
const okCheck = async (ws, o) => { checks.push({ ws: ws.id, runtime: o?.runtime }); return { ok: true, actual: ws.claudeAccount }; };
C._testDeps({
  settings: () => settings,
  jevMode: () => 'typesafe',
  rules: ws => (ws === 'studio' ? "Sam's standing rules (already decided, never ask again):\n- Every video task runs on the strong model at medium effort; never ask Sam.\n" : ''),
  accountCheck: okCheck,
  ask: async (state, qs, o) => { gates.push({ state, criteria: qs.mode.criteria, purpose: o.purpose, timeoutMs: o.timeoutMs }); return { ms: 1, answers: { mode: gateAnswer() } }; },
  think: async o => { thinks.push(o); const v = line(o); return { text: typeof v === 'string' ? v : JSON.stringify(v), costUsd: 0.0125 }; },
  log: m => logs.push(m),
});
const speak = (mode, about, extra = {}) => () => ({ speak: true, mode, about, observation: 'They plan a new service.', concern: 'It adds a moving part nobody owns.', alternative: 'Use the JSON file in Tasks/.', tradeoff: 'Less real-time.', recommendation: 'Start with the file; add the service only if it hurts.', ...extra });
const gateSays = (choice, p) => () => ({ choice, confidence: p, probabilities: { observe: 1 - p, [choice]: p } });

const lastStart = () => started.at(-1);
async function turn(reply) {
  const { run } = lastStart();
  run.huddleReply = reply;
  run.outcome = 'completed';
  run.status = 'done';
  await H.onTurnEnded(run.id);
}
const mine = new Set();
const cleanup = () => { for (const id of mine) delete db().huddles[id]; for (const s of started) delete db().runs[s.run.id]; };

try {
  // ── the gate's thresholds (no huddle needed) ──
  {
    const h = { id: 'h_x', workspace: 'acme', status: 'talking', topic: 't', agents: [{ slug: 'a', name: 'A', role: 'R' }], turns: [] };
    const pick = async ans => { gateAnswer = () => ans; return (await C.gate(h)).mode; };
    ok(await pick({ choice: 'challenge', probabilities: { observe: 0.5, challenge: 0.5 } }) === 'observe', 'observe wins at P(observe) 0.5');
    ok(await pick({ choice: 'challenge', probabilities: { observe: 0.3, challenge: 0.55 } }) === 'challenge', 'challenge wins at P(observe) 0.3, P(challenge) 0.55');
    ok(await pick({ choice: 'advise', probabilities: { observe: 0.4, advise: 0.45, challenge: 0.15 } }) === 'observe', 'a winner under 0.5 stays observe');
    ok(await pick({ choice: 'withdraw', probabilities: { observe: 0.1, withdraw: 0.9 } }) === 'observe', 'withdraw only counts when there is a point to withdraw');
    ok(gates.at(-1).purpose === 'coach' && gates.at(-1).timeoutMs === C.COACH.gateMs && !('withdraw' in gates.at(-1).criteria), 'one Jev call, purpose coach, 8s, no withdraw choice without a pushback');
    ok(/what Sam asked/.test(gates.at(-1).criteria.challenge) && gates.at(-1).state.owner_asked === 't', 'the gate speaks of the owner by their own name', JSON.stringify(gates.at(-1).criteria.challenge));
    gates.length = 0;
  }

  // ── Acme: a new-service proposal; Orchy challenges under Acme's own account ──
  let h = await H.startHuddle({ workspace: 'acme', agents: ['agent-builder', 'ops-advisor'], topic: 'Speed up the weekly ops report.', session: 's_test', maxTurns: 12 });
  mine.add(h.id);
  gateAnswer = gateSays('challenge', 0.8);
  line = speak('challenge', 'New Redis service where a file does', { to: 'agent-builder' });
  await turn({ message: 'Proposal: stand up a new Redis queue service for the report.' });
  ok(!gates.length && !thinks.length, 'fewer than two agent turns: no call at all');
  await turn({ message: 'Too heavy for a weekly report.', challenge: 'Iris, a service is a lot for one report a week.', ready: true });
  h = H.getHuddle(h.id);
  const o = h.turns.at(-1);
  ok(gates.length === 1 && thinks.length === 1, 'second agent turn: the gate, then the writer', JSON.stringify({ g: gates.length, t: thinks.length }));
  ok(o.by === 'orchy' && o.kind === 'coach' && o.mode === 'challenge' && o.about === 'New Redis service where a file does' && o.to === 'agent-builder', 'Orchy’s line is a coach turn in h.turns', JSON.stringify(o));
  ok(/^I challenge for Iris: New Redis/.test(o.text) && /Observation: .+\nConcern: .+\nAlternative: .+\nTrade-off: .+\nRecommendation: /.test(o.text), 'rendered as the five labelled lines', o.text);
  ok(h.readyFrom === h.turns.length - 1, 'a challenge resets readyFrom to Orchy’s line', String(h.readyFrom));
  ok(H.turnsUsed(h) === 2, 'Orchy’s line is not one of the turns the owner allowed');
  const t0 = thinks[0];
  ok(t0.configDir === '~/.claude-acme' && t0.purpose === 'huddle-coach' && t0.workspace === 'acme' && t0.tools === '' && t0.model === 'sonnet', 'Acme’s huddle: the writer runs as Acme’s account (its profile folder), tool-less, recorded as huddle-coach', JSON.stringify({ c: t0.configDir, p: t0.purpose, w: t0.workspace, t: t0.tools, m: t0.model }));
  ok(checks.length && checks.every(c => c.ws === 'acme' && c.runtime === 'claude'), 'the account check is for Acme’s Claude Code profile', JSON.stringify(checks));
  ok(h.coach.count === 1 && h.coach.cost === 0.0125 && h.coach.issues[0].status === 'open', 'the spend and the open point are kept on the huddle', JSON.stringify(h.coach));
  ok(!said.some(x => /Redis/.test(x.text)), 'Orchy’s line does not go to the owner’s chat');
  const { protocolText } = await import('../lib/prompts.mjs');
  const { workspace: wsFor } = await import('../lib/workspaces.mjs');
  const sec = protocolText(wsFor('acme'), { id: 'run_x', workspace: 'acme', agentSlug: 'ops-advisor', agentName: 'Ops Advisor', huddle: h.id, huddleTalk: true });
  ok(/Orchy's points are a teammate's/.test(sec) && /name Orchy in `challenge`/.test(sec) && /can't approve anything or hand out work/.test(sec), 'each turn is told how to treat Orchy’s points, and that he can’t approve or assign');
  ok(/Orchy raised: New Redis service where a file does\. Answer it/.test(lastStart().opts.instruction) && /\*\*Orchy:\*\* I challenge/.test(lastStart().opts.instruction), 'the addressed agent reads it and is told to answer it', lastStart().opts.instruction.slice(-900));

  await turn({ message: 'Fair: a JSON file in Tasks/ instead.', challenge: 'Nora, then you keep the file tidy.', ready: true });
  h = H.getHuddle(h.id);
  ok(gates.length === 1, 'cooldown: no gate call one agent turn after Orchy spoke');
  ok(h.coach.issues[0].status === 'answered' && h.coach.issues[0].answeredBy, 'the addressed agent’s answer marks the point answered');
  ok(h.status === 'talking' && !/Orchy raised/.test(lastStart().opts.instruction), 'still talking: the other agent has to say ready again; the point isn’t repeated to it');
  gateAnswer = gateSays('advise', 0.2);
  await turn({ message: 'Agreed.', ready: true });
  h = H.getHuddle(h.id);
  ok(gates.length === 2 && thinks.length === 1, 'after the cooldown the gate runs again; observe means no writer call');
  ok(h.status === 'wrapping', 'both ready again after Orchy’s challenge: they wrap up');
  line = () => ({ take: 'Go with the file now and review in a month.', why: 'It ships this week, and the service can come later if the file hurts.' });
  await turn({ message: 'Done.', agreement: { summary: 'A JSON file in Tasks/.', work: [{ agent: 'agent-builder', task: 'Add the file step.' }], dissent: ['Nora wants a daily digest; Iris says weekly.'] } });
  h = H.getHuddle(h.id);
  ok(h.status === 'agreed' && h.agreement.orchyTake?.take.startsWith('Go with the file') && thinks.length === 2 && thinks[1].configDir === '~/.claude-acme', 'dissent: Orchy’s take for the owner, under the same account', JSON.stringify(h.agreement.orchyTake));
  ok(/My take is in the proposal/.test(said.at(-1).text) && h.status === 'agreed', 'Orchy points to his take; the owner still approves', said.at(-1).text);
  ok(h.coach.cost === 0.025, 'both calls’ spend recorded', String(h.coach.cost));

  // no dissent: no take
  {
    const th = thinks.length;
    let q = await H.startHuddle({ workspace: 'acme', agents: ['agent-builder', 'ops-advisor'], topic: 'Quick one.', session: 's_test', maxTurns: 2 });
    mine.add(q.id);
    gateAnswer = gateSays('observe', 0.9);
    for (let i = 0; i < 4; i++) await turn({ message: `m${i}` });
    await turn({ message: 'Done.', agreement: { summary: 'x', work: [{ agent: 'agent-builder', task: 't' }] } });
    q = H.getHuddle(q.id);
    ok(q.status === 'agreed' && !q.agreement.orchyTake && thinks.length === th, 'no dissent: no take, no call');
  }

  // ── Studio: advice, a pushback and withdrawal, no repeats, the cap; the rules reach the coach ──
  settings = { huddleCoachMax: 2 };
  gates.length = 0; thinks.length = 0; checks.length = 0;
  let j = await H.startHuddle({ workspace: 'studio', agents: ['agent-builder', 'chief-marketing-officer'], topic: 'Plan the launch video and blog post.', session: 's_test', maxTurns: 20 });
  mine.add(j.id);
  gateAnswer = gateSays('advise', 0.7);
  line = speak('advise', 'Run the two drafts in parallel');
  await turn({ message: 'Video first, then the blog post. Which model should the video run on?', questions_for_owner: ['Which model for the video?'] });
  await turn({ message: 'Fine, but I need the brief first.', challenge: 'Juno, the brief comes before either.' });
  j = H.getHuddle(j.id);
  ok(j.turns.at(-1).mode === 'advise' && j.readyFrom === j.turns.length - 2, 'advice does not reset readyFrom (it stays at the agent’s own challenge)', String(j.readyFrom));
  ok(thinks[0].configDir === null && thinks[0].workspace === 'studio' && checks.every(c => c.ws === 'studio'), 'Studio’s huddle: the writer runs under Studio’s own account (its default profile, checked first)', String(thinks[0].configDir));
  ok(/strong model at medium effort/.test(thinks[0].prompt) && /point to the rule/.test(thinks[0].prompt) && /strong model/.test(gates[0].state.owner_rules), 'the standing rules reach the gate and the writer', gates[0].state.owner_rules);
  await turn({ message: 'Parallel would mean two reviews at once.', challenge: 'Orchy, parallel breaks the review order: the video is reviewed before the blog.' });
  j = H.getHuddle(j.id);
  ok(j.coach.issues[0].pushback?.name && j.coach.issues[0].status === 'open', 'an agent naming Orchy in its challenge disputes the point');
  gateAnswer = gateSays('withdraw', 0.8);
  await turn({ message: 'Right, the order matters.' });
  j = H.getHuddle(j.id);
  ok('withdraw' in gates.at(-1).criteria && j.turns.at(-1).mode === 'withdraw' && /^Orchy withdraws: Run the two drafts in parallel\./.test(j.turns.at(-1).text), 'the gate may concede: “Orchy withdraws”', j.turns.at(-1).text);
  ok(thinks.length === 1 && j.coach.issues[0].status === 'withdrawn' && j.coach.count === 1, 'withdrawing needs no writer call and doesn’t count against the cap');
  ok(/Run the two drafts in parallel/.test(gates.at(-1).state.orchy_already_raised), 'the gate sees what Orchy already raised');
  gateAnswer = gateSays('challenge', 0.8);
  line = speak('challenge', 'Run both drafts in parallel');
  await turn({ message: 'Video first then.' });
  await turn({ message: 'Ok.' });
  j = H.getHuddle(j.id);
  ok(thinks.length === 2 && j.turns.at(-1).by !== 'orchy' && j.coach.count === 1, 'the same point in other words is never raised again', JSON.stringify(j.turns.at(-1)));
  line = speak('challenge', 'No rollback if the export fails');
  await turn({ message: 'Export at 4K tonight.' });
  j = H.getHuddle(j.id);
  ok(j.turns.at(-1).about === 'No rollback if the export fails' && j.coach.count === 2 && j.readyFrom === j.turns.length - 1, 'a new point: Orchy challenges again (2 of 2)');
  const g = gates.length;
  for (let i = 0; i < 3; i++) await turn({ message: `talk ${i}` });
  ok(gates.length === g, 'budget spent: no gate call at all after the cap', `${gates.length - g} calls`);
  H.stopHuddle(j.id);
  settings = {};

  // ── never reacts to itself, a join line, the wrap-up, or with 0 points allowed ──
  ok(C.skipWhy({ status: 'talking', turns: [{ by: 'a' }, { by: 'b' }, { by: 'orchy', kind: 'coach' }] }, { by: 'orchy', kind: 'coach' }, { on: true, max: 3 }) === 'own line', 'never reacts to its own line');
  ok(C.skipWhy({ status: 'talking', turns: [{ by: 'a' }, { by: 'b' }, { by: 'orchy', text: 'X joined', joined: 'c' }] }, { by: 'orchy', joined: 'c' }, { on: true, max: 3 }) === 'own line', 'nor to a join line');
  ok(C.skipWhy({ status: 'talking', turns: [{ by: 'a' }, { by: 'owner' }] }, { by: 'owner' }, { on: true, max: 3 }) === 'own line', 'nor to the owner’s line');
  ok(C.skipWhy({ status: 'wrapping', turns: [{ by: 'a' }, { by: 'b' }] }, { by: 'b' }, { on: true, max: 3 }) === 'wrapping', 'quiet while the agreement is written');
  ok(C.skipWhy({ status: 'talking', turns: [{ by: 'a' }, { by: 'b' }] }, { by: 'b' }, { on: true, max: 0 }) === 'off', '0 interventions: off');
  ok(C.coachSettings({ huddleCoachMax: 9 }).max === 6 && C.coachSettings({ huddleCoachMax: -1 }).max === 0 && C.coachSettings({}).max === 3 && C.coachSettings({ huddleCoach: false }).on === false, 'settings: 0–6 points, 3 by default, on unless switched off');

  // ── accounts, Settings off, no Jev, gate timeout: no calls ──
  const fakeH = (ws, extra = {}) => ({ id: `h_${ws}`, workspace: ws, status: 'talking', topic: 't', readyFrom: 0, agents: [{ slug: 'a', name: 'A', role: 'R' }, { slug: 'b', name: 'B', role: 'R' }], turns: [{ by: 'a', name: 'A', text: 'x' }, { by: 'b', name: 'B', text: 'y' }], ...extra });
  const quiet = async (label, setup, h2 = fakeH('acme')) => {
    gates.length = 0; thinks.length = 0;
    const undo = setup() || (() => {});
    const r = await C.coach(h2, h2.turns.at(-1));
    undo();
    ok(r === null && !gates.length && !thinks.length && !h2.turns.some(t => t.by === 'orchy'), label, JSON.stringify({ r, g: gates.length, t: thinks.length, last: h2.coach?.last }));
    return h2;
  };
  gateAnswer = gateSays('challenge', 0.9);
  line = speak('challenge', 'Something new entirely');
  await quiet('Settings off: no calls', () => { settings = { huddleCoach: false }; return () => { settings = {}; }; });
  const offH = fakeH('acme', { agreement: { summary: 's', dissent: ['x'] } });
  settings = { huddleCoach: false };
  ok(await C.orchyTake(offH) === null && !thinks.length, 'Settings off: no take either');
  settings = {};
  const { workspace: realWs } = await import('../lib/workspaces.mjs');
  const noAcct = await quiet('a workspace with no Claude Code account of its own: no coaching, never another account', () => {
    C._testDeps({ workspace: id => (id === 'x' ? { id: 'x', name: 'Xperiment', runtime: 'claude', claudeAccount: null, claudeConfigDir: null } : realWs(id)) });
  }, fakeH('x'));
  ok(/Xperiment has no Claude Code account of its own/.test(logs.at(-1)) && /never speaks in its huddle from another account/.test(noAcct.coach.off), 'and the log says why', logs.at(-1));
  ok(await C.orchyTake(fakeH('x', { agreement: { summary: 's', dissent: ['x'] } })) === null && !thinks.length, 'no account of its own: no take either');
  C._testDeps({ workspace: realWs });
  await quiet('the profile logged in as someone else: no coaching', () => { C._testDeps({ accountCheck: async () => ({ ok: false, loggedIn: true, actual: 'someone@else.example' }) }); return () => C._testDeps({ accountCheck: okCheck }); });
  ok(/isn't logged in as ops@example\.com \(it's someone@else\.example\)/.test(logs.at(-1)), 'it says whose profile it found', logs.at(-1));
  await quiet('Jev off: no gate, no writer', () => { C._testDeps({ jevMode: () => 'none' }); return () => C._testDeps({ jevMode: () => 'typesafe' }); });
  {
    const was = C.COACH.gateMs;
    C.COACH.gateMs = 20;
    C._testDeps({ ask: () => new Promise(() => {}) });
    thinks.length = 0;
    const h3 = fakeH('acme');
    const t = Date.now();
    const r = await C.coach(h3, h3.turns.at(-1));
    ok(r === null && !thinks.length && h3.coach.last === 'gate down' && Date.now() - t < 2000, 'gate timeout: silent, no writer call', JSON.stringify({ last: h3.coach.last, ms: Date.now() - t }));
    C.COACH.gateMs = was;
  }
  // the writer may decline, or answer with junk: silent
  C._testDeps({ ask: async () => ({ ms: 1, answers: { mode: gateSays('challenge', 0.9)() } }) });
  {
    line = () => ({ speak: false });
    const h4 = fakeH('acme');
    ok(await C.coach(h4, h4.turns.at(-1)) === null && h4.coach.last === 'declined' && h4.coach.calls === 1, 'the writer can still decline (speak:false)');
    line = () => 'not json at all';
    const h5 = fakeH('acme');
    ok(await C.coach(h5, h5.turns.at(-1)) === null && !h5.turns.some(t => t.by === 'orchy'), 'junk from the writer: silent');
  }
  ok(C.sameIssue('New Redis service where a file does', 'A new Redis service where a file would do') && !C.sameIssue('No rollback if the export fails', 'Run the drafts in parallel'), 'same issue in other words is caught; a different one isn’t');
} finally {
  cleanup();
  config.workspaces = config.workspaces.filter(w => !FIXTURES.includes(w)); // the fixtures only, never an install's own
  fs.rmSync(path.join(ROOT, FOLDER), { recursive: true, force: true });
}

console.log(fail ? `\n${fail} failed` : '\nall good');
process.exit(fail ? 1 : 0);
