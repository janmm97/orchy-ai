// Agents ring the owner, only inside the owner's dashboard: an incoming call they answer there with the agent's own
// voice agent (voiceagents.mjs#callSession). No phone line, so nobody else can be called or answer.
//   stuck  → a question or approval waited settings.callStuckMin minutes (default 10): its agent rings
//   asked  → the agent's bridge tool call_owner (urgent things only; never in a client's run)
//   done   → a run finished (off unless the owner switches it on)
// One call at a time, at most PER_DAY rings a day. Missed or declined calls land in Orchy's chat with
// "Call back". When a call ends, its transcript goes back into the run as a note (and to call_owner).
import { db, save, id } from './store.mjs';
import { bus, emit, clientCount } from './bus.mjs';
import { env, ownerName } from './env.mjs';
import { voiceEnabled } from './voice.mjs';
import * as voiceAgents from './voiceagents.mjs';
import * as inbox from './inbox.mjs';
import { addNote, ownerNote, isLive } from './runner.mjs';
import { say } from './orchy.mjs';
import { BUILDER_SLUG } from './agents.mjs';

const RING_MS = 45_000;
const PER_DAY = 12;
const PER_RUN = 2;          // call_owner per run
const CALL_BACK_MS = 24 * 3600_000;
const LIVE_MAX_MS = 20 * 60_000; // a live call this old was left open (tab closed, PC asleep): it's over
const AWAY_MS = 60_000;          // no dashboard open this long during a live call: it's over
const RANG = ['ringing', 'live', 'ended', 'missed', 'declined'];

const waiters = new Map();  // callId -> Set<resolve>
let current = null;         // the call ringing or live right now
let ringTimer = null;
let awaySince = null;       // when the last dashboard went away during a live call

const calls = () => (db().calls ||= {});
export const settings = () => {
  const s = db().settings;
  return { stuck: s.callStuck !== false, stuckMin: Number(s.callStuckMin) || 10, asked: s.callAsk !== false, done: s.callDone === true };
};

export function publicCall(c) {
  if (!c) return null;
  const { id: cid, key, name, role, workspace, runId, itemId, trigger, reason, status, at, endedAt } = c;
  return { id: cid, key, name, role, workspace, runId, itemId, trigger, reason, status, at, endedAt };
}
export const ringing = () => (current?.status === 'ringing' ? publicCall(current) : null);

const fail = (status, message) => Object.assign(new Error(message), { status });

/** Ring the owner for a run. Throws (with a plain reason) when it can't ring right now. */
export function ring(run, { trigger, reason, itemId = null, context = '' }) {
  if (!voiceEnabled()) throw fail(400, `voice is switched off in Orchy, so ${ownerName()} can't be called`);
  if (!env('ELEVENLABS_API_KEY')) throw fail(400, 'voice calls are off (no ElevenLabs key)');
  if (current) throw fail(409, `${ownerName()} is on another call`);
  if (!clientCount()) throw fail(409, `${ownerName()} isn’t at the Orchy dashboard right now`);
  // every call here rang (cancelled and busy ones too)
  const today = Object.values(calls()).filter(c => Date.now() - Date.parse(c.at) < 24 * 3600_000).length;
  if (today >= PER_DAY) throw fail(429, `${ownerName()} already got ${PER_DAY} calls today`);
  const key = voiceAgents.voiceKey(run.workspace, run.isBuilder ? BUILDER_SLUG : run.agentSlug);
  const own = key !== 'orchy';
  const name = own ? voiceAgents.nameOf(run.workspace, run.isBuilder ? BUILDER_SLUG : run.agentSlug) : 'Orchy';
  const c = {
    id: id('c'), key, name, role: run.agentName, workspace: run.workspace, runId: run.id, session: run.session || null,
    itemId, trigger, reason: String(reason).slice(0, 300), context: String(context).slice(0, 4000), status: 'ringing', at: new Date().toISOString(),
  };
  calls()[c.id] = c;
  for (const old of Object.values(calls()).sort((a, b) => b.at.localeCompare(a.at)).slice(200)) delete calls()[old.id];
  save();
  current = c;
  clearTimeout(ringTimer);
  ringTimer = setTimeout(() => { if (current === c && c.status === 'ringing') finish(c, 'missed'); }, RING_MS);
  emit('call.ringing', { call: publicCall(c) });
  return c;
}

