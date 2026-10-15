// Delegation: a department head (an agent whose frontmatter has a `team:` list of slugs) hands part of its
// task to an agent on that team. Each hand-off is a real Orchy run of the team agent (its own connections,
// engine, account check and approval gate), linked to the head's run by `run.delegatedBy` and logged in
// LOGS.md. Not `parentRunId`: that means a follow-up (resumed conversation, shared task folder).
// One level only: a run that was handed work can't hand it on. The Agent Builders never delegate (they build
// agents), neither do a client's run or a scheduled one, and an agent shared with any client is never reachable.
// C-suite agents may also start a huddle from their own run, under the same limits (huddlePartners below).
import { config, ownerName } from './env.mjs';
import { db } from './store.mjs';
import { getAgent, listAgents, BUILDER_SLUG } from './agents.mjs';
import { workspace, engineFor } from './workspaces.mjs';
import { engine } from './engines/index.mjs';

/** Can an agent (pinned engine, or the workspace's) take part in huddles? Only engines whose talk-only rule the gate can enforce. */
const canHuddleOn = (ws, pin) => !!engine(engineFor(ws, pin))?.capabilities.huddles;

export const MAX_LIVE_SUBRUNS = 3;
const LIVE = new Set(['starting', 'working', 'waiting', 'stopping']);
const no = (msg, status = 403) => Object.assign(new Error(msg), { status });

/** This workspace's agents shared with a client (switched off or not): delegation never reaches them. */
export function clientSharedSlugs(wsId) {
  return new Set((config.clients || []).filter(c => c.workspace === wsId).flatMap(c => c.agents || []));
}

/** Why this run can't delegate at all, or null if it may (to its team). */
function cantDelegate(run) {
  if (run.client) return `${run.clientName || 'A client'} started this run from their own page, and a client's run can't hand work to other agents. Do it yourself.`;
  if (run.isBuilder) return 'The AI Agent Builder builds agents; it doesn’t hand them work.';
  if (run.delegatedBy) return `${run.delegatedByName || 'Your head'} handed you this task, and a team agent can't hand it on (one level only). Do it yourself, or say what's missing in your report.`;
  if (!run.agentSlug) return 'Only a department head with a team can hand work over. Do it yourself.';
  // the team runs on its own schedules too: a scheduled run hands work over the usual way (Notion), not by delegate
  if (run.routing?.source === 'schedule') return 'This is a scheduled run, so hand work over the usual way (your instructions say how), not by delegating.';
  return null;
}

/** The agents this run may hand work to (summaries), [] for anyone who can't delegate. */
export function teamFor(run) {
  if (!run || cantDelegate(run)) return [];
  let head;
  try { head = getAgent(run.workspace, run.agentSlug); } catch { return []; }
  if (!head.team.length) return [];
  const shared = clientSharedSlugs(run.workspace);
  const have = new Map(listAgents(run.workspace).map(a => [a.slug, a]));
  return head.team
    .filter(s => s !== run.agentSlug && s !== BUILDER_SLUG && !shared.has(s) && have.has(s) && !have.get(s).error)
    .map(s => have.get(s));
}

/** Sub-runs a head's run has going right now. */
export function liveSubRuns(parentId) {
  return Object.values(db().runs).filter(r => r.delegatedBy === parentId && LIVE.has(r.status));
}

/** Check a hand-off; returns the team agent or throws (403) with a reason the head can act on. */
export function checkDelegation(parent, slug) {
  const why = cantDelegate(parent);
  if (why) throw no(why);
  if (clientSharedSlugs(parent.workspace).has(slug)) throw no(`${slug} works with one of ${ownerName()}'s clients, so it can't be handed work this way. Do it yourself or tell ${ownerName()}.`);
  const team = teamFor(parent);
  if (!team.length) throw no(`${parent.agentName} has no team to hand work to. Do it yourself.`);
  const target = team.find(a => a.slug === slug);
  if (!target) throw no(`${slug || 'That agent'} isn't on your team. Your team: ${team.map(a => `${a.displayName} (\`${a.slug}\`)`).join(', ')}.`);
  if (liveSubRuns(parent.id).length >= MAX_LIVE_SUBRUNS) throw no(`You already have ${MAX_LIVE_SUBRUNS} hand-offs running. Wait for one to finish first.`, 429);
  return target;
}

// ── Huddles a C-suite agent starts from its own run (bridge tool `huddle`; huddle.mjs#startFromRun) ──
// Same reach as delegating, minus the team: any huddle-able agent of its own workspace, from a run the owner started.

export const MAX_RUN_HUDDLES = 2;

/** Why this run can't start a huddle, or null if its agent may (when it's C-suite). */
export function cantHuddle(run) {
  if (!run?.agentSlug || run.isBuilder) return 'Only C-suite agents (a Chief, a CxO or a department head) start huddles.';
  if (run.client) return `${run.clientName || 'A client'} started this run from their own page, so it can't pull other agents in. Do it yourself.`;
  if (run.huddle) return 'You’re in a huddle already: talk it through there.';
  if (run.fromHuddle) return `You’re doing your part of a huddle ${ownerName()} approved: carry it out rather than starting another.`;
  if (run.delegatedBy) return `${run.delegatedByName || 'Your head'} handed you this task, so you can't start a huddle from it. Do it yourself, or say what's missing in your report.`;
  if (run.routing?.source === 'schedule') return `This is a scheduled run, and huddles only start from tasks ${ownerName()} gives you.`;
  return null;
}

/** The agents this run's agent may huddle with ([] unless it's C-suite and may start one): team first, then the rest. */
export function huddlePartners(run) {
  if (cantHuddle(run)) return [];
  let ws, me;
  try { ws = workspace(run.workspace); me = getAgent(ws.id, run.agentSlug); } catch { return []; }
  const shared = clientSharedSlugs(ws.id);
  if (!me.executive || shared.has(me.slug) || !canHuddleOn(ws, me)) return [];
  const others = listAgents(ws.id).filter(a => a.slug !== me.slug && !a.error && !shared.has(a.slug) && canHuddleOn(ws, a.isBuilder ? null : a));
  const onTeam = a => (me.team.includes(a.slug) ? 0 : 1);
  return others.sort((a, b) => onTeam(a) - onTeam(b));
}

// ── Agents a huddle's agents may bring in mid-talk (huddle_reply `invite`; huddle.mjs#bringIn) ──
export const MAX_HUDDLE_AGENTS = 4;

/** The agents of a huddle's workspace that could join it now: not in it yet, not shared with a client, Claude Code. */
export function huddleInvitees(h) {
  if (!h || (h.agents || []).length >= MAX_HUDDLE_AGENTS) return [];
  let ws;
  try { ws = workspace(h.workspace); } catch { return []; }
  const shared = clientSharedSlugs(ws.id);
  const inIt = new Set(h.agents.map(a => a.slug));
  return listAgents(ws.id).filter(a => !inIt.has(a.slug) && !a.error && !shared.has(a.slug) && canHuddleOn(ws, a.isBuilder ? null : a));
}

/** Claude Code deny rules: a workspace's own agents never run inside another run (the built-in Agent tool). */
export function nativeAgentDenyRules(wsAgentSlugs) {
  return wsAgentSlugs.flatMap(s => [`Agent(${s})`, `Task(${s})`]);
}
