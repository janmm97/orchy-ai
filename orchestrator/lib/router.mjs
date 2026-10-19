// Routing: Jev decides intent, client workspace, agent and model for each instruction.
// Only workspaces that are switched on take part: a disabled one is invisible here, even when
// the owner names it, so Orchy never sends it work.
import fs from 'node:fs';
import path from 'node:path';
import { config, ORCH_DIR, ownerName } from './env.mjs';
import { ask } from './jev.mjs';
import { askViaHarness } from './brain.mjs';
import { workspaces, tierModel, modelsFor, modelFor, handles, BACKEND_ID } from './workspaces.mjs';
import { engine } from './engines/index.mjs';
import { listAgents, BUILDER_SLUG } from './agents.mjs';
import { db } from './store.mjs';
import { nameOf } from './voiceagents.mjs';
import { budgetLine, budgetPace } from './usagereview.mjs';

function agentKey(wsId, slug) { return `${wsId}/${slug || 'general'}`; }

// How Orchy works, for Jev's routing reads: orchestrator/jev-primer.md, written by hand, read again when it changes
const PRIMER_FILE = path.join(ORCH_DIR, 'jev-primer.md');
let primerCache = { mtime: -1, text: '', owner: '' };
export function jevPrimer() {
  try {
    const { mtimeMs } = fs.statSync(PRIMER_FILE);
    if (mtimeMs !== primerCache.mtime || primerCache.owner !== ownerName()) primerCache = { mtime: mtimeMs, owner: ownerName(), text: fs.readFileSync(PRIMER_FILE, 'utf8').replace(/^#[^\n]*\n+/, '').replace(/\{\{OWNER\}\}/g, ownerName()).trim() };
  } catch { primerCache = { mtime: -1, text: '', owner: '' }; }
  return primerCache.text;
}

/** "Ada, Chief Marketing Officer": the first name the owner calls an agent by, then its role. */
function agentLabel(a, nameFor) {
  const n = nameFor(a.workspace, a.slug) || a.callName;
  return n && n.toLowerCase() !== String(a.displayName).toLowerCase() ? `${n}, ${a.displayName}` : a.displayName;
}

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Names that are also everyday words ("main", "one") only count when the owner clearly means the workspace:
// "@main", "for Main", "Main's inbox", "in main." / "for main's Slack", "Main: …", "Main Agent". The owner's own first name is one too.
const COMMON = new Set(['one', 'me', 'my', 'all', 'any', 'home', 'main', 'work', 'team', 'core', 'ops', 'us', 'it', 'go', 'hub', 'base', 'lab', 'desk', 'new', 'admin', 'personal']);
const isCommon = h => COMMON.has(h) || h === ownerName().toLowerCase();
const POINTER = '(?:for|to|in|on|at|via|from|with|into|inside|under|over to|hand(?: it)? to|send(?: it)? to)';

/** Does the instruction name this handle? */
function mentions(text, handle) {
  const h = handle.toLowerCase();
  const e = esc(h);
  const t = text.toLowerCase();
  if (new RegExp(`(^|[^\\w])@${e}(?![\\w])`).test(t)) return true;
  // a number ("314") never counts inside a bigger number, phone number or amount: "2,314", "314-555-0199", "314.50", "314%"
  const [pre, post] = /^\d+$/.test(h) ? ['(?<!\\d,)', '(?![-,.]\\d|%)'] : ['', ''];
  if (!isCommon(h)) return new RegExp(`(^|[^\\w@$£€#.])${pre}${e}(?![\\w])${post}`).test(t);
  const Cap = esc(h[0].toUpperCase() + h.slice(1));
  return new RegExp(`(?<=[\\w,;)'"’]\\s+)${Cap}\\b(?!\\s+of\\b)`).test(text) // capitalised mid-sentence: "draft it for Main"
    || new RegExp(`(^|[^\\w])${Cap}\\s+(Agent|workspace)\\b`).test(text) // "Main Agent, please …"
    || new RegExp(`^\\s*${Cap}\\s*[:–—-]`).test(text) // "Main: check the inbox"
    || new RegExp(`\\b${POINTER}\\s+(the\\s+)?${e}(?=\\s*$|\\s*[.,;:!?)]|['’]s\\b|\\s+workspace\\b)`).test(t); // "do it in main." / "for main's slack"
}

/** Every switched-on workspace the owner names in this text, by id, alias, or name ("Acme", "@acme"). */
export function namedTargets(text, wss) {
  return wss.filter(w => handles(w).some(h => mentions(String(text || ''), h))).map(w => w.id);
}

/** The owner named exactly one switched-on workspace. */
function explicitTarget(text, wss) {
  const hits = namedTargets(text, wss);
  return hits.length === 1 ? hits[0] : null;
}

/** The owner named a switched-off workspace ("@acme", "Acme Agent", or its client by a distinctive name). */
export function offTarget(text, off) {
  const cased = text.replace(/[^\w\s@-]/g, ' ');
  const t = cased.toLowerCase();
  for (const w of off) {
    if (handles(w).some(h => mentions(text, h))) return w;
    const names = [w.name, String(w.client || '').replace(/\(.*?\)/g, '')].map(s => s.replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim()).filter(s => s.length >= 4);
    // a name that starts with an everyday word ("Main Agent") only counts written as a name: "build main agent" isn't it
    if (names.some(n => isCommon(n.split(' ')[0].toLowerCase()) ? new RegExp(`\\b${esc(n)}\\b`).test(cased) : new RegExp(`\\b${esc(n.toLowerCase())}\\b`).test(t))) return w;
  }
  return null;
}

// ── precedent: what the owner sent each workspace before ──
const STOP = new Set(['the', 'and', 'for', 'you', 'your', 'this', 'that', 'with', 'from', 'please', 'can', 'could', 'would', 'need', 'want', 'let', 'know', 'have', 'has', 'are', 'was', 'his', 'her', 'our', 'them', 'they', 'what', 'when', 'who', 'all', 'any', 'but', 'not', 'now', 'just', 'also', 'here', 'there', 'into', 'about', 'will', 'did', 'does', 'how', 'why']);
const words = s => new Set((String(s).toLowerCase().replace(/https?:\/\/\S+|\S*\\\S*/g, ' ').replace(/['’]s\b/g, '').match(/[a-z0-9]{3,}/g) || []).filter(w => !STOP.has(w)));
const clip = s => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > 140 ? t.slice(0, 139) + '…' : t; };

/** The owner's own earlier instructions (no scheduled runs, follow-ups or heads' hand-offs), newest first, one per wording. */
function pastTasks(live) {
  const seen = new Set();
  return Object.values(db().runs || {})
    .filter(r => r.kind === 'task' && !r.parentRunId && !r.delegatedBy && !r.client && r.routing?.source !== 'schedule' && live.has(r.workspace) && r.instruction)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .filter(r => { const k = r.instruction.trim().toLowerCase(); return !seen.has(k) && !!seen.add(k); });
}

/**
 * Per workspace: the newest tasks the owner sent it, plus older ones sharing a rare word with this instruction
 * ("Maria", "resume"), so people, projects and documents stay with the client they already belong to.
 * A task the owner moved off Jev's pick says so.
 */
export function earlierTasks(text, wss, { newest = 4, related = 4 } = {}) {
  const pool = pastTasks(new Set(wss.map(w => w.id)));
  const bags = pool.map(r => words(r.instruction));
  const df = new Map();
  for (const b of bags) for (const w of b) df.set(w, (df.get(w) || 0) + 1);
  const rare = [...words(text)].filter(w => df.has(w) && df.get(w) / pool.length <= 0.2);
  const score = bags.map(b => rare.reduce((s, w) => s + (b.has(w) ? Math.log(pool.length / df.get(w)) : 0), 0));
  const line = r => clip(r.instruction) + (r.routing?.overridden && r.routing.workspace && r.routing.workspace !== r.workspace ? ` (${ownerName()} moved this here)` : '');
  return Object.fromEntries(wss.map(w => {
    const mine = pool.map((_, i) => i).filter(i => pool[i].workspace === w.id);
    const pick = new Set(mine.slice(0, newest));
    mine.filter(i => score[i] > 0 && !pick.has(i)).sort((a, b) => score[b] - score[a] || a - b).slice(0, related).forEach(i => pick.add(i));
    return [w.id, [...pick].sort((a, b) => a - b).map(i => line(pool[i]))];
  }));
}

// Orchy (or his dashboard) named with something wrong: a fix of his own code
const FIX_ORCHY = t => /\b(orchy|dashboard)\b/i.test(t) && /\b(bug|broken|fix|error|crash(es|ed)?|not working|doesn'?t work|won'?t|stuck|blank|freez(es|ing))\b/i.test(t);
const fixGuess = () => ({ intent: 'fix_orchy', workspace: BACKEND_ID, agent: null, model: 'opus', tier: 2, confidence: 0.5, source: 'heuristic' });

/** A message with files that asks to fix Orchy (a screenshot of the problem): its routing, else null (Orchy reviews the files). */
export function fixRouting(text) {
  return FIX_ORCHY(String(text || '')) ? finalize({ ...fixGuess(), source: 'files' }) : null;
}

// Offline fallback: the words that point at a workspace: its client, name, aliases and the longer words of its blurb.
const BLURB_SKIP = new Set(['work', 'works', 'working', 'client', 'clients', 'agent', 'agents', 'workspace', 'their', 'there', 'which', 'about', 'other', 'orchy', 'tasks', 'inbox', 'email', 'emails']);
function keywordsOf(w) {
  const names = [w.client, w.name.replace(/\s+agent$/i, ''), ...(w.aliases || [])].map(s => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').trim()).filter(s => s.length > 2);
  const blurb = (String(w.blurb || '').toLowerCase().match(/[a-z0-9]{5,}/g) || []).filter(s => !STOP.has(s) && !BLURB_SKIP.has(s));
  return [...new Set([...names, ...blurb])].filter(s => !isCommon(s));
}
function heuristic(text, wss, agents = []) {
  const t = text.toLowerCase();
  if (FIX_ORCHY(t)) return fixGuess(); // the card still waits for the owner
  const build = /\b(build|create|make|design|set ?up|spin up|hire)\b.*\bagent\b|\bagent builder\b|\bnew agent\b/.test(t);
  const status = /\b(status|progress|what('s| is) (running|happening)|logs?|how did|did .* finish)\b/.test(t);
  const question = /^(what|who|why|how|when|where|is|are|can|do|does|should)\b.*\?$/.test(t.trim());
  const named = wss.filter(w => keywordsOf(w).some(s => new RegExp(`\\b${esc(s)}\\b`).test(t)));
  const said = explicitTarget(text, wss) || (named.length === 1 ? named[0].id : null);
  // an agent called by its name ("ask Ada to…"), in the workspace named or, with none named, in any
  const agent = agentByName(t, agents.filter(a => !said || a.workspace === said));
  // a question with no workspace named is for Orchy; work with none named goes to the only workspace there is
  const chat = question && !said && !agent;
  const ws = said || agent?.workspace || (!chat && wss.length === 1 ? wss[0].id : null);
  const pick = ws && wss.find(w => w.id === ws);
  return {
    intent: build ? 'build_agent' : status ? 'status' : chat ? 'chat' : 'task',
    workspace: ws,
    agent: agent && agent.workspace === ws ? agent.slug : null,
    model: pick ? tierModel(pick, text.length > 400 ? 2 : 1) : null,
    confidence: said || agent ? 0.6 : ws ? 0.45 : 0.3,
    source: 'heuristic',
  };
}

/** The one agent whose name (its first word, at least 3 letters) the text says as a word; none or two: null. */
function agentByName(t, agents) {
  const hits = agents.filter(a => {
    const first = String(a.displayName || '').trim().split(/\s+/)[0].toLowerCase();
    return first.length >= 3 && !isCommon(first) && new RegExp(`\\b${esc(first)}\\b`).test(t);
  });
  return hits.length === 1 ? hits[0] : null;
}

// ── huddles: two or more agents of one workspace talk something through (huddle.mjs) ──
const HUDDLE_WORDS = /\b(huddle|meet(ing)?|talk (it )?(over|through)|discuss|together|sync up|sit down|brainstorm|align|put .{1,40} heads together|confer)\b/i;

/** Agents the owner names in the text (call name, role or slug; the builder also as "builder"), in the order they appear. */
export function namedAgents(text, agents, nameFor = () => null) {
  const hits = [];
  for (const a of agents) {
    const at = nameAt(text, a, nameFor);
    if (at >= 0) hits.push({ a, at });
  }
  return hits.sort((x, y) => x.at - y.at).map(h => h.a);
}
/** Where the owner first names this agent in the text (call name, role or slug), or -1. */
function nameAt(text, a, nameFor = () => null) {
  const t = String(text || '');
  const names = [nameFor(a.workspace, a.slug), a.callName, a.displayName, a.slug, ...(a.isBuilder ? ['agent builder', 'builder'] : [])].filter(n => n && String(n).length >= 3);
  let at = -1;
  for (const n of names) {
    const m = new RegExp(`(^|[^\\w])${esc(String(n)).replace(/[-\s]+/g, '[-\\s]+')}(?![\\w])`, 'i').exec(t);
    if (m && (at < 0 || m.index < at)) at = m.index;
  }
  return at;
}

/** The agents of a huddle: everyone the owner named, topped up to two with Jev's picks; all in one workspace, never the same twice. */
export function huddlePair(text, agents, { first = null, second = null, workspace = null, nameFor } = {}) {
  const named = namedAgents(text, agents, nameFor);
  // every workspace has a builder, so "the builder" alone doesn't place it: the workspace most of the named agents
  // (and Jev's picks, as a tiebreak) live in does, then whichever was named first
  const score = new Map();
  named.forEach(a => score.set(a.workspace, (score.get(a.workspace) || 0) + (a.isBuilder ? 1 : 1.5)));
  [first, second].filter(Boolean).forEach(a => score.set(a.workspace, (score.get(a.workspace) || 0) + 0.25));
  const best = [...score.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
  const ws = workspace || best || null;
  const pick = [];
  for (const a of named) if (a.workspace === ws && !pick.some(p => p.slug === a.slug)) pick.push(a);
  // Jev's picks only fill in when the owner named fewer than two
  for (const a of [first, second].filter(Boolean)) if (pick.length < 2 && a.workspace === ws && !pick.some(p => p.slug === a.slug)) pick.push(a);
  return { workspace: ws, agents: pick.map(a => a.slug) };
}

// ── missions: several agents of one workspace in a row (missions.mjs) ──
// Jev's `mission` reading only stands when the words read as more than one piece of work in a row ("research X and
// make a PDF", "find …, then draft …"). It's a necessary sign, not a sufficient one: most two-verb asks stay tasks.
const WORK_VERB = /\b(research|find|look ?up|search|gather|collect|compile|analy[sz]e|audit|review|summari[sz]e|write|draft|make|create|design|build|turn|convert|render|produce|edit|record|prepare|plan|outline|scrape|pull|check|translate|format|compare|rank|score|generate|illustrate|animate|post|send|schedule|publish|email|storyboard|script)\b/gi;
const SEQUENCE = /\b(then|after that|afterwards|followed by|once (?:that|it|you|they)['’]?s?\b|from (?:that|it|the (?:research|findings|results|notes))|based on (?:that|it|the (?:research|findings|results|notes))|use (?:that|it|the (?:research|findings|results|notes)) to|turn (?:it|that|them|the \w+) into)\b/i;
const AND_MAKE = /(?:\band|,)\s+(?:have \w+\s+|get \w+ to\s+|let \w+\s+)?(?:make|create|write|draft|design|turn|build|produce|render|prepare|storyboard|script)\b/i;
export function missionShape(text) {
  const t = String(text || '');
  const verbs = new Set((t.match(WORK_VERB) || []).map(v => v.toLowerCase().replace(/\s+/g, '')));
  return verbs.size >= 2 && (SEQUENCE.test(t) || AND_MAKE.test(t));
}
/** The owner names this agent only after the work has started ("research X, then have Ada make the PDF"): it owns a later step, not the whole ask. */
function laterStepOnly(text, a, nameFor) {
  const at = nameAt(text, a, nameFor);
  const first = String(text || '').search(new RegExp(WORK_VERB.source, 'i'));
  return at >= 0 && first >= 0 && first < at;
}
const MISSION_MIN = 0.5;  // Jev's mission probability below this stays a task
export const MISSION_SURE = 0.7; // and at or above this the mission card may start on its own (missions.mjs#SURE)

// ── earlier runs in this session: is the owner continuing one, or asking how it went? ──
const RUN_CHOICES = 5;
const clipRun = r => `${r.agentName} in ${r.workspace}: "${clip(r.instruction || '')}" → ${r.status}${r.report?.summary ? `: ${clip(r.report.summary)}` : ''}`;

/** The runs the owner's message may be about: this session's latest, never a client's or a head's hand-off. */
export function earlierRuns(runs, sid) {
  return runs.filter(r => r.session === sid && !r.client && !r.delegatedBy)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, RUN_CHOICES);
}

export function earlierRunQuestion(runs) {
  return {
    type: 'choice',
    instructions: `Is ${ownerName()}'s new message about one of the runs started earlier in this conversation? Pick that run when ${ownerName()} continues it (more work on the same thing, a correction, "now send it", "also add X to that", "try again") or asks how it went or what it found. Pick none for a new, separate piece of work, even for the same agent or client.`,
    criteria: { none: 'Not about any of these runs: a new, separate task or question', ...Object.fromEntries(runs.map((r, i) => [`r${i}`, clipRun(r)])) },
  };
}

// What a status question asks, so the common ones are answered from Orchy's own records without Claude.
const statusQuestion = () => ({
  type: 'choice',
  instructions: `If ${ownerName()} is asking about progress or state, what exactly does ${ownerName()} want to know?`,
  criteria: {
    running: 'What is running or being worked on right now',
    waiting: `What is waiting on ${ownerName()}: questions, approvals, decisions`,
    run: 'How one particular earlier task went, or what it found or produced',
    other: 'Anything else: opinions, explanations, plans, history, counts, or not a status question at all',
  },
});

/**
 * Route an instruction. Returns a routing proposal the dashboard shows before dispatch.
 * `recent`: the latest messages of the session it was said in. `runs`: that session's latest runs
 * (earlierRuns), so a follow-up can continue its run and "how did it go" can be answered from it.
 * `ask`, `workspaces`, `agents`, `names` (voice names) and `primer` (jev-primer.md) let tests fake Jev and the setup. `purpose` labels the Jev call in the log
 * ('live' when Jev reads as the owner types, livejev.mjs). `files`: names of files the owner attached to the message.
 */
export async function route(text, { recent = [], runs = [], files = [], purpose = 'routing', ask: askJev = ask, harness, workspaces: all = workspaces(), agents: allAgents = listAgents(), names = nameOf, primer = jevPrimer(), budget = currentBudget() } = {}) {
  const wss = all.filter(w => w.enabled);
  const live = new Set(wss.map(w => w.id));
  const agents = allAgents.filter(a => !a.isBuilder && live.has(a.workspace));
  const forced = explicitTarget(text, wss);

  // Work meant for a switched-off workspace is left alone: never re-routed to another client.
  const off = forced ? null : offTarget(text, all.filter(w => !w.enabled));
  if (off) return finalize({ intent: 'ignored', workspace: null, agent: null, model: null, confidence: 1, source: 'switched-off', switchedOff: { id: off.id, name: off.name } });

  if (!wss.length) {
    return finalize({ intent: 'chat', workspace: null, agent: null, model: null, confidence: 1, source: 'none-enabled' });
  }

  // What the owner calls each workspace ("Acme", "Beta"), so Jev reads the short names the way the owner means them.
  const calls = w => `${ownerName()} calls it: ${handles(w).map(h => `"${h}"`).join(', ')}.`;
  const describe = w => `${w.name} — client ${w.client}. ${calls(w)} ${w.blurb}`;
  const named = namedTargets(text, wss);
  // A follow-up without a name ("now draft the reply") most likely continues with the last workspace the owner named.
  const lastNamed = named.length ? null : [...recent].reverse().filter(m => m.role === 'user' || m.role === 'owner').map(m => namedTargets(m.text, wss)).find(h => h.length === 1)?.[0] || null;

  // every agent Jev may pick, by the name the owner calls it, the AI Agent Builders included (picking one makes it build_agent)
  const agentCriteria = {};
  for (const w of forced ? wss.filter(x => x.id === forced) : wss) {
    agentCriteria[agentKey(w.id, null)] = `${w.name} generalist: any task for ${w.client} when no specialist below fits. ${w.blurb}`;
    const mine = allAgents.filter(a => a.workspace === w.id);
    for (const a of mine) {
      const team = (a.team || []).map(s => mine.find(x => x.slug === s)).filter(Boolean).map(x => agentLabel(x, names).split(',')[0]);
      agentCriteria[agentKey(w.id, a.slug)] = a.isBuilder
        ? `${agentLabel(a, names)} in ${w.name}: creates, changes and retires ${w.name}'s agents, and decides which apps and connections each one may use`
        : `${agentLabel(a, names)} in ${w.name} (${w.client}): ${a.description}${team.length ? ` Leads a team: ${team.join(', ')}.` : ''}`;
    }
  }
  const conversation = recent.map(m => `${m.role}: ${m.text}`).join('\n');
  // every agent that can join a huddle, the AI Agent Builders included
  const huddlers = allAgents.filter(a => live.has(a.workspace) && (!forced || a.workspace === forced));
  // agents the owner names ("Ada", "Iris", "the builder"): Jev is told who they are, and two of one workspace may be a huddle
  const namedHere = namedAgents(text, huddlers, names);
  const twoNamed = namedHere.some((a, i) => namedHere.some((b, j) => j !== i && b.workspace === a.workspace));
  const huddleish = huddlers.length >= 2 && (HUDDLE_WORDS.test(text) || twoNamed);

  const wsName = id => wss.find(w => w.id === id)?.name || id;
  const state = {
    ...(primer ? { how_orchy_works: primer } : {}),
    instruction: text,
    ...(files.length ? { files_owner_attached: `${files.join(', ')}. ${ownerName()} attached these to the instruction; "this", "it" or "the file" means them. Giving them to an agent, or having an agent use them for work, is a task; only ${ownerName()} asking what is in them or what Orchy thinks of them is chat.` } : {}),
    agents_named_in_instruction: namedHere.length ? namedHere.map(a => `${agentLabel(a, names)} in ${wsName(a.workspace)} (${agentKey(a.workspace, a.slug)})`).join('; ') : '(none)',
    recent_conversation: conversation || '(none)',
    workspaces: Object.fromEntries(wss.map(w => [w.id, describe(w)])),
    workspaces_named_in_instruction: named.length ? named.join(', ') : '(none)',
    workspace_named_earlier_in_conversation: lastNamed || '(none)',
    earlier_tasks_by_workspace: earlierTasks(text, wss),
    ...(runs.length ? { runs_earlier_in_this_conversation: runs.map((r, i) => `r${i}: ${clipRun(r)}`).join('\n') } : {}),
    ...(budget?.line ? { usage_this_week: budget.line } : {}),
  };
  const questions = {
    intent: {
      type: 'choice',
      instructions: `What is ${ownerName()} asking for?`,
      criteria: {
        task: 'Work an agent must do in a client workspace using tools or connected apps (email, docs, research, scheduling, CRM, files...)',
        build_agent: 'Create, change, or retire an AI agent (a reusable specialist) in a workspace, including giving an agent access to an app or connection: the workspace\'s AI Agent Builder does it',
        chat: 'Small talk or a general question Orchy can answer directly without touching any client app',
        status: 'Asking about progress, running agents, results or logs of earlier work',
        mission: `Work that needs two or more DIFFERENT agents of one workspace one after another, each using what the one before made (one researches, then another designs a PDF report from that research). Not a mission when one agent or the workspace generalist can do it end to end (most work), when ${ownerName()} names the one agent to do it, or when a department head would hand it to its own team`,
        huddle: `Get two or more agents of one workspace to talk something through together first (a huddle or meeting between agents), then each does its part once ${ownerName()} approves what they agree. Also when ${ownerName()} has one named agent ask, brief, check with or get the view of another named agent, even if one of them must also change something`,
        fix_orchy: `Something is wrong with Orchy itself, this orchestrator app and its dashboard (a button, window or pane that misbehaves, an error Orchy shows, a crash, routing, voice or calls not working, a run failing because of Orchy rather than a client app), or ${ownerName()} wants Orchy's own code, behaviour or look changed. Not work on a client's or ${ownerName()}'s own website, apps or code`,
      },
    },
    workspace: {
      type: 'choice',
      instructions: `Which client workspace does this belong to? ${ownerName()} refers to workspaces by the short names listed (e.g. "for <name>", "<name> task"); a workspace ${ownerName()} names wins over guessing from the topic. With no name, continue with the workspace named earlier in the conversation when this is a follow-up. Otherwise follow precedent: earlier_tasks_by_workspace shows what ${ownerName()} sent each workspace before, and a person, project or document that already has tasks in a workspace belongs there. Precedent means the same person or thing, not the same word: "my resume" (${ownerName()}'s own) is not someone else's resume. An agent ${ownerName()} names (agents_named_in_instruction) places it in that agent's workspace.`,
      criteria: {
        ...Object.fromEntries(wss.map(w => [w.id, describe(w)])),
        none: `Not tied to any of these clients (chat or status only)`,
      },
    },
    agent: {
      type: 'choice',
      instructions: `Which agent is the best fit to do this work? An agent ${ownerName()} names (agents_named_in_instruction) is the one ${ownerName()} means; with two, the first named leads. Changing an agent or what it may use is its workspace's AI Agent Builder's job.` + (budget?.tight ? ' Usage is running high this week (usage_this_week): for a small, quick ask that needs no specialist knowledge, the workspace generalist is the cheaper fit.' : ''),
      criteria: agentCriteria,
    },
    effort: {
      type: 'score',
      instructions: 'How much reasoning power does this need?',
      criteria: [
        'Quick lookup, one short step, or a simple reply',
        'Normal multi-step task with a few tools',
        'Complex, high-stakes, long, or needs careful judgement and writing',
      ],
    },
    status_about: statusQuestion(),
    ...(runs.length ? { earlier_run: earlierRunQuestion(runs) } : {}),
    // only asked when it sounds like a huddle, so ordinary routing stays as small as it was
    ...(huddleish ? { huddle_with: {
      type: 'choice',
      instructions: `If ${ownerName()} wants two agents to talk something through together, which agent joins the one picked for "agent"? It must be in the same workspace and not the same agent. ${ownerName()} may name them.`,
      criteria: Object.fromEntries(huddlers.map(a => [agentKey(a.workspace, a.slug), `${agentLabel(a, names)} in ${a.workspace}${a.isBuilder ? ': creates or updates agents' : `: ${String(a.description || '').slice(0, 160)}`}`])),
    } } : {}),
  };

  let res;
  try {
    // The owner is waiting on the card: a hung Jev falls back to the heuristic quickly, without the slower One route
    res = await askJev(state, questions, { purpose, timeoutMs: ROUTE_TIMEOUT_MS, fallback: false });
  } catch (e) {
    // Jev is off: the owner's own harness answers Jev's questions instead (brain.mjs), except for the reads made
    // while the owner types (too slow and too many). Keywords only when there is no harness, or it fails.
    const substitute = harness === undefined ? (askJev === ask ? askViaHarness : null) : harness;
    if (e.code === 'NO_JEV' && purpose !== 'live' && substitute) {
      try { res = await substitute(state, questions, { purpose, timeoutMs: HARNESS_ROUTE_TIMEOUT_MS }); }
      catch (err) { if (err.code !== 'NO_BRAIN') console.warn('[router] harness routing failed, using keywords:', err.message); }
    }
    if (!res) {
      if (e.code !== 'NO_JEV') console.warn('[router] Jev unavailable, using heuristic:', e.message);
      return finalize(heuristic(text, wss, agents), { error: e.message });
    }
  }

  const A = res.answers || {};
  let intent = A.intent?.choice || 'task';
  // A close call between "answer me" and "do something" isn't Orchy's to guess: the card waits for the owner,
  // with "Just answer" next to Send.
  const pi = A.intent?.probabilities || {};
  const askChat = (intent === 'chat' || intent === 'status') && (pi.task || 0) + (pi.build_agent || 0) >= CHAT_TASK_MARGIN;
  if (askChat) intent = (pi.build_agent || 0) > (pi.task || 0) ? 'build_agent' : 'task';
  let wsChoice = A.workspace?.choice;
  let wsConf = A.workspace?.confidence ?? 0;
  const [agentWs, agentSlugRaw] = String(A.agent?.choice || '').split('/');
  const agentSlug = agentSlugRaw && agentSlugRaw !== 'general' ? agentSlugRaw : null;
  // the builder picked to do the work: it's a change to the workspace's agents
  if (intent === 'task' && agentSlug === BUILDER_SLUG) {
    intent = 'build_agent';
    if (!forced && live.has(agentWs)) wsChoice = agentWs; // that builder's own workspace
  }

  // Orchy fixing his own code (backend.mjs): his own built-in workspace, no agent, a strong model.
  // Self-surgery always waits on the card for the owner's go (finalize: holdReason 'fix').
  if (intent === 'fix_orchy') {
    const effort = A.effort?.score ?? 1;
    // "that didn't work" after an earlier fix in this session continues it
    const fr = A.earlier_run, fi = fr?.choice && fr.choice !== 'none' ? Number(fr.choice.slice(1)) : -1;
    const frP = fi >= 0 ? fr.probabilities?.[fr.choice] ?? fr.confidence ?? 0 : 0;
    return finalize({
      intent, workspace: BACKEND_ID, agent: null, model: effort < 0.6 ? 'sonnet' : 'opus', tier: effort < 0.6 ? 1 : 2,
      confidence: A.intent?.confidence ?? 1, source: 'jev',
      probabilities: { intent: A.intent?.probabilities || {}, workspace: {}, agent: {}, effort: A.effort?.probabilities || {} },
      agentConfidence: null, askChat: false, statusAbout: null, effortScore: effort,
      earlierRun: runs[fi]?.backend && frP >= EARLIER_RUN_MIN ? { runId: runs[fi].id, confidence: frP } : null,
      jev: { model: res.model, ms: res.ms, via: res.via, usage: res.usage },
    });
  }

  if (forced) { wsChoice = forced; wsConf = 1; }
  if (wsChoice === 'none' && (intent === 'task' || intent === 'build_agent' || intent === 'mission')) {
    // Jev thinks it belongs to no client: offer its best agent's workspace, but only as a guess the owner confirms
    wsChoice = agentWs || null;
    wsConf = A.workspace?.probabilities?.[agentWs] ?? 0;
  }
  if (!live.has(wsChoice)) wsChoice = null; // never route to a workspace that's switched off

  // a huddle: the agents the owner named, else Jev's agent pick and who joins it; the card waits when that's under two
  if (intent === 'huddle') {
    const byKey = k => { const [w, s] = String(k || '').split('/'); return huddlers.find(a => a.workspace === w && a.slug === s) || null; };
    const pair = huddlePair(text, huddlers, { first: byKey(A.agent?.choice), second: byKey(A.huddle_with?.choice), workspace: forced, nameFor: names });
    return finalize({
      intent, workspace: pair.workspace, agent: null, huddle: pair.agents, model: null, tier: 1,
      confidence: pair.agents.length >= 2 ? A.intent?.confidence ?? 1 : 0,
      source: forced ? 'jev+mention' : 'jev',
      probabilities: { intent: A.intent?.probabilities || {}, workspace: A.workspace?.probabilities || {}, agent: A.agent?.probabilities || {}, huddleWith: A.huddle_with?.probabilities || {} },
      agentConfidence: null, askChat: false, earlierRun: null, statusAbout: null, effortScore: 1,
      jev: { model: res.model, ms: res.ms, via: res.via, usage: res.usage },
    });
  }

  // the earlier run the owner means (to continue it, or to hear how it went): only when Jev is fairly sure
  const er = A.earlier_run;
  const ri = er?.choice && er.choice !== 'none' ? Number(er.choice.slice(1)) : -1;
  const erP = ri >= 0 ? er.probabilities?.[er.choice] ?? er.confidence ?? 0 : 0;
  const earlierRun = runs[ri] && erP >= EARLIER_RUN_MIN ? { runId: runs[ri].id, confidence: erP } : null;
  // a mission (missions.mjs) only when Jev is fairly sure AND the words read as work in a row; never when it continues an
  // earlier run or when Jev's agent is a head (it hands work to its own team), unless the owner names that head only for
  // a later step ("research X, then have Ada make the PDF"). An agent the owner names keeps its part: the planner gives
  // it that step, and one agent for everything comes back as a plain task card.
  if (intent === 'mission') {
    const pm = pi.mission ?? A.intent?.confidence ?? 0;
    const pickA = agentSlug && allAgents.find(a => a.workspace === agentWs && a.slug === agentSlug);
    const head = pickA?.team?.length && !laterStepOnly(text, pickA, names);
    if (pm < MISSION_MIN || !missionShape(text) || head || earlierRun) intent = 'task';
    else return finalize({
      intent, workspace: wsChoice || null, agent: null, model: null, tier: 1,
      confidence: Math.min(wsConf || 0, pm), source: forced ? 'jev+mention' : 'jev',
      probabilities: { intent: A.intent?.probabilities || {}, workspace: A.workspace?.probabilities || {}, agent: A.agent?.probabilities || {}, effort: A.effort?.probabilities || {} },
      agentConfidence: null, askChat: false, earlierRun: null, statusAbout: null, effortScore: A.effort?.score ?? 1,
      missionP: Math.round(pm * 100) / 100, missionSure: pm >= MISSION_SURE,
      jev: { model: res.model, ms: res.ms, via: res.via, usage: res.usage },
    });
  }
  // continuing a run brings its client and agent along, so Jev's reading of the follow-up is what counts
  // (unless the owner named another client); Jev's agent and model only stay when they belong to that client
  const cont = earlierRun && (intent === 'task' || intent === 'build_agent') && live.has(runs[ri].workspace) && (!forced || forced === runs[ri].workspace) ? runs[ri] : null;
  if (cont) wsChoice = cont.workspace;
  let pickedAgent = null;
  if (intent === 'task' && agentWs === wsChoice && agentSlug) pickedAgent = agentSlug;

  const score = A.effort?.score ?? 1;
  let tier = score < 0.6 ? 0 : score < 1.5 ? 1 : 2;
  // budget-aware: when the week runs high, a score just over a tier boundary (a close call) takes the cheaper tier
  const leaned = !!budget?.tight && intent === 'task' && ((tier === 2 && score < 1.5 + BUDGET_MARGIN) || (tier === 1 && score < 0.6 + BUDGET_MARGIN));
  if (leaned) tier -= 1;
  const chosen = wss.find(w => w.id === wsChoice);
  const pickedAgentObj = pickedAgent ? agents.find(a => a.workspace === wsChoice && a.slug === pickedAgent) : null;
  // an agent pinned to its own engine (a Codex agent in a Claude workspace) runs on its own model; any other agent
  // with a model in its frontmatter runs on exactly that one (ceilingTierModel); the rest get the tier
  const pinned = pickedAgentObj?.engine ? pickedAgentObj : null;
  const taskModel = chosen ? (intent === 'build_agent' ? tierModel(chosen, 2)
    : pinned ? modelFor(chosen, pinned.model, pinned.engine)
    : ceilingTierModel(chosen, pickedAgentObj, tier)) : null;

  return finalize({
    intent,
    workspace: wsChoice || null,
    agent: intent === 'build_agent' ? BUILDER_SLUG : pickedAgent,
    model: taskModel,
    tier: intent === 'build_agent' ? 2 : tier,
    confidence: Math.min(cont ? erP : wsConf || 0, A.intent?.confidence ?? 1),
    source: forced ? 'jev+mention' : 'jev',
    probabilities: {
      intent: A.intent?.probabilities || {},
      workspace: A.workspace?.probabilities || {},
      agent: A.agent?.probabilities || {},
      effort: A.effort?.probabilities || {},
      ...(er ? { earlierRun: er.probabilities || {} } : {}),
    },
    // how sure Jev is of the agent it picked (null when the owner's named client overrode its workspace)
    agentConfidence: intent === 'task' && !cont && agentWs === wsChoice ? A.agent?.confidence ?? null : null,
    askChat,
    earlierRun,
    statusAbout: A.status_about?.choice ? { kind: A.status_about.choice, confidence: A.status_about.confidence ?? 0 } : null,
    effortScore: score,
    ...(budget?.pace != null ? { budget: { pace: budget.pace, leaned } } : {}),
    jev: { model: res.model, ms: res.ms, via: res.via, usage: res.usage },
  });
}

const BUDGET_MARGIN = 0.15; // how far over a tier boundary still counts as a close call when the week runs high

/** This week's usage vs a usual week, for routing (usagereview.mjs). Never blocks routing. */
function currentBudget() {
  try {
    const line = budgetLine();
    if (!line) return null;
    const p = budgetPace();
    return { line, pace: p.pace, tight: p.tight };
  } catch { return null; }
}

/** The model for an agent at a tier: an agent's own frontmatter model, exactly, when it names one this engine has;
 *  only the generalist and agents without a model take tierModel(ws, tier, runtime). */
export function ceilingTierModel(ws, agent, tier, runtime = agent?.engine || ws.runtime) {
  const list = modelsFor(ws, runtime);
  if (agent?.model && agent.model !== 'inherit') {
    const exact = modelFor(ws, agent.model, runtime);
    // an engine that takes any model id (Hermes, Antigravity) keeps the one the agent names
    if (list.includes(exact) || (exact !== 'default' && engine(runtime)?.openModels)) return exact;
  }
  return tierModel(ws, Math.max(0, Math.min(tier, list.length - 1)), runtime);
}

/**
 * The model for a run that didn't go through Jev (a pane's "Give a task", a follow-up, a schedule, a hand-off): the
 * agent's own model when it has one, else a tier read from the size of the ask (small lookups light, big strategy
 * work strong, everything else the middle).
 */
export function unroutedModel(ws, agent, instruction = '', { kind = 'task', isScheduled = false, isDelegated = false, isFollowUp = false, runtime = agent?.engine || ws.runtime } = {}) {
  if (kind === 'build' || agent?.isBuilder) return tierModel(ws, 2, runtime);
  const t = String(instruction || '').trim();
  let tier = 1;
  if (isScheduled || isDelegated) {
    tier = t.length > 0 && t.length < 70 && /^(?:check|list|count|ping|status)\b/i.test(t) ? 0 : 1;
  } else if (t.length > 0 && t.length < 95 && /^(?:what|where|when|who|show|list|send me|give me|share)\b/i.test(t) && !/\b(?:write|build|draft|create|analyse|analyze|research|audit|design|plan|refactor|update|change|fix)\b/i.test(t)) {
    tier = 0;
  } else if (!isFollowUp && (t.length > 420 || /\b(?:architect|comprehensive|deep[- ]dive|full audit|strategy|contract|legal|financial model|board deck|rewrite entire)\b/i.test(t))) {
    tier = 2;
  }
  return ceilingTierModel(ws, agent, tier, runtime);
}

/** When the owner moves a card to another workspace, keep the same strength of model on its engine. */
export function remodel(fromWs, toWs, model) {
  const from = fromWs ? modelsFor(fromWs) : [];
  // an engine whose tiers are all the same ("default": Hermes) says nothing about strength: the middle one
  const i = new Set(from).size > 1 ? from.indexOf(model) : -1;
  return tierModel(toWs, i >= 0 ? i : 1);
}

const CHAT_TASK_MARGIN = 0.4;   // task + build probability that makes a chat/status reading a close call
const EARLIER_RUN_MIN = 0.7;    // Jev's probability for that run before Orchy offers to continue it
const ROUTE_TIMEOUT_MS = 15_000; // how long the owner's card waits for Jev before the heuristic picks
const HARNESS_ROUTE_TIMEOUT_MS = 90_000; // a harness standing in for Jev starts a whole agent turn: slower

function finalize(r, extra = {}) {
  const work = r.intent === 'task' || r.intent === 'build_agent' || r.intent === 'huddle' || r.intent === 'mission';
  const needsWorkspace = work && !r.workspace;
  const needsPair = r.intent === 'huddle' && (r.huddle || []).length < 2;
  // past runs: the owner rarely changed an agent Jev was over a third sure of, so only a very unsure pick waits
  const lowAgent = r.intent === 'task' && r.agentConfidence != null && r.agentConfidence < (config.routing.minAgentConfidence ?? 0.35);
  const unsure = work && (r.confidence ?? 0) < config.routing.minConfidenceForAutoDispatch;
  const holdReason = r.intent === 'fix_orchy' ? 'fix' : needsWorkspace ? 'workspace' : needsPair ? 'huddle' : r.askChat ? 'chat-or-task' : unsure ? 'unsure' : lowAgent ? 'agent' : null;
  const auto = config.routing.autoDispatchSeconds;
  return {
    ...r,
    ...extra,
    needsChoice: !!holdReason,
    holdReason,
    autoDispatchSeconds: db().settings.autoDispatch === false ? 0 : auto,
  };
}
