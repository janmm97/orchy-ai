// Runs agents in their workspace folder under that workspace's account, on its engine (engines/index.mjs):
//   Claude Code → `claude -p --output-format stream-json` with the Orchy bridge as permission-prompt tool
//   Codex       → `codex app-server` (codex.mjs), every approval answered by the Orchy gate
//   OpenCode    → `opencode serve` + its HTTP API (engines/opencode-run.mjs), every ask answered by the Orchy gate
// This file holds what every engine shares (the run record, the feed, finishing, stopping); each engine's launch code
// lives in its engines/ module and gets the `RT` object below.
// Wires the Orchy MCP bridge, streams events, logs the result.
// Runs on one account wait their turn: at most `maxLivePerAccount` live at once per account (Settings, default 3),
// approved huddle work one after another, and a run that hits its account's session/usage limit pauses (with the
// runs queued behind it) until the window resets. "Run now" jumps the queue.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, ORCH_DIR, DATA_DIR, ownerName } from './env.mjs';
import { db, save, id, runEventsPath } from './store.mjs';
import { emit } from './bus.mjs';
import { workspace, workspaces, accountCheck, readMcp, allConnections, modelFor, modelsFor, accountFor, engineFor, runtimeLabel, oneScope } from './workspaces.mjs';
import { engine, engines, ungatedRefusal, offeredRefusal, engineInstallCmd, engineHealth, brokenMessage } from './engines/index.mjs';
import { profilePath, shellLine } from './engines/shared.mjs';
import { getAgent, listAgents, agentFingerprint, BUILDER_SLUG } from './agents.mjs';
import { protocolFile, builderBrief, codexInstructions } from './prompts.mjs';
import { namingBrief, nameOf } from './voiceagents.mjs';
import { expireForRun, itemsForRun, createItem, waitFor } from './inbox.mjs';
import { appendRunLog, appendCostLine } from './logs.mjs';
import { hasTaskDir, openTaskDir, saveTask } from './tasks.mjs';
import { syncResources } from './resources.mjs';
import { serversWithAuth } from './mcpauth.mjs';
import { ensureHome, clientSettingsFile, clientReadDirs, adoptUploads, copyIntoTask, filesNote, taskRoot, tasksBase, taskRootRel, taskRel } from './clientspace.mjs';
import { gate, gateAndWait, waitAnswered } from './gate.mjs';
import { actionKind } from './engines/hookmap.mjs';
import { askFields, clientDenyRules } from './clients.mjs';
import { teamFor, huddlePartners, nativeAgentDenyRules } from './delegation.mjs';
import { planFor, planLine } from './actionplan.mjs';
import { splitShell } from './policy.mjs';
import { snapshot, changes, backendSettingsFile } from './backend.mjs';
import { unroutedModel } from './router.mjs';
import { redactEvent, nextActivity, briefFor, huddleWith } from './activity.mjs';
import { moving } from './recover.mjs';

export const BRIDGE_TOKEN = crypto.randomBytes(16).toString('hex');
const live = new Map(); // runId -> { child, fingerprint, stop, acted, lookups (tool_use ids of One lookups), tools, queued, launch }
const runAcct = new Map(); // runId -> the account key its usage counts against (accountKey), while it's live or queued
const launchers = new Map(); // runId -> start (or start again) this run on its engine, while it's live or queued
const accountLimits = new Map(); // account key -> { until, reason, timer, announced }: a session/usage limit was hit
let orchyReporter = null;
let limitReporter = null;
export function onRunFinished(fn) { orchyReporter = fn; }
/** fn({ ws, run, reason, until }) once per limit window: an account hit its session/usage limit (server.mjs says so). */
export function onSessionLimit(fn) { limitReporter = fn; }
let serverPort = 8008;
export function setPort(p) { serverPort = p; }

/**
 * The account a run's usage counts against, per engine: an email engine's login (two workspaces on one login share
 * its limits), a profile engine's profile folder (its provider keys live there).
 */
export function accountKey(ws, runtime = ws.runtime) {
  const eng = engine(runtime);
  const a = accountFor(ws, runtime);
  let prof = '';
  if (a.profileDir) {
    prof = path.resolve(profilePath(a.profileDir)).replace(/[\\/]+$/, '');
    if (process.platform === 'win32') prof = prof.toLowerCase();
  }
  const who = eng?.accountModel === 'profile' ? prof || 'default' : String(a.email || '').toLowerCase().trim() || prof || 'default';
  return `${runtime}:${who}`;
}

/** Is any run of this workspace live or queued? */
export function liveIn(wsId) {
  for (const runId of live.keys()) if (db().runs[runId]?.workspace === wsId) return true;
  return false;
}

/** How many runs are really working right now (queued and paused ones don't count), across all workspaces. */
export function liveCount() {
  let n = 0;
  for (const e of live.values()) if (!e.queued) n++;
  return n;
}

/**
 * The runs working on one account (huddle talk doesn't count: it only talks, and never waits in the queue), and whether
 * one of them is approved huddle work. `forRun`'s own head is left out: it waits on its team, so its hand-offs can
 * start even when the limit is 1.
 */
function activeOnAccount(acctKey, forRun = null) {
  let count = 0, huddleWorkActive = false;
  for (const [rid, e] of live.entries()) {
    if (e.queued || runAcct.get(rid) !== acctKey) continue;
    const r = db().runs[rid];
    if (!r || r.huddleTalk || (forRun?.delegatedBy && rid === forRun.delegatedBy)) continue;
    count++;
    if (r.fromHuddle) huddleWorkActive = true;
  }
  return { count, huddleWorkActive };
}

/** Settings → Concurrency: live runs per account, 1–10 (default 3). */
export const maxLivePerAccount = () => Math.max(1, Math.min(10, Math.round(Number(db().settings?.maxLivePerAccount)) || 3));

/** Must this run wait? Approved huddle work starts one after another, and only once nothing else runs on the account. */
function mustWait(run, acctKey) {
  const { count, huddleWorkActive } = activeOnAccount(acctKey, run);
  return { count, wait: count >= maxLivePerAccount() || (!!run.fromHuddle && (huddleWorkActive || count >= 1)) };
}

export function getRun(runId) {
  const run = db().runs[runId];
  if (!run) throw Object.assign(new Error('No such run'), { status: 404 });
  return run;
}

export function listRuns(limit = 60) {
  return Object.values(db().runs).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
}

