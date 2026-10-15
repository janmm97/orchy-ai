// Orchy's own voice: chat replies, status answers, and report-backs when agents finish.
// Runs Claude under the default profile. Each session has its own Orchy memory, so two conversations
// never bleed into each other. In a session Orchy works from the Uploads folder with the Read tool, so he
// can open the files the owner gives him (and nothing outside that folder); everything else is tool-less.
import crypto from 'node:crypto';
import { ROOT, config, ownerName } from './env.mjs';
import { db, save } from './store.mjs';
import { emit } from './bus.mjs';
import { quickClaude } from './claude.mjs';
import { orchyPersonaFile } from './prompts.mjs';
import { listRuns } from './runner.mjs';
import { listAgents } from './agents.mjs';
import { workspaces, runtimeLabel } from './workspaces.mjs';
import { pending } from './inbox.mjs';
import { readLogs, fmtTime } from './logs.mjs';
import { post, ensureSession, sessionChat } from './sessions.mjs';
import { UPLOADS_DIR, filesBrief } from './uploads.mjs';
import { callName } from './voiceagents.mjs';
// "Chloe (Head of Social)": the name the owner calls the agent by, with its role
const who = r => callName(r.workspace, r.isBuilder ? 'agent-builder' : r.agentSlug, r.agentName);

function snapshot(sid) {
  const runs = listRuns(12).map(r => `- [${r.status}] ${who(r)} (${r.workspace})${r.clientName ? ` · started by ${r.clientName}` : ''} · ${r.model} · "${r.instruction.slice(0, 120)}"${r.report?.summary ? ` → ${r.report.summary.slice(0, 200)}` : ''}${r.error ? ` → error: ${r.error.slice(0, 120)}` : ''} · started ${fmtTime(r.startedAt)}${sid && r.session === sid ? ' · from this session' : ''}`).join('\n') || '- none yet';
  const agents = listAgents().map(a => `- ${callName(a.workspace, a.slug, a.displayName)} [${a.workspace}]${a.isBuilder ? ' (Chief of AI Agents)' : ''}: ${a.description.slice(0, 140)}`).join('\n') || '- none';
  const waiting = pending().filter(i => i.answerer !== 'client').map(i => `- ${i.kind} from ${i.agent?.displayName || 'an agent'}: ${i.title}`).join('\n') || '- nothing';
  const onClients = pending().filter(i => i.answerer === 'client').map(i => `- ${i.kind} for ${i.askee} from ${i.agent?.displayName || 'an agent'}: ${i.title}`).join('\n');
  const logs = readLogs().entries.slice(-5).map(e => `- ${e.when}: ${e.status} · ${e.workspace} · ${e.agent} · ${e.task.slice(0, 100)}`).join('\n') || '- empty';
  return `STATE (live, ${fmtTime(new Date().toISOString())})
Workspaces: ${workspaces().map(w => `${w.name} (client ${w.client}, ${runtimeLabel(w.runtime)}${w.enabled ? '' : ', SWITCHED OFF: gets no work'})`).join('; ')}
Agents:
${agents}
Recent runs:
${runs}
Waiting on ${ownerName()}:
${waiting}
${onClients ? `Waiting on clients (they answer on their own page, not ${ownerName()}):\n${onClients}\n` : ''}Latest LOGS.md entries:
${logs}`;
}

/**
 * Ask Claude as Orchy. With a session it remembers that conversation and can open files in Uploads
 * (its working folder, the only one Read reaches); without one it starts fresh, tool-less.
 */
async function think(prompt, { model, session = null, timeoutMs } = {}) {
  const useResume = session?.orchySessionId;
  try {
    const r = await quickClaude({
      prompt, model: model || config.orchy.chatModel, systemFile: orchyPersonaFile(), timeoutMs,
      ...(session ? { cwd: UPLOADS_DIR, tools: 'Read,Glob' } : { cwd: ROOT }),
      ...(useResume ? { resume: useResume } : { sessionId: crypto.randomUUID() }),
    });
    if (session && r.sessionId) { session.orchySessionId = r.sessionId; save(); }
    return r.text;
  } catch (e) {
    // only a memory Claude no longer has starts over; a timeout or outage keeps it for next time
    if (useResume && /no conversation found|session.{0,60}(not found|does not exist)/i.test(e.message)) {
      session.orchySessionId = null; save(); return think(prompt, { model, session, timeoutMs });
    }
    throw e;
  }
}

/** Orchy says something. meta.session puts it in that session's thread. */
export function say(text, meta = {}) {
  const { session = null, ...rest } = meta;
  return post('orchy', text, rest, session, { speak: !!rest.speak || !!db().settings.voiceReplies });
}

