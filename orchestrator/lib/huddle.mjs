// Huddles: two or more agents of one workspace talk a task through, turn by turn, with Orchy as moderator. Any
// agent in it may bring another agent of the workspace in (huddle_reply `invite`, bringIn below; no cap): the
// newcomer is seated after whoever brought them in and speaks next, having read the talk so far; turns go round.
// They challenge each other: each tests the others' proposals from its own role (huddle_reply `challenge`). An
// agent's `ready` only counts once it has pushed back on something, and a fresh challenge reopens the talk (everyone
// says ready again after it). What they never settle goes in the agreement as `dissent`.
// Each turn is a short Orchy run of that agent (runner.startRun with `huddle`): the first one hears the topic, later
// ones a compact digest of the talk (huddleDigest), so a long huddle doesn't drag its whole history along. Turns only
// talk: the gate refuses anything that changes something (policy.mjs#huddleTalk), and a turn ends with the bridge
// tool huddle_reply. Orchy reads along and now and then speaks himself (huddlecoach.mjs). When all say they agree,
// or the turn budget is spent, the first agent writes the agreement: at most 5 merged questions for the owner, which
// Orchy first checks against the owner's standing rules (rules.mjs#preAnswer). Nothing is built until the owner
// approves it; then each agent does its part as a normal run in the same session (an Agent Builder in the huddle
// updates the agents that need it). Same workspace only (accounts never mix), two or more agents to start, only
// agents on an engine that can huddle (capabilities.huddles), never an agent shared with a client. The owner starts
// one (chat, Huddle window, Workspaces window), or a C-suite agent does from its own run with the bridge tool
// `huddle` (startFromRun): it opens, and its run waits for the result.
import fs from 'node:fs';
import path from 'node:path';
import { db, save, id } from './store.mjs';
import { emit, bus } from './bus.mjs';
import { workspace, engineFor } from './workspaces.mjs';
import { engine } from './engines/index.mjs';
import { getAgent, BUILDER_SLUG } from './agents.mjs';
import { nameOf } from './voiceagents.mjs';
import { clientSharedSlugs, cantHuddle, huddlePartners, huddleInvitees, MAX_RUN_HUDDLES } from './delegation.mjs';
import { appendHuddleLog } from './logs.mjs';
import { taskRootFor } from './tasks.mjs';
import { tasksBase, taskRel } from './clientspace.mjs';
import { config, ownerName } from './env.mjs';
import { ensureSession, post as postChat } from './sessions.mjs';
import * as runner from './runner.mjs';
import { rulesText, preAnswer, addRule } from './rules.mjs';
import { coach as coachTurn, orchyTake, raisedFor, MODE_LABEL } from './huddlecoach.mjs';

// `join`: extra turns when an agent is brought in, so the newcomer has room to talk. `each`: every agent gets at
// least this many turns (one to propose or answer, one to challenge), so a bigger huddle gets more; the cap grows with it.
export const TURNS = { default: 10, min: 2, max: 40, more: 6, join: 2, each: 2 };
export const capFor = n => Math.max(TURNS.max, n * 4);
export const turnsFor = (n, base) => Math.min(capFor(n), Math.max(base, n * TURNS.each));
// the tiers a turn runs on (runner.mjs maps them onto the agent's own engine): talk is normal, the agreement strong
const TALK_MODEL = 'sonnet';
const WRAP_MODEL = 'opus';
const TALKING = new Set(['talking', 'wrapping']);

let say = () => {};
// what a huddle touches outside itself; tests swap these for fakes (no agent runs, no files, no saves, no Jev).
// Every huddle gets an Orchy session of its own (`session`), and `post` puts a line in a session without speaking it.
// `coach`/`coachTake`: Orchy's part in the talk (huddlecoach.mjs); `preAnswer`/`addRule`: the standing rules (rules.mjs).
const io = {
  runner, save, log: appendHuddleLog, files: true, preAnswer, addRule, coach: coachTurn, coachTake: orchyTake,
  session: title => ensureSession(null, { text: title, origin: 'huddle' }).id,
  post: (role, text, meta, sid) => postChat(role, text, meta, sid),
};
export function _testIO(over) { Object.assign(io, over); }
/** server.mjs hands over how Orchy speaks in a session (orchy.say). */
export function initHuddles(opts = {}) {
  if (opts.say) say = opts.say;
  // Orchy restarted mid-huddle: the turn that was running is gone, so the huddle waits for the owner (Keep talking)
  for (const h of Object.values(all())) {
    if (TALKING.has(h.status) && !(h.currentRunId && io.runner.isLive(h.currentRunId))) end(h, 'failed', 'Orchy restarted while they were talking. Keep talking picks it up again.');
  }
}