export function runEvents(runId) {
  const p = runEventsPath(runId);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// Every event gets `n` (the run's own counter, run.evN) and goes through the redaction pass (activity.mjs) before
// it's written or sent; the run's activity (what it's doing now) rides along in the same `run.event`.
function record(run, evt) {
  run.evN = (run.evN || 0) + 1;
  const e = { t: new Date().toISOString(), n: run.evN, ...redactEvent(evt) };
  fs.appendFileSync(runEventsPath(run.id), JSON.stringify(e) + '\n');
  run.lastActivity = e.t;
  run.activity = nextActivity(run, e);
  if (run.stalledAt && !run.endedAt) moving(run); // flagged as stuck (recover.mjs#checkStalls), and it isn't
  emit('run.event', { runId: run.id, workspace: run.workspace, event: e, activity: run.activity });
}

const FINAL = new Set(['done', 'failed', 'stopped']);
export function setRunStatus(run, status) {
  // an ended run keeps its outcome, and a stopping one only ever ends (a late answer or Codex start can't revive it)
  if (run.status === status || run.endedAt || (run.status === 'stopping' && !FINAL.has(status))) return;
  run.status = status;
  run.activity = nextActivity(run, null, { statusChanged: true });
  save();
  emit('run.updated', { run: publicRun(run) });
}

export function publicRun(run) {
  const { prompt, ...rest } = run;
  return rest;
}

// A shell call that only asked One about actions (`one --agent actions find|load|knowledge …`, maybe after a cd and
// cut short by head/tail): its output is One's own JSON, not text the agent wrote, so the gate may trust what it says.
const LOOKUP = /^(?:npx\s+)?(?:[^\s'"]*[\\/])?one(?:\.cmd|\.ps1|\.exe)?\s+--agent\s+(?:actions|a)\s+(?:find|load|knowledge|search)\s/i;
function oneLookup(command) {
  const s = String(command || ''), segs = splitShell(s);
  return segs.some(p => LOOKUP.test(p)) && !/[`$<]|>(?!&1|\s*\/dev\/null|\s*\$null)/i.test(s)
    && segs.every(p => LOOKUP.test(p) || /^cd\s+\S/i.test(p) || /^(head|tail)(\s+(-{1,2}[a-z]+(=?\d+)?|-?\d+))*$/i.test(p));
}

/** Remember what One said about actions (never over an entry that already has a method). */
function harvestActions(text) {
  const re = /"actionId"\s*:\s*"([^"]+)"\s*,\s*"title"\s*:\s*"([^"]*)"\s*,\s*"method"\s*:\s*"([A-Z]+)"(?:\s*,\s*"path"\s*:\s*"([^"]*)")?/g;
  const cache = db().actionCache;
  let m, n = 0;
  while ((m = re.exec(text))) {
    if (cache[m[1]]?.method) continue;
    cache[m[1]] = { title: m[2], method: m[3], path: m[4] || null };
    n++;
  }
  if (n) save();
}

function describeTool(name, input, run = null) {
  const base = s => path.basename(String(s || ''));
  if (name === 'Bash' || name === 'PowerShell') {
    const cmd = String(input.command || '');
    const exec = cmd.match(/one(?:\s+--agent)?\s+(?:actions|a)\s+execute\s+(\S+)\s+(\S+)/);
    if (exec) {
      const title = db().actionCache[exec[2].replace(/['"]/g, '')]?.title;
      return `Running ${title || 'an action'} on ${exec[1]}`;
    }
    const find = cmd.match(/one(?:\s+--agent)?\s+(?:actions|a)\s+find\s+(\S+)/);
    if (find) return `Looking up ${find[1]} actions`;
    const load = cmd.match(/one(?:\s+--agent)?\s+(?:actions|a)\s+load\s+((?:conn_mod_def::\S+\s*)+)/);
    if (load) {
      const ids = load[1].trim().split(/\s+/).map(s => s.replace(/['"]/g, ''));
      const title = ids.length === 1 && db().actionCache[ids[0]]?.title;
      return title ? `Reading the docs for ${title}` : `Reading the docs for ${ids.length} action${ids.length === 1 ? '' : 's'}`;
    }
    if (/one(?:\s+--agent)?\s+list\b/.test(cmd)) return 'Checking connections';
    return `Running \`${cmd.split('\n')[0].slice(0, 70)}\``;
  }
  if (name === 'Read') return `Reading ${base(input.file_path)}`;
  if (name === 'Write') return `Writing ${base(input.file_path)}`;
  if (name === 'Edit' || name === 'MultiEdit') return `Editing ${base(input.file_path)}`;
  if (name === 'Glob' || name === 'Grep') return `Searching files${input.pattern ? ` for ${String(input.pattern).slice(0, 40)}` : ''}`;
  if (name === 'WebSearch') return `Searching the web: ${String(input.query || '').slice(0, 60)}`;
  if (name === 'WebFetch') { try { return `Reading ${new URL(input.url).host}`; } catch { return 'Reading a web page'; } }
  if (name === 'TodoWrite') return 'Planning the steps';
  if (name === 'Task' || name === 'Agent') return `Delegating: ${String(input.description || '').slice(0, 60)}`;
  if (name === 'mcp__jos__ask_user') return `Asking ${run?.clientName || ownerName()} a question`;
  if (name === 'mcp__jos__request_connections') return `Asking ${ownerName()} which connections to use`;
  if (name === 'mcp__jos__jev_pick_tools') return 'Asking Jev which tools to use';
  if (name === 'mcp__jos__report_done') return 'Reporting back to Orchy';
  if (name === 'mcp__jos__call_owner') return `Ringing ${ownerName()}`;
  if (name === 'mcp__jos__delegate') return `Handing work to ${String(input.agent || 'a teammate').slice(0, 40)}`;
  if (name === 'mcp__jos__huddle') return `Huddling with ${huddleWith(input)}`;
  if (name === 'mcp__jos__note') return String(input.text || 'Progress note').slice(0, 90);
  if (name.startsWith('mcp__')) return `Using ${name.split('__').slice(1).join(' › ')}`;
  return `Using ${name}`;
}

/**
 * Start a run.
 * opts: { workspace, agentSlug|null, model, instruction, routing, parentRunId, resumeSessionId, kind:'task'|'build', session, delegatedBy }
 * `session` is the Orchy session that sent it (its report goes back there). `delegatedBy` is the head's run
 * when a department head handed this task to its team agent (delegation.mjs).
 */
/** For an agent pinned to its own engine: is `model` a pick of that engine's (one of its tiers, or, on an engine that
 * takes any model id, a specific id it passes through), so it wins over the agent's own model? */
function pinnedPick(ws, model, runtime) {
  if (!model || model === 'inherit') return false;
  if (modelsFor(ws, runtime).includes(model)) return true;
  return !!engine(runtime)?.openModels && modelFor(ws, model, runtime) === model;
}

export async function startRun(opts) {
  const ws = workspace(opts.workspace);
  if (!ws.enabled) {
    throw Object.assign(new Error(`${ws.name} is switched off, so Orchy isn't sending it work. Switch it back on in Workspaces → ${ws.name}.`), { status: 409, code: 'WORKSPACE_DISABLED' });
  }
  // Orchy fixing his own code (backend.mjs): no agent, no client, Claude Code in the Orchy folder
  const backend = !!ws.builtin;
  if (backend && (opts.client || opts.huddle || opts.delegatedBy)) throw Object.assign(new Error(`Only ${ownerName()} asks Orchy to fix himself`), { status: 400 });
  const isBuilder = !backend && (opts.kind === 'build' || opts.agentSlug === BUILDER_SLUG);
  const agentSlug = backend ? null : isBuilder ? BUILDER_SLUG : (opts.agentSlug || null);
  let agent = null;
  if (agentSlug) agent = getAgent(ws.id, agentSlug);
  if (agent?.error && /engine/i.test(agent.error)) throw Object.assign(new Error(`${agent.displayName} can't run: ${agent.error}`), { status: 400 });
  // the builder always runs on the workspace's engine; any other agent may pin its own
  const runtime = isBuilder ? ws.runtime : engineFor(ws, agent);

  const eng = engine(runtime);
  if (!eng) throw Object.assign(new Error(`${runtimeLabel(runtime)} isn't a harness this Orchy has an adapter for, so ${ws.name} can't run on it.`), { status: 400, code: 'UNKNOWN_ENGINE' });
  // An engine that can't hold every risky action behind the approval gate only runs where the owner allowed it
  // (allowUngated in config.json). Every run can change files or run commands, so every run is refused.
  const ungated = ungatedRefusal(ws, eng);
  if (ungated) throw Object.assign(new Error(ungated), { status: 409, code: 'UNGATED_ENGINE' });
  // an opt-in engine (Antigravity) the owner hasn't switched on in .env
  const off = offeredRefusal(eng);
  if (off) throw Object.assign(new Error(off), { status: 409, code: 'ENGINE_OFF' });
  // a workspace can be set to an engine before it's installed, or one whose install didn't finish (it won't start);
  // say so instead of failing to spawn it
  const health = engineHealth(eng);
  if (health === 'missing') {
    const cmd = engineInstallCmd(eng);
    throw Object.assign(new Error(`${eng.label} isn't installed on this PC, so ${ws.name} can't run yet.${cmd ? ` Install it with: ${cmd}` : ''} Then start the task again.`), { status: 409, code: 'ENGINE_MISSING' });
  }
  if (health === 'broken') throw Object.assign(new Error(brokenMessage(eng, { then: 'start the task again' })), { status: 409, code: 'ENGINE_BROKEN' });
  // Orchy doesn't see every command an ungated engine runs, so it could reach the apps of whatever One login the CLI
  // falls back to: a workspace without its own One login never runs on one
  if (!eng.capabilities.gated && !backend && !oneScope(ws).own) throw Object.assign(new Error(`${ws.name} isn't signed in to its own One account yet, and ${eng.label}'s commands aren't all checked by Orchy, so it could reach another account's apps. Sign it in to One first (Workspaces → ${ws.name} → Sign in to One).`), { status: 409, code: 'ONE_SCOPE' });

  // the dashboard's account checks are cached for a minute; a run start wants one at most 10s old
  await eng.account(accountFor(ws, runtime).profileDir, { maxAge: 10_000 });
  const acct = await accountCheck(ws, { runtime });
  if (!acct.ok) {
    const fix = acct.error && /install|account set/i.test(acct.error) ? acct.error : `In PowerShell: ${acct.fix}`;
    const who = runtime === ws.runtime ? ws.name : `${ws.name}'s ${agent.displayName}`;
    if (acct.profileProblem) throw Object.assign(new Error(`${acct.profileProblem} Not running it.`), { status: 409, code: 'ACCOUNT_MISMATCH' });
    // no account picked yet (a fresh install's Orchy, fixing himself): say that, not "must run as null"
    if (!acct.expected && acct.accountModel === 'email') throw Object.assign(new Error(`${acct.error || `${ws.name} has no ${acct.runtimeLabel} account set`}. Not running it.`), { status: 409, code: 'ACCOUNT_MISMATCH' });
    throw Object.assign(new Error(
      acct.loggedIn
        ? `${who} must run as ${acct.expected} on ${acct.runtimeLabel}, but its profile is logged in as ${acct.actual || 'another account'}. Not running it. ${fix}`
        : `${ws.name}'s ${acct.runtimeLabel} profile isn't logged in yet (needs ${acct.expected || 'an account'}). ${acct.hint ? `${acct.hint} ` : ''}${fix}`), { status: 409, code: 'ACCOUNT_MISMATCH' });
  }

  // An agent that pins its engine runs on its own model unless the owner picked another of that engine's models.
  const own = agent?.model && agent.model !== 'inherit' ? agent.model : null;
  // a follow-up can only resume a conversation on the engine that started it
  const parent = opts.parentRunId ? db().runs[opts.parentRunId] : null;
  let resume = parent && (parent.runtime || ws.runtime) !== runtime ? null : opts.resumeSessionId;
  // The workspace's Claude account can change after a task ran (its sessions then sit in the old profile), and
  // `claude --resume` only looks in the profile it runs under: "No conversation found". Start fresh instead.
  let lostSession = false;
  if (resume && eng.canResume && !eng.canResume(ws, resume)) { resume = null; lostSession = true; }
  // Long-chain reset: a follow-up chain past 60 turns (or whose last turn re-read over 120k input tokens) starts a fresh
  // session seeded with the task file and the last report, instead of re-reading a huge transcript on every turn.
  let chainTurns = 0;
  for (let cur = parent, seen = new Set(); cur && !seen.has(cur.id); cur = cur.parentRunId ? db().runs[cur.parentRunId] : null) {
    seen.add(cur.id);
    chainTurns += Number(cur.numTurns) || 0;
  }
  const lastInput = Number(parent?.lastInputTokens || parent?.tokens?.uncachedInput || 0);
  let chainReset = false;
  if (resume && !opts.huddleTalk && (chainTurns > 60 || lastInput > 120_000)) { resume = null; chainReset = true; }
  // the owner started it (not a hand-off, a client, a huddle or a schedule)
  const ownerStarted = !opts.delegatedBy && !opts.client && !parent?.client && !opts.huddle && !opts.fromHuddle && opts.routing?.source !== 'schedule';
  // A resumed session keeps the model it started on: a long session on the strong model reopened on a smaller one
  // can fail at once, so a follow-up never down-shifts it. Jev's pick (routed) or the owner's own pick wins next;
  // anything else (a pane's task, a hand-off, a schedule) gets router.mjs#unroutedModel: the agent's own model, or
  // a tier from the size of the ask for the generalist and agents without one.
  const model = opts.huddleTalk && opts.model
    ? modelFor(ws, opts.model, runtime)
    : resume && parent?.model && modelsFor(ws, runtime).includes(parent.model)
      ? parent.model
      : agent?.engine && !isBuilder
        ? modelFor(ws, pinnedPick(ws, opts.model, runtime) ? opts.model : own || opts.model, runtime)
        : (opts.routing && opts.routing.source !== 'schedule' && opts.model) || (ownerStarted && opts.model && opts.model !== own)
          ? modelFor(ws, opts.model || own, runtime)
          : unroutedModel(ws, agent, opts.instruction, {
              kind: isBuilder ? 'build' : 'task',
              isScheduled: opts.routing?.source === 'schedule',
              isDelegated: !!opts.delegatedBy,
              isFollowUp: !!opts.parentRunId,
              runtime,
            });
  // high/max effort only on runs the owner started: hand-offs, schedules and huddles work at medium at most
  const rawEffort = !isBuilder && agent?.effort ? agent.effort : null;
  const effort = rawEffort && !ownerStarted && /^(high|max)$/i.test(rawEffort) ? 'medium' : rawEffort;
  const head = opts.delegatedBy ? db().runs[opts.delegatedBy] : null;
  // a client's task stays theirs whoever follows it up: the owner's reply (dashboard or voice) runs in the client's
  // folder under the same limits, and shows on their page labelled the owner
  const client = opts.client || (parent?.client ? { id: parent.client, name: parent.clientName } : null);
  if (client && !eng.capabilities.clientSafe) {
    throw Object.assign(new Error(`${agent?.displayName || 'This agent'} runs on ${eng.label}, which can't work on a client's task yet: ${eng.capabilities.clientReason || 'Orchy can’t keep it inside the client’s folder.'} Switch it to Claude Code, or keep it off client pages.`), { status: 400 });
  }
  if (client && (isBuilder || !agentSlug)) throw Object.assign(new Error('A client’s task needs one of the agents shared with them'), { status: 400 });
  // a huddle turn only talks (huddle.mjs): Claude Code keeps every change behind the gate, the other engines can't promise that yet
  if (opts.huddleTalk && !eng.capabilities.huddles) throw Object.assign(new Error(`${agent?.displayName || 'This agent'} runs on ${eng.label}, and huddles are Claude Code only for now`), { status: 400 });

  const run = {
    id: id('run'),
    workspace: ws.id,
    agentSlug,
    agentName: agent ? agent.displayName : backend ? 'Orchy (fixing himself)' : `${ws.name} generalist`,
    isBuilder,
    kind: isBuilder ? 'build' : backend ? 'fix' : 'task',
    backend,
    runtime,
    model,
    effort,
    instruction: opts.instruction,
    routing: opts.routing || null,
    parentRunId: opts.parentRunId || null,
    session: opts.session || null,
    // handed over by a department head's run: its report goes back to the head, not to Orchy's chat
    delegatedBy: head?.id || null,
    delegatedByName: head?.agentName || null,
    // started by one of the owner's clients from their page (portal.mjs): their questions and app decisions go there
    client: client?.id || null,
    clientName: client?.name || null,
    ownerReply: !!client && !opts.client, // The owner following up on a client's task
    // a turn in a huddle (huddle.mjs): talk only, no report to Orchy's chat or LOGS.md of its own
    huddle: opts.huddle || null,
    huddleTalk: !!opts.huddleTalk,
    // the work an agent does once the owner approved its huddle's agreement
    fromHuddle: opts.fromHuddle || null,
    // Orchy starting a failed run again (recover.mjs): the run it repeats, and how many automatic tries so far
    retryOf: opts.retryOf || null,
    retries: Number(opts.retries) || 0,
    // a step of a mission (missions.mjs): it reports to the mission, which checks it and decides what comes next
    missionId: opts.missionId || null,
    stepId: opts.stepId || null,
    files: [],
    sessionId: resume || crypto.randomUUID(),
    status: 'starting',
    startedAt: new Date().toISOString(),
    endedAt: null,
    report: null,
    notes: [],
    createdAgents: [],
    liveAtStart: liveCount(), // how many runs were working when it started (the Usage tab's spend at >=4 live)
  };
  // a skill installed since the last sync is filed into Resources/ and linked before the agent loads its skills
  if (!backend) { try { syncResources(ws, { moves: !liveIn(ws.id), index: 'auto' }); } catch (e) { console.warn('[resources]', e.message); } }
  // a task gets its own folder in its agent's Tasks (tasks.mjs; a follow-up keeps its parent's);
  // a client's lives in the client's own corner of the workspace (clientspace.mjs)
  if (run.client) ensureHome(ws, run.client);
  // a mission's steps all share the mission's folder (a plain name under the mission's Tasks, never a client's)
  const shared = run.missionId && !run.client && !backend && !run.huddleTalk && typeof opts.taskDir === 'string'
    && /^[\w][\w .-]{0,80}$/.test(opts.taskDir) && !opts.taskDir.includes('..') && !/[. ]$/.test(opts.taskDir) ? opts.taskDir : null;
  if (shared) {
    run.taskRoot = taskRootRel({ taskRoot: opts.taskRoot });
    fs.mkdirSync(path.join(tasksBase(ws, run), shared), { recursive: true });
    run.taskDir = shared;
  } else if (hasTaskDir(run)) run.taskDir = openTaskDir(ws, run, parent);
  // files the client uploaded (staged on their page) or the owner attached to a reply on the client's task
  if (run.client) {
    const paths = [...adoptUploads(ws, run, opts.uploads || []), ...copyIntoTask(ws, run, opts.ownerFiles || [])];
    run.files = paths;
    if (paths.length) run.instruction = `${run.instruction || 'Have a look at the attached files.'}${filesNote(paths, run.ownerReply ? ownerName() : run.clientName)}`;
  }

  // Jev's action plan (actionplan.mjs): the One actions this task needs, with their docs, picked before the
  // agent starts. Routed tasks get it made during the routing countdown; a slow or failed plan is skipped.
  const plan = opts.huddleTalk ? null : await planFor({ ws, agent, instruction: opts.instruction, client: client || null, isBuilder, resume: !!resume });
  if (plan) run.plan = plan.summary;

  // every fix starts from a snapshot of Orchy's code, so it can be undone (and a restart that fails rolls back)
  if (backend) {
    try { snapshot(run.id); } catch (e) { throw Object.assign(new Error(`Orchy couldn't snapshot his code before the fix, so he isn't touching it: ${e.message}`), { status: 500 }); }
  }

  let prompt = run.instruction;
  if (lostSession) {
    prompt += `\n\n(Orchy: the conversation this follows up on isn't available under this workspace's current Claude account, so you're starting fresh. Pick the work up from the files in the folder and Notion${parent?.taskDir ? `, starting with the task folder ${parent.taskDir}` : ''}, and check what's already done before redoing anything.)`;
    record(run, { kind: 'system', text: "The earlier conversation isn't under this workspace's current Claude account, so this starts a fresh one." });
  }
  if (chainReset) {
    prompt += `\n\n${chainSeed(ws, run, parent, { chainTurns, lastInput })}`;
    record(run, { kind: 'system', text: `Long conversation chain (${chainTurns} turns): starting a fresh session seeded with the task file and the last report.` });
  }
  if (isBuilder && !resume && !opts.huddle) {
    const conns = await allConnections(ws);
    let naming = null;
    try { naming = namingBrief(); } catch (e) { console.warn('[voice] no naming brief:', e.message); }
    prompt = builderBrief(ws, opts.instruction, conns, listAgents(ws.id), naming);
  }
  run.prompt = prompt;

  // MCP: the Orchy bridge + the external servers this agent may use (all of them for the builder/generalist).
  const servers = await serversWithAuth(ws, readMcp(ws)); // servers signed in with OAuth carry their token as a header (mcpauth.mjs)
  const allowedMcp = agent && !isBuilder && agent.mcpServers.length ? agent.mcpServers : (agent && !isBuilder ? [] : null);
  const bridge = {
    command: process.execPath,
    args: [path.join(ORCH_DIR, 'mcp', 'bridge.mjs')],
    env: { JOS_URL: `http://127.0.0.1:${serverPort}`, JOS_TOKEN: BRIDGE_TOKEN, JOS_RUN_ID: run.id, JOS_WORKSPACE: ws.id, JOS_PERSON: run.client && !run.ownerReply ? run.clientName : ownerName(), ...(run.client || run.huddleTalk ? { JOS_NO_CALL: '1' } : {}), ...(run.huddleTalk ? { JOS_HUDDLE: '1' } : {}) },
  };
  // a head's own run gets the delegate tool, listing its team (the server checks every hand-off again); not while it huddles
  const team = run.huddleTalk ? [] : teamFor(run);
  const who = a => ({ slug: a.slug, name: (nameOf(ws.id, a.slug) || a.callName) ? `${nameOf(ws.id, a.slug) || a.callName} (${a.displayName})` : a.displayName, does: a.description.slice(0, 200) });
  if (team.length) bridge.env.JOS_TEAM = JSON.stringify(team.map(who));
  // a C-suite agent's own run gets the huddle tool, listing who it may huddle with (the server checks again)
  const partners = huddlePartners(run);
  if (partners.length) bridge.env.JOS_HUDDLE_WITH = JSON.stringify(partners.map(a => ({ ...who(a), does: a.isBuilder ? 'Creates and updates this workspace’s agents.' : a.description.slice(0, 160) })));

  db().runs[run.id] = run;
  save();
  emit('run.started', { run: publicRun(run) });
  if (head) record(run, { kind: 'system', text: `Handed over by ${head.agentName} (run ${head.id})` });
  record(run, { kind: 'system', text: `Dispatched to ${ws.name} · ${run.agentName} · ${runtime === ws.runtime ? '' : `${runtimeLabel(runtime)} · `}${model}${effort ? ` (${effort})` : ''}` });
  if (run.plan) record(run, { kind: 'plan', text: planLine(run.plan) });
  const planText = plan?.text || '';

  const fingerprint = isBuilder ? agentFingerprint(ws.id) : null;
  const agentMarkdown = isBuilder ? getAgent(ws.id, BUILDER_SLUG).markdown : agent?.markdown || null;
  // each engine turns Orchy's bridge + the allowed servers into its own MCP config and starts the run itself
  const mcp = eng.mcpConfig({ servers, allowed: allowedMcp, bridge });
  const acctKey = accountKey(ws, runtime);
  runAcct.set(run.id, acctKey);
  // `again` (a run paused on its account's limit, started again): the conversation it was in, if it had one
  const launchNow = (again = resume) => {
    run.liveAtStart = liveCount();
    try {
      eng.launch(run, ws, { prompt, agentSlug, agentMarkdown, mcp, resume: again, fingerprint, planText }, RT);
    } catch (e) {
      // a launch that throws must not leave a run that is "starting" for ever
      record(run, { kind: 'error', text: e.message });
      finish(run, ws, 1, e.message);
    }
  };
  launchers.set(run.id, launchNow);

  // the account's queue: a huddle turn only talks and never waits; "Run now" (opts.runNow) skips it
  if (!run.huddleTalk && !opts.runNow) {
    const lim = accountLimits.get(acctKey);
    if (lim && Date.now() >= lim.until) { clearTimeout(lim.timer); accountLimits.delete(acctKey); }
    const paused = accountLimits.get(acctKey);
    const { count, wait } = mustWait(run, acctKey);
    if (paused || wait) {
      run.status = paused ? 'paused-limit' : 'queued';
      if (paused) run.limitError = paused.reason;
      record(run, { kind: 'system', text: paused
        ? `Paused: ${ws.name}'s ${eng.label} account hit its usage limit. Queued to start by itself when the window resets (or press Run now).`
        : `Queued on ${ws.name}'s ${eng.label} account (${count} live${run.fromHuddle ? ', huddle work starts one after another' : ''}). Press Run now to start it at once.` });
      live.set(run.id, { queued: true, fingerprint, launch: () => launchNow(), stop: () => finish(run, ws, null, '') });
      run.activity = nextActivity(run, null, { statusChanged: true });
      save();
      emit('run.updated', { run: publicRun(run) });
      return publicRun(run);
    }
  }
  launchNow();
  return publicRun(run);
}

/** What a follow-up that starts fresh after a long chain is told: the task file, the last report, what's open. */
function chainSeed(ws, run, parent, { chainTurns, lastInput }) {
  const holder = run.taskDir ? run : parent?.taskDir ? parent : null;
  const file = holder ? path.join(taskRoot(ws, holder), 'TASK.md') : null;
  const shown = holder ? `${taskRel(holder)}/TASK.md` : null;
  let taskDoc = '';
  try { if (file && fs.existsSync(file)) taskDoc = fs.readFileSync(file, 'utf8').slice(0, 2500).trim(); } catch {}
  const lastSummary = String(parent?.report?.summary || parent?.resultText || '').slice(0, 1500).trim();
  const outputs = (parent?.report?.outputs || []).slice(0, 10);
  const followUps = (parent?.report?.follow_ups || []).slice(0, 10);
  return [
    `(Orchy: the earlier conversation reached ${chainTurns} turns${lastInput > 120_000 ? ` (${Math.round(lastInput / 1000)}k input tokens)` : ''}, so this follow-up starts a fresh session to keep it fast.`,
    shown ? `Task file: ${shown}` : 'Check the Tasks/ folder for the earlier task files.',
    lastSummary ? `Last report summary:\n${lastSummary}` : '',
    outputs.length ? `Outputs so far:\n- ${outputs.join('\n- ')}` : '',
    followUps.length ? `Open follow-ups:\n- ${followUps.join('\n- ')}` : '',
    taskDoc ? `Current TASK.md excerpt:\n${taskDoc}` : '',
    'Pick up from these files without redoing finished work.)',
  ].filter(Boolean).join('\n\n');
}

// ── session/usage limits ──
// A run that fails on its account's session or usage limit doesn't fail: it pauses (`paused-limit`), and the runs
// queued behind it on that account wait too, until the window resets (the time the harness names, else 30 minutes).
export const SESSION_LIMIT_RE = /session limit|usage limit|rate limit.*reset|hit your limit|out of .*usage|exceeded.*(?:plan|usage).*limit|usage cap/i;
const SESSION_LIMIT_WAIT_MS = 30 * 60_000;

export function parseResetWaitMs(text) {
  const min = String(text || '').match(/in\s+(\d{1,3})\s*(?:min|minute)/i);
  if (min) return Math.max(60_000, Math.min(4 * 3600_000, Number(min[1]) * 60_000));
  const hr = String(text || '').match(/in\s+(\d{1,2})\s*(?:hr|hour)/i);
  if (hr) return Math.max(60_000, Math.min(6 * 3600_000, Number(hr[1]) * 3600_000));
  return SESSION_LIMIT_WAIT_MS;
}

/** A run that hit its account's limit: park it (and the account) until the window resets; `relaunch` starts it again. */
function pauseForSessionLimit(run, ws, reason, relaunch) {
  const acctKey = runAcct.get(run.id) || accountKey(ws, run.runtime);
  const waitMs = parseResetWaitMs(reason);
  const until = Date.now() + waitMs;
  const prevEntry = live.get(run.id);
  run.status = 'paused-limit';
  run.limitError = String(reason).slice(0, 400);
  run.apiError = null;
  record(run, { kind: 'system', text: `Paused: ${ws.name}'s ${engine(run.runtime)?.label || run.runtime} account hit its session/usage limit (${String(reason).slice(0, 200)}). It starts again by itself when the window resets (or press Run now).` });
  live.set(run.id, { queued: true, fingerprint: prevEntry?.fingerprint || null, launch: relaunch, stop: () => finish(run, ws, null, '') });
  run.activity = nextActivity(run, null, { statusChanged: true });
  save();
  emit('run.updated', { run: publicRun(run) });

  const prev = accountLimits.get(acctKey);
  if (prev?.timer) clearTimeout(prev.timer);
  const timer = setTimeout(() => { accountLimits.delete(acctKey); drainQueue(acctKey); }, waitMs);
  timer.unref?.();
  accountLimits.set(acctKey, { until, reason: run.limitError, timer, announced: true });
  if (!prev?.announced && limitReporter) {
    try { limitReporter({ ws, run: publicRun(run), reason: run.limitError, until: new Date(until).toISOString() }); } catch {}
  }
}

/** Start what's waiting on an account, as far as its limit allows (after a run ends, or the limit window resets). */
function drainQueue(acctKey) {
  const lim = accountLimits.get(acctKey);
  if (lim && Date.now() < lim.until) return;
  if (lim) { clearTimeout(lim.timer); accountLimits.delete(acctKey); }
  for (const [rid, entry] of [...live.entries()]) {
    if (!entry.queued || runAcct.get(rid) !== acctKey) continue;
    const r = db().runs[rid];
    if (!r) { live.delete(rid); runAcct.delete(rid); continue; }
    const { count, wait } = mustWait(r, acctKey);
    if (count >= maxLivePerAccount()) break;
    if (wait) continue; // huddle work waits for the account to be free
    entry.queued = false;
    r.limitError = null;
    setRunStatus(r, 'starting');
    record(r, { kind: 'system', text: 'Starting from the queue.' });
    entry.launch();
  }
}

// The workspace's own setup (settings, hooks, skills, agents, instructions, MCP servers). acceptEdits takes edits in
// the folder without asking anyone, so these are ask rules: they reach the gate, which asks the owner (policy.mjs#setupFile).
// The AI Agent Builder writes agent files (and retires them), so .claude/agents and .jos/retired stay open to it.
const SETUP_ASK = ['.claude/**', '.codex/**', '.agents/skills/**', '.one/**', '.jos/mcp.json', '.jos/retired/**', 'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.mcp.json'];
const BUILDER_ASK = ['.claude/*', '.claude/skills/**', '.claude/hooks/**', '.claude/commands/**', '.claude/rules/**', '.claude/output-styles/**', '.codex/**', '.agents/skills/**', '.one/**', '.jos/mcp.json', 'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.mcp.json'];
// image reads reach the gate too, so it can count them (gate.mjs: a run reading frame after frame asks after 60)
const IMAGE_ASK = ['**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.webp', '**/*.gif'];
const fwd = p => String(p).replace(/\\/g, '/');
/** The files in Orchy's own folder that a run must never load as its instructions (Claude Code walks up from the run's folder). */
export const ROOT_INSTRUCTIONS = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md'];
/** The PreToolUse hook that tells Orchy where each shell command runs (mcp/cwd-hook.mjs), as a command line for the harness's shell. */
export const cwdHookCommand = runId => shellLine([process.execPath, path.join(ORCH_DIR, 'mcp', 'cwd-hook.mjs'), runId]);
export function setupSettingsFile(ws, run) {
  // relative to the run's folder, and by absolute path in Claude Code's form (//c/Users/…). Edit rules cover every
  // built-in edit (Write, NotebookEdit…); a match only hands the call to the gate, which lets nested look-alikes through
  const root = `//${path.resolve(ws.dir).replace(/\\/g, '/').replace(/^([A-Za-z]):\//, (_, d) => `${d.toLowerCase()}/`)}`;
  const ask = [
    ...(run.isBuilder ? BUILDER_ASK : SETUP_ASK).flatMap(g => [`Edit(./${g})`, `Edit(${root}/${g})`]),
    ...IMAGE_ASK.flatMap(g => [`Read(./${g})`, `Read(${root}/${g})`]),
  ];
  const file = path.join(DATA_DIR, 'runs', `${run.id}.settings.json`);
  // the folder each command runs in (the shell keeps a `cd` between commands), for the gate's checks (gate.mjs#shellCwd)
  const cwdHook = { type: 'command', command: cwdHookCommand(run.id), timeout: 10 };
  // Orchy's own CLAUDE.md is for people and agents working on Orchy, never for a workspace's agents (both path forms)
  const claudeMdExcludes = [...new Set(ROOT_INSTRUCTIONS.flatMap(f => [fwd(path.join(ROOT, f)), path.join(ROOT, f)]))];
  fs.writeFileSync(file, JSON.stringify({ claudeMdExcludes, permissions: { ask }, hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [cwdHook] }] } }, null, 2));
  return file;
}