// Dispatches and report-backs are said without Claude, so they aren't in Orchy's memory of the
// session: give him the thread's recent lines with every reply.
function threadText(sid, excludeId) {
  const lines = sessionChat(sid, 12).filter(m => m.id !== excludeId).slice(-10).map(m => {
    const run = m.meta?.runId ? db().runs[m.meta.runId] : null;
    const files = m.meta?.files?.length ? ` [attached, in Uploads: ${m.meta.files.map(f => `"${f.name}"`).join(', ')}]` : '';
    return `- ${m.role === 'owner' ? ownerName() : 'You'}: ${String(m.text).replace(/\s+/g, ' ').slice(0, 300)}${files}${run ? ` [run ${run.status}]` : ''}`;
  });
  return lines.length ? `THIS SESSION so far (oldest first):\n${lines.join('\n')}\n\n` : '';
}

/** The owner said something in a session that isn't a dispatch: answer it there. */
export async function reply(text, { model, viaVoice, session, messageId, direct = false } = {}) {
  emit('orchy.state', { state: 'thinking', session: session.id });
  try {
    // "Just answer" on a routing card: the owner chose an answer over a run, so nothing went to any agent
    const own = direct ? `${ownerName()} pressed "Just answer" on the routing card: answer this yourself. Nothing was sent to any agent, so never say you sent or handed it on. If it truly needs an agent to look something up in a client's apps, say so in one line and suggest ${ownerName()} sends it as a task.\n\n` : '';
    const answer = await think(`${snapshot(session.id)}\n\n${threadText(session.id, messageId)}${own}${ownerName()} says: ${text}`, { model, session });
    return say(answer || 'Hmm, I drew a blank there. Try me again?', { speak: viaVoice, session: session.id });
  } catch (e) {
    return say(`I couldn't think that through: ${e.message}`, { error: true, session: session.id });
  } finally {
    emit('orchy.state', { state: 'idle', session: session.id });
  }
}

/** The owner gave Orchy files (already in Uploads): open them and answer in the session. */
export async function review(text, files, { viaVoice, session, messageId } = {}) {
  emit('orchy.state', { state: 'thinking', session: session.id });
  try {
    const many = files.length > 1;
    const prompt = `${snapshot(session.id)}

${threadText(session.id, messageId)}${ownerName()} gave you ${many ? `${files.length} files` : 'a file'} to review. ${many ? 'They are' : 'It is'} in your working folder (the Uploads folder):
${filesBrief(files)}

This is a file review: open every file before answering, and be as thorough as ${ownerName()}'s request needs. Short paragraphs and simple lists are fine here (still no tables, headings or code blocks). Point to the exact spot (page, slide, sheet, line) when it matters. Never describe anything you couldn't open; say which file and why.

${ownerName()} says: ${text || 'Have a look at this and tell me what you think.'}`;
    const answer = await think(prompt, { model: 'sonnet', session, timeoutMs: 600_000 });
    return say(answer || 'I opened it but drew a blank. Ask me something specific about it?', { speak: viaVoice, session: session.id, kind: 'review' });
  } catch (e) {
    return say(`I couldn't review that: ${e.message}`, { error: true, session: session.id });
  } finally {
    emit('orchy.state', { state: 'idle', session: session.id });
  }
}

/**
 * An agent finished: tell the owner, short and speakable. `extra.tail` is a line Orchy adds as is, `extra.meta` rides on
 * the message (a fix of Orchy's own code: its restart, reload and undo buttons).
 */