const all = () => (db().huddles ||= {});
export const getHuddle = hid => {
  const h = all()[hid];
  if (!h) throw Object.assign(new Error('That huddle is gone'), { status: 404 });
  return h;
};
export const listHuddles = (limit = 30) => Object.values(all()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
export const publicHuddle = h => h;
// the owner's lines ('jan' in huddles stored by older builds)
const isOwnerLine = t => t.by === 'owner' || t.by === 'jan';
// an agent's turn (not the owner's lines, not Orchy's)
const isTalk = t => !isOwnerLine(t) && t.by !== 'orchy';
/** Has this agent pushed back on anything yet? Its `ready` only counts once it has. */
export const hasChallenged = (h, slug) => h.turns.some(t => t.by === slug && t.challenge);
// the agreement itself isn't one of the turns the owner allowed
export const turnsUsed = h => h.turns.filter(t => isTalk(t) && !t.wrap).length;
export const maxTurnsSetting = () => {
  const n = Number(db().settings.huddleTurns);
  return Number.isFinite(n) ? Math.min(TURNS.max, Math.max(TURNS.min, Math.round(n))) : TURNS.default;
};
const othersOf = (h, slug) => h.agents.filter(a => a.slug !== slug);
const partOf = (h, slug) => h.agents.find(a => a.slug === slug);
// who speaks after this agent: the next one round the table (a newcomer sits after whoever brought them in)
const nextAfter = (h, slug) => h.agents[(h.agents.findIndex(a => a.slug === slug) + 1) % h.agents.length];
/** "Ada", "Ada and Ben", "Ada, Ben and Cleo" */
export const nameList = names => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
const whoRoles = list => nameList(list.map(o => `${o.name} (${o.role})`));
/** The agreement's questions, for huddles stored before they were kept structured. */
export const questionsOf = g => (g?.questions?.length ? g.questions : (g?.questions_for_owner || g?.questions_for_jan || []).map((q, i) => ({ id: `q${i + 1}`, q: String(q) })));

function changed(h) {
  io.save();
  emit('huddle.updated', { huddle: publicHuddle(h) });
}

/** An agent's place in a huddle: its name, role, what it covers and (once it has spoken) its own session. */
const partFor = (ws, a) => ({
  slug: a.slug, name: nameOf(ws.id, a.slug) || a.callName || a.displayName, role: a.displayName, isBuilder: a.slug === BUILDER_SLUG,
  // what it covers, so the others know what it can speak to (and where to challenge it)
  does: a.slug === BUILDER_SLUG ? `Creates and updates ${ws.name}'s agents.` : String(a.description || '').replace(/\s+/g, ' ').slice(0, 200),
  sessionId: null, runIds: [],
});

/** Can these agents (two or more) huddle? Returns their summaries, or throws with a reason the owner (or Jev's card) can act on. */
export function checkHuddle(wsId, slugs) {
  const ws = workspace(wsId);
  if (!ws.enabled) throw Object.assign(new Error(`${ws.name} is switched off`), { status: 409 });
  const list = [...new Set((slugs || []).map(s => String(s || '').trim()).filter(Boolean))];
  if (list.length < 2) throw Object.assign(new Error('A huddle needs at least two different agents of the same workspace'), { status: 400 });
  const shared = clientSharedSlugs(ws.id);
  const agents = list.map(slug => {
    let a;
    try { a = getAgent(ws.id, slug); } catch { a = null; }
    if (!a || a.error) throw Object.assign(new Error(`${slug} isn't one of ${ws.name}'s agents${a?.error ? ` (its file is broken: ${a.error})` : ''}`), { status: 400 });
    if (shared.has(slug)) throw Object.assign(new Error(`${a.displayName} works with one of your clients, so it can't join a huddle`), { status: 403 });
    const eng = engine(engineFor(ws, slug === BUILDER_SLUG ? null : a));
    if (!eng?.capabilities.huddles) throw Object.assign(new Error(`${a.displayName} runs on ${eng?.label || 'another engine'}, and huddles are Claude Code only for now`), { status: 400 });
    return partFor(ws, a);
  });
  const busy = Object.values(all()).find(h => h.workspace === ws.id && TALKING.has(h.status));
  if (busy) throw Object.assign(new Error(`${ws.name} already has a huddle going (${busy.agents.map(a => a.name).join(' + ')}). Let it finish or stop it first.`), { status: 409 });
  return { ws, agents };
}

/**
 * Start a huddle: the first agent named opens it (and writes the agreement at the end).
 * `startedBy` ({ runId, slug, name }) when a C-suite agent asked for it from its own run (startFromRun).
 * It lives in a new Orchy session of its own (`h.session`: its start, joins, agreement and the approved work's
 * reports); the session it was asked from (`h.askedIn`) gets one line pointing there.
 */
export async function startHuddle({ workspace: wsId, agents: slugs, topic, session, maxTurns, startedBy = null }) {
  const text = String(topic || '').trim();
  if (!text) throw Object.assign(new Error('Say what the huddle is about'), { status: 400 });
  const { ws, agents } = checkHuddle(wsId, slugs);
  const own = io.session(`Huddle · ${agents.map(a => a.name).join(' + ')}: ${text}`);
  const base = Number(maxTurns) > 0 ? Math.min(TURNS.max, Math.max(TURNS.min, Math.round(maxTurns))) : maxTurnsSetting();
  const h = {
    id: id('huddle'), workspace: ws.id, session: own, askedIn: session && session !== own ? session : null, topic: text, agents, startedBy,
    turns: [], readyFrom: 0, maxTurns: turnsFor(agents.length, base),
    status: 'talking', currentRunId: null, agreement: null, workRunIds: [], createdAt: new Date().toISOString(), endedAt: null,
  };
  all()[h.id] = h;
  changed(h);
  // the huddle's own session opens with the ask (the owner's words, or the agent's), then Orchy's start line
  const meta = { huddleId: h.id, kind: 'huddle', workspace: ws.id };
  if (!startedBy) io.post('owner', text, {}, own); // as the owner asked it; the session's title says who's huddling
  const pulled = `${agents[0].name} pulled ${nameList(agents.slice(1).map(a => a.name))} into a huddle`;
  const together = `${nameList(agents.map(a => a.name))} are huddling`;
  const start = startedBy
    ? `${pulled} in ${ws.name}: ${text.length > 220 ? `${text.slice(0, 220)}…` : text}\n\nOpen it to read along or jump in; nothing gets built until you approve what they agree.`
    : `${together} in ${ws.name} on it. Open the huddle to read along or jump in; nothing gets built until you approve what they agree.`;
  if (!h.askedIn) say(start, { ...meta, session: own });
  else {
    io.post('orchy', start, meta, own);
    say(`${startedBy ? pulled : together} in ${ws.name}. It has a session of its own, where you'll hear how it goes and approve what they agree.`, { ...meta, huddleSession: own, session: h.askedIn });
  }
  await nextTurn(h, agents[0]).catch(e => end(h, 'failed', e.message));
  return h;
}

const refuse = (msg, status = 403) => Object.assign(new Error(msg), { status });

/**
 * A C-suite agent starts a huddle from its own run (bridge tool `huddle`): it opens with the topic it wrote, in the
 * session its run belongs to. `agents` (one or more slugs; `agent` from older bridges). Its own workspace only, at
 * most MAX_RUN_HUDDLES per run, one huddle per workspace at a time.
 */
export async function startFromRun(run, { agent, agents, topic } = {}) {
  const why = cantHuddle(run);
  if (why) throw refuse(why);
  const partners = huddlePartners(run);
  if (!partners.length) throw refuse(`${run.agentName} isn't C-suite (a Chief, a CxO or a department head), so it can't start huddles. Do it yourself, or ask ${ownerName()}.`);
  const slugs = [...new Set([...(Array.isArray(agents) ? agents : []), agent].map(s => String(s || '').trim()).filter(s => s && s !== run.agentSlug))];
  const who = () => partners.map(a => `${nameOf(run.workspace, a.slug) || a.callName || a.displayName} (\`${a.slug}\`)`).join(', ');
  if (!slugs.length) throw refuse(`Say who to huddle with. Who can: ${who()}.`, 400);
  const wrong = slugs.filter(s => !partners.some(a => a.slug === s));
  if (wrong.length) throw refuse(`${wrong.join(', ')} can't huddle with you. Who can: ${who()}.`);
  if (Object.values(all()).filter(h => h.startedBy?.runId === run.id).length >= MAX_RUN_HUDDLES) throw refuse(`You've started ${MAX_RUN_HUDDLES} huddles in this task already. Work with what they agreed.`, 429);
  const name = nameOf(run.workspace, run.agentSlug) || run.agentName;
  return startHuddle({ workspace: run.workspace, agents: [run.agentSlug, ...slugs], topic, session: run.session, startedBy: { runId: run.id, slug: run.agentSlug, name } });
}

/** What a huddle came to, for the run that started it (the bridge's `huddle` tool waits for this). */
export function outcomeFor(h) {
  const done = !TALKING.has(h.status);
  return { done, status: h.status, note: h.note || null, turns: turnsUsed(h), agreement: h.agreement, taskDir: h.taskDir || null, taskRel: taskRel(h), with: nameList(h.agents.slice(1).map(a => a.name)) };
}

// ── turns ──

/**
 * Everything said since this agent's last prompt (the other agents' turns, the owner's and Orchy's). Counted from what
 * it was shown, not from its own last line: the owner may jump in while it's mid-turn, and that line still has to reach it.
 */
function unseen(h, a) {
  return h.turns.slice(a.seen || 0).filter(t => t.by !== a.slug);
}
const line = t => `**${isOwnerLine(t) ? ownerName() : t.name}:** ${t.text}`;

const trimLine = (s, n = 320) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

/** The compact digest every turn after an agent's first gets: its own positions, open challenges, the recent talk. */
export function huddleDigest(h, a) {
  const os = othersOf(h, a.slug);
  const by = h.startedBy;
  const starter = by && partOf(h, by.slug);
  const openerWho = !by ? ownerName() : by.slug === a.slug ? 'you' : `${by.name}${starter ? ` (${starter.role})` : ''}`;
  const mine = h.turns.filter(t => t.by === a.slug);
  const challenges = h.turns.slice(h.readyFrom || 0).filter(t => t.challenge);
  const allChallenges = challenges.length ? challenges : h.turns.filter(t => t.challenge).slice(-4);
  const tail = h.turns.slice(-6);
  // the owner's and Orchy's lines it hasn't seen always reach it, even when older than the last six
  const unseenSpecial = unseen(h, a).filter(t => (isOwnerLine(t) || t.by === 'orchy') && !tail.includes(t));
  const recent = [...unseenSpecial, ...tail];
  let out = `Huddle digest (opened by ${openerWho} with ${whoRoles(os)}):\n\n> ${h.topic.replace(/\n/g, '\n> ')}\n\n`;
  if (mine.length) {
    out += `Your past positions (${a.name}):\n${mine.map((t, i) => `- Turn ${i + 1}: ${trimLine(t.text, 300)}${t.challenge ? ` [challenged: ${trimLine(t.challenge, 200)}]` : ''}`).join('\n')}\n\n`;
  }
  if (allChallenges.length) {
    out += `Open challenges:\n${allChallenges.map(t => `- **${t.name}:** ${trimLine(t.challenge, 300)}`).join('\n')}\n\n`;
  }
  if (recent.length) {
    out += `Recent turns (last ${recent.length} of ${h.turns.length}):\n\n${recent.map(line).join('\n\n')}\n\n`;
  }
  return out;
}

export function turnPrompt(h, a) {
  const who = ownerName();
  const os = othersOf(h, a.slug);
  const news = unseen(h, a);
  const first = !a.sessionId && !(a.runIds?.length);
  const by = h.startedBy;
  const starter = by && partOf(h, by.slug);
  const why = a.joinedBy?.why ? ` (${a.joinedBy.why.replace(/[.\s]+$/, '')})` : '';
  const ask = a.joinedBy ? `${a.joinedBy.name} brought you into a huddle with ${whoRoles(os)}${why}. ${by ? `${by.name} started it while working on a task for ${who}` : `${who} asked Orchy for it`}, to work out this`
    : !by ? `${who} asked Orchy to get you and ${whoRoles(os)} together on this`
    : by.slug === a.slug ? `You asked Orchy for a huddle with ${whoRoles(os)} while working on a task for ${who}, to work out this`
    : `${by.name}${starter ? ` (${starter.role})` : ''} asked Orchy to get you ${h.agents.length === 2 ? 'two ' : 'all '}together while working on a task for ${who}, to work out this`;
  const head = first ? `${ask}:\n\n> ${h.topic.replace(/\n/g, '\n> ')}\n\n` : huddleDigest(h, a);
  const said = first && news.length ? `Said so far:\n\n${news.map(line).join('\n\n')}\n\n` : '';
  if (h.status === 'wrapping') return `${head}${said}${wrapText(h)}`;
  const left = h.maxTurns - turnsUsed(h);
  const opener = !h.turns.some(isTalk);
  // nobody agrees by default: until this agent has pushed back on something, its ready won't count, and Orchy says so
  const owes = !opener && !hasChallenged(h, a.slug)
    ? ` You haven't challenged anything yet: before you can agree, test what's been proposed from your role as ${a.role} (what's wrong, missing, risky or too costly, what your side would need, or a better option) and put it in \`challenge\`.`
    : '';
  return `${head}${said}${opener ? `You open the huddle: propose how to go about it and what you need from ${nameList(os.map(o => o.name))}. They'll test it from their roles, so give your reasons.` : first && a.joinedBy ? 'Your turn: you just joined, so say what you bring to this and where you see it differently.' : 'Your turn.'}${owes}${raisedFor(h, a.slug)}${left <= 2 ? ` ${left === 1 ? 'This is the last turn' : 'Two turns left'} before the agreement, so converge: settle what you can and leave the rest as contested.` : ''} End with huddle_reply.`;
}

function wrapText(h) {
  const who = ownerName();
  const why = h.wrapWhy === 'turns' ? `: that's the ${h.maxTurns} turns ${who} allowed` : '';
  return `Time to wrap up${why}. Write the agreement now with huddle_reply: a one-line \`message\` to close, and \`agreement\`:
- \`summary\`: what you agreed, in a few sentences, for ${who}.
- \`decisions\`: the choices you made.
- \`work\`: each agent's part once ${who} approves, as a complete task: \`agent\` is the slug (${h.agents.map(a => `\`${a.slug}\` for ${a.name}`).join(', ')}) and \`task\` says what to do, with the names, links, IDs and details from this talk. Leave an agent out if it has nothing to do.
- \`questions_for_owner\`: **at most 5 broad questions** that together settle everything only ${who} can answer. ${who} answers them one at a time, so merge: one general question per decision, never the same question twice in other words, and a contested point (dissent) becomes one question with each side as an option. Give each \`options\` (2–4 short answers), \`recommended\` when you agree on one, \`why\` (what it settles) and \`covers\` (slugs whose work it changes). Don't ask what the rules below already answer.
- \`dissent\`: each challenge you didn't settle, as "who holds what view, and why", so ${who} can decide. Don't paper over it.
Where you didn't agree, say so in the summary and leave it out of the work. Say in the summary what changed because someone pushed back.${raisedText(h)}${rulesBlock(h)}`;
}

