// Huddles (huddle.mjs) with the runner faked: turns alternate and resume each agent's session, the owner's lines reach
// both agents, they wrap up when both are ready or the turns run out, the agreement only gives work to the huddle's
// own agents, and approval starts each part in the agent's huddle session. An agent in it can bring a third in
// (invite): the newcomer speaks next and everyone agrees again. Also the gate's talk-only rule
// (policy.mjs), Jev's huddle picks (router.mjs), and C-suite agents starting one from their own run (startFromRun).
// Nothing is saved, logged or written, and no agent runs.
// Uses Beta's Lab Analyst and AI Agent Builder as the pair. Run: node orchestrator/scripts/test-huddle.mjs
import * as H from '../lib/huddle.mjs';
import { decide } from '../lib/policy.mjs';
import { route as realRoute, namedAgents, huddlePair } from '../lib/router.mjs';
import { db } from '../lib/store.mjs';
import { workspace } from '../lib/workspaces.mjs';
import { isExecutive } from '../lib/agents.mjs';
import { huddlePartners } from '../lib/delegation.mjs';
import { protocolText } from '../lib/prompts.mjs';
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
for (const [slug, display, role, call] of [['agent-builder', 'AI Agent Builder', 'Chief of AI Agents', 'Theo'], ['analyst', 'Lab Analyst', 'Analyst', 'Nora'], ['chief-of-staff', 'Chief of Staff', 'Chief of Staff', 'Cass']]) {
  fs.writeFileSync(path.join(WS_DIR, '.claude', 'agents', `${slug}.md`), agentMd(slug, display, role, call));
}
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
H._testIO({ runner: fake, save: () => {}, log: h => logged.push(h.status), files: false, session: title => { opened.push(title); return `s_huddle_${++sn}`; }, post: (role, text, meta, sid) => posted.push({ role, text, meta, sid }) });
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
  }

  // ── a huddle that agrees ──
  let h = await H.startHuddle({ workspace: 'beta', agents: ['agent-builder', 'analyst'], topic: 'Ask Nora what slows down his board prep, then update him.', session: 's_test', maxTurns: 6 });
  mine.add(h.id);
  ok(h.status === 'talking' && started.length === 1, 'starting opens the first turn');
  let s = lastStart();
  ok(s.opts.agentSlug === 'agent-builder' && s.opts.huddleTalk && s.opts.huddle === h.id && !s.opts.resumeSessionId, 'the first agent named opens, talk-only, a fresh session');
  ok(/Sam asked Orchy to get you and .+ together/.test(s.opts.instruction) && s.opts.instruction.includes('board prep') && /You open the huddle/.test(s.opts.instruction), 'the opener gets the topic and opens', s.opts.instruction);
  ok(said[0]?.meta?.huddleId === h.id, 'Orchy says the huddle started, with a link to it');
  ok(h.session === 's_huddle_1' && h.askedIn === 's_test' && /^Huddle · .+ \+ .+: Ask Nora/.test(opened[0]), 'each huddle opens a session of its own, titled with who and what', JSON.stringify({ s: h.session, a: h.askedIn, t: opened[0] }));
  ok(posted[0]?.role === 'owner' && posted[0].sid === h.session && posted[0].text.includes('board prep') && posted[1]?.role === 'orchy' && posted[1].sid === h.session && posted[1].meta.huddleId === h.id, 'that session opens with Sam’s ask and Orchy’s start line', JSON.stringify(posted.slice(0, 2)));
  ok(said[0].meta.session === 's_test' && said[0].meta.huddleSession === h.session && /session of its own/.test(said[0].text), 'where Sam asked, one line points to it', JSON.stringify(said[0]));
  ok(s.opts.session === h.session, 'its turns belong to its own session');

  await turn({ message: 'Nora, what takes longest when you prep board questions?', questions_for_owner: ['Which board meeting is next?'] });
  s = lastStart();
  ok(s.opts.agentSlug === 'analyst' && !s.opts.resumeSessionId, 'turns alternate; the second agent starts its own session');
  ok(s.opts.instruction.includes('what takes longest') && s.opts.instruction.includes('together on this'), 'the second agent hears the topic and what was said', s.opts.instruction);

  H.ownerSays(h.id, 'Keep it to the Q3 deck for now.');
  await turn({ message: 'Pulling the KPI tables out of each deck by hand.' });
  s = lastStart();
  ok(s.opts.agentSlug === 'agent-builder' && s.opts.resumeSessionId === 'sess_agent-builder', 'the next turn resumes the agent’s own session');
  ok(s.opts.instruction.includes('Pulling the KPI') && s.opts.instruction.includes('**Sam:** Keep it to the Q3 deck') && !s.opts.instruction.includes('together on this'), 'it hears only what is new, Sam included', s.opts.instruction);

  await turn({ message: 'I can give you a KPI extraction step. Agreed?', ready: true });
  s = lastStart();
  ok(s.opts.instruction.includes('**Sam:** Keep it to the Q3 deck'), 'Sam’s line reaches the other agent too');
  await turn({ message: 'Agreed.', ready: true });
  h = H.getHuddle(h.id);
  ok(h.status === 'wrapping' && h.wrapWhy === 'agreed', 'both ready: they wrap up');
  s = lastStart();
  ok(s.opts.agentSlug === 'agent-builder' && /Time to wrap up/.test(s.opts.instruction) && s.opts.instruction.includes('`analyst`'), 'the opener writes the agreement, told the slugs', s.opts.instruction);

  await turn({
    message: 'Here is what we agreed.',
    agreement: {
      summary: 'Theo adds a KPI extraction step to Nora.', decisions: ['Q3 deck only'],
      work: [{ agent: 'agent-builder', task: 'Update analyst.md with a KPI extraction step.' }, { agent: 'someone-else', task: 'x' }, { agent: 'analyst', task: '' }],
      questions_for_owner: ['Which board meeting is next?', 'Should it cover Q2 too?'],
    },
  });
  h = H.getHuddle(h.id);
  ok(h.status === 'agreed' && h.agreement.work.length === 1 && h.agreement.work[0].agent === 'agent-builder', 'agreed: only the huddle’s own agents get work, with a task', JSON.stringify(h.agreement.work));
  ok(h.agreement.questions_for_owner.length === 2, 'questions for Sam are merged without repeats', JSON.stringify(h.agreement.questions_for_owner));
  ok(said.at(-1)?.meta?.kind === 'huddle-agreed' && said.at(-1).meta.session === h.session && logged.includes('agreed'), 'Orchy says they agreed in the huddle’s session, and it is logged once');
  ok(H.turnsUsed(h) === 4 && h.turns.filter(t => t.by === 'owner').length === 1 && h.turns.at(-1).wrap, 'turns counted without Sam’s lines or the agreement', String(H.turnsUsed(h)));

  const before = started.length;
  const res = await H.approve(h.id, { note: 'Next meeting is Nov 4. Q3 only.' });
  const work = started.slice(before);
  ok(res.huddle.status === 'approved' && work.length === 1, 'approving starts the agreed work');
  ok(work[0].opts.agentSlug === 'agent-builder' && work[0].opts.resumeSessionId === 'sess_agent-builder' && work[0].opts.fromHuddle === h.id && !work[0].opts.huddleTalk, 'in the builder’s huddle session, no longer talk-only');
  ok(work[0].opts.session === h.session, 'the approved work reports to the huddle’s session');
  ok(work[0].opts.instruction.includes('KPI extraction') && work[0].opts.instruction.includes('Nov 4') && work[0].opts.instruction.includes('report_done'), 'with its task and Sam’s answers', work[0].opts.instruction);
  try { await H.approve(h.id); ok(false, 'approving twice is refused'); } catch { ok(true, 'approving twice is refused'); }

  // ── the turn cap ──
  let c = await H.startHuddle({ workspace: 'beta', agents: ['analyst', 'agent-builder'], topic: 'Talk about nothing in particular.', session: 's_test', maxTurns: 2 });
  mine.add(c.id);
  try { await H.startHuddle({ workspace: 'beta', agents: ['analyst', 'agent-builder'], topic: 'x', session: 's_test' }); ok(false, 'one huddle at a time per workspace'); }
  catch (e) { ok(/already has a huddle/.test(e.message), 'one huddle at a time per workspace', e.message); }
  await turn({ message: 'One.' });
  ok(lastStart().opts.instruction.includes('last turn'), 'the last turn is flagged', lastStart().opts.instruction);
  await turn({ message: 'Two.' });
  c = H.getHuddle(c.id);
  ok(c.status === 'wrapping' && c.wrapWhy === 'turns' && /2 turns Sam allowed/.test(lastStart().opts.instruction), 'out of turns: they wrap up anyway');
  await turn({ message: 'We did not agree.' });
  c = H.getHuddle(c.id);
  ok(c.status === 'agreed' && c.agreement.work.length === 0 && /without writing an agreement|did not agree/i.test(c.agreement.summary), 'no agreement written: an empty one, nothing to approve');
  try { await H.approve(c.id); ok(false, 'nothing to approve'); } catch (e) { ok(/nobody any work/.test(e.message), 'an agreement without work can’t be approved', e.message); }

  // ── keep talking, then stop ──
  const startedBefore = started.length;
  c = await H.keepTalking(c.id, { text: 'Try again: one concrete change.', more: 4 });
  ok(c.status === 'talking' && c.maxTurns === H.turnsUsed(c) + 4 && c.readyFrom === c.turns.length && started.length === startedBefore + 1, 'Keep talking: more turns, ready flags reset');
  ok(lastStart().opts.agentSlug === 'agent-builder' && lastStart().opts.instruction.includes('Try again'), 'the other agent goes next, with Sam’s note', lastStart().opts.agentSlug);
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

  // ── an agent brings another in (huddle_reply `invite`) ──
  {
    let g = await H.startHuddle({ workspace: 'beta', agents: ['analyst', 'agent-builder'], topic: 'Speed up board prep.', session: 's_test', maxTurns: 4 });
    mine.add(g.id);
    const sec = protocolText(workspace('beta'), { id: 'run_x', workspace: 'beta', agentSlug: 'analyst', agentName: 'Lab Analyst', huddle: g.id, huddleTalk: true });
    ok(/Bring someone in/.test(sec) && sec.includes('`chief-of-staff`') && !/- .*`agent-builder`\): Creates/.test(sec), 'each turn is told who it can bring in, not who is already there', sec.slice(sec.indexOf('## You\'re in a huddle')));
    await turn({ message: 'We need the Chief of Staff for the meeting calendar.', invite: { agent: 'chief-of-staff', why: 'They own the board calendar.' } });
    g = H.getHuddle(g.id);
    s = lastStart();
    ok(g.agents.map(a => a.slug).join() === 'analyst,chief-of-staff,agent-builder', 'the newcomer is seated after whoever brought them in', g.agents.map(a => a.slug).join());
    ok(s.opts.agentSlug === 'chief-of-staff' && !s.opts.resumeSessionId && s.opts.huddleTalk, 'the newcomer speaks next, in a fresh talk-only session');
    ok(/brought you into a huddle with .+ and .+ \(They own the board calendar\)/.test(s.opts.instruction) && s.opts.instruction.includes('Speed up board prep') && s.opts.instruction.includes('meeting calendar') && /you just joined/.test(s.opts.instruction), 'it hears who brought it in and why, the topic and everything said so far', s.opts.instruction);
    ok(g.turns.at(-1).by === 'orchy' && g.turns.at(-1).joined === 'chief-of-staff' && g.maxTurns === 6 && H.turnsUsed(g) === 1, 'Orchy says who joined in the talk (not a turn); two more turns for them', JSON.stringify({ m: g.maxTurns, u: H.turnsUsed(g) }));
    ok(/brought .+ into the huddle: They own the board calendar/.test(said.at(-1).text) && said.at(-1).meta.huddleId === g.id, 'and tells Sam in the chat');

    await turn({ message: 'Board meets Nov 4.', ready: true, invite: { agent: 'analyst', why: 'x' } });
    g = H.getHuddle(g.id);
    s = lastStart();
    ok(g.agents.length === 3 && s.opts.agentSlug === 'agent-builder' && s.opts.instruction.includes('Board meets Nov 4') && s.opts.instruction.includes('**Orchy:**'), 'inviting someone already there changes nothing; the round goes on to whoever hasn’t spoken', s.opts.agentSlug);
    await turn({ message: 'Let me add someone.', invite: { agent: 'nobody-here', why: 'x' }, ready: true });
    g = H.getHuddle(g.id);
    ok(g.agents.length === 3 && /can't join/.test(g.turns.at(-1).text) && lastStart().opts.agentSlug === 'analyst', 'an agent who can’t join is refused in the talk, and the round goes on');
    ok(lastStart().opts.instruction.includes('can\'t join'), 'the inviter hears why', lastStart().opts.instruction);
    ok(g.status === 'talking', 'not everyone is ready yet: still talking');
    await turn({ message: 'Agreed.', ready: true });
    g = H.getHuddle(g.id);
    ok(g.status === 'wrapping' && lastStart().opts.agentSlug === 'analyst' && lastStart().opts.instruction.includes('`chief-of-staff`'), 'all three ready: the opener writes the agreement, the newcomer’s slug included', lastStart().opts.instruction);
    await turn({ message: 'Done.', invite: { agent: 'notion-workspace-manager', why: 'late' }, agreement: { summary: 'Prep pack by Nov 4.', work: [{ agent: 'chief-of-staff', task: 'Send the Nov 4 prep timeline.' }, { agent: 'agent-builder', task: 'Add a KPI step to Nora.' }] } });
    g = H.getHuddle(g.id);
    ok(g.status === 'agreed' && g.agents.length === 3 && g.agreement.work.length === 2, 'the newcomer gets work in the agreement; no one joins while it is written', JSON.stringify(g.agreement.work));
    ok(/agreed\./.test(said.at(-1).text) && /, .+ and /.test(said.at(-1).text), 'Orchy names all three', said.at(-1).text);
    const b4 = started.length;
    await H.approve(g.id);
    const cos = started.slice(b4).find(x => x.opts.agentSlug === 'chief-of-staff');
    ok(cos && cos.opts.resumeSessionId === 'sess_chief-of-staff' && /huddle with .+ and .+\. Your part/.test(cos.opts.instruction), 'approved: the newcomer works in its huddle session, told who it huddled with', cos?.opts.instruction);
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
    let x = await H.startFromRun(exec, { agent: 'analyst', topic: 'What do you need from me for the Q3 board pack?' });
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
  }
} finally {
  cleanup();
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
    { workspace: 'alpha', slug: 'support', displayName: 'Support Agent', callName: 'Leo' },
  ];
  const names = (ws, slug) => ({ 'beta/agent-builder': 'Theo' }[`${ws}/${slug}`] || null);
  ok(namedAgents('huddle Nora and Theo about the deck', agents, names).map(a => a.slug).join() === 'analyst,agent-builder', 'named agents, in the order Sam says them');
  ok(namedAgents('get the agent builder and the lab analyst together', agents, names).map(a => a.slug).join() === 'agent-builder,analyst', 'by role too');
  ok(huddlePair('huddle Nora with Leo', agents, { nameFor: names }).agents.join() === 'analyst', 'never across workspaces');
  const twoBuilders = [{ workspace: 'gamma', slug: 'agent-builder', displayName: 'AI Agent Builder', isBuilder: true }, ...agents];
  const tb = huddlePair('Get the agent builder and the lab analyst together', twoBuilders, { nameFor: names });
  ok(tb.workspace === 'beta' && tb.agents.join() === 'agent-builder,analyst', '"the builder" goes where the other named agent lives', JSON.stringify(tb));
  const p = huddlePair('have them meet', agents, { first: agents[1], second: agents[0], nameFor: names });
  ok(p.workspace === 'beta' && p.agents.join() === 'analyst,agent-builder', 'no names: Jev’s two picks');

  const W = [{ id: 'beta', name: 'Beta Labs', client: 'Beta Labs Inc', blurb: '', aliases: [], runtime: 'claude', enabled: true }, { id: 'alpha', name: 'Alpha Studio', client: 'Alpha Studio Ltd', blurb: '', aliases: [], runtime: 'claude', enabled: true }];
  let asked = null;
  const ask = intent => async (state, questions) => { asked = questions; return { model: 'fake', ms: 1, answers: { intent: { choice: intent, confidence: 0.9, probabilities: { [intent]: 0.9 } }, workspace: { choice: 'beta', confidence: 0.9 }, agent: { choice: 'beta/analyst', confidence: 0.8 }, huddle_with: { choice: 'beta/agent-builder', confidence: 0.8 } } }; };
  const r = await realRoute('Huddle Nora and Theo: what does Nora need to prep faster?', { ask: ask('huddle'), workspaces: W, agents, names });
  ok(r.intent === 'huddle' && r.workspace === 'beta' && r.huddle.join() === 'analyst,agent-builder' && !r.needsChoice, 'Jev reads a huddle; the pair is the two Sam named', JSON.stringify({ i: r.intent, w: r.workspace, h: r.huddle, n: r.needsChoice }));
  ok('huddle_with' in asked && 'huddle' in asked.intent.criteria, 'a huddle-sounding message asks who joins');
  await realRoute('check the support inbox', { ask: ask('task'), workspaces: W, agents, names });
  ok(!('huddle_with' in asked), 'an ordinary message doesn’t');
  const one = await realRoute('get Nora to meet someone about the deck', { ask: async () => ({ model: 'fake', ms: 1, answers: { intent: { choice: 'huddle', confidence: 0.9 }, workspace: { choice: 'beta', confidence: 0.9 }, agent: { choice: 'beta/general', confidence: 0.5 } } }), workspaces: W, agents, names });
  ok(one.intent === 'huddle' && one.needsChoice && one.holdReason === 'huddle', 'only one agent known: the card waits for Sam to pick the second', JSON.stringify({ h: one.huddle, r: one.holdReason }));

  // A message with no huddle word, but two agents of one workspace by first name (Kai is Gamma's builder)
  const gamma = [{ id: 'gamma', name: 'Gamma Works', client: 'Gamma Works Ltd', blurb: '', aliases: [], runtime: 'claude', enabled: true }, ...W];
  const gammaAgents = [
    { workspace: 'gamma', slug: 'agent-builder', displayName: 'AI Agent Builder', isBuilder: true },
    { workspace: 'gamma', slug: 'chief-marketing-officer', displayName: 'Chief Marketing Officer', description: 'Marketing for Sam', team: ['web-search-manager'] },
    { workspace: 'gamma', slug: 'web-search-manager', displayName: 'Web Search Manager', description: 'Search' },
    ...agents,
  ];
  const gammaNames = (ws, slug) => ({ 'gamma/agent-builder': 'Kai', 'gamma/chief-marketing-officer': 'Brooke', 'gamma/web-search-manager': 'Clara', 'beta/agent-builder': 'Theo' }[`${ws}/${slug}`] || null);
  const msg = 'Could you brief Kai that SerpAPI and Data for SEO connections have been added. Then have him ask Brooke who should it give it access to. But make sure Kai gives full access to Brooke first for the SerpAPI and Data for SEO';
  let state = null;
  const huddleJev = async (s, q) => { state = s; asked = q; return { model: 'fake', ms: 1, answers: { intent: { choice: 'huddle', confidence: 0.8, probabilities: { huddle: 0.8 } }, workspace: { choice: 'gamma', confidence: 0.9 }, agent: { choice: 'gamma/agent-builder', confidence: 0.7 }, huddle_with: { choice: 'gamma/chief-marketing-officer', confidence: 0.8 } } }; };
  const kb = await realRoute(msg, { ask: huddleJev, workspaces: gamma, agents: gammaAgents, names: gammaNames, primer: 'how it works' });
  ok(/Kai, AI Agent Builder in Gamma Works \(gamma\/agent-builder\).*Brooke, Chief Marketing Officer in Gamma Works \(gamma\/chief-marketing-officer\)/.test(state.agents_named_in_instruction), 'Jev is told who Kai and Brooke are, in the order Sam names them', state.agents_named_in_instruction);
  ok('huddle_with' in asked, 'two named agents of one workspace ask who joins, with no huddle word');
  ok(asked.agent.criteria['gamma/agent-builder']?.startsWith('Kai, AI Agent Builder') && asked.agent.criteria['gamma/chief-marketing-officer']?.startsWith('Brooke, Chief Marketing Officer') && /Leads a team: Clara/.test(asked.agent.criteria['gamma/chief-marketing-officer']), 'agent choices carry first names, the builder and a head\'s team', JSON.stringify(asked.agent.criteria['gamma/chief-marketing-officer']));
  ok(state.how_orchy_works === 'how it works', 'Jev gets the primer on how Orchy works');
  ok(kb.intent === 'huddle' && kb.workspace === 'gamma' && kb.huddle.join() === 'agent-builder,chief-marketing-officer' && !kb.needsChoice, 'it becomes a Kai–Brooke huddle in Gamma, Kai leading', JSON.stringify({ i: kb.intent, w: kb.workspace, h: kb.huddle, n: kb.needsChoice }));
  await realRoute('brief Kai about the new connections', { ask: huddleJev, workspaces: gamma, agents: gammaAgents, names: gammaNames });
  ok(!('huddle_with' in asked), 'one named agent alone doesn\'t ask who joins');
  await realRoute('email Kai and Leo the deck', { ask: huddleJev, workspaces: gamma, agents: gammaAgents, names: gammaNames });
  ok(!('huddle_with' in asked), 'two named agents in different workspaces don\'t either');
}

fs.rmSync(WS_DIR, { recursive: true, force: true });
console.log(fail ? `\n${fail} failed` : '\nall good');
process.exit(fail ? 1 : 0);