/** The owner picked up (or calls back a missed one): the signed session with this call's greeting and reason. */
export async function answer(cid) {
  const c = calls()[cid];
  if (!c) throw fail(404, 'That call is gone');
  const callBack = c.status === 'missed' || c.status === 'declined';
  if (c.status !== 'ringing' && !(callBack && Date.now() - Date.parse(c.at) < CALL_BACK_MS)) throw fail(409, c.status === 'live' ? 'Already answered' : 'That call is over');
  if (current && current !== c) throw fail(409, 'Hang up the other call first');
  clearTimeout(ringTimer);
  c.status = 'live'; c.answeredAt = new Date().toISOString(); c.calledBack = callBack;
  current = c;
  awaySince = null;
  save();
  emit('call.updated', { call: publicCall(c) });
  try {
    return await voiceAgents.callSession(c.key, { firstMessage: greeting(c, callBack), context: brief(c, callBack) });
  } catch (e) {
    end(c.id, {});
    throw e;
  }
}

export function decline(cid, { busy = false } = {}) {
  const c = calls()[cid];
  if (!c || c.status !== 'ringing') return publicCall(c);
  finish(c, busy ? 'busy' : 'declined');
  return publicCall(c);
}

/** The call hung up: fetch what was said, put it in the run, and wake call_owner. */
export function end(cid, { conversationId } = {}) {
  const c = calls()[cid];
  if (!c) throw fail(404, 'That call is gone');
  if (c.status !== 'live') {
    // the watchdog already ended it and the page reports it late (back from sleep): still put what was said in the run
    if (c.cutOff && conversationId && !c.conversationId) { c.conversationId = conversationId; transcript(c).catch(() => {}); }
    return publicCall(c);
  }
  c.conversationId = conversationId || null;
  finish(c, 'ended');
  if (conversationId) transcript(c).catch(e => { c.transcriptError = e.message; settle(c); });
  else settle(c);
  return publicCall(c);
}

function finish(c, status) {
  clearTimeout(ringTimer);
  c.status = status;
  c.endedAt = new Date().toISOString();
  if (current === c) current = null;
  save();
  emit('call.updated', { call: publicCall(c) });
  if (status === 'missed' || status === 'declined') {
    say(`Missed call from ${c.name}${c.key === 'orchy' ? ` (about ${c.role})` : ` (${c.role})`}: ${c.reason}`, { workspace: c.workspace, session: c.session, runId: c.runId, callBack: { callId: c.id, key: c.key, name: c.name } });
  }
  // a stuck item that didn't get through (busy) can ring again on the next sweep
  if (status === 'busy' && c.itemId) { const it = inbox.getItem(c.itemId); if (it) { delete it.rang; save(); } }
  if (status !== 'ended') settle(c);
}

function settle(c) {
  for (const r of waiters.get(c.id) || []) r(c);
  waiters.delete(c.id);
}

async function transcript(c) {
  let conv;
  for (let i = 0; i < 20; i++) { // ElevenLabs processes the call for a few seconds after hang-up
    conv = await voiceAgents.conversation(c.conversationId);
    if (conv.status === 'done' || conv.status === 'failed') break;
    await new Promise(r => setTimeout(r, 3000));
  }
  const lines = (conv.transcript || []).filter(t => t.message).map(t => `${t.role === 'user' ? ownerName() : c.name}: ${t.message}`);
  c.transcript = lines.join('\n').slice(0, 8000);
  c.summary = conv.analysis?.transcript_summary || '';
  c.seconds = conv.metadata?.call_duration_secs || null;
  save();
  // a call about a client's task (the owner rung for a step on their PC) stays off the client's page
  try { (db().runs[c.runId]?.client ? ownerNote : addNote)(c.runId, `Call with ${ownerName()}${c.seconds ? ` (${Math.max(1, Math.round(c.seconds / 60))} min)` : ''}: ${(c.summary || c.transcript || 'nothing said').replace(/\s+/g, ' ').slice(0, 480)}`); } catch {}
  settle(c);
}