// ── Pre-tool hooks: Antigravity and Hermes run mcp/tool-hook.mjs before every tool call, and it asks here ──
// The hook names its run by the session id the harness gives it (agy's conversation, Hermes's ACP session), so two
// runs sharing an agy folder or a Hermes profile never answer for each other. Fail closed: no live hooked run with
// that session, no answer.
const toolHookRuns = new Map(); // runId → { engine, allows: [{ kind, file, at }], pending: Map(call → inbox item id) }
const HOOK_ALLOW_TTL = 10 * 60_000;
export const TOOL_HOOK_SCRIPT = path.join(ORCH_DIR, 'mcp', 'tool-hook.mjs');
/** Where the hook finds Orchy and its bridge token: a file in Orchy's data folder, which no agent may read. */
export function toolHookCreds() {
  const file = path.join(DATA_DIR, 'tool-hook.json');
  const body = JSON.stringify({ url: `http://127.0.0.1:${serverPort}`, token: BRIDGE_TOKEN });
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf8'); } catch {}
  if (cur !== body) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(file, body, { mode: 0o600 }); }
  return file;
}

/**
 * One hook call (POST /api/bridge/tool-hook): every call it names goes through the gate; an ask waits for the owner up
 * to maxWaitMs. Still unanswered then (Hermes stops a hook after 5 minutes): "still waiting", and the same call asked
 * again waits on the same pop-up instead of opening another. Returns { allow, reason?, pending? }.
 */
