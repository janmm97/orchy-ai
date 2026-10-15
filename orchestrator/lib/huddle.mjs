// Huddles: two agents of one workspace talk a task through, turn by turn, with Orchy as moderator. An agent in
// it may bring another agent of the workspace in (huddle_reply `invite`, bringIn below; up to MAX_HUDDLE_AGENTS):
// the newcomer is seated after whoever brought them in and speaks next, having read the talk so far; turns go round.
// Each turn is a short Orchy run of that agent (runner.startRun with `huddle`) that resumes the agent's own
// session, so each keeps its instructions, connections and memory of the talk. Turns only talk: the gate
// refuses anything that changes something (policy.mjs#huddleTalk), and a turn ends with the bridge tool
// huddle_reply. When all say they agree, or the turn cap is reached, the first agent writes the agreement.
// Nothing is built until the owner approves it; then each agent does its part as a normal run in the same session
// (an Agent Builder in the huddle updates the agents that need it). Questions only the owner can answer wait for
// the agreement. Same workspace only (accounts never mix), two agents to start, Claude Code agents only for now,
// never an agent shared with a client. The owner starts one (chat, Huddle window, Workspace window), or a C-suite agent
// does from its own run with the bridge tool `huddle` (startFromRun): it opens, and its run waits for the result.
import fs from 'node:fs';
import path from 'node:path';
import { db, save, id } from './store.mjs';
import { emit, bus } from './bus.mjs';
import { workspace, engineFor } from './workspaces.mjs';
import { engine } from './engines/index.mjs';
import { getAgent, BUILDER_SLUG } from './agents.mjs';
import { nameOf } from './voiceagents.mjs';
import { clientSharedSlugs, cantHuddle, huddlePartners, huddleInvitees, MAX_RUN_HUDDLES, MAX_HUDDLE_AGENTS } from './delegation.mjs';
import { appendHuddleLog } from './logs.mjs';
import { tasksDir } from './tasks.mjs';
import { config, ownerName } from './env.mjs';
import { ensureSession, post as postChat } from './sessions.mjs';
import * as runner from './runner.mjs';

// `join`: extra turns when an agent is brought in, so the newcomer has room to talk
export const TURNS = { default: 10, min: 2, max: 40, more: 6, join: 2 };
const TALKING = new Set(['talking', 'wrapping']);

