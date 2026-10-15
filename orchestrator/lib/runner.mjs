// Runs agents in their workspace folder under that workspace's account, on its engine (engines/index.mjs):
//   Claude Code → `claude -p --output-format stream-json` with the Orchy bridge as permission-prompt tool
//   Codex       → `codex app-server` (codex.mjs), every approval answered by the Orchy gate
//   OpenCode    → `opencode serve` + its HTTP API (engines/opencode-run.mjs), every ask answered by the Orchy gate
// This file holds what every engine shares (the run record, the feed, finishing, stopping); each engine's launch code
// lives in its engines/ module and gets the `RT` object below.
// Wires the Orchy MCP bridge, streams events, logs the result.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ORCH_DIR, DATA_DIR, ownerName } from './env.mjs';
import { db, save, id, runEventsPath } from './store.mjs';
import { emit } from './bus.mjs';
import { workspace, accountCheck, readMcp, allConnections, modelFor, modelsFor, accountFor, engineFor, runtimeLabel } from './workspaces.mjs';
import { engine, ungatedRefusal } from './engines/index.mjs';
import { getAgent, listAgents, agentFingerprint, BUILDER_SLUG } from './agents.mjs';
import { protocolFile, builderBrief, codexInstructions } from './prompts.mjs';
import { namingBrief, nameOf } from './voiceagents.mjs';
import { expireForRun, itemsForRun, createItem } from './inbox.mjs';
import { appendRunLog } from './logs.mjs';
import { hasTaskDir, openTaskDir, saveTask } from './tasks.mjs';
import { ensureHome, clientSettingsFile, clientReadDirs, adoptUploads, copyIntoTask, filesNote } from './clientspace.mjs';
import { gateAndWait, waitAnswered } from './gate.mjs';
import { askFields, clientDenyRules } from './clients.mjs';
import { teamFor, huddlePartners, nativeAgentDenyRules } from './delegation.mjs';
import { planFor, planLine } from './actionplan.mjs';
import { splitShell } from './policy.mjs';
import { snapshot, changes, backendSettingsFile } from './backend.mjs';

export const BRIDGE_TOKEN = crypto.randomBytes(16).toString('hex');
const live = new Map(); // runId -> { child, fingerprint, stop, acted, lookups (tool_use ids of One lookups) }
let orchyReporter = null;
export function onRunFinished(fn) { orchyReporter = fn; }
let serverPort = 8008;
export function setPort(p) { serverPort = p; }

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

function record(run, evt) {
  const e = { t: new Date().toISOString(), ...evt };
  fs.appendFileSync(runEventsPath(run.id), JSON.stringify(e) + '\n');
  run.lastActivity = e.t;
  emit('run.event', { runId: run.id, workspace: run.workspace, event: e });
}