export async function toolHook({ engine: eng, sessionId, calls, maxWaitMs = 270_000 }) {
  const runId = sessionId && [...toolHookRuns.keys()].find(id => {
    const r = db().runs[id];
    return r && !r.endedAt && live.has(id) && r.sessionId === sessionId && toolHookRuns.get(id).engine === eng;
  });
  if (!runId) return { allow: false, reason: 'Orchy has no live run for this session, so the tool is refused.' };
  if (!Array.isArray(calls) || !calls.length) return { allow: false, reason: 'No tool to check.' };
  const run = db().runs[runId], th = toolHookRuns.get(runId);
  const wait = Math.max(1000, Math.min(Number(maxWaitMs) || 0, 6 * 3600_000));
  for (const c of calls.slice(0, 20)) {
    const v = await hookDecide(run, th, String(c?.tool || ''), c?.input && typeof c.input === 'object' ? c.input : {}, wait);
    if (!v.allow) return v;
  }
  for (const c of calls) th.allows.push({ kind: actionKind(c.tool), file: c.input?.file_path ? path.resolve(String(c.input.file_path)) : null, at: Date.now() });
  return { allow: true };
}

async function hookDecide(run, th, tool, input, waitMs) {
  const key = `${tool}\n${JSON.stringify(input)}`;
  let itemId = th.pending.get(key);
  if (!itemId) {
    const v = await gate(run.id, tool, input);
    if (v.decision === 'allow') return { allow: true };
    if (v.decision === 'deny') return { allow: false, reason: `${v.reason} Don't try it another way.` };
    itemId = v.itemId;
    th.pending.set(key, itemId);
  }
  setRunStatus(run, 'waiting');
  const until = Date.now() + waitMs;
  let item = db().inbox[itemId];
  while (item?.status === 'pending' && !run.endedAt && Date.now() < until) item = await waitFor(itemId, Math.min(25_000, until - Date.now()));
  if (item?.status === 'pending' && !run.endedAt) {
    return { allow: false, pending: true, reason: `Still waiting for ${ownerName()}'s OK on this: Orchy has asked. Try exactly the same action again in a minute, and don't do it another way meanwhile.` };
  }
  th.pending.delete(key);
  if (!run.endedAt) setRunStatus(run, 'working');
  if (item?.status === 'answered' && item.answer?.approve) return { allow: true };
  const who = item?.askee || ownerName();
  const reason = item?.status === 'answered' ? `${who} denied this${item.answer?.note ? `: ${item.answer.note}` : '.'} Don't try it another way.` : `No answer from ${who}.`;
  record(run, { kind: 'denied', text: reason });
  return { allow: false, reason };
}

