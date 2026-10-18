// Huddles (huddle.mjs) with the runner faked: turns go round, the first turn hears the topic and later ones a
// digest, the owner's lines reach every agent, they wrap up when all are ready or the turns run out, the agreement only
// gives work to the huddle's own agents, and approval starts each part in the agent's huddle session. Huddles start
// with any number of agents, an agent in one can bring another in (invite), and agents must challenge each other:
// ready only counts after pushing back, a challenge reopens the talk, dissent is kept. The proposal: at most 5 merged
// questions, Orchy's answers from the standing rules, the owner's answers one by one (Remember this → a rule), Send
// back. Also the gate's talk-only rule (policy.mjs), Jev's huddle picks (router.mjs), C-suite agents starting one from
// their own run (startFromRun), and huddles stored by older builds. Nothing is saved, logged or written, no agent
// runs, no Jev call. Uses Beta's Lab Analyst and AI Agent Builder. Run: node orchestrator/scripts/test-huddle.mjs
import * as H from '../lib/huddle.mjs';
import { decide } from '../lib/policy.mjs';
import { route as realRoute, namedAgents, huddlePair } from '../lib/router.mjs';
import { db } from '../lib/store.mjs';
import { workspace } from '../lib/workspaces.mjs';
import { isExecutive } from '../lib/agents.mjs';
import { huddlePartners, huddleInvitees } from '../lib/delegation.mjs';
import { protocolText } from '../lib/prompts.mjs';
import { teamFacts, rulesText, preAnswer } from '../lib/rules.mjs';
import { huddleLogEntry } from '../lib/logs.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config } from '../lib/env.mjs';

// a made-up workspace ("Beta Labs") in a throwaway folder under workspaces/ (git-ignored), removed again at the end;
// config.json is never saved
config.owner = { name: 'Sam' };
const FOLDER = 'workspaces/__huddle-test';
const WS_DIR = path.join(ROOT, FOLDER);
const agentMd = (slug, display, role, call) => `---\nname: ${slug}\ndescription: "${display} for the test workspace"\ndisplay_name: ${display}\nrole: ${role}\ncall_name: ${call}\n---\n\n## Identity\nYou are ${call}.\n`;
fs.mkdirSync(path.join(WS_DIR, '.claude', 'agents'), { recursive: true });
const BETA = [['agent-builder', 'AI Agent Builder', 'Chief of AI Agents', 'Iris'], ['analyst', 'Lab Analyst', 'Analyst', 'Nora'], ['chief-of-staff', 'Chief of Staff', 'Chief of Staff', 'Cass'],
  ['researcher', 'Researcher', 'Researcher', 'Rex'], ['editor', 'Editor', 'Editor', 'Eve'], ['designer', 'Designer', 'Designer', 'Dov']];
for (const [slug, display, role, call] of BETA) fs.writeFileSync(path.join(WS_DIR, '.claude', 'agents', `${slug}.md`), agentMd(slug, display, role, call));
config.workspaces.push({ id: 'beta', name: 'Beta Labs', client: 'Beta Labs Inc', blurb: 'Lab notebooks and sample orders.', folder: FOLDER, runtime: 'claude', enabled: true, aliases: [], color: 'jade', claudeAccount: 'sam@example.com' });