export async function reportRun(run, ws, extra = {}) {
  const r = run.report || {};
  const facts = run.backend ? `You just finished working on your own code (Orchy's), because ${ownerName()} reported a problem. Tell ${ownerName()} in 1-2 short spoken sentences, in the first person, what was wrong and what you changed (or why you couldn't). Don't mention restarting, reloading or what happens next; that's said right after.
${ownerName()} said: ${run.instruction.slice(0, 400)}
Outcome: ${run.outcome}
Report: ${(r.summary || run.resultText || run.error || '').slice(0, 1500)}
Files changed: ${(run.backendChanges || []).map(c => `${c.file} (${c.change})`).join(', ') || 'none'}
Follow-ups: ${(r.follow_ups || []).join('; ') || 'none'}` : `An agent just finished. Tell ${ownerName()} in 1-2 short spoken sentences what happened, starting with the agent and client. Mention if anything needs ${ownerName()}.
Agent: ${who(run)} in ${ws.name} (client ${ws.client})
${run.clientName ? `Started by: ${run.clientName}, from their own client page (they already see the result there)\n` : ''}Task: ${run.instruction.slice(0, 400)}
Outcome: ${run.outcome}
Summary: ${(r.summary || run.resultText || run.error || '').slice(0, 1500)}
Follow-ups: ${(r.follow_ups || []).join('; ') || 'none'}
New/updated agents: ${(run.createdAgents || []).map(a => a.error ? `${a.slug} (BROKEN FILE, can't run until fixed: ${a.error.split('\n')[0]})` : a.slug).join(', ') || 'none'}`;
  let text;
  try {
    text = await think(facts, { model: config.orchy.summaryModel });
  } catch {
    const ok = run.outcome === 'completed';
    text = run.backend
      ? `${ok ? 'Done working on my code' : run.outcome === 'stopped' ? 'My fix was stopped' : 'My fix ran into trouble'}. ${(r.summary || run.error || '').split(/(?<=\.)\s/)[0] || ''}`.trim()
      : `${who(run)} in ${ws.name} ${ok ? 'is done' : run.outcome === 'stopped' ? 'was stopped' : 'ran into trouble'}. ${(r.summary || run.error || '').split(/(?<=\.)\s/)[0] || ''}`.trim();
  }
  if (extra.tail) text = `${text} ${extra.tail}`;
  // the report goes back to the session that sent the work (runs from before sessions get their own)
  const session = ensureSession(run.session, { text: run.instruction, origin: 'run' });
  if (run.session !== session.id) { run.session = session.id; save(); }
  return say(text, { runId: run.id, workspace: ws.id, kind: 'report', outcome: run.outcome, session: session.id, ...(extra.meta || {}) });
}

// ── The daily greeting: a fresh, funny hello the first time the owner opens Orchy each day ──
// Written once per day (the owner's date), posted to the chat, and replayed whenever Orchy starts
// at sign-in that day. Each day gets its own comedic style so it never feels like a rerun.
const greetingStyles = () => [
  'a one-line fake news headline about Orchy, then one short encouraging sentence',
  'a tiny robot confession about something silly Orchy did overnight',
  'a motivational-poster parody (the poster line, then a wink)',
  'a three-line haiku about the day ahead, light and silly (put it on one line, separated by slashes)',
  'a weather report from inside Orchy\'s circuits',
  `an over-the-top sports commentator welcoming ${ownerName()} onto the field for the shift`,
  'a pun about pixels, robots, inboxes or calendars',
  'an obviously made-up "fun fact" about robots, then a nudge to start the day',
  'a dramatic movie-trailer voice-over for today',
  'a pep talk from a very small, very serious robot coach',
  `a playful horoscope for ${ownerName()}, sign: Virtual Assistant`,
  'a video-game loading-screen tip for today\'s level',
  `a nature-documentary narrator observing ${ownerName()} arriving at the desk`,
  'a fake product announcement for an absurd upgrade Orchy installed overnight',
];
const fallbackGreetings = () => [
  `Breaking news: local robot polishes every pixel, reports feeling extremely shiny. Let's make today a good one, ${ownerName()}.`,
  'Confession: I spent the night alphabetizing my bits. Ready when you are.',
  'Loading screen tip: coffee first, inbox second. You\'ve got this.',
  'Weather inside my circuits: sunny, with a 100% chance of getting things done.',
  `And ${ownerName()} takes the field! The crowd goes wild. Well, I do. Let's go.`,
  'Fun fact: robots can\'t drink coffee, which is why I run on your good vibes. Morning!',
  `In a world of overflowing inboxes, one assistant dared to clock in. Today: ${ownerName()}.`,
];

const dateET = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(d);
const hashStr = s => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);
let greetingInFlight = null;

export function dailyGreeting() {
  const st = db();
  st.greetings ||= [];
  const today = dateET();
  const have = st.greetings.find(g => g.date === today);
  if (have) return Promise.resolve({ ...have, isNew: false });
  if (greetingInFlight) return greetingInFlight;
  greetingInFlight = (async () => {
    const now = new Date();
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', hour12: false }).formatToParts(now).map(p => [p.type, p.value]));
    const hour = Number(parts.hour) % 24;
    const partOfDay = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
    const style = greetingStyles()[hashStr(today) % greetingStyles().length];
    const dayNote = {
      Monday: 'It is Monday. Acknowledge it with humour and make Monday feel like a fun fresh start, not a chore.',
      Friday: 'It is Friday. A little celebratory energy is welcome.',
    }[parts.weekday] || '';
    const recent = st.greetings.slice(-14).map(g => `- ${g.text}`).join('\n') || '- none yet';
    const prompt = `Write today's greeting for ${ownerName()}. It appears in your speech bubble and is read aloud when ${ownerName()} signs in to start the shift.
Today: ${parts.weekday}, ${parts.month} ${parts.day}. It's ${partOfDay} in ${config.timezone}.
Today's comedic style: ${style}.
${dayNote}
Rules: genuinely funny and warm, the kind of line that puts someone in a good mood. One to three short sentences, at most 45 words. Workplace-safe. No emoji, no markdown, no quotation marks around the whole thing, no hashtags. Don't mention clients, tasks, agents or numbers from work. Don't reuse a joke or premise from these earlier greetings:
${recent}
Reply with the greeting only.`;
    let text = '';
    try {
      text = (await think(prompt, { model: 'sonnet' }) || '').trim().replace(/^["“]|["”]$/g, '').replace(/[*_#`]/g, '');
    } catch (e) {
      console.warn('[orchy] greeting fell back:', e.message);
    }
    if (!text || text.length > 400) text = fallbackGreetings()[hashStr(today) % fallbackGreetings().length];
    const msg = say(text, { kind: 'greeting' });
    const g = { date: today, text, at: msg.at, messageId: msg.id };
    st.greetings.push(g);
    st.greetings = st.greetings.slice(-30);
    save();
    return { ...g, isNew: true };
  })().finally(() => { greetingInFlight = null; });
  return greetingInFlight;
}