const FINAL = new Set(['done', 'failed', 'stopped']);
export function setRunStatus(run, status) {
  // an ended run keeps its outcome, and a stopping one only ever ends (a late answer or Codex start can't revive it)
  if (run.status === status || run.endedAt || (run.status === 'stopping' && !FINAL.has(status))) return;
  run.status = status;
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
  if (name === 'mcp__jos__huddle') return `Huddling with ${String(input.agent || 'a colleague').slice(0, 40)}`;
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
export async function startRun(opts) {
  const ws = workspace(opts.workspace);
  if (!ws.enabled) {
    throw Object.assign(new Error(`${ws.name} is switched off, so Orchy isn't sending it work. Switch it back on in Workspace → ${ws.name}.`), { status: 409, code: 'WORKSPACE_DISABLED' });
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

  // the dashboard's account checks are cached for a minute; a run start wants one at most 10s old
  await eng.account(accountFor(ws, runtime).profileDir, { maxAge: 10_000 });
  const acct = await accountCheck(ws, { runtime });
  if (!acct.ok) {
    const fix = acct.error && /install|account set/i.test(acct.error) ? acct.error : `In PowerShell: ${acct.fix}`;
    const who = runtime === ws.runtime ? ws.name : `${ws.name}'s ${agent.displayName}`;
    if (acct.profileProblem) throw Object.assign(new Error(`${acct.profileProblem} Not running it.`), { status: 409, code: 'ACCOUNT_MISMATCH' });
    throw Object.assign(new Error(
      acct.loggedIn
        ? `${who} must run as ${acct.expected} on ${acct.runtimeLabel}, but its profile is logged in as ${acct.actual || 'another account'}. Not running it. ${fix}`
        : `${ws.name}'s ${acct.runtimeLabel} profile isn't logged in yet (needs ${acct.expected || 'an account'}). ${fix}`), { status: 409, code: 'ACCOUNT_MISMATCH' });
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
  // A resumed session keeps the model it started on: a long Opus session reopened on a smaller model
  // can fail at once (Sadie's "Proceed", 2026-10-13), so a follow-up never down-shifts it.
  const model = resume && parent?.model && modelsFor(ws, runtime).includes(parent.model)
    ? parent.model
    : agent?.engine && !isBuilder
      ? modelFor(ws, modelsFor(ws, runtime).includes(opts.model) ? opts.model : own || opts.model, runtime)
      : modelFor(ws, opts.model || own, runtime);
  const effort = !isBuilder && agent?.effort ? agent.effort : null;
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
    files: [],
    sessionId: resume || crypto.randomUUID(),
    status: 'starting',
    startedAt: new Date().toISOString(),
    endedAt: null,
    report: null,
    notes: [],
    createdAgents: [],
  };
  // a generalist's task, and every client's, gets its own folder in Tasks/ (a follow-up keeps its parent's);
  // a client's lives in the client's own corner of the workspace (clientspace.mjs)
  if (run.client) ensureHome(ws, run.client);
  if (hasTaskDir(run)) run.taskDir = openTaskDir(ws, run, parent);
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
  if (isBuilder && !resume && !opts.huddle) {
    const conns = await allConnections(ws);
    let naming = null;
    try { naming = namingBrief(); } catch (e) { console.warn('[voice] no naming brief:', e.message); }
    prompt = builderBrief(ws, opts.instruction, conns, listAgents(ws.id), naming);
  }
  run.prompt = prompt;

  // MCP: the Orchy bridge + the external servers this agent may use (all of them for the builder/generalist).
  const servers = readMcp(ws);
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
  try {
    eng.launch(run, ws, { prompt, agentSlug, agentMarkdown, mcp, resume, fingerprint, planText }, RT);
  } catch (e) {
    // a launch that throws must not leave a run that is "starting" for ever
    record(run, { kind: 'error', text: e.message });
    finish(run, ws, 1, e.message);
  }
  return publicRun(run);
}

// The workspace's own setup (settings, hooks, skills, agents, instructions, MCP servers). acceptEdits takes edits in
// the folder without asking anyone, so these are ask rules: they reach the gate, which asks the owner (policy.mjs#setupFile).
// The AI Agent Builder writes agent files (and retires them), so .claude/agents and .jos/retired stay open to it.
const SETUP_ASK = ['.claude/**', '.codex/**', '.agents/skills/**', '.one/**', '.jos/mcp.json', '.jos/retired/**', 'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.mcp.json'];
const BUILDER_ASK = ['.claude/*', '.claude/skills/**', '.claude/hooks/**', '.claude/commands/**', '.claude/rules/**', '.claude/output-styles/**', '.codex/**', '.agents/skills/**', '.one/**', '.jos/mcp.json', 'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.mcp.json'];
function setupSettingsFile(ws, run) {
  // relative to the run's folder, and by absolute path in Claude Code's form (//c/Users/…). Edit rules cover every
  // built-in edit (Write, NotebookEdit…); a match only hands the call to the gate, which lets nested look-alikes through
  const root = `//${path.resolve(ws.dir).replace(/\\/g, '/').replace(/^([A-Za-z]):\//, (_, d) => `${d.toLowerCase()}/`)}`;
  const ask = (run.isBuilder ? BUILDER_ASK : SETUP_ASK).flatMap(g => [`Edit(./${g})`, `Edit(${root}/${g})`]);
  const file = path.join(DATA_DIR, 'runs', `${run.id}.settings.json`);
  fs.writeFileSync(file, JSON.stringify({ permissions: { ask } }, null, 2));
  return file;
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
      const summary = describeTool(evt.tool, evt.input || {}, run) + (evt.extra ? ` (+${evt.extra} more)` : '');
      record(run, { kind: 'tool', tool: evt.tool, summary, input: trimInput(evt.input) });
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
    usage: tokens => { run.tokens = tokens; },
    cost: usd => { run.costUsd = usd; },
    done: ({ code, status, error, resultText }) => {
      if (resultText) run.resultText = resultText;
      run.apiError = code === 0 ? null : status === 'interrupted' ? 'Interrupted' : (error || `The ${runtimeLabel(run.runtime)} turn failed`);
      finish(run, ws, code, error || '');
    },
  };
}

/** What an engine's launch() gets besides the run (engines/index.mjs): the shared run machinery and the modules it needs. */
const RT = {
  live, record, finish, save,
  handleLine: (run, ws, line) => handleLine(run, ws, line), // Claude Code's stream-json lines
  hooks: hooksFor,
  setupSettingsFile: (ws, run) => setupSettingsFile(ws, run),
  instructions: (ws, run, agentMarkdown, planText) => codexInstructions(ws, run, agentMarkdown, planText),
  deps: { ensureHome, clientSettingsFile, clientReadDirs, backendSettingsFile, nativeAgentDenyRules, clientDenyRules, listAgents, protocolFile },
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
    for (const block of msg.message?.content || []) {
      if (block.type === 'text' && block.text?.trim()) record(run, { kind: 'text', text: block.text.trim() });
      if (block.type === 'tool_use') {
        const entry = live.get(run.id);
        if (entry) entry.acted = true; // from here on a failure isn't safe to retry blindly
        if (entry && (block.name === 'Bash' || block.name === 'PowerShell') && oneLookup(block.input?.command)) (entry.lookups ||= new Set()).add(block.id);
        record(run, { kind: 'tool', tool: block.name, summary: describeTool(block.name, block.input || {}, run), input: trimInput(block.input) });
      }
    }
    return;
  }
  if (msg.type === 'user') {
    for (const block of msg.message?.content || []) {
      if (block.type !== 'tool_result') continue;
      const text = Array.isArray(block.content) ? block.content.map(c => c.text || '').join('\n') : String(block.content || '');
      if (live.get(run.id)?.lookups?.delete(block.tool_use_id) && !block.is_error) harvestActions(text);
      if (block.is_error) record(run, { kind: 'tool_error', text: text.slice(0, 600) });
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
  live.delete(run.id);
  run.endedAt = new Date().toISOString();
  run.durationMs = Date.parse(run.endedAt) - Date.parse(run.startedAt);
  if (run.status === 'stopping') run.outcome = 'stopped';
  else if (run.report?.status) run.outcome = run.report.status;
  else if (code === 0 && !run.apiError) run.outcome = 'completed';
  else run.outcome = 'failed';
  if (run.outcome === 'failed' && !run.report) {
    // a bare result subtype ("error_during_execution") says nothing: add what Claude printed on stderr
    const tail = stderr.trim().split('\n').slice(-6).join('\n');
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
  save();
  record(run, { kind: 'system', text: `Finished: ${run.outcome}` });
  emit('run.ended', { run: publicRun(run) });
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

/** Stop the team runs a head handed work to (when the head stops or ends). */
function stopSubRuns(parentId) {
  for (const r of Object.values(db().runs)) {
    if (r.delegatedBy === parentId && live.has(r.id) && r.status !== 'stopping') {
      try { stopRun(r.id); } catch (e) { console.error('[delegate] stop failed', e.message); }
    }
  }
}

export function isLive(runId) { return live.has(runId); }

export function markInterruptedRuns() {
  for (const run of Object.values(db().runs)) {
    if (['starting', 'working', 'waiting', 'stopping'].includes(run.status)) {
      run.status = 'failed';
      run.outcome = 'failed';
      run.error = 'The orchestrator stopped while this run was in progress, so the agent was cut off. Re-send the task if it still needs doing.';
      run.endedAt = run.endedAt || run.lastActivity || new Date().toISOString();
      run.durationMs = Date.parse(run.endedAt) - Date.parse(run.startedAt);
      if (!run.logged) {
        try { appendRunLog(run, workspace(run.workspace), itemsForRun(run.id)); run.logged = true; } catch (e) { console.error('[logs]', e.message); }
        try { saveTask(run, workspace(run.workspace)); } catch (e) { console.error('[tasks]', e.message); }
      }
    }
  }
  save();
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