let fail = 0;
const ok = (cond, label, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : `  ${extra}`}`); if (!cond) fail++; };

// ── a fake runner: each turn is a run record we end by hand ──
const started = [];
const stopped = [];
let n = 0;
const fake = {
  startRun: async opts => {
    const run = { id: `run_test_${++n}`, workspace: opts.workspace, agentSlug: opts.agentSlug, isBuilder: opts.agentSlug === 'agent-builder', huddle: opts.huddle || null, huddleTalk: !!opts.huddleTalk, fromHuddle: opts.fromHuddle || null, sessionId: opts.resumeSessionId || `sess_${opts.agentSlug}`, instruction: opts.instruction, status: 'working' };
    db().runs[run.id] = run;
    started.push({ opts, run });
    return run;
  },
  stopRun: rid => { stopped.push(rid); },
  isLive: () => false,
};
const logged = [];
const opened = []; // sessions the huddles opened
const posted = []; // lines put in a session without speaking
let sn = 0;
// Orchy's pre-answer is faked too (no Jev call): it answers questions about the model from a rule
const rulesAdded = [];
const fakePre = async (_ws, qs) => qs.map(q => (/model/i.test(q.q) ? { ...q, orchy: { answer: 'The strong model at medium effort for video work.', source: 'Your standing rule (2026-01-01)' } } : q));
H._testIO({ runner: fake, save: () => {}, log: h => logged.push(h.status), files: false, session: title => { opened.push(title); return `s_huddle_${++sn}`; }, post: (role, text, meta, sid) => posted.push({ role, text, meta, sid }), preAnswer: fakePre, addRule: (ws, text) => rulesAdded.push({ ws, text }), coach: null, coachTake: null }); // Orchy's coaching: test-coach.mjs
const said = [];
H.initHuddles({ say: (text, meta) => said.push({ text, meta }) });

const lastStart = () => started.at(-1);
/** The current turn says something and ends. */
async function turn(reply, outcome = 'completed') {
  const { run } = lastStart();
  run.huddleReply = reply;
  run.outcome = outcome;
  run.status = outcome === 'completed' ? 'done' : outcome;
  await H.onTurnEnded(run.id);
}
const mine = new Set();
const cleanup = () => { for (const id of mine) delete db().huddles[id]; for (const s of started) delete db().runs[s.run.id]; };

try {
  // ── who can huddle ──
  {
    const bad = (slugs, label, re) => { try { H.checkHuddle('beta', slugs); ok(false, label, 'no error'); } catch (e) { ok(re.test(e.message), label, e.message); } };
    bad(['analyst', 'analyst'], 'the same agent twice is refused', /two different agents/);
    bad(['analyst'], 'one agent is refused', /two different agents/);
    bad(['analyst', 'nope'], 'an agent from nowhere is refused', /isn't one of/);
    const { agents } = H.checkHuddle('beta', ['agent-builder', 'analyst']);
    ok(agents[0].isBuilder && !agents[1].isBuilder && agents.every(a => a.name), 'the AI Agent Builder can huddle, with names');
    ok(agents[0].does.includes('Creates and updates') && agents[1].does.includes('Lab Analyst'), 'each agent comes with what it covers');
    ok(H.checkHuddle('beta', BETA.map(b => b[0])).agents.length === 6, 'any number of agents can huddle (no cap)');
  }

  // ── a huddle that agrees ──
  let h = await H.startHuddle({ workspace: 'beta', agents: ['agent-builder', 'analyst'], topic: 'Ask Nora what slows down the weekly report, then update her.', session: 's_test', maxTurns: 6 });
  mine.add(h.id);
  ok(h.status === 'talking' && started.length === 1, 'starting opens the first turn');
  let s = lastStart();
  ok(s.opts.agentSlug === 'agent-builder' && s.opts.huddleTalk && s.opts.huddle === h.id && !s.opts.resumeSessionId && s.opts.model === 'sonnet', 'the first agent named opens, talk-only, a fresh run on the normal tier');
  ok(/Sam asked Orchy to get you and .+ together/.test(s.opts.instruction) && s.opts.instruction.includes('weekly report') && /You open the huddle/.test(s.opts.instruction), 'the opener gets the topic and opens', s.opts.instruction);
  ok(said[0]?.meta?.huddleId === h.id, 'Orchy says the huddle started, with a link to it');
  ok(h.session === 's_huddle_1' && h.askedIn === 's_test' && /^Huddle · .+ \+ .+: Ask Nora/.test(opened[0]), 'each huddle opens a session of its own, titled with who and what', JSON.stringify({ s: h.session, a: h.askedIn, t: opened[0] }));
  ok(posted[0]?.role === 'owner' && posted[0].sid === h.session && posted[0].text.includes('weekly report') && posted[1]?.role === 'orchy' && posted[1].sid === h.session && posted[1].meta.huddleId === h.id, 'that session opens with Sam’s ask and Orchy’s start line', JSON.stringify(posted.slice(0, 2)));
  ok(said[0].meta.session === 's_test' && said[0].meta.huddleSession === h.session && /session of its own/.test(said[0].text), 'where Sam asked, one line points to it', JSON.stringify(said[0]));
  ok(s.opts.session === h.session, 'its turns belong to its own session');

  await turn({ message: 'Nora, what takes longest when you prep the report?', questions_for_owner: ['Which report is next?'] });
  s = lastStart();
  ok(s.opts.agentSlug === 'analyst' && !s.opts.resumeSessionId, 'turns go round; the second agent starts its own run');
  ok(s.opts.instruction.includes('what takes longest') && s.opts.instruction.includes('together on this'), 'the second agent hears the topic and what was said', s.opts.instruction);
  ok(/You haven't challenged anything yet/.test(s.opts.instruction), 'and is asked to push back before it can agree');

  H.ownerSays(h.id, 'Keep it to the Q3 report for now.');
  await turn({ message: 'Pulling the KPI tables out of each sheet by hand.', challenge: 'Iris, a new agent won’t help if the sheets keep changing format.' });
  s = lastStart();
  ok(s.opts.agentSlug === 'agent-builder' && !s.opts.resumeSessionId && s.opts.model === 'sonnet', 'each later talk turn is a fresh run too (the digest carries the talk)');
  ok(/Huddle digest/.test(s.opts.instruction) && /Your past positions/.test(s.opts.instruction) && /Open challenges/.test(s.opts.instruction) && s.opts.instruction.includes('Pulling the KPI') && s.opts.instruction.includes('**Sam:** Keep it to the Q3 report'), 'it gets the digest: its own positions, the open challenge, recent turns and Sam’s line', s.opts.instruction);

  await turn({ message: 'I can give you a KPI extraction step. Agreed?', challenge: 'Nora, then we start with the Q3 format only.', ready: true });
  s = lastStart();
  ok(s.opts.instruction.includes('**Sam:** Keep it to the Q3 report'), 'Sam’s line reaches the other agent too');
  await turn({ message: 'Agreed.', ready: true });
  h = H.getHuddle(h.id);
  ok(h.status === 'wrapping' && h.wrapWhy === 'agreed', 'all ready (after pushing back): they wrap up');
  s = lastStart();
  ok(s.opts.agentSlug === 'agent-builder' && s.opts.model === 'opus' && /Time to wrap up/.test(s.opts.instruction) && s.opts.instruction.includes('`analyst`'), 'the opener writes the agreement on the strong tier, told the slugs', s.opts.instruction);

  await turn({
    message: 'Here is what we agreed.',
    agreement: {
      summary: 'Iris adds a KPI extraction step to Nora.', decisions: ['Q3 report only'],
      work: [{ agent: 'agent-builder', task: 'Update analyst.md with a KPI extraction step.' }, { agent: 'someone-else', task: 'x' }, { agent: 'analyst', task: '' }],
      questions_for_owner: ['Which report is next?', 'Should it cover Q2 too?', 'which report is next'],
    },
  });
  h = H.getHuddle(h.id);
  ok(h.status === 'agreed' && h.agreement.work.length === 1 && h.agreement.work[0].agent === 'agent-builder', 'agreed: only the huddle’s own agents get work, with a task', JSON.stringify(h.agreement.work));
  ok(h.agreement.questions_for_owner.length === 2 && h.agreement.questions[0].id === 'q1', 'questions for Sam are merged without repeats, each with an id', JSON.stringify(h.agreement.questions));
  ok(said.at(-1)?.meta?.kind === 'huddle-agreed' && said.at(-1).meta.session === h.session && logged.includes('agreed') && /View proposal/.test(said.at(-1).text), 'Orchy says they agreed in the huddle’s session (View proposal), and it is logged once', said.at(-1).text);
  ok(H.turnsUsed(h) === 4 && h.turns.filter(t => t.by === 'owner').length === 1 && h.turns.at(-1).wrap, 'turns counted without Sam’s lines or the agreement', String(H.turnsUsed(h)));

  const before = started.length;
  const res = await H.approve(h.id, { note: 'Next report is due Nov 4. Q3 only.' });
  const work = started.slice(before);
  ok(res.huddle.status === 'approved' && work.length === 1, 'approving starts the agreed work');
  ok(work[0].opts.agentSlug === 'agent-builder' && work[0].opts.resumeSessionId === 'sess_agent-builder' && work[0].opts.fromHuddle === h.id && !work[0].opts.huddleTalk, 'in the builder’s huddle session, no longer talk-only');
  ok(work[0].opts.session === h.session, 'the approved work reports to the huddle’s session');
  ok(work[0].opts.instruction.includes('KPI extraction') && work[0].opts.instruction.includes('Nov 4') && work[0].opts.instruction.includes('report_done'), 'with its task and Sam’s note', work[0].opts.instruction);
  try { await H.approve(h.id); ok(false, 'approving twice is refused'); } catch { ok(true, 'approving twice is refused'); }

  // ── the proposal: merged questions, Orchy's answers from the rules, the owner's answers one by one ──
  {
    let p = await H.startHuddle({ workspace: 'beta', agents: ['analyst', 'agent-builder'], topic: 'Redo the report template.', session: 's_test', maxTurns: 2 });
    mine.add(p.id);
    await turn({ message: 'Plan A.', questions_for_owner: ['Which model should Iris run on?'] });
    await turn({ message: 'Plan B.', questions_for_owner: ['Which model should Iris use?', 'Strict order or parallel?'] });
    await turn({ message: 'Fine.', questions_for_owner: ['Which model should Iris run on?'] });
    await turn({ message: 'Fine.' });
    const wrap = lastStart().opts.instruction;
    ok(/at most 5 broad questions/.test(wrap) && /Questions raised during the talk/.test(wrap) && (wrap.match(/Which model should Iris run on/g) || []).length === 1, 'the wrap-up is told to merge, and sees each raised question once', wrap.slice(wrap.indexOf('Time to wrap')));
    await turn({ message: 'Done.', agreement: {
      summary: 'Redo it.', work: [{ agent: 'agent-builder', task: 'Update Nora.' }, { agent: 'analyst', task: 'Draft the template.' }],
      questions_for_owner: [
        { question: 'Which model should Iris run on?', options: ['Strong', 'Normal'] },
        { question: 'Strict order, or parallel builds?', why: 'Settles the order dispute.', options: ['Parallel', 'Strict'], recommended: 'Parallel', covers: ['agent-builder', 'nobody'] },
        { question: 'Strict order, or parallel builds?' },
      ],
    } });
    p = H.getHuddle(p.id);
    const qs = p.agreement.questions;
    ok(qs.length === 2 && qs[0].id === 'q1' && qs[1].recommended === 'Parallel' && qs[1].covers.join() === 'agent-builder', 'the wrap-up’s questions are kept structured, repeats dropped, covers checked', JSON.stringify(qs));
    ok(qs[0].orchy?.answer.includes('strong model') && p.agreement.questions_for_owner.length === 1 && p.agreement.questions_for_owner[0].startsWith('Strict'), 'Orchy answers the model question from the rules; Sam’s list keeps only the rest', JSON.stringify(p.agreement.questions_for_owner));
    ok(/1 question for you first: View proposal/.test(said.at(-1).text) && /I answered 1 from your rules/.test(said.at(-1).text), 'Orchy says how many are left for Sam, and that it answered one', said.at(-1).text);
    const b4 = started.length;
    await H.approve(p.id, { answers: [{ id: 'q2', answer: 'Parallel, header first.', remember: true }], note: 'Thanks.' });
    const runs = started.slice(b4);
    const builder = runs.find(x => x.opts.agentSlug === 'agent-builder').opts.instruction;
    const analyst = runs.find(x => x.opts.agentSlug === 'analyst').opts.instruction;
    ok(builder.includes('Parallel, header first.') && builder.includes('strong model at medium') && builder.includes('(Orchy, from your rules)') && builder.includes('Thanks.') && /Sam's answers to your questions/.test(builder), 'each answer goes in as question → answer, Orchy’s marked as his', builder);
    ok(!analyst.includes('Parallel, header first.') && analyst.includes('strong model at medium'), 'an answer only reaches the agents it covers', analyst);
    ok(rulesAdded.length === 1 && rulesAdded[0].ws === 'beta' && rulesAdded[0].text.includes('→ Parallel, header first.'), '“Remember this” saves the answer as a standing rule', JSON.stringify(rulesAdded));
    ok(H.getHuddle(p.id).agreement.questions[1].answer === 'Parallel, header first.', 'Sam’s answer is kept on the agreement');
    const pLog = huddleLogEntry(H.getHuddle(p.id), workspace('beta'));
    ok(/Answered by Orchy from Sam's standing rules[\s\S]*Which model should Iris run on\? → The strong model at medium effort/.test(pLog) && !/Still contested/.test(pLog), 'the LOGS.md entry lists what Orchy answered from the rules', pLog);

    // sent back: the owner's answers become their line and they rework the plan
    let r = await H.startHuddle({ workspace: 'beta', agents: ['analyst', 'agent-builder'], topic: 'Again.', session: 's_test', maxTurns: 2 });
    mine.add(r.id);
    for (let i = 0; i < 4; i++) await turn({ message: `m${i}`, questions_for_owner: [`Old question ${i}?`] });
    await turn({ message: 'Done.', agreement: { summary: 'x', work: [{ agent: 'agent-builder', task: 't' }], questions_for_owner: [{ question: 'Dates OK?' }] } });
    r = await H.keepTalking(r.id, { answers: [{ id: 'q1', answer: 'Move step 4 sooner.' }] });
    ok(r.status === 'talking' && r.turns.at(-1).by === 'owner' && r.turns.at(-1).answered && /Dates OK\?\n {2}→ Move step 4 sooner\./.test(r.turns.at(-1).text) && /new agreement/.test(r.turns.at(-1).text), 'Send back: Sam’s answers go in as their line, and they write a new agreement', r.turns.at(-1).text);
    // a new agreement with no questions of its own doesn't bring back what the owner answered
    r.turns.push({ by: 'agent-builder', name: 'Iris', text: 'ok', questions: ['New question?'] });
    const again = H.agreementFrom(r, { summary: 'y', work: [] });
    ok(again.questions_for_owner.join() === 'New question?', 'after Send back, only questions raised since Sam answered stand in', JSON.stringify(again.questions_for_owner));
    H.stopHuddle(r.id);
  }

  // ── the turn cap ──
  let c = await H.startHuddle({ workspace: 'beta', agents: ['analyst', 'agent-builder'], topic: 'Talk about nothing in particular.', session: 's_test', maxTurns: 2 });
  mine.add(c.id);
  try { await H.startHuddle({ workspace: 'beta', agents: ['analyst', 'agent-builder'], topic: 'x', session: 's_test' }); ok(false, 'one huddle at a time per workspace'); }
  catch (e) { ok(/already has a huddle/.test(e.message), 'one huddle at a time per workspace', e.message); }
  ok(c.maxTurns === 4, 'each agent gets two turns at least, whatever the setting', String(c.maxTurns));
  ok(H.turnsFor(12, 10) === 24 && H.turnsFor(20, 40) === 40 && H.capFor(20) === 80 && H.turnsFor(30, 10) === 60, 'the budget scales with the agent count, and so does the cap');
  await turn({ message: 'One.' });
  await turn({ message: 'Two.' });
  await turn({ message: 'Three.' });
  ok(lastStart().opts.instruction.includes('last turn'), 'the last turn is flagged', lastStart().opts.instruction);
  await turn({ message: 'Four.' });
  c = H.getHuddle(c.id);
  ok(c.status === 'wrapping' && c.wrapWhy === 'turns' && /4 turns Sam allowed/.test(lastStart().opts.instruction), 'out of turns: they wrap up anyway');
  await turn({ message: 'We did not agree.' });
  c = H.getHuddle(c.id);
  ok(c.status === 'agreed' && c.agreement.work.length === 0 && /without writing an agreement|did not agree/i.test(c.agreement.summary), 'no agreement written: an empty one, nothing to approve');
  try { await H.approve(c.id); ok(false, 'nothing to approve'); } catch (e) { ok(/nobody any work/.test(e.message), 'an agreement without work can’t be approved', e.message); }

  // ── keep talking, then stop ──
  const startedBefore = started.length;
  c = await H.keepTalking(c.id, { text: 'Try again: one concrete change.', more: 4 });
  ok(c.status === 'talking' && c.maxTurns === H.turnsUsed(c) + 4 && c.readyFrom === c.turns.length && started.length === startedBefore + 1, 'Keep talking: more turns, ready flags reset');
  ok(lastStart().opts.agentSlug === 'agent-builder' && lastStart().opts.instruction.includes('Try again'), 'the next agent round the table goes, with Sam’s note', lastStart().opts.agentSlug);
  const cur = lastStart().run.id;
  c = H.stopHuddle(c.id);
  ok(c.status === 'stopped' && stopped.includes(cur), 'Stop ends the huddle and its running turn');
  await turn({ message: 'late words' }, 'stopped');
  c = H.getHuddle(c.id);
  ok(c.status === 'stopped' && started.length === startedBefore + 1, 'a turn ending after Stop starts nothing');

  // ── a failed turn ──
  let f = await H.startHuddle({ workspace: 'beta', agents: ['analyst', 'agent-builder'], topic: 'A turn that fails.', session: 's_test' });
  mine.add(f.id);
  await turn(null, 'failed');
  f = H.getHuddle(f.id);
  ok(f.status === 'failed' && said.at(-1)?.meta?.error, 'a turn that fails without a word stops the huddle and says so');

  // ── an agent brings another in (huddle_reply `invite`), and must challenge before agreeing ──
  {
    let g = await H.startHuddle({ workspace: 'beta', agents: ['analyst', 'agent-builder'], topic: 'Speed up report prep.', session: 's_test', maxTurns: 10 });
    mine.add(g.id);
    const sec = protocolText(workspace('beta'), { id: 'run_x', workspace: 'beta', agentSlug: 'analyst', agentName: 'Lab Analyst', huddle: g.id, huddleTalk: true });
    ok(/Bring someone in/.test(sec) && sec.includes('`chief-of-staff`') && !/- .*`agent-builder`\): Creates/.test(sec), 'each turn is told who it can bring in, not who is already there', sec.slice(sec.indexOf('## You\'re in a huddle')));
    ok(/Challenge each other/.test(sec) && /Who's in the room/.test(sec) && sec.includes('AI Agent Builder: Creates and updates') && /questions_for_owner/.test(sec) && /`dissent`/.test(sec), 'each turn is told to challenge, and what everyone in the room covers', sec.slice(sec.indexOf('## You\'re in a huddle')));
    ok(!/up to \d+ in a huddle/.test(sec), 'no cap on who can be brought in');
    await turn({ message: 'We need the Chief of Staff for the review calendar.', invite: { agent: 'chief-of-staff', why: 'They own the review calendar.' } });
    g = H.getHuddle(g.id);
    s = lastStart();
    ok(g.agents.map(a => a.slug).join() === 'analyst,chief-of-staff,agent-builder', 'the newcomer is seated after whoever brought them in', g.agents.map(a => a.slug).join());
    ok(s.opts.agentSlug === 'chief-of-staff' && !s.opts.resumeSessionId && s.opts.huddleTalk, 'the newcomer speaks next, in a fresh talk-only run');
    ok(/brought you into a huddle with .+ and .+ \(They own the review calendar\)/.test(s.opts.instruction) && s.opts.instruction.includes('Speed up report prep') && s.opts.instruction.includes('review calendar') && /you just joined/.test(s.opts.instruction), 'it hears who brought it in and why, the topic and everything said so far', s.opts.instruction);
    ok(g.turns.at(-1).by === 'orchy' && g.turns.at(-1).joined === 'chief-of-staff' && g.maxTurns === 12 && H.turnsUsed(g) === 1, 'Orchy says who joined in the talk (not a turn); two more turns for them', JSON.stringify({ m: g.maxTurns, u: H.turnsUsed(g) }));
    ok(/brought .+ into the huddle: They own the review calendar/.test(said.at(-1).text) && said.at(-1).meta.huddleId === g.id, 'and tells Sam in the chat');

    await turn({ message: 'Reviews happen Nov 4.', challenge: 'Nora, a full pack by Nov 4 is tight; the KPI page first.', ready: true, invite: { agent: 'analyst', why: 'x' } });
    g = H.getHuddle(g.id);
    s = lastStart();
    ok(g.agents.length === 3 && s.opts.agentSlug === 'agent-builder' && s.opts.instruction.includes('Reviews happen Nov 4') && s.opts.instruction.includes('**Orchy:**'), 'inviting someone already there changes nothing; the round goes on to whoever hasn’t spoken', s.opts.agentSlug);
    await turn({ message: 'Let me add someone.', invite: { agent: 'nobody-here', why: 'x' }, ready: true });
    ok(H.getHuddle(g.id).turns.find(t => t.text === 'Let me add someone.')?.readyUnearned && !H.getHuddle(g.id).turns.find(t => t.text === 'Let me add someone.')?.ready, 'ready without ever pushing back doesn’t count');
    g = H.getHuddle(g.id);
    ok(g.agents.length === 3 && /can't join/.test(g.turns.at(-1).text) && lastStart().opts.agentSlug === 'analyst', 'an agent who can’t join is refused in the talk, and the round goes on');
    ok(lastStart().opts.instruction.includes('can\'t join'), 'the inviter hears why', lastStart().opts.instruction);
    ok(g.status === 'talking', 'not everyone is ready yet: still talking');
    await turn({ message: 'Fine, KPI page first.', challenge: 'Iris, keep the step out of the other sheets.', ready: true });
    ok(lastStart().opts.agentSlug === 'chief-of-staff', 'the round goes on');
    await turn({ message: 'Agreed.', ready: true });
    g = H.getHuddle(g.id);
    ok(g.status === 'talking' && lastStart().opts.agentSlug === 'agent-builder' && /You haven't challenged anything yet/.test(lastStart().opts.instruction), 'an agent that hasn’t pushed back is told its ready won’t count yet', lastStart().opts.instruction);
    await turn({ message: 'Agreed, other sheets stay as they are.', challenge: 'Nora, then I need the Q3 template link.', ready: true });
    await turn({ message: 'Here it is. Agreed.', ready: true });
    g = H.getHuddle(g.id);
    ok(g.status === 'talking', 'a fresh challenge reopens the talk: who agreed before it says so again');
    await turn({ message: 'Agreed.', ready: true });
    g = H.getHuddle(g.id);
    ok(g.status === 'wrapping' && lastStart().opts.agentSlug === 'analyst' && lastStart().opts.instruction.includes('`chief-of-staff`'), 'all three ready: the opener writes the agreement, the newcomer’s slug included', lastStart().opts.instruction);
    ok(/dissent/.test(lastStart().opts.instruction), 'the agreement asks for what they didn’t settle');
    await turn({ message: 'Done.', challenge: 'ignored while wrapping', invite: { agent: 'editor', why: 'late' }, agreement: { summary: 'Prep pack by Nov 4.', dissent: ['Nora wants the full pack; the Chief of Staff says KPI page first.'], work: [{ agent: 'chief-of-staff', task: 'Send the Nov 4 prep timeline.' }, { agent: 'agent-builder', task: 'Add a KPI step to Nora.' }] } });
    g = H.getHuddle(g.id);
    ok(g.status === 'agreed' && g.agents.length === 3 && g.agreement.work.length === 2, 'the newcomer gets work in the agreement; no one joins while it is written', JSON.stringify(g.agreement.work));
    ok(g.agreement.dissent.length === 1 && !g.turns.at(-1).challenge, 'what they still contest is kept for Sam; no pushback while wrapping');
    const gLog = huddleLogEntry({ ...g, agreement: { ...g.agreement, orchyTake: { take: 'Go KPI page first.', why: 'It fits Nov 4.' } } }, workspace('beta'));
    ok(/\*\*Still contested\*\*\n- Nora wants the full pack/.test(gLog) && /Orchy's take\*\* \(advice; Sam decides\): Go KPI page first\. It fits Nov 4\./.test(gLog), 'the LOGS.md entry keeps the dissent and Orchy’s take', gLog);
    ok(/mostly agreed\./.test(said.at(-1).text) && /still contested/.test(said.at(-1).text) && /, .+ and /.test(said.at(-1).text), 'Orchy names all three and flags the contested point', said.at(-1).text);
    const b4 = started.length;
    await H.approve(g.id);
    const cos = started.slice(b4).find(x => x.opts.agentSlug === 'chief-of-staff');
    ok(cos && cos.opts.resumeSessionId === 'sess_chief-of-staff' && /huddle with .+ and .+\. Your part/.test(cos.opts.instruction), 'approved: the newcomer works in its huddle session, told who it huddled with', cos?.opts.instruction);
    ok(huddleInvitees({ workspace: 'beta', agents: BETA.slice(0, 5).map(b => ({ slug: b[0] })) }).map(a => a.slug).join() === 'designer', 'with five in the room, the sixth can still be brought in (no cap)');
  }

  // ── any number of agents from the start ──
  {
    const m = await H.startHuddle({ workspace: 'beta', agents: ['chief-of-staff', 'analyst', 'agent-builder'], topic: 'Plan the Q3 report pack.', session: 's_test', maxTurns: 2 });
    mine.add(m.id);
    ok(m.agents.length === 3 && m.maxTurns === 6, 'three agents start together, two turns each at least', JSON.stringify({ n: m.agents.length, t: m.maxTurns }));
    ok(/, .+ and .+ are huddling/.test(said.at(-1).text), 'Orchy names them all', said.at(-1).text);
    await turn({ message: 'Proposal: one pack, KPI first.' });
    ok(lastStart().opts.agentSlug === 'analyst' && /You haven't challenged anything yet/.test(lastStart().opts.instruction), 'the round goes on, and the next agent is asked to push back');
    H.stopHuddle(m.id);
  }

  // ── a C-suite agent starts one from its own run (Beta's Chief of Staff, with the Lab Analyst) ──
  {
    ok(isExecutive('Chief of Staff') && isExecutive('', 'CMO') && isExecutive('Analyst', '', ['x']) && !isExecutive('CRO Specialist') && !isExecutive('Board Materials Analyst'), 'C-suite: a Chief, a CxO or a department head; not everyone');
    const exec = { id: 'run_test_exec', workspace: 'beta', agentSlug: 'chief-of-staff', agentName: 'Chief of Staff', session: 's_test', routing: null };
    const partners = huddlePartners(exec);
    ok(partners.some(a => a.slug === 'analyst') && !partners.some(a => a.slug === 'chief-of-staff'), 'a C-suite run can huddle with its own workspace’s agents', partners.map(a => a.slug).join());
    ok(!huddlePartners({ ...exec, agentSlug: 'analyst' }).length, 'an agent that isn’t C-suite can’t start one');
    ok(['routing', 'delegatedBy', 'client', 'huddle', 'fromHuddle'].every(k => !huddlePartners({ ...exec, [k]: k === 'routing' ? { source: 'schedule' } : 'x' }).length), 'not from a scheduled, handed-over, client, huddle or huddle-work run');
    const refused = async (run, args, re, label) => { try { await H.startFromRun(run, args); ok(false, label, 'no error'); } catch (e) { ok(re.test(e.message), label, e.message); } };
    await refused({ ...exec, agentSlug: 'analyst', agentName: 'Lab Analyst' }, { agent: 'chief-of-staff', topic: 'x' }, /isn't C-suite/, 'a run that isn’t C-suite is refused');
    await refused(exec, { agent: 'nope', topic: 'x' }, /can't huddle with you\. Who can:/, 'an agent it can’t huddle with is refused, with who it can');
    let x = await H.startFromRun(exec, { agent: 'analyst', topic: 'What do you need from me for the Q3 report pack?' });
    mine.add(x.id);
    s = lastStart();
    ok(x.startedBy?.runId === exec.id && x.agents[0].slug === 'chief-of-staff' && x.askedIn === 's_test' && x.session !== 's_test' && !posted.some(p => p.sid === x.session && p.role === 'owner'), 'the C-suite agent opens, in a new session (no line from Sam), pointed to from its run’s');
    ok(/You asked Orchy for a huddle with/.test(s.opts.instruction) && s.opts.huddleTalk, 'it hears that it asked, and only talks', s.opts.instruction);
    ok(/pulled .+ into a huddle/.test(said.at(-1).text), 'Orchy says who pulled whom in');
    ok(!H.outcomeFor(x).done, 'its run waits while they talk');
    await turn({ message: 'I need the KPI tables by Friday.' });
    ok(/asked Orchy to get you two together while working on a task for Sam/.test(lastStart().opts.instruction), 'the other agent hears who asked', lastStart().opts.instruction);
    await refused(exec, { agent: 'analyst', topic: 'again' }, /already has a huddle going/, 'one huddle per workspace at a time');
    const cur2 = lastStart().run.id;
    H.starterStopped(exec.id);
    x = H.getHuddle(x.id);
    ok(x.status === 'stopped' && stopped.includes(cur2) && H.outcomeFor(x).done, 'stopping the starter’s run stops its huddle, and its wait ends');
    const y = await H.startFromRun(exec, { agent: 'analyst', topic: 'A second one.' });
    mine.add(y.id);
    H.stopHuddle(y.id);
    await refused(exec, { agent: 'analyst', topic: 'A third.' }, /2 huddles/, 'at most two per run');
    const exec2 = { ...exec, id: 'run_test_exec2' };
    await refused(exec2, { agents: [], topic: 'x' }, /Say who to huddle with/, 'it has to say who');
    await refused(exec2, { agents: ['analyst', 'nope'], topic: 'x' }, /nope can't huddle with you/, 'every agent it names is checked');
    const z = await H.startFromRun(exec2, { agents: ['analyst', 'agent-builder'], topic: 'Q3 pack: what each of you needs.' });
    mine.add(z.id);
    ok(z.agents.map(a => a.slug).join() === 'chief-of-staff,analyst,agent-builder' && /pulled .+ and .+ into a huddle/.test(said.at(-1).text), 'a C-suite agent can pull several in at once', said.at(-1).text);
    ok(/ and /.test(H.outcomeFor(z).with), 'its run hears everyone it huddled with', H.outcomeFor(z).with);
    H.stopHuddle(z.id);
  }

  // ── huddles stored by older builds: 'jan' lines, text-only questions ──
  {
    const old = {
      id: 'huddle_test_old', workspace: 'beta', session: 's_old', askedIn: null, topic: 'Old one.', startedBy: null, readyFrom: 0, maxTurns: 6, status: 'agreed', currentRunId: null, workRunIds: [], createdAt: new Date().toISOString(), endedAt: null,
      agents: [{ slug: 'analyst', name: 'Nora', role: 'Lab Analyst', sessionId: 'sess_old', runIds: [] }, { slug: 'agent-builder', name: 'Iris', role: 'AI Agent Builder', isBuilder: true, sessionId: null, runIds: [] }],
      turns: [{ by: 'jan', name: 'Owner', text: 'Steer.' }, { by: 'analyst', name: 'Nora', text: 'ok', ready: true }],
      agreement: { summary: 'Old.', decisions: [], work: [{ agent: 'analyst', task: 'Do the old thing.' }], questions_for_owner: ['Which week?'] },
    };
    db().huddles[old.id] = old;
    mine.add(old.id);
    ok(H.turnsUsed(old) === 1 && H.questionsOf(old.agreement)[0].id === 'q1', 'an old owner line isn’t a turn; text-only questions get ids');
    const b4 = started.length;
    await H.approve(old.id, { answers: [{ id: 'q1', answer: 'Next week.' }] });
    ok(/Which week\?\n {2}→ Next week\./.test(started.slice(b4)[0]?.opts.instruction || ''), 'and the owner can still answer and approve them', started.slice(b4)[0]?.opts.instruction);
  }
} finally {
  cleanup();
}

// ── standing rules (rules.mjs) without Jev or saving: the team's models, the text agents read, Jev's pick ──
{
  const facts = teamFacts('beta', { agents: [{ slug: 'analyst', displayName: 'Lab Analyst', model: 'opus', effort: 'medium' }, { slug: 'editor', displayName: 'Editor', model: 'sonnet' }, { slug: 'designer', displayName: 'Designer', model: 'inherit' }] });
  ok(facts.length === 3 && /Every agent runs on exactly/.test(facts[0].text) && facts[1].text.includes('opus, medium effort'), 'the team’s models: one line for all, then one each (inherit left out)', JSON.stringify(facts));
  ok(rulesText('beta') === '' || /never ask/.test(rulesText('beta')), 'with no rules and no pinned models, agents read nothing extra');
  const qs = [{ id: 'q1', q: 'Which model for the video?' }, { id: 'q2', q: 'Ship Friday?' }];
  const given = [{ text: 'Video runs on the strong model.', source: 'Your standing rule (2026-01-01)' }];
  const ask = async () => ({ answers: { q0: { choice: 'r0', probabilities: { none: 0.1, r0: 0.9 } }, q1: { choice: 'r0', probabilities: { none: 0.4, r0: 0.6 } } } });
  const out = await preAnswer('beta', qs, { ask, facts: given });
  ok(out[0].orchy?.answer === 'Video runs on the strong model.' && !out[1].orchy, 'Jev’s sure pick fills in Orchy’s answer; a weak one stays with the owner', JSON.stringify(out));
  const down = await preAnswer('beta', qs, { ask: async () => { throw Object.assign(new Error('off'), { code: 'NO_JEV' }); }, facts: given });
  ok(down.every(q => !q.orchy), 'Jev off: nothing is filled in');
}

// ── the gate: a huddle turn only talks ──
{
  const ws = workspace('beta');
  const ctx = (method, title) => ({ run: { huddleTalk: true, workspace: 'beta' }, ws, connections: [{ key: 'live::gmail::default::k1', platform: 'gmail', name: 'Beta gmail' }], oneScoped: true, mode: 'decisions', askFor: {}, resolveAction: async () => ({ method, title }) });
  const d = async (tool, input, c = ctx('GET', 'List Messages')) => decide(tool, input, c);
  const huddleNo = v => v.decision === 'deny' && /in a huddle/.test(v.reason);
  ok(huddleNo(await d('Write', { file_path: `${ws.dir}/x.md`, content: 'x' })), 'writing a file is refused');
  ok(huddleNo(await d('Bash', { command: 'rm notes.md' })), 'a command that isn’t a read is refused');
  ok(!huddleNo(await d('Bash', { command: 'ls Tasks' })), 'a plain read goes on to the usual checks');
  ok(!huddleNo(await d('Bash', { command: 'one --agent actions execute gmail conn_mod_def::A::B live::gmail::default::k1' })), 'a One read action goes on');
  ok(huddleNo(await d('Bash', { command: 'one --agent actions execute gmail conn_mod_def::A::B live::gmail::default::k1 -d "{}"' }, ctx('POST', 'Send Email'))), 'a One action that changes data is refused');
  ok(huddleNo(await d('Bash', { command: 'one --agent flow create x' })), '`one flow create` is refused');
  ok(!huddleNo(await d('Bash', { command: 'one --agent actions find gmail "list"' })), 'One lookups go on');
  ok(huddleNo(await d('mcp__notion__create_page', {})), 'an MCP tool that writes is refused');
  ok(!huddleNo(await d('mcp__notion__search', {})), 'an MCP read goes on');
  ok((await d('mcp__jos__huddle_reply', { message: 'x' })).decision === 'allow', 'huddle_reply passes');
  const normal = await decide('Write', { file_path: `${ws.dir}/x.md` }, { ...ctx('GET', 'x'), run: { workspace: 'beta' } });
  ok(normal.decision === 'allow', 'outside a huddle, the same write is allowed as before', JSON.stringify(normal));
}

// ── Jev's huddle picks ──
{
  const agents = [
    { workspace: 'beta', slug: 'agent-builder', displayName: 'AI Agent Builder', isBuilder: true, callName: null },
    { workspace: 'beta', slug: 'analyst', displayName: 'Lab Analyst', callName: 'Nora' },
    { workspace: 'alpha', slug: 'support', displayName: 'Support Agent', callName: 'Pax' },
  ];
  const names = (ws, slug) => ({ 'beta/agent-builder': 'Iris' }[`${ws}/${slug}`] || null);
  ok(namedAgents('huddle Nora and Iris about the deck', agents, names).map(a => a.slug).join() === 'analyst,agent-builder', 'named agents, in the order Sam says them');
  ok(namedAgents('get the agent builder and the lab analyst together', agents, names).map(a => a.slug).join() === 'agent-builder,analyst', 'by role too');
  ok(huddlePair('huddle Nora with Pax', agents, { nameFor: names }).agents.join() === 'analyst', 'never across workspaces');
  const twoBuilders = [{ workspace: 'gamma', slug: 'agent-builder', displayName: 'AI Agent Builder', isBuilder: true }, ...agents];
  const tb = huddlePair('Get the agent builder and the lab analyst together', twoBuilders, { nameFor: names });
  ok(tb.workspace === 'beta' && tb.agents.join() === 'agent-builder,analyst', '"the builder" goes where the other named agent lives', JSON.stringify(tb));
  const p = huddlePair('have them meet', agents, { first: agents[1], second: agents[0], nameFor: names });
  ok(p.workspace === 'beta' && p.agents.join() === 'analyst,agent-builder', 'no names: Jev’s two picks');
  const three = [...agents, { workspace: 'beta', slug: 'chief-of-staff', displayName: 'Chief of Staff', callName: 'Vera' }];
  const t3 = huddlePair('get Vera, Nora and Iris to talk through the pack', three, { first: three[1], second: three[0], nameFor: names });
  ok(t3.agents.join() === 'chief-of-staff,analyst,agent-builder', 'everyone the owner names joins, not just two', t3.agents.join());
  const t1 = huddlePair('get Vera to meet someone about the pack', three, { first: three[1], second: three[3], nameFor: names });
  ok(t1.agents.join() === 'chief-of-staff,analyst', 'one named: topped up to two with Jev’s pick', t1.agents.join());

  const W = [{ id: 'beta', name: 'Beta Labs', client: 'Beta Labs Inc', blurb: '', aliases: [], runtime: 'claude', enabled: true }, { id: 'alpha', name: 'Alpha Studio', client: 'Alpha Studio Ltd', blurb: '', aliases: [], runtime: 'claude', enabled: true }];
  let asked = null;
  const ask = intent => async (state, questions) => { asked = questions; return { model: 'fake', ms: 1, answers: { intent: { choice: intent, confidence: 0.9, probabilities: { [intent]: 0.9 } }, workspace: { choice: 'beta', confidence: 0.9 }, agent: { choice: 'beta/analyst', confidence: 0.8 }, huddle_with: { choice: 'beta/agent-builder', confidence: 0.8 } } }; };
  const r = await realRoute('Huddle Nora and Iris: what does Nora need to prep faster?', { ask: ask('huddle'), workspaces: W, agents, names });
  ok(r.intent === 'huddle' && r.workspace === 'beta' && r.huddle.join() === 'analyst,agent-builder' && !r.needsChoice, 'Jev reads a huddle; the pair is the two Sam named', JSON.stringify({ i: r.intent, w: r.workspace, h: r.huddle, n: r.needsChoice }));
  ok('huddle_with' in asked && 'huddle' in asked.intent.criteria, 'a huddle-sounding message asks who joins');
  await realRoute('check the support inbox', { ask: ask('task'), workspaces: W, agents, names });
  ok(!('huddle_with' in asked), 'an ordinary message doesn’t');
  const one = await realRoute('get Nora to meet someone about the deck', { ask: async () => ({ model: 'fake', ms: 1, answers: { intent: { choice: 'huddle', confidence: 0.9 }, workspace: { choice: 'beta', confidence: 0.9 }, agent: { choice: 'beta/general', confidence: 0.5 } } }), workspaces: W, agents, names });
  ok(one.intent === 'huddle' && one.needsChoice && one.holdReason === 'huddle', 'only one agent known: the card waits for Sam to pick the second', JSON.stringify({ h: one.huddle, r: one.holdReason }));
  const threeR = await realRoute('Huddle Vera, Nora and Iris about the pack', { ask: ask('huddle'), workspaces: W, agents: three, names });
  ok(threeR.huddle.join() === 'chief-of-staff,analyst,agent-builder' && !threeR.needsChoice, 'three named: all three huddle, and the card can count down', JSON.stringify({ h: threeR.huddle, n: threeR.needsChoice }));

  // A message with no huddle word, but two agents of one workspace by first name (Juno is Gamma's builder)
  const gamma = [{ id: 'gamma', name: 'Gamma Works', client: 'Gamma Works Ltd', blurb: '', aliases: [], runtime: 'claude', enabled: true }, ...W];
  const gammaAgents = [
    { workspace: 'gamma', slug: 'agent-builder', displayName: 'AI Agent Builder', isBuilder: true },
    { workspace: 'gamma', slug: 'chief-marketing-officer', displayName: 'Chief Marketing Officer', description: 'Marketing for Sam', team: ['web-search-manager'] },
    { workspace: 'gamma', slug: 'web-search-manager', displayName: 'Web Search Manager', description: 'Search' },
    ...agents,
  ];
  const gammaNames = (ws, slug) => ({ 'gamma/agent-builder': 'Juno', 'gamma/chief-marketing-officer': 'Mira', 'gamma/web-search-manager': 'Otto', 'beta/agent-builder': 'Iris' }[`${ws}/${slug}`] || null);
  const msg = 'Could you brief Juno that the search API connections have been added. Then have her ask Mira who should get access. But make sure Juno gives full access to Mira first for the search API';
  let state = null;
  const huddleJev = async (st, q) => { state = st; asked = q; return { model: 'fake', ms: 1, answers: { intent: { choice: 'huddle', confidence: 0.8, probabilities: { huddle: 0.8 } }, workspace: { choice: 'gamma', confidence: 0.9 }, agent: { choice: 'gamma/agent-builder', confidence: 0.7 }, huddle_with: { choice: 'gamma/chief-marketing-officer', confidence: 0.8 } } }; };
  const kb = await realRoute(msg, { ask: huddleJev, workspaces: gamma, agents: gammaAgents, names: gammaNames, primer: 'how it works' });
  ok(/Juno, AI Agent Builder in Gamma Works \(gamma\/agent-builder\).*Mira, Chief Marketing Officer in Gamma Works \(gamma\/chief-marketing-officer\)/.test(state.agents_named_in_instruction), 'Jev is told who Juno and Mira are, in the order Sam names them', state.agents_named_in_instruction);
  ok('huddle_with' in asked, 'two named agents of one workspace ask who joins, with no huddle word');
  ok(asked.agent.criteria['gamma/agent-builder']?.startsWith('Juno, AI Agent Builder') && asked.agent.criteria['gamma/chief-marketing-officer']?.startsWith('Mira, Chief Marketing Officer') && /Leads a team: Otto/.test(asked.agent.criteria['gamma/chief-marketing-officer']), 'agent choices carry first names, the builder and a head\'s team', JSON.stringify(asked.agent.criteria['gamma/chief-marketing-officer']));
  ok(state.how_orchy_works === 'how it works', 'Jev gets the primer on how Orchy works');
  ok(kb.intent === 'huddle' && kb.workspace === 'gamma' && kb.huddle.join() === 'agent-builder,chief-marketing-officer' && !kb.needsChoice, 'it becomes a Juno–Mira huddle in Gamma, Juno leading', JSON.stringify({ i: kb.intent, w: kb.workspace, h: kb.huddle, n: kb.needsChoice }));
  await realRoute('brief Juno about the new connections', { ask: huddleJev, workspaces: gamma, agents: gammaAgents, names: gammaNames });
  ok(!('huddle_with' in asked), 'one named agent alone doesn\'t ask who joins');
  await realRoute('email Juno and Pax the deck', { ask: huddleJev, workspaces: gamma, agents: gammaAgents, names: gammaNames });
  ok(!('huddle_with' in asked), 'two named agents in different workspaces don\'t either');
}

config.workspaces = config.workspaces.filter(w => w.id !== 'beta');
fs.rmSync(WS_DIR, { recursive: true, force: true });
console.log(fail ? `\n${fail} failed` : '\nall good');
process.exit(fail ? 1 : 0);