// every question the talk left for the owner, so the wrap-up merges them instead of piling them up
function raisedText(h) {
  const raised = dedupe(openQuestionTurns(h).flatMap(t => (t.questions || []).map(q => ({ by: t.name, q }))));
  return raised.length ? `\n\nQuestions raised during the talk (merge them, don't list them one by one):\n${raised.map(x => `- ${x.by}: ${x.q}`).join('\n')}` : '';
}
// turns whose questions are still open: once the owner sends a proposal back with answers, what was asked before is settled
function openQuestionTurns(h) {
  let from = 0;
  h.turns.forEach((t, i) => { if (isOwnerLine(t) && t.answered) from = i + 1; });
  return h.turns.slice(from);
}
function rulesBlock(h) {
  let t = '';
  try { t = rulesText(h.workspace); } catch {}
  return t ? `\n\n${t}` : '';
}
const qKey = q => String(q).toLowerCase().replace(/\W+/g, ' ').trim();
const dedupe = xs => { const seen = new Set(); return xs.filter(x => { const k = qKey(x.q ?? x); return k && !seen.has(k) && !!seen.add(k); }); };
const cap = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** The wrap-up's questions as Orchy keeps them: { q, why, options, recommended, covers } (plain strings from older agents too). */
export function questionsIn(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, 20).map(x => {
    if (typeof x === 'string' || typeof x === 'number') return { q: cap(x, 600) };
    if (!x || typeof x !== 'object') return null;
    const list = v => (Array.isArray(v) ? v : []).map(o => cap(o, 200)).filter(Boolean);
    const options = list(x.options).slice(0, 4);
    const rec = cap(x.recommended, 200);
    const why = cap(x.why, 400);
    const covers = list(x.covers).slice(0, 20);
    return { q: cap(x.question ?? x.q, 600), ...(why ? { why } : {}), ...(options.length ? { options } : {}), ...(rec ? { recommended: rec } : {}), ...(covers.length ? { covers } : {}) };
  }).filter(x => x?.q);
}