let say = () => {};
// what a huddle touches outside itself; tests swap these for fakes (no Claude runs, no files, no saves).
// Every huddle gets an Orchy session of its own (`session`), and `post` puts a line in a session without speaking it.
const io = {
  runner, save, log: appendHuddleLog, files: true,
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
// an agent's turn (not the owner's lines, not Orchy's when someone joins)
const isTalk = t => t.by !== 'owner' && t.by !== 'orchy';
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
/** "Theo", "Theo and Nathan", "Theo, Nathan and Clara" */
export const nameList = names => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
const whoRoles = list => nameList(list.map(o => `${o.name} (${o.role})`));

function changed(h) {
  io.save();
  emit('huddle.updated', { huddle: publicHuddle(h) });
}

/** An agent's place in a huddle: its name, role and (once it has spoken) its own session. */
const partFor = (ws, a) => ({ slug: a.slug, name: nameOf(ws.id, a.slug) || a.callName || a.displayName, role: a.displayName, isBuilder: a.slug === BUILDER_SLUG, sessionId: null, runIds: [] });

/** Can these two agents huddle? Returns their summaries, or throws with a reason the owner (or Jev's card) can act on. */
export function checkHuddle(wsId, slugs) {
  const ws = workspace(wsId);
  if (!ws.enabled) throw Object.assign(new Error(`${ws.name} is switched off`), { status: 409 });
  const list = [...new Set((slugs || []).map(s => String(s || '').trim()).filter(Boolean))];
  if (list.length !== 2) throw Object.assign(new Error('A huddle needs two different agents of the same workspace'), { status: 400 });
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
  const h = {
    id: id('huddle'), workspace: ws.id, session: own, askedIn: session && session !== own ? session : null, topic: text, agents, startedBy,
    turns: [], readyFrom: 0, maxTurns: Number(maxTurns) > 0 ? Math.min(TURNS.max, Math.max(TURNS.min, Math.round(maxTurns))) : maxTurnsSetting(),
    status: 'talking', currentRunId: null, agreement: null, workRunIds: [], createdAt: new Date().toISOString(), endedAt: null,
  };
  all()[h.id] = h;
  changed(h);
  // the huddle's own session opens with the ask (the owner's words, or the agent's), then Orchy's start line
  const meta = { huddleId: h.id, kind: 'huddle', workspace: ws.id };
  if (!startedBy) io.post('owner', text, {}, own); // as the owner asked it; the session's title says who's huddling
  const start = startedBy
    ? `${agents[0].name} pulled ${agents[1].name} into a huddle in ${ws.name}: ${text.length > 220 ? `${text.slice(0, 220)}…` : text}\n\nOpen it to read along or jump in; nothing gets built until you approve what they agree.`
    : `${agents[0].name} and ${agents[1].name} are huddling in ${ws.name} on it. Open the huddle to read along or jump in; nothing gets built until you approve what they agree.`;
  if (!h.askedIn) say(start, { ...meta, session: own });
  else {
    io.post('orchy', start, meta, own);
    say(`${startedBy ? `${agents[0].name} pulled ${agents[1].name} into a huddle` : `${agents[0].name} and ${agents[1].name} are huddling`} in ${ws.name}. It has a session of its own, where you'll hear how it goes and approve what they agree.`, { ...meta, huddleSession: own, session: h.askedIn });
  }
  await nextTurn(h, agents[0]).catch(e => end(h, 'failed', e.message));
  return h;
}

const refuse = (msg, status = 403) => Object.assign(new Error(msg), { status });

/**
 * A C-suite agent starts a huddle from its own run (bridge tool `huddle`): it opens with the topic it wrote, in the
 * session its run belongs to. Its own workspace only, at most MAX_RUN_HUDDLES per run, one huddle per workspace at a time.
 */
export async function startFromRun(run, { agent, topic } = {}) {
  const why = cantHuddle(run);
  if (why) throw refuse(why);
  const partners = huddlePartners(run);
  if (!partners.length) throw refuse(`${run.agentName} isn't C-suite (a Chief, a CxO or a department head), so it can't start huddles. Do it yourself, or ask ${ownerName()}.`);
  const slug = String(agent || '').trim();
  const other = partners.find(a => a.slug === slug);
  if (!other) throw refuse(`${slug || 'That agent'} can't huddle with you. Who can: ${partners.map(a => `${nameOf(run.workspace, a.slug) || a.callName || a.displayName} (\`${a.slug}\`)`).join(', ')}.`);
  if (Object.values(all()).filter(h => h.startedBy?.runId === run.id).length >= MAX_RUN_HUDDLES) throw refuse(`You've started ${MAX_RUN_HUDDLES} huddles in this task already. Work with what they agreed.`, 429);
  const name = nameOf(run.workspace, run.agentSlug) || run.agentName;
  return startHuddle({ workspace: run.workspace, agents: [run.agentSlug, other.slug], topic, session: run.session, startedBy: { runId: run.id, slug: run.agentSlug, name } });
}

/** What a huddle came to, for the run that started it (the bridge's `huddle` tool waits for this). */
export function outcomeFor(h) {
  const done = !TALKING.has(h.status);
  return { done, status: h.status, note: h.note || null, turns: turnsUsed(h), agreement: h.agreement, taskDir: h.taskDir || null, with: h.agents.slice(1).map(a => a.name).join(', ') };
}

// ── turns ──

/**
 * Everything said since this agent's last prompt (the other agent's turns and the owner's). Counted from what it was
 * shown, not from its own last line: the owner may jump in while it's mid-turn, and that line still has to reach it.
 */
function unseen(h, a) {
  return h.turns.slice(a.seen || 0).filter(t => t.by !== a.slug);
}
const line = t => `**${t.by === 'owner' ? ownerName() : t.name}:** ${t.text}`;

export function turnPrompt(h, a) {
  const os = othersOf(h, a.slug);
  const news = unseen(h, a);
  const first = !a.sessionId;
  const by = h.startedBy;
  const starter = by && partOf(h, by.slug);
  const why = a.joinedBy?.why ? ` (${a.joinedBy.why.replace(/[.\s]+$/, '')})` : '';
  const ask = a.joinedBy ? `${a.joinedBy.name} brought you into a huddle with ${whoRoles(os)}${why}. ${by ? `${by.name} started it while working on a task for ${ownerName()}` : `${ownerName()} asked Orchy for it`}, to work out this`
    : !by ? `${ownerName()} asked Orchy to get you and ${whoRoles(os)} together on this`
    : by.slug === a.slug ? `You asked Orchy for a huddle with ${whoRoles(os)} while working on a task for ${ownerName()}, to work out this`
    : `${by.name}${starter ? ` (${starter.role})` : ''} asked Orchy to get you ${h.agents.length === 2 ? 'two ' : ''}together while working on a task for ${ownerName()}, to work out this`;
  const head = first ? `${ask}:\n\n> ${h.topic.replace(/\n/g, '\n> ')}\n\n` : '';
  const said = news.length ? `${first ? 'Said so far:\n\n' : ''}${news.map(line).join('\n\n')}\n\n` : '';
  if (h.status === 'wrapping') return `${head}${said}${wrapText(h)}`;
  const left = h.maxTurns - turnsUsed(h);
  const opener = !h.turns.some(isTalk);
  return `${head}${said}${opener ? `You open the huddle: say what you need from ${nameList(os.map(o => o.name))}, or what you propose.` : first && a.joinedBy ? 'Your turn: you just joined, so say what you bring to this.' : 'Your turn.'}${left <= 2 ? ` ${left === 1 ? 'This is the last turn' : 'Two turns left'} before the agreement, so converge.` : ''} End with huddle_reply.`;
}

function wrapText(h) {
  const why = h.wrapWhy === 'turns' ? `: that's the ${h.maxTurns} turns ${ownerName()} allowed` : '';
  return `Time to wrap up${why}. Write the agreement now with huddle_reply: a one-line \`message\` to close, and \`agreement\`:
- \`summary\`: what you agreed, in a few sentences, for ${ownerName()}.
- \`decisions\`: the choices you made.
- \`work\`: each agent's part once ${ownerName()} approves, as a complete task: \`agent\` is the slug (${h.agents.map(a => `\`${a.slug}\` for ${a.name}`).join(', ')}) and \`task\` says what to do, with the names, links, IDs and details from this talk. Leave an agent out if it has nothing to do.
- \`questions_for_owner\`: everything only ${ownerName()} can answer, from both of you.
Where you didn't agree, say so in the summary and leave it out of the work.`;
}