/**
 * The hooks an engine whose adapter talks to a long-lived server (Codex, OpenCode) calls: the run's feed, its gate,
 * the owner's question box, usage, and the end. Same for every such engine.
 */
function hooksFor(run, ws) {
  const who = { slug: run.agentSlug || 'general', displayName: run.agentName };
  return {
    record: evt => {
      if (evt.kind !== 'tool') return record(run, evt);
      const entry = live.get(run.id);
      if (entry) entry.acted = true; // from here on a failure isn't safe to start over blindly
      const summary = describeTool(evt.tool, evt.input || {}, run) + (evt.extra ? ` (+${evt.extra} more)` : '');
      record(run, { kind: 'tool', tool: evt.tool, ...(evt.toolUseId ? { toolUseId: evt.toolUseId } : {}), summary, input: trimInput(evt.input) });
    },
    started: ({ threadId }) => { run.sessionId = threadId; save(); setRunStatus(run, 'working'); },
    gate: async (tool, input) => {
      const v = await gateAndWait(run.id, tool, input, { onAsk: () => setRunStatus(run, 'waiting') });
      if (!v.allow && v.byOwner) record(run, { kind: 'denied', text: v.reason });
      return v;
    },
    // the engine's own "ask the user" tool becomes the same pop-up as ask_user
    ask: async questions => {
      const out = {};
      for (const q of questions) {
        const item = createItem('question', { runId: run.id, workspace: ws.id, agent: who, title: q.question, message: q.question, context: q.header || '', options: (q.options || []).map(o => o.label), ...askFields(run) });
        setRunStatus(run, 'waiting');
        const it = await waitAnswered(item.id);
        out[q.id] = it.status === 'answered' ? String(it.answer?.text ?? '') : '';
      }
      return out;
    },
    // an engine that can't ask on the way (Antigravity) asks the owner once, before it starts; never remembered
    approveRun: async ({ title, message }) => {
      const item = createItem('approval', { runId: run.id, workspace: ws.id, agent: who, title, message, detail: run.instruction, noRemember: true, ...askFields(run) });
      setRunStatus(run, 'waiting');
      const it = await waitAnswered(item.id);
      const ok = it.status === 'answered' && !!it.answer?.approve;
      if (ok) setRunStatus(run, 'starting');
      return ok;
    },
    // an engine gated by its own pre-tool hook (Antigravity, Hermes): from now on mcp/tool-hook.mjs asks for this run
    useToolHook: eng => {
      toolHookRuns.set(run.id, { engine: eng, allows: [], pending: new Map() });
      return { credsFile: toolHookCreds(), script: TOOL_HOOK_SCRIPT };
    },
    // a tool the harness runs was OK'd by the hook (same kind, and the same file when both name one): used up once,
    // unless `keep` (an ACP edit request for it, which comes under another tool-call id than the tool itself)
    takeHookAllow: (kind, file = null, { keep = false } = {}) => {
      const th = toolHookRuns.get(run.id);
      if (!th) return false;
      const now = Date.now();
      th.allows = th.allows.filter(a => now - a.at < HOOK_ALLOW_TTL);
      const i = th.allows.findIndex(a => a.kind === kind && (!file || !a.file || a.file === path.resolve(file)));
      if (i < 0) return false;
      if (!keep) th.allows.splice(i, 1);
      return true;
    },
    usage: tokens => { run.tokens = tokens; },
    cost: usd => { run.costUsd = usd; },
    done: ({ code, status, error, resultText }) => {
      toolHookRuns.delete(run.id);
      if (resultText) run.resultText = resultText;
      run.apiError = code === 0 ? null : status === 'interrupted' ? 'Interrupted' : (error || `The ${runtimeLabel(run.runtime)} turn failed`);
      // the account's session/usage limit: pause instead of failing, and start again (in the same conversation if it acted)
      if (code !== 0 && status !== 'interrupted' && run.status !== 'stopping' && !run.report && !run.huddleTalk && SESSION_LIMIT_RE.test(`${error || ''}\n${resultText || ''}`)) {
        const again = live.get(run.id)?.acted ? run.sessionId : undefined;
        const launch = launchers.get(run.id);
        if (launch) return pauseForSessionLimit(run, ws, String(error || 'Session/usage limit reached').trim(), () => { run.apiError = null; launch(again); });
      }
      finish(run, ws, code, error || '');
    },
  };
}