async function nextTurn(h, a) {
  if (!TALKING.has(h.status)) return;
  const prompt = turnPrompt(h, a);
  a.seen = h.turns.length;
  // every turn is a fresh short run (the digest carries the talk); the agreement is written on the strong tier
  const run = await io.runner.startRun({
    workspace: h.workspace, agentSlug: a.slug, kind: a.isBuilder ? 'build' : 'task', instruction: prompt,
    model: h.status === 'wrapping' ? WRAP_MODEL : TALK_MODEL, session: h.session, huddle: h.id, huddleTalk: true,
  });
  (a.runIds ||= []).push(run.id);
  h.currentRunId = run.id;
  h.speaking = a.slug;
  changed(h);
}

/** A turn's run ended: take what the agent said, Orchy's word if any, then the next turn, the wrap-up, or the end. */
export async function onTurnEnded(runId) {
  const run = db().runs[runId];
  const h = run?.huddle ? all()[run.huddle] : null;
  if (!h) return;
  const a = partOf(h, run.agentSlug);
  if (!a) return;
  if (run.sessionId) a.sessionId = run.sessionId;
  if (h.currentRunId === run.id) { h.currentRunId = null; h.speaking = null; }
  const r = run.huddleReply || (run.resultText ? { message: run.resultText } : null);
  const wrapping = h.status === 'wrapping';
  const challenge = wrapping ? '' : String(r?.challenge || '').trim().slice(0, 2000);
  if (r?.message) {
    const earned = !!challenge || hasChallenged(h, a.slug);
    h.turns.push({
      by: a.slug, name: a.name, text: String(r.message).slice(0, 6000), ...(challenge ? { challenge } : {}),
      // ready only counts from an agent that has pushed back on something (this turn included)
      ready: !!r.ready && earned, ...(r.ready && !earned ? { readyUnearned: true } : {}),
      ...(wrapping ? { wrap: true } : {}), questions: (r.questions_for_owner || r.questions_for_jan || []).slice(0, 10), runId: run.id, at: new Date().toISOString(),
    });
    // a fresh challenge reopens the talk: everyone else agrees again after it (the challenger's own ready stands)
    if (challenge) h.readyFrom = h.turns.length - 1;
  }
  if (!TALKING.has(h.status)) return changed(h); // stopped meanwhile: keep what was said, nothing more
  if (!r?.message) return end(h, 'failed', `${a.name}'s turn ${run.outcome === 'stopped' ? 'was stopped' : run.outcome === 'completed' ? 'ended without saying anything' : `failed${run.error ? `: ${run.error.split('\n')[0].slice(0, 200)}` : ''}`}.`);

  if (wrapping) {
    h.agreement = agreementFrom(h, r?.agreement, r?.message);
    await orchyAnswers(h);
    // contested points: Orchy's take for the owner (advice only; the owner still decides)
    if (h.agreement.dissent.length && io.coachTake) await io.coachTake(h).catch(e => console.error('[huddle] Orchy take failed', e.message));
    if (!TALKING.has(h.status)) return changed(h);
    return end(h, 'agreed');
  }
  // Orchy reads the turn and may speak (huddlecoach.mjs): never longer than its own budget, silent on any failure
  if (io.coach) {
    try { await io.coach(h, h.turns.at(-1), { busy: on => { h.speaking = on ? 'orchy' : null; changed(h); } }); }
    catch (e) { console.error('[huddle] coach failed', e.message); }
    if (h.speaking === 'orchy') h.speaking = null;
    if (!TALKING.has(h.status)) return changed(h); // the owner stopped it meanwhile
  }
  // an agent asked to bring someone in: they join and speak next (everyone agrees again with them in)
  const joined = r.invite ? bringIn(h, a, r.invite) : null;
  if (joined) return nextTurn(h, joined).catch(e => end(h, 'failed', e.message));
  const spoke = h.turns.slice(h.readyFrom).filter(isTalk);
  const allReady = h.agents.every(x => spoke.filter(t => t.by === x.slug).at(-1)?.ready);
  if (allReady || turnsUsed(h) >= h.maxTurns) {
    h.status = 'wrapping';
    h.wrapWhy = allReady ? 'agreed' : 'turns';
    changed(h);
    return nextTurn(h, h.agents[0]).catch(e => end(h, 'failed', e.message));
  }
  return nextTurn(h, nextAfter(h, a.slug)).catch(e => end(h, 'failed', e.message));
}