/** Long-poll for call_owner: resolves once the call is settled (or after ms). */
export function waitCall(cid, ms = 25_000) {
  const c = calls()[cid];
  if (!c) return Promise.resolve(null);
  if (isSettled(c)) return Promise.resolve(c);
  return new Promise(resolve => {
    const set = waiters.get(cid) || new Set();
    const done = () => { clearTimeout(t); set.delete(done); resolve(c); };
    const t = setTimeout(done, ms);
    set.add(done);
    waiters.set(cid, set);
  });
}
export const isSettled = c => !['ringing', 'live'].includes(c.status) && (c.status !== 'ended' || c.transcript !== undefined || !!c.transcriptError || !c.conversationId);

// ── what the voice agent says and knows ──
function greeting(c, callBack) {
  if (callBack) return c.key === 'orchy' ? `Hey ${ownerName()}, Orchy here. Thanks for calling back!` : `Hey ${ownerName()}, it's ${c.name}. Thanks for calling back!`;
  return c.key === 'orchy' ? `Hey ${ownerName()}, it's Orchy. Got a sec?` : `Hey ${ownerName()}, it's ${c.name}. Got a sec?`;
}

function brief(c, callBack) {
  const who = c.key === 'orchy' ? `You're calling for ${c.role} (run ${c.runId}), which has no voice of its own.` : `You're calling from your run ${c.runId} in Orchy.`;
  const it = c.itemId ? inbox.getItem(c.itemId) : null;
  const item = it?.status === 'pending' ? `
- It's waiting on ${ownerName()} as ${it.kind} ${it.id}. ${it.kind === 'question' ? `Ask it plainly${it.options?.length ? ` (the suggested answers: ${it.options.join('; ')})` : ''}. When ${ownerName()} answers, send it with answer_item, item_id "${it.id}" and ${ownerName()}'s answer.` : it.kind === 'approval' ? `Say what you want to do and why. Only when ${ownerName()} clearly says yes or no, use answer_item with item_id "${it.id}" and decision approve or deny.` : `It needs the dashboard (picking connections), so ask ${ownerName()} to open it there.`}` : c.itemId ? `\n- ${ownerName()} already dealt with it in the dashboard, so just check there's nothing else.` : '';
  return `# Why you called ${ownerName()}
You rang ${ownerName()} in the Orchy dashboard, so ${ownerName()} picked up there. ${who}${callBack ? ` ${ownerName()} missed your call and is calling back.` : ''}
- The reason: ${c.reason}${c.context ? `\n- What you know: ${c.context}` : ''}${item}
- Right after your greeting, say in a sentence or two why you called. Don't wait for ${ownerName()} to ask.
- Keep it short. Once it's settled, repeat ${ownerName()}'s answer back in a sentence (your run reads the transcript), say bye and end the call.`;
}

// ── triggers ──
const itemName = it => voiceAgents.callName(it.workspace, it.agent?.slug, it.agent?.displayName);

/** An agent asked to ring the owner (bridge call_owner). */
export function askedRing(run, reason) {
  if (!settings().asked) throw fail(403, `${ownerName()} switched off calls from agents (Settings)`);
  if (run.client) throw fail(403, `This run is for a client, so it can’t ring ${ownerName()}`);
  if (!isLive(run.id)) throw fail(409, 'Your run has ended');
  const mine = Object.values(calls()).filter(c => c.runId === run.id && c.trigger === 'asked' && RANG.includes(c.status)).length;
  if (mine >= PER_RUN) throw fail(429, `You already rang ${ownerName()} ${PER_RUN} times in this task`);
  const r = String(reason || '').trim();
  if (!r) throw fail(400, 'Say why you’re calling');
  return ring(run, { trigger: 'asked', reason: r });
}

// stuck: one ring per item that waited long enough, oldest first
function sweep() {
  const s = settings();
  if (!s.stuck || current || !env('ELEVENLABS_API_KEY')) return;
  for (const it of inbox.pending()) {
    if (it.answerer === 'client' || it.rang || Date.now() - Date.parse(it.createdAt) < s.stuckMin * 60_000) continue;
    const run = db().runs[it.runId];
    if (!run || !isLive(run.id)) continue;
    it.rang = true; save();
    const what = it.kind === 'approval' ? `needs your OK to ${String(it.title).replace(/^\w/, ch => ch.toLowerCase())}`
      : it.kind === 'connections' ? `needs you to pick the connections for ${it.payload?.agentName || 'a new agent'}` : `needs your answer: ${it.title}`;
    const mins = Math.round((Date.now() - Date.parse(it.createdAt)) / 60_000);
    try {
      ring(run, { trigger: 'stuck', itemId: it.id, reason: `${itemName(it)} ${what} (waiting ${mins} minutes)`, context: [it.message !== it.title ? it.message : '', it.context].filter(Boolean).join(' ') });
    } catch {} // away or capped: let it be
    return;
  }
}

// a live call nobody hangs up (the tab closed, the PC slept) would block every other call: end it, and wake call_owner
function watch() {
  const c = current;
  if (c?.status !== 'live') { awaySince = null; return; }
  awaySince = clientCount() ? null : awaySince || Date.now();
  const why = Date.now() - Date.parse(c.answeredAt || c.at) > LIVE_MAX_MS ? 'it ran past 20 minutes'
    : awaySince && Date.now() - awaySince > AWAY_MS ? 'the Orchy dashboard closed' : null;
  if (!why) return;
  c.cutOff = true;
  c.transcriptError = `the call was cut off: ${why}`;
  end(c.id, {});
}

function onEvent(e) {
  // The owner answered in the dashboard (or the run ended) while it rang: stop ringing
  if ((e.type === 'inbox.answered' || e.type === 'inbox.expired') && current?.status === 'ringing' && current.itemId === e.item?.id) finish(current, 'cancelled');
  if (e.type === 'run.ended' && current?.status === 'ringing' && current.runId === e.run?.id && current.trigger !== 'done') finish(current, 'cancelled');
  if (e.type === 'run.ended' && settings().done && e.run && !current) {
    const run = db().runs[e.run.id];
    if (!run || run.client || run.delegatedBy) return; // a client's run is theirs; a hand-off reports to its head
    const summary = String(run.report?.summary || run.resultText || '').replace(/\s+/g, ' ');
    try { ring(run, { trigger: 'done', reason: `${voiceAgents.callName(run.workspace, run.isBuilder ? BUILDER_SLUG : run.agentSlug, run.agentName)} ${run.outcome === 'completed' ? 'finished' : `ended (${run.outcome || run.status})`}: ${String(run.instruction || '').replace(/\s+/g, ' ').slice(0, 140)}`, context: `The report says: ${summary.slice(0, 1500)} Give ${ownerName()} the gist; get_result with run id ${run.id} has the rest.` }); } catch {}
  }
}

export function startCalls() {
  // nothing survives a restart mid-ring: a call that was ringing or live is over
  for (const c of Object.values(calls())) if (c.status === 'ringing' || c.status === 'live') { c.status = c.status === 'ringing' ? 'missed' : 'ended'; c.endedAt ||= new Date().toISOString(); }
  save();
  bus.on('event', onEvent);
  setInterval(sweep, 30_000).unref?.();
  setInterval(watch, 15_000).unref?.();
}