/** What an engine's launch() gets besides the run (engines/index.mjs): the shared run machinery and the modules it needs. */
const RT = {
  live, record, finish, save, briefFor,
  // a Claude Code run that hit its account's session/usage limit (engines/claude.mjs): pause it, `relaunch` later
  SESSION_LIMIT_RE,
  limitPause: (run, ws, reason, relaunch) => pauseForSessionLimit(run, ws, reason, relaunch),
  handleLine: (run, ws, line) => handleLine(run, ws, line), // Claude Code's stream-json lines
  hooks: hooksFor,
  setupSettingsFile: (ws, run) => setupSettingsFile(ws, run),
  instructions: (ws, run, agentMarkdown, planText) => codexInstructions(ws, run, agentMarkdown, planText),
  deps: {
    allWorkspaces: () => workspaces(),
    // every harness profile folder of the other workspaces, and this one's for its other engines (Antigravity's deny rules)
    profileDirs: (ws, others = [], except = null) => [...others.flatMap(w => engines().map(e => w[e.fields.profile])), ...engines().filter(e => e.id !== except).map(e => ws[e.fields.profile])].filter(Boolean).map(profilePath),
    ensureHome, clientSettingsFile, clientReadDirs, backendSettingsFile, nativeAgentDenyRules, clientDenyRules, listAgents, protocolFile },
};