/**
 * An agent in the huddle brings another agent of the workspace in (huddle_reply `invite`). No ask: a huddle only
 * talks and the owner approves the agreement anyway. Same rules as starting one (same workspace, not shared with a
 * client, an engine that can huddle), no cap: the turn budget grows with the room. Orchy says who joined and why in
 * the talk (everyone reads it), or why not, so the inviter hears it. Returns the newcomer, or null.
 */
export function bringIn(h, by, invite) {
  const slug = String(invite?.agent || '').trim();
  const why = String(invite?.why || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  if (!slug || partOf(h, slug)) return null;
  const at = new Date().toISOString();
  const no = text => { h.turns.push({ by: 'orchy', name: 'Orchy', text, at }); return null; };
  const a = huddleInvitees(h).find(x => x.slug === slug);
  let ws = null;
  try { ws = workspace(h.workspace); } catch {}
  if (!a || !ws) return no(`${by.name} asked to bring in ${slug}, but they can't join: not one of this workspace's agents, working with a client, or on an engine that can't huddle. Carry on with who's here.`);
  const part = { ...partFor(ws, a), joinedBy: { slug: by.slug, name: by.name, why }, joinedAt: at };
  h.agents.splice(h.agents.indexOf(by) + 1, 0, part); // seated after whoever brought them in: they speak next, then the round goes on
  const text = `${by.name} brought ${part.name} (${part.role}) into the huddle${why ? `: ${why}` : '.'}`;
  h.turns.push({ by: 'orchy', name: 'Orchy', text, joined: part.slug, at });
  h.readyFrom = h.turns.length;
  h.maxTurns = Math.min(turnsUsed(h) + capFor(h.agents.length), h.maxTurns + TURNS.join);
  changed(h);
  say(text, { huddleId: h.id, kind: 'huddle', workspace: h.workspace, session: h.session });
  return part;
}

/** The agreement as the lead wrote it (merged questions, dissent); only the huddle's own agents get work. */
export function agreementFrom(h, raw, closing) {
  const g = raw && typeof raw === 'object' ? raw : {};
  const list = v => (Array.isArray(v) ? v : v ? [v] : []).map(x => String(x).trim()).filter(Boolean);
  const slugs = new Set(h.agents.map(a => a.slug));
  const work = (Array.isArray(g.work) ? g.work : [])
    .map(w => ({ agent: String(w?.agent || '').trim(), task: String(w?.task || '').trim() }))
    .filter(w => w.task && slugs.has(w.agent));
  // the wrap-up merges every question of the talk into a few broad ones; only when it wrote none do the turns' own
  // questions (since the owner last answered) stand in
  const merged = dedupe(questionsIn(g.questions_for_owner ?? g.questions_for_jan));
  const questions = (merged.length ? merged : dedupe(openQuestionTurns(h).flatMap(t => t.questions || []).map(q => ({ q: String(q).trim() }))))
    .map((q, i) => ({ id: `q${i + 1}`, ...q, ...(q.covers ? { covers: q.covers.filter(s => slugs.has(s)) } : {}) }));
  return {
    summary: String(g.summary || closing || 'They wrapped up without writing an agreement.').trim(),
    decisions: list(g.decisions),
    work,
    questions,
    questions_for_owner: questions.map(q => q.q),
    dissent: list(g.dissent),
  };
}

/**
 * Orchy's first look at the questions (rules.mjs#preAnswer): what the owner's standing rules or the team's settings
 * already answer is filled in, with its source, and leaves their list. questions_for_owner keeps only what's left.
 */
export async function orchyAnswers(h, { pre = io.preAnswer } = {}) {
  const g = h.agreement;
  if (!g?.questions?.length || !pre) return g;
  try { g.questions = await pre(h.workspace, g.questions); } catch (e) { console.error('[huddle] pre-answer failed', e.message); }
  g.questions_for_owner = g.questions.filter(q => !q.orchy).map(q => q.q);
  return g;
}

/**
 * The owner's answers from the proposal window, as the note each agent gets: question → answer, only the ones that
 * touch its work (`covers`, empty means everyone), Orchy's answers included unless the owner changed them.
 * `remember` makes an answer a standing rule. Returns { all, forAgent(slug) } as text.
 */
export function answersNote(h, answers = [], note = '') {
  const who = ownerName();
  const g = h.agreement || {};
  const given = new Map((Array.isArray(answers) ? answers : []).map(a => [String(a?.id || ''), a]));
  if (h.agreement && !g.questions?.length) g.questions = questionsOf(g); // stored before questions were kept structured
  const rows = (g.questions || []).map(q => {
    const a = given.get(q.id);
    const mine = cap(a?.answer, 2000);
    const text = mine || q.orchy?.answer || '';
    if (mine) q.answer = mine; // kept on the agreement: what the owner said to each
    if (a?.remember && mine) { try { io.addRule(h.workspace, `${q.q} → ${mine}`, { question: q.q }); } catch {} }
    return text ? { q, text, mine: !!mine } : null;
  }).filter(Boolean);
  const extra = String(note || '').trim();
  const fmt = list => [...list.map(r => `- ${r.q.q}\n  → ${r.text}${r.mine ? '' : ' (Orchy, from your rules)'}`), ...(extra ? [`- ${who}'s note: ${extra}`] : [])].join('\n');
  return { all: fmt(rows), forAgent: slug => fmt(rows.filter(r => !r.q.covers?.length || r.q.covers.includes(slug))) };
}

function end(h, status, why = '') {
  h.status = status;
  h.endedAt = new Date().toISOString();
  h.currentRunId = null;
  h.speaking = null;
  if (why) h.note = why;
  let ws = null;
  try { ws = workspace(h.workspace); } catch {}
  if (ws) {
    if (io.files) try { writeTranscript(h, ws); } catch (e) { console.error('[huddle] transcript failed', e.message); }
    try { io.log(h, ws); } catch (e) { console.error('[huddle] log failed', e.message); }
  }
  changed(h);
  const names = nameList(h.agents.map(a => a.name));
  if (status === 'agreed') {
    const g = h.agreement;
    const q = g.questions_for_owner.length;
    const d = g.dissent.length;
    const o = (g.questions || []).filter(x => x.orchy).length;
    say(`${names} ${d ? 'mostly agreed' : 'agreed'}. ${g.summary}${d ? `\n\n${d} point${d === 1 ? ' is' : 's are'} still contested: your call.${g.orchyTake ? ' My take is in the proposal, for what it’s worth.' : ''}` : ''}${q ? `\n\nThey have ${q} question${q === 1 ? '' : 's'} for you first: View proposal takes you through them one at a time.` : ''}${o ? ` I answered ${o} from your rules; you can change ${o === 1 ? 'it' : 'them'} there.` : ''}\n\nApprove it and ${g.work.length ? nameList(g.work.map(w => partOf(h, w.agent).name)) : 'nobody'} get${g.work.length === 1 ? 's' : ''} to work, or keep them talking.`, { huddleId: h.id, kind: 'huddle-agreed', workspace: h.workspace, session: h.session });
  } else if (status === 'failed') {
    say(`The huddle between ${names} stopped: ${why} You can keep them talking from the huddle window.`, { huddleId: h.id, kind: 'huddle', workspace: h.workspace, session: h.session, error: true });
  }
}

/** HUDDLE.md in the lead's department's Tasks/ (the workspace's Tasks/ without departments): the whole talk and the agreement, rewritten as it goes on. */
function writeTranscript(h, ws) {
  const who = ownerName();
  if (!h.taskDir) {
    h.taskRoot = taskRootFor(ws, { lead: h.agents[0]?.slug });
    const day = new Date(h.createdAt).toLocaleDateString('en-CA', { timeZone: config.timezone });
    const base = `${day}-huddle-${h.agents.map(a => a.slug).join('-')}`.slice(0, 64);
    let name = base;
    for (let n = 2; fs.existsSync(path.join(tasksBase(ws, h), name)); n++) name = `${base}-${n}`;
    h.taskDir = name;
  }
  const dir = path.join(tasksBase(ws, h), h.taskDir);
  fs.mkdirSync(dir, { recursive: true });
  const g = h.agreement;
  const speaker = t => (isOwnerLine(t) ? who : t.kind === 'coach' ? `Orchy ${MODE_LABEL[t.mode] || ''}`.trim() : t.name);
  const md = `# Huddle: ${h.agents.map(a => `${a.name} (${a.role})`).join(' + ')}

**${h.startedBy ? `${h.startedBy.name} asked` : `${who} asked`}:** ${h.topic}
**Status:** ${h.status}${h.note ? ` (${h.note})` : ''} · ${turnsUsed(h)} turns · huddle \`${h.id}\`

## The talk

${h.turns.map(t => `**${speaker(t)}:** ${t.kind === 'coach' ? t.text.replace(/\n/g, '  \n') : t.text}${t.challenge ? `\n\n_Pushes back:_ ${t.challenge}` : ''}${t.ready ? ' _(ready to agree)_' : ''}${t.questions?.length ? `\n\n_Questions for ${who}:_ ${t.questions.join(' · ')}` : ''}`).join('\n\n') || '_Nothing said yet._'}
${g ? `
## Agreement

${g.summary}

**Decisions**
${g.decisions.map(d => `- ${d}`).join('\n') || '- —'}

**Work once ${who} approves**
${g.work.map(w => `- ${partOf(h, w.agent)?.name || w.agent}: ${w.task}`).join('\n') || '- —'}

**Still contested**
${(g.dissent || []).map(q => `- ${q}`).join('\n') || '- —'}
${g.orchyTake ? `\n**Orchy's take** (advice; ${who} decides): ${g.orchyTake.take}${g.orchyTake.why ? ` ${g.orchyTake.why}` : ''}\n` : ''}
**Questions for ${who}**
${questionsOf(g).map(q => `- ${q.q}${q.options?.length ? ` _(${q.options.join(' / ')}${q.recommended ? `; they recommend: ${q.recommended}` : ''})_` : ''}${q.orchy ? `\n  → Orchy answered: ${q.orchy.answer} (${q.orchy.source})` : ''}${q.answer ? `\n  → ${who}: ${q.answer}` : ''}`).join('\n') || '- —'}
` : ''}`;
  fs.writeFileSync(path.join(dir, 'HUDDLE.md'), md);
}

// ── the owner's controls ──

/** The owner jumps in: every agent reads it on its next turn. */
export function ownerSays(hid, text) {
  const h = getHuddle(hid);
  const t = String(text || '').trim();
  if (!t) throw Object.assign(new Error('Say something first'), { status: 400 });
  h.turns.push({ by: 'owner', name: ownerName(), text: t.slice(0, 4000), at: new Date().toISOString() });
  changed(h);
  return h;
}

/**
 * Keep talking: more turns (and the owner's note), from where they left off. Also picks up a stopped or failed
 * huddle. `answers` (from the proposal window's Send back): the owner's answers so far become their line, and the
 * agents rework the plan with them.
 */
export async function keepTalking(hid, { text = '', more = TURNS.more, answers = null } = {}) {
  const h = getHuddle(hid);
  if (TALKING.has(h.status)) throw Object.assign(new Error('They are still talking'), { status: 409 });
  if (h.status === 'approved') throw Object.assign(new Error('You already approved this one; its work is running'), { status: 409 });
  if (!workspace(h.workspace).enabled) throw Object.assign(new Error(`${workspace(h.workspace).name} is switched off`), { status: 409 });
  const busy = Object.values(all()).find(x => x.id !== h.id && x.workspace === h.workspace && TALKING.has(x.status));
  if (busy) throw Object.assign(new Error('Another huddle is going in this workspace'), { status: 409 });
  const answering = Array.isArray(answers) && h.status === 'agreed' && h.agreement;
  if (answering) {
    const said = answersNote(h, answers).all;
    text = [said && `My answers to your questions:\n${said}`, String(text || '').trim(), 'Rework the plan with these and write a new agreement.'].filter(Boolean).join('\n\n');
  }
  if (String(text).trim()) h.turns.push({ by: 'owner', name: ownerName(), text: String(text).trim().slice(0, 4000), ...(answering ? { answered: true } : {}), at: new Date().toISOString() });
  h.status = 'talking';
  h.maxTurns = Math.min(turnsUsed(h) + capFor(h.agents.length), turnsUsed(h) + Math.max(2, Math.round(Number(more) || TURNS.more)));
  h.readyFrom = h.turns.length; // they say they agree again after what the owner added
  h.agreement = null;
  h.endedAt = null;
  h.note = null;
  changed(h);
  const last = [...h.turns].reverse().find(isTalk);
  await nextTurn(h, last ? nextAfter(h, last.by) : h.agents[0]).catch(e => end(h, 'failed', e.message));
  return h;
}

export function stopHuddle(hid) {
  const h = getHuddle(hid);
  if (!TALKING.has(h.status)) return h;
  const cur = h.currentRunId;
  end(h, 'stopped', `${ownerName()} stopped it.`);
  if (cur) io.runner.stopRun(cur);
  return h;
}

/**
 * The owner approves the agreement: each agent with work does its part as a normal run (the owner's approvals as
 * usual), resuming its huddle session so it remembers the talk. `answers` ({id, answer, remember}) are the owner's
 * answers from the proposal window; `note` anything else they want said.
 */
export async function approve(hid, { note = '', answers = [] } = {}) {
  const who = ownerName();
  const h = getHuddle(hid);
  if (h.status !== 'agreed' || !h.agreement) throw Object.assign(new Error('There is no agreement waiting for you on this huddle'), { status: 409 });
  if (!h.agreement.work.length) throw Object.assign(new Error('The agreement gives nobody any work. Keep them talking, or close it.'), { status: 400 });
  const said = answersNote(h, answers, note);
  const started = [];
  const errors = [];
  for (const w of h.agreement.work) {
    const a = partOf(h, w.agent);
    const mine = said.forAgent(w.agent);
    const task = `${who} approved the agreement from your huddle with ${nameList(othersOf(h, w.agent).map(o => o.name))}. Your part:\n\n${w.task}${mine ? `\n\n${who}'s answers to your questions (they override anything in the plan above):\n${mine}` : ''}\n\nDo it now: huddle rules are over, your usual instructions apply (approvals as usual), and end with report_done.`;
    try {
      const run = await io.runner.startRun({
        workspace: h.workspace, agentSlug: a.slug, kind: a.isBuilder ? 'build' : 'task', instruction: task,
        session: h.session, fromHuddle: h.id, ...(a.sessionId ? { resumeSessionId: a.sessionId } : {}),
      });
      started.push(run);
      h.workRunIds.push(run.id);
    } catch (e) { errors.push(`${a.name}: ${e.message}`); }
  }
  if (started.length) { h.status = 'approved'; h.approvedAt = new Date().toISOString(); h.ownerNote = said.all || null; }
  changed(h);
  if (errors.length && !started.length) throw Object.assign(new Error(errors.join(' · ')), { status: 409 });
  return { huddle: h, runs: started, errors };
}

/** Close an agreement the owner doesn't want built. */
export function dismiss(hid) {
  const h = getHuddle(hid);
  if (h.status !== 'agreed') throw Object.assign(new Error('Nothing to close'), { status: 409 });
  h.status = 'closed';
  changed(h);
  return h;
}

/** The run that asked for a huddle was stopped: the huddle it's waiting on stops with it (what was said stays). */
export function starterStopped(runId) {
  for (const h of Object.values(all())) {
    if (h.startedBy?.runId !== runId || !TALKING.has(h.status)) continue;
    const cur = h.currentRunId;
    end(h, 'stopped', `${h.startedBy.name}'s task was stopped, so the huddle stopped too.`);
    if (cur) io.runner.stopRun(cur);
  }
}

// a turn's run ended (huddle runs don't report to Orchy's chat or LOGS.md one by one)
bus.on('event', e => {
  if (e.type !== 'run.ended') return;
  if (e.run?.huddle) onTurnEnded(e.run.id).catch(err => console.error('[huddle] turn end failed', err));
  else if (e.run?.outcome === 'stopped') starterStopped(e.run.id);
});