async function nextTurn(h, a) {
  if (!TALKING.has(h.status)) return;
  const prompt = turnPrompt(h, a);
  a.seen = h.turns.length;
  const run = await io.runner.startRun({
    workspace: h.workspace, agentSlug: a.slug, kind: a.isBuilder ? 'build' : 'task', instruction: prompt,
    session: h.session, huddle: h.id, huddleTalk: true, ...(a.sessionId ? { resumeSessionId: a.sessionId } : {}),
  });
  a.runIds.push(run.id);
  h.currentRunId = run.id;
  h.speaking = a.slug;
  changed(h);
}

/** A turn's run ended: take what the agent said, then the next turn, the wrap-up, or the end. */
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
  if (r?.message) h.turns.push({ by: a.slug, name: a.name, text: String(r.message).slice(0, 6000), ready: !!r.ready, ...(wrapping ? { wrap: true } : {}), questions: (r.questions_for_owner || []).slice(0, 10), runId: run.id, at: new Date().toISOString() });
  if (!TALKING.has(h.status)) return changed(h); // stopped meanwhile: keep what was said, nothing more
  if (!r?.message) return end(h, 'failed', `${a.name}'s turn ${run.outcome === 'stopped' ? 'was stopped' : run.outcome === 'completed' ? 'ended without saying anything' : `failed${run.error ? `: ${run.error.split('\n')[0].slice(0, 200)}` : ''}`}.`);

  if (wrapping) {
    h.agreement = agreementFrom(h, r?.agreement, r?.message);
    return end(h, 'agreed');
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
 * talks and the owner approves the agreement anyway. Same rules as starting one (same workspace, not shared with a client,
 * Claude Code), at most MAX_HUDDLE_AGENTS. Orchy says who joined and why in the talk (everyone reads it), or why
 * not, so the inviter hears it. Returns the newcomer, or null.
 */
export function bringIn(h, by, invite) {
  const slug = String(invite?.agent || '').trim();
  const why = String(invite?.why || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  if (!slug || partOf(h, slug)) return null;
  const at = new Date().toISOString();
  const no = text => { h.turns.push({ by: 'orchy', name: 'Orchy', text, at }); return null; };
  if (h.agents.length >= MAX_HUDDLE_AGENTS) return no(`${by.name} asked to bring in ${slug}, but a huddle holds ${MAX_HUDDLE_AGENTS} agents at most. Carry on with who's here.`);
  const a = huddleInvitees(h).find(x => x.slug === slug);
  let ws = null;
  try { ws = workspace(h.workspace); } catch {}
  if (!a || !ws) return no(`${by.name} asked to bring in ${slug}, but they can't join: not one of this workspace's agents, working with a client, or on Codex. Carry on with who's here.`);
  const part = { ...partFor(ws, a), joinedBy: { slug: by.slug, name: by.name, why }, joinedAt: at };
  h.agents.splice(h.agents.indexOf(by) + 1, 0, part); // seated after whoever brought them in: they speak next, then the round goes on
  const line = `${by.name} brought ${part.name} (${part.role}) into the huddle${why ? `: ${why}` : '.'}`;
  h.turns.push({ by: 'orchy', name: 'Orchy', text: line, joined: part.slug, at });
  h.readyFrom = h.turns.length;
  h.maxTurns = Math.min(turnsUsed(h) + TURNS.max, h.maxTurns + TURNS.join);
  changed(h);
  say(line, { huddleId: h.id, kind: 'huddle', workspace: h.workspace, session: h.session });
  return part;
}

/** The agreement as the lead wrote it, plus every question either agent left for the owner; only the huddle's own agents get work. */
export function agreementFrom(h, raw, closing) {
  const g = raw && typeof raw === 'object' ? raw : {};
  const list = v => (Array.isArray(v) ? v : v ? [v] : []).map(x => String(x).trim()).filter(Boolean);
  const slugs = new Set(h.agents.map(a => a.slug));
  const work = (Array.isArray(g.work) ? g.work : [])
    .map(w => ({ agent: String(w?.agent || '').trim(), task: String(w?.task || '').trim() }))
    .filter(w => w.task && slugs.has(w.agent));
  const asked = [...list(g.questions_for_owner), ...h.turns.flatMap(t => t.questions || [])];
  const seen = new Set();
  const questions = asked.filter(q => { const k = q.toLowerCase().replace(/\W+/g, ' ').trim(); return k && !seen.has(k) && !!seen.add(k); });
  return {
    summary: String(g.summary || closing || 'They wrapped up without writing an agreement.').trim(),
    decisions: list(g.decisions),
    work,
    questions_for_owner: questions,
  };
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
    const q = h.agreement.questions_for_owner.length;
    say(`${names} agreed. ${h.agreement.summary}${q ? `\n\nThey have ${q} question${q === 1 ? '' : 's'} for you first.` : ''}\n\nApprove it and ${h.agreement.work.length ? h.agreement.work.map(w => partOf(h, w.agent).name).join(' and ') : 'nobody'} get${h.agreement.work.length === 1 ? 's' : ''} to work, or keep them talking.`, { huddleId: h.id, kind: 'huddle-agreed', workspace: h.workspace, session: h.session });
  } else if (status === 'failed') {
    say(`The huddle between ${names} stopped: ${why} You can keep them talking from the huddle window.`, { huddleId: h.id, kind: 'huddle', workspace: h.workspace, session: h.session, error: true });
  }
}

/** HUDDLE.md in the workspace's Tasks/: the whole talk and the agreement, rewritten as it goes on. */
function writeTranscript(h, ws) {
  if (!h.taskDir) {
    const day = new Date(h.createdAt).toLocaleDateString('en-CA', { timeZone: config.timezone });
    const base = `${day}-huddle-${h.agents.map(a => a.slug).join('-')}`.slice(0, 64);
    let name = base;
    for (let n = 2; fs.existsSync(path.join(tasksDir(ws), name)); n++) name = `${base}-${n}`;
    h.taskDir = name;
  }
  const dir = path.join(tasksDir(ws), h.taskDir);
  fs.mkdirSync(dir, { recursive: true });
  const g = h.agreement;
  const md = `# Huddle: ${h.agents.map(a => `${a.name} (${a.role})`).join(' + ')}

**${ownerName()} asked:** ${h.topic}
**Status:** ${h.status}${h.note ? ` (${h.note})` : ''} · ${turnsUsed(h)} turns · huddle \`${h.id}\`

## The talk

${h.turns.map(t => `**${t.by === 'owner' ? ownerName() : t.name}:** ${t.text}${t.ready ? ' _(ready to agree)_' : ''}${t.questions?.length ? `\n\n_Questions for ${ownerName()}:_ ${t.questions.join(' · ')}` : ''}`).join('\n\n') || '_Nothing said yet._'}
${g ? `
## Agreement

${g.summary}

**Decisions**
${g.decisions.map(d => `- ${d}`).join('\n') || '- —'}

**Work once ${ownerName()} approves**
${g.work.map(w => `- ${partOf(h, w.agent)?.name || w.agent}: ${w.task}`).join('\n') || '- —'}

**Questions for ${ownerName()}**
${g.questions_for_owner.map(q => `- ${q}`).join('\n') || '- —'}
` : ''}`;
  fs.writeFileSync(path.join(dir, 'HUDDLE.md'), md);
}

// ── the owner's controls ──

/** The owner jumps in: both agents read it on their next turn. */
export function ownerSays(hid, text) {
  const h = getHuddle(hid);
  const t = String(text || '').trim();
  if (!t) throw Object.assign(new Error('Say something first'), { status: 400 });
  h.turns.push({ by: 'owner', name: ownerName(), text: t.slice(0, 4000), at: new Date().toISOString() });
  changed(h);
  return h;
}

/** Keep talking: more turns (and the owner's note), from where they left off. Also picks up a stopped or failed huddle. */
export async function keepTalking(hid, { text = '', more = TURNS.more } = {}) {
  const h = getHuddle(hid);
  if (TALKING.has(h.status)) throw Object.assign(new Error('They are still talking'), { status: 409 });
  if (h.status === 'approved') throw Object.assign(new Error('You already approved this one; its work is running'), { status: 409 });
  if (!workspace(h.workspace).enabled) throw Object.assign(new Error(`${workspace(h.workspace).name} is switched off`), { status: 409 });
  const busy = Object.values(all()).find(x => x.id !== h.id && x.workspace === h.workspace && TALKING.has(x.status));
  if (busy) throw Object.assign(new Error('Another huddle is going in this workspace'), { status: 409 });
  if (String(text).trim()) h.turns.push({ by: 'owner', name: ownerName(), text: String(text).trim().slice(0, 4000), at: new Date().toISOString() });
  h.status = 'talking';
  h.maxTurns = Math.min(turnsUsed(h) + TURNS.max, turnsUsed(h) + Math.max(2, Math.round(Number(more) || TURNS.more)));
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
 * The owner approves the agreement: each agent with work does its part as a normal run (the owner's approvals as usual),
 * resuming its huddle session so it remembers the talk. `note` carries the owner's answers to their questions.
 */
export async function approve(hid, { note = '' } = {}) {
  const h = getHuddle(hid);
  if (h.status !== 'agreed' || !h.agreement) throw Object.assign(new Error('There is no agreement waiting for you on this huddle'), { status: 409 });
  if (!h.agreement.work.length) throw Object.assign(new Error('The agreement gives nobody any work. Keep them talking, or close it.'), { status: 400 });
  const extra = String(note || '').trim();
  const started = [];
  const errors = [];
  for (const w of h.agreement.work) {
    const a = partOf(h, w.agent);
    const task = `${ownerName()} approved the agreement from your huddle with ${nameList(othersOf(h, w.agent).map(o => o.name))}. Your part:\n\n${w.task}${extra ? `\n\n${ownerName()}'s answers and notes: ${extra}` : ''}\n\nDo it now: huddle rules are over, your usual instructions apply (approvals as usual), and end with report_done.`;
    try {
      const run = await io.runner.startRun({
        workspace: h.workspace, agentSlug: a.slug, kind: a.isBuilder ? 'build' : 'task', instruction: task,
        session: h.session, fromHuddle: h.id, ...(a.sessionId ? { resumeSessionId: a.sessionId } : {}),
      });
      started.push(run);
      h.workRunIds.push(run.id);
    } catch (e) { errors.push(`${a.name}: ${e.message}`); }
  }
  if (started.length) { h.status = 'approved'; h.approvedAt = new Date().toISOString(); h.ownerNote = extra || null; }
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