function handleLine(run, ws, line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'system' && msg.subtype === 'init') {
    const jos = (msg.mcp_servers || []).find(s => s.name === 'jos');
    if (jos && jos.status !== 'connected') record(run, { kind: 'error', text: `Orchestrator bridge status: ${jos.status}` });
    setRunStatus(run, 'working');
    return;
  }
  if (msg.type === 'assistant') {
    const u = msg.message?.usage;
    if (u) run.lastInputTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    for (const block of msg.message?.content || []) {
      if (block.type === 'text' && block.text?.trim()) record(run, { kind: 'text', text: block.text.trim() });
      if (block.type === 'tool_use') {
        const entry = live.get(run.id);
        if (entry) entry.acted = true; // from here on a failure isn't safe to retry blindly
        if (entry && (block.name === 'Bash' || block.name === 'PowerShell') && oneLookup(block.input?.command)) (entry.lookups ||= new Set()).add(block.id);
        if (entry && block.id) (entry.tools ||= new Map()).set(block.id, block.name); // for the result's tool_done
        record(run, { kind: 'tool', tool: block.name, toolUseId: block.id, summary: describeTool(block.name, block.input || {}, run), input: trimInput(block.input) });
      }
    }
    return;
  }
  if (msg.type === 'user') {
    for (const block of msg.message?.content || []) {
      if (block.type !== 'tool_result') continue;
      const text = Array.isArray(block.content) ? block.content.map(c => c.text || '').join('\n') : String(block.content || '');
      const entry = live.get(run.id);
      if (entry?.lookups?.delete(block.tool_use_id) && !block.is_error) harvestActions(text);
      const tool = entry?.tools?.get(block.tool_use_id);
      entry?.tools?.delete(block.tool_use_id);
      if (block.is_error) record(run, { kind: 'tool_error', toolUseId: block.tool_use_id, tool, text: text.slice(0, 600) });
      // success: a safe digest only (counts), never the output itself
      else record(run, { kind: 'tool_done', toolUseId: block.tool_use_id, tool, ok: true, brief: briefFor(tool, block.content) });
    }
    return;
  }
  if (msg.type === 'result') {
    run.resultText = msg.result || run.resultText;
    run.numTurns = msg.num_turns;
    run.costUsd = msg.total_cost_usd;
    run.apiError = msg.is_error ? (msg.result || msg.subtype) : null;
    if (msg.session_id) run.sessionId = msg.session_id;
    if (msg.permission_denials?.length) run.permissionDenials = msg.permission_denials.length;
    if (msg.usage) {
      const u = msg.usage;
      const input = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      const output = u.output_tokens || 0;
      run.tokens = { input, output, total: input + output, uncachedInput: u.input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheCreate: u.cache_creation_input_tokens || 0 };
    }
    save();
  }
}

function trimInput(input) {
  if (!input) return input;
  const s = JSON.stringify(input);
  return s.length > 1500 ? JSON.parse(JSON.stringify(input, (k, v) => (typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '…' : v))) : input;
}

async function finish(run, ws, code, stderr) {
  const entry = live.get(run.id);
  const acctKey = runAcct.get(run.id);
  live.delete(run.id);
  runAcct.delete(run.id);
  launchers.delete(run.id);
  run.endedAt = new Date().toISOString();
  run.durationMs = Date.parse(run.endedAt) - Date.parse(run.startedAt);
  if (run.status === 'stopping') run.outcome = 'stopped';
  // a huddle turn that already said its piece (huddle_reply) and was ended early (endHuddleTurn) completed
  else if (run.huddleTalk && run.huddleReply) run.outcome = 'completed';
  else if (run.report?.status) run.outcome = run.report.status;
  else if (code === 0 && !run.apiError) run.outcome = 'completed';
  else run.outcome = 'failed';
  if (run.outcome === 'failed' && !run.report) {
    // a bare result subtype ("error_during_execution") says nothing: add what Claude printed on stderr
    const tail = String(stderr || '').trim().split('\n').slice(-6).join('\n');
    const bare = run.apiError && /^error_[a-z_]+$/.test(run.apiError);
    run.error = ((bare && tail ? `${run.apiError}: ${tail}` : run.apiError) || tail || `${runtimeLabel(run.runtime)} exited with code ${code}`).slice(0, 1500);
    record(run, { kind: 'error', text: run.error });
  }

  if (entry?.fingerprint) {
    const after = agentFingerprint(ws.id);
    const fileErrors = Object.fromEntries(listAgents(ws.id).filter(a => a.error).map(a => [a.slug, a.error]));
    run.createdAgents = Object.keys(after).filter(s => s !== BUILDER_SLUG && (!entry.fingerprint[s] || entry.fingerprint[s] !== after[s]))
      .map(s => ({ slug: s, isNew: !entry.fingerprint[s], ...(fileErrors[s] ? { error: fileErrors[s] } : {}) }));
    for (const a of run.createdAgents) {
      emit(a.isNew ? 'agent.created' : 'agent.updated', { workspace: ws.id, slug: a.slug });
      // A file with broken frontmatter can't be routed to or run; say so instead of reporting success.
      if (a.error) record(run, { kind: 'error', text: `${a.slug}.md was written but its frontmatter is broken, so it can't run: ${a.error}` });
    }
  }

  // what a fix changed in Orchy's code (backend.mjs restarts him from it and offers an undo)
  if (run.backend) { try { run.backendChanges = changes(run.id) || []; } catch (e) { console.error('[backend] changes', e.message); run.backendChanges = []; } }

  run.status = run.outcome === 'failed' ? 'failed' : run.outcome === 'stopped' ? 'stopped' : 'done';
  stopSubRuns(run.id); // a head that ended can't take its team's reports any more
  const items = itemsForRun(run.id);
  expireForRun(run.id);
  // a huddle's turns are logged together, as the huddle (huddle.mjs)
  if (!run.huddle) {
    try { appendRunLog(run, ws, items); run.logged = true; } catch (e) { console.error('[logs] append failed', e); }
    try { saveTask(run, ws); } catch (e) { console.error('[tasks] save failed', e); }
  }
  try { appendCostLine(run, ws); } catch (e) { console.error('[costs] append failed', e.message); }
  save();
  record(run, { kind: 'system', text: `Finished: ${run.outcome}` });
  emit('run.ended', { run: publicRun(run) });
  if (acctKey) drainQueue(acctKey); // a slot on its account is free
  if (orchyReporter && !run.huddle) orchyReporter(run, ws).catch(e => console.error('[orchy] report failed', e));
}

export function stopRun(runId, { by = null } = {}) {
  const run = getRun(runId);
  const entry = live.get(runId);
  if (!entry) return publicRun(run);
  if (by) run.stoppedBy = by; // a client stopping their own run from their page
  setRunStatus(run, 'stopping');
  entry.stop();
  stopSubRuns(runId);
  return publicRun(run);
}

/** End a huddle turn once its huddle_reply has landed (server.mjs, the bridge), so it doesn't take extra trailing turns. */
export function endHuddleTurn(runId) {
  const entry = live.get(runId);
  const run = db().runs[runId];
  if (!entry || entry.queued || !run?.huddleTalk || !run.huddleReply) return;
  entry.huddleDone = true;
  entry.stop();
}

/** Start a queued or limit-paused run at once (the owner's "Run now"). A limit pause on its account is lifted for it. */
export function runNow(runId) {
  const run = getRun(runId);
  const entry = live.get(runId);
  if (!entry || !entry.queued) return publicRun(run);
  const acctKey = runAcct.get(runId);
  const lim = acctKey && accountLimits.get(acctKey);
  if (lim) { clearTimeout(lim.timer); accountLimits.delete(acctKey); }
  entry.queued = false;
  run.limitError = null;
  setRunStatus(run, 'starting');
  record(run, { kind: 'system', text: `Started at once by ${ownerName()} (jumped the queue).` });
  entry.launch();
  return publicRun(run);
}

/** Stop the team runs a head handed work to (when the head stops or ends). */
function stopSubRuns(parentId) {
  for (const r of Object.values(db().runs)) {
    if (r.delegatedBy === parentId && live.has(r.id) && r.status !== 'stopping') {
      try { stopRun(r.id); } catch (e) { console.error('[delegate] stop failed', e.message); }
    }
  }
}

export function isLive(runId) { return live.has(runId); }

/** Runs cut off by a restart (queued and paused ones too) are failed; their ids are returned. */
export function markInterruptedRuns() {
  const cut = [];
  for (const run of Object.values(db().runs)) {
    if (['queued', 'paused-limit', 'starting', 'working', 'waiting', 'stopping'].includes(run.status)) {
      cut.push(run.id);
      run.status = 'failed';
      run.outcome = 'failed';
      run.error = 'The orchestrator stopped while this run was in progress, so the agent was cut off. Re-send the task if it still needs doing.';
      run.endedAt = run.endedAt || run.lastActivity || new Date().toISOString();
      run.durationMs = Date.parse(run.endedAt) - Date.parse(run.startedAt);
      run.activity = nextActivity(run);
      if (!run.logged) {
        try { appendRunLog(run, workspace(run.workspace), itemsForRun(run.id)); run.logged = true; } catch (e) { console.error('[logs]', e.message); }
        try { saveTask(run, workspace(run.workspace)); } catch (e) { console.error('[tasks]', e.message); }
      }
    }
  }
  save();
  return cut;
}

/** A line on the run's timeline only the owner sees (a client's page shows notes, not these). */
export function ownerNote(runId, text) {
  record(getRun(runId), { kind: 'system', text });
}

/** Bridge callbacks */
export function addNote(runId, text) {
  const run = getRun(runId);
  run.notes.push({ t: new Date().toISOString(), text });
  record(run, { kind: 'note', text });
  save();
}

export function setReport(runId, report) {
  const run = getRun(runId);
  // agents sometimes send one string where a list belongs; LOGS.md, Orchy and the panes all expect lists
  const list = x => (Array.isArray(x) ? x : x ? [x] : []).map(String);
  run.report = { ...report, actions_taken: list(report.actions_taken), outputs: list(report.outputs), follow_ups: list(report.follow_ups) };
  save();
  record(run, { kind: 'report', text: report.summary?.slice(0, 400) || '' });
  emit('run.updated', { run: publicRun(run) });
}
