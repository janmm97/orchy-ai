// What went wrong with a run, and what Orchy does about it (docs: README "Core ideas", recovery).
// classify() names the failure from what the run really recorded (its error, the engine's API error, its events,
// the asks it made). Only a run that did nothing but read (Read/Glob/Grep/WebSearch/WebFetch, One action lookups)
// and failed on the engine, the API, the network or a tool that didn't load is retried on its own: a fresh run with
// `retryOf`, 20–60s later, then once more with a longer wait (`run.retries`). Never after anything that could have
// changed something, sent something or asked the owner; never a client's task, a huddle turn, a hand-off or a fix of
// Orchy. A retry is an ordinary startRun, so the account check (workspaces.mjs#accountCheck), the ungated-engine
// refusal and the approval gate run as for any run; a refusal turns into a card. Everything else is one card in
// Orchy's chat (a message with `meta.recover`: Resume · Start over · Leave it, or Follow up · Huddle on it), answered
// through POST /api/runs/:id/recover. The stall timer flags a run with no new step for Settings "Flag a stuck run
// after" minutes; it never stops one (only the optional "Stop runs after" cap does). The session-limit pause in
// runner.mjs runs first: this only sees what got past it.
import fs from 'node:fs';
import { db as storeDb, save as storeSave, runEventsPath } from './store.mjs';
import { emit as busEmit } from './bus.mjs';
import { itemsForRun } from './inbox.mjs';
import { splitShell } from './policy.mjs';

const deps = {
  db: storeDb, save: storeSave, emit: busEmit,
  events: runId => { try { return fs.readFileSync(runEventsPath(runId), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } },
  items: runId => itemsForRun(runId),
  // wired by server.mjs (recover.start)
  startRun: null, stopRun: null, isLive: () => false, followUp: null, say: null, note: null, who: r => r.agentName || 'The agent', wsName: id => id,
  publicRun: run => { const { prompt, ...rest } = run; return rest; },
  now: () => Date.now(), random: Math.random, setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: t => clearTimeout(t),
};
export function configure(o) { Object.assign(deps, o); }

export const MAX_AUTO = 2;
const settings = () => deps.db().settings || {};
export const stallMinutes = (s = settings()) => (s.stallMin === undefined || s.stallMin === null ? 20 : Math.max(0, Number(s.stallMin) || 0));

// ── what ran ──
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'ToolSearch', 'Skill', 'NotebookRead', 'ACP_read', 'ACP_search', 'ACP_fetch', 'mcp__jos__note']);
const LOOKUP = /^(?:npx\s+)?(?:[^\s'"]*[\\/])?one(?:\.cmd|\.ps1|\.exe)?\s+--agent\s+(?:(?:actions|a)\s+(?:find|load|knowledge|search)\b|list\b|whoami\b|guide\b)/i;
/** A shell line that only asked One about actions or connections (optionally after a cd, cut by head/tail). */
export function lookupOnly(command) {
  const s = String(command || '');
  if (!s.trim() || /[`$<]|>(?!&1|\s*\/dev\/null|\s*\$null)/i.test(s)) return false;
  const segs = splitShell(s);
  return segs.some(p => LOOKUP.test(p)) && segs.every(p => LOOKUP.test(p) || /^cd\s+\S/i.test(p) || /^(head|tail)(\s+(-{1,2}[a-z]+(=?\d+)?|-?\d+))*$/i.test(p));
}
export const readOnlyStep = e => READ_TOOLS.has(e.tool) || ((e.tool === 'Bash' || e.tool === 'PowerShell') && lookupOnly(e.input?.command));
/** The steps that weren't plain reads (anything here could have changed or sent something). */
export function sideEffects(events = []) {
  return events.filter(e => e.kind === 'tool' && !readOnlyStep(e)).map(e => ({ tool: e.tool, summary: String(e.summary || '').slice(0, 120) }));
}

// ── naming the failure ──
const RX = {
  interrupted: /orchestrator stopped while this run was in progress/i,
  notApproved: /run was not approved|was not approved\.|declined by (?:the )?owner/i,
  authRace: /Failed to refresh OAuth token|another Claude Code process is refreshing/i,
  auth: /Failed to authenticate|OAuth (?:session|token) (?:has )?expired|not logged in|please run \/login|\/login to|invalid api key|authentication_error|\b401\b|unauthori[sz]ed|account (?:isn['’]t|not) signed in|must run as/i,
  sessionLimit: /session limit|usage limit|rate limit.*reset|hit your limit|out of .*usage|exceeded.*(?:plan|usage).*limit|usage cap|purchase more credits/i,
  rateLimit: /rate[ _-]?limit|\b429\b|too many requests/i,
  overloaded: /overloaded|\b529\b|\b50[0234]\b|internal server error|service unavailable|bad gateway|api_error|api error: 5/i,
  network: /ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|fetch failed|can['’]t reach the api|network (?:error|is unreachable)|getaddrinfo|connection (?:reset|refused|closed)|timed out/i,
  sessionLost: /No conversation found|session .{0,40}(?:not found|does not exist)|cannot resume sessions/i,
  config: /model not found|unknown model|invalid model|Invalid params|not ready:|isn['’]t installed|is not installed|no such (?:model|engine)|Configure it with/i,
  toolMissing: /MCP tool \S+ .*not found|Available MCP tools: none|bridge status: (?:failed|pending|needs-auth)|no such tool|tool \S+ (?:is )?not (?:found|available)|command not found|is not recognized as an internal or external command/i,
  permission: /\bEPERM\b|\bEACCES\b|access is denied|permission denied|operation not permitted/i,
  // everything else (error_during_execution, "exited with code", a harness that stopped) is the engine crashing
};

const L = {
  auth_race: 'its sign-in was busy', auth: 'its account isn’t signed in', session_limit: 'the account hit its usage limit',
  api_error: 'the model’s API was busy', rate_limit: 'the model’s API was rate-limited', network: 'the network dropped',
  tool_missing: 'a tool it needs didn’t load', permission: 'the system refused a file or folder', config: 'its engine or model isn’t set up right',
  session_lost: 'its earlier conversation is gone', engine_crash_before_tools: 'the engine stopped before it did anything',
  engine_crash_after_tools: 'the engine stopped partway through', interrupted: 'I restarted while it was working',
  denied: 'it was told no', blocked: 'it got stuck and said why', agent_error: 'it reported that it failed',
  bad_output: 'its report didn’t pass my check', stalled: 'no new step for a while', stopped: 'it was stopped',
};
export const LABELS = L;

const OPT = {
  resume: { action: 'resume', label: 'Resume' },
  restart: { action: 'restart', label: 'Start over' },
  again: { action: 'restart', label: 'Try again' },
  leave: { action: 'leave', label: 'Leave it' },
  stop: { action: 'stop', label: 'Stop it' },
  login: { action: 'login', label: 'Log in' },
  followup: { action: 'followup', label: 'Follow up' },
  huddle: { action: 'huddle', label: 'Huddle on it' },
  dont: { action: 'leave', label: 'Don’t retry' },
};
// `login`, `followup` and `huddle` are the dashboard's own moves (open Settings → Accounts, the follow-up box, a
// huddle); resume/restart/stop/leave go to POST /api/runs/:id/recover.
const OPTIONS = {
  auth_race: ['again', 'leave'], auth: ['login', 'again', 'leave'], session_limit: ['resume', 'leave'],
  api_error: ['resume', 'restart', 'leave'], rate_limit: ['resume', 'restart', 'leave'], network: ['resume', 'restart', 'leave'],
  tool_missing: ['again', 'leave'], permission: ['resume', 'leave'], config: ['again', 'leave'], session_lost: ['restart', 'leave'],
  engine_crash_before_tools: ['again', 'leave'], engine_crash_after_tools: ['resume', 'restart', 'leave'],
  interrupted: ['resume', 'restart', 'leave'], stalled: ['resume', 'restart', 'stop', 'leave'],
  blocked: ['followup', 'huddle', 'leave'], agent_error: ['followup', 'restart', 'leave'],
};
export const optionsFor = cls => (OPTIONS[cls] || ['restart', 'leave']).map(k => OPT[k]);

const errText = (run, events) => [run.error, run.apiError, run.limitError, ...events.filter(e => e.kind === 'error').slice(-3).map(e => e.text)].filter(Boolean).join('\n');

/**
 * classify(run) → { cls, label, retry: 'auto'|'owner'|'none', options, why, effects } or null (nothing went wrong).
 * `retry: 'auto'` only names a class that may be retried; retryGate() still decides for this run.
 */
export function classify(run, { events = deps.events(run.id) } = {}) {
  const out = (cls, retry, why = '') => ({ cls, label: L[cls], retry, options: retry === 'owner' ? optionsFor(cls) : [], why: String(why || '').split('\n')[0].slice(0, 200), effects: sideEffects(events).length });
  if (run.outcome === 'stopped' || run.status === 'stopped') return out('stopped', 'none');
  const rs = run.report?.status;
  if (rs === 'blocked') return out('blocked', 'owner', run.report.summary);
  if (rs === 'failed') return out('agent_error', 'owner', run.report.summary);
  if (run.outcome === 'completed' || run.outcome === 'partial' || rs === 'completed' || rs === 'partial') {
    return run.validation?.verdict === 'failed' ? out('bad_output', 'none') : null;
  }
  if (run.outcome !== 'failed' && run.status !== 'failed') return null;
  const text = errText(run, events);
  const fx = sideEffects(events).length;
  if (RX.interrupted.test(text)) return out('interrupted', 'owner', text);
  if (RX.notApproved.test(text)) return out('denied', 'none', text);
  if (RX.authRace.test(text)) return out('auth_race', 'owner', text);
  if (RX.sessionLimit.test(text)) return out('session_limit', 'owner', text);
  if (RX.auth.test(text)) return out('auth', 'owner', text);
  if (RX.sessionLost.test(text)) return out('session_lost', 'owner', text);
  if (RX.config.test(text)) return out('config', 'owner', text);
  if (RX.toolMissing.test(text)) return out('tool_missing', 'auto', text);
  if (RX.rateLimit.test(text)) return out('rate_limit', 'auto', text);
  if (RX.network.test(text)) return out('network', 'auto', text);
  if (RX.overloaded.test(text)) return out('api_error', 'auto', text);
  if (RX.permission.test(text)) return out('permission', 'owner', text);
  return fx ? out('engine_crash_after_tools', 'owner', text) : out('engine_crash_before_tools', 'auto', text);
}

/** May Orchy retry this failed run on its own? { ok, why }. Refuses when any side-effect step ran (and more). */
export function retryGate(run, { events = deps.events(run.id), items = deps.items(run.id), s = settings() } = {}) {
  const no = why => ({ ok: false, why });
  if (s.autoRetry === false) return no('retrying on its own is off in Settings');
  if (run.backend || run.huddle || run.huddleTalk) return no('not for this kind of run');
  if (run.client) return no('a client’s task');
  if (run.delegatedBy) return no('a hand-off (its head decides)');
  if (run.report) return no('it reported');
  if ((Number(run.retries) || 0) >= MAX_AUTO) return no(`tried ${MAX_AUTO} times already`);
  const fx = sideEffects(events);
  if (fx.length) return no(`it had already run ${fx[0].tool}${fx[0].summary ? ` (${fx[0].summary})` : ''}`);
  if ((items || []).length) return no('it had asked you something');
  if (run.subRuns?.length || run.createdAgents?.length) return no('it had handed work on or changed agents');
  return { ok: true, why: '' };
}

/** 20–60s for the first retry, 60–120s for the second. */
export const retryDelay = (attempt, rnd = deps.random()) => (attempt <= 1 ? 20_000 + rnd * 40_000 : 60_000 + rnd * 60_000);

/** The same task again as a fresh run: same workspace, agent, model, words and session; never another account. */
export function retryOpts(run, { auto = false } = {}) {
  const parent = run.parentRunId ? deps.db().runs[run.parentRunId] : null;
  return {
    workspace: run.workspace,
    agentSlug: run.agentSlug || null,
    kind: run.kind === 'build' || run.isBuilder ? 'build' : 'task',
    model: run.model,
    instruction: run.instruction,
    routing: run.routing || null,
    session: run.session || null,
    parentRunId: run.parentRunId || null,
    ...(parent?.sessionId ? { resumeSessionId: parent.sessionId } : {}),
    ...(run.fromHuddle ? { fromHuddle: run.fromHuddle } : {}),
    retryOf: run.id,
    retries: auto ? (Number(run.retries) || 0) + 1 : 0,
  };
}

const timers = new Map(); // runId -> pending auto-retry timer
const touch = run => { deps.save(); deps.emit('run.updated', { run: deps.publicRun(run) }); };
const secs = ms => `${Math.round(ms / 1000)}s`;
// runs Orchy doesn't recover on his own: fixes, huddle turns, a client's own task, a step of a multi-step plan (its
// supervisor uses classify/retryGate itself)
const quietOwn = run => run.backend || run.huddle || run.huddleTalk || (run.client && !run.ownerReply) || !!run.missionId;

/**
 * After a run ended (server.mjs, before Orchy reports): classify it, schedule the safe retry or set up the owner's
 * card. Returns null (report as usual), { tail, meta } (the report gets a line and the card's buttons), or
 * { quiet, meta } (an auto-retry: Orchy says one line instead of a report).
 */
export function afterRun(run) {
  if (quietOwn(run)) return null;
  const events = deps.events(run.id), items = deps.items(run.id);
  const c = classify(run, { events });
  if (!c) return null;
  const at = new Date(deps.now()).toISOString();
  const base = { cls: c.cls, label: c.label, why: c.why, at };
  if (c.retry === 'none' || run.delegatedBy) {
    if (run.outcome === 'failed' || c.cls === 'bad_output') { run.recovery = { ...base, state: run.delegatedBy ? 'head' : 'none' }; touch(run); }
    return null;
  }
  if (c.retry === 'auto') {
    const gate = retryGate(run, { events, items });
    if (gate.ok) {
      const attempt = (Number(run.retries) || 0) + 1, wait = retryDelay(attempt);
      run.recovery = { ...base, state: 'scheduled', attempt, dueAt: new Date(deps.now() + wait).toISOString(), options: [OPT.dont] };
      timers.set(run.id, deps.setTimeout(() => fire(run.id), wait));
      touch(run);
      return { quiet: `${deps.who(run)} in ${deps.wsName(run.workspace)} stopped because ${c.label}, before it changed anything, so I'm trying it again in ${secs(wait)} (try ${attempt} of ${MAX_AUTO}).`, meta: { recover: { runId: run.id, cls: c.cls, auto: true } } };
    }
    run.recovery = { ...base, state: 'asking', gate: gate.why, options: optionsFor(c.cls === 'engine_crash_before_tools' ? 'engine_crash_after_tools' : c.cls) };
    touch(run);
    return { tail: `I didn't retry it on my own: ${gate.why}.`, meta: { recover: { runId: run.id, cls: c.cls } } };
  }
  run.recovery = { ...base, state: 'asking', options: c.options };
  touch(run);
  return { tail: offerLine(c.cls), meta: { recover: { runId: run.id, cls: c.cls } } };
}

function offerLine(cls) {
  return {
    auth: 'Log in to its account (Settings → Accounts), then try again.',
    auth_race: 'Its sign-in stayed busy; try again in a minute.',
    session_limit: 'Resume when the limit resets; it picks up its conversation.',
    session_lost: 'Start over runs it fresh.',
    config: 'Fix its engine or model, then try again.',
    blocked: 'Follow up with what it needs, or have it huddle on it.',
    agent_error: 'Follow up, or start it over.',
    permission: 'Free the file or folder, then resume.',
  }[cls] || 'Resume picks up its conversation; Start over runs it fresh.';
}

async function fire(runId) {
  timers.delete(runId);
  const run = deps.db().runs[runId];
  if (!run?.recovery || run.recovery.state !== 'scheduled') return;
  try {
    const nr = await deps.startRun(retryOpts(run, { auto: true }));
    run.recovery = { ...run.recovery, state: 'retried', retriedBy: nr.id, options: [] };
    touch(run);
    deps.say?.(`Trying ${deps.who(run)} again (try ${run.recovery.attempt} of ${MAX_AUTO}).`, { runId: nr.id, workspace: run.workspace, kind: 'dispatch', session: run.session });
  } catch (e) {
    // the account check, an ungated engine, a switched-off workspace or a missing agent refuses it: the owner decides
    run.recovery = { ...run.recovery, state: 'asking', error: String(e.message || e).slice(0, 300), options: optionsFor('engine_crash_before_tools') };
    touch(run);
    deps.say?.(`I couldn't retry ${deps.who(run)}: ${run.recovery.error}`, { runId: run.id, workspace: run.workspace, session: run.session, error: true, recover: { runId: run.id, cls: run.recovery.cls } });
  }
}

export const RESUME_TEXT = "(Orchy: you were cut off before you finished. Carry on where you left off. Check what's already done before redoing anything, and don't repeat anything you already sent, posted or changed.)";

async function waitEnded(runId, ms = 60_000) {
  for (let t = 0; t < ms; t += 200) {
    const r = deps.db().runs[runId];
    if (r?.endedAt && !deps.isLive(runId)) return true;
    await new Promise(res => setTimeout(res, 200));
  }
  return false;
}

/**
 * The owner's answer on a recovery card (POST /api/runs/:id/recover). resume → a follow-up in its own session;
 * restart → the same task as a fresh run (retryOf); stop → stops a live (stalled) run; leave → nothing, card closed.
 * A live stalled run is stopped first, quietly. Returns { ok, run? }.
 */
export async function act(runId, action) {
  const run = deps.db().runs[runId];
  if (!run) throw Object.assign(new Error('No such run'), { status: 404 });
  if (!['resume', 'restart', 'stop', 'leave'].includes(action)) throw Object.assign(new Error('Unknown choice'), { status: 400 });
  if (quietOwn(run) || run.delegatedBy) throw Object.assign(new Error('Orchy doesn’t recover this kind of run'), { status: 400 });
  const rec = run.recovery || { cls: 'manual', label: '', at: new Date(deps.now()).toISOString() };
  if (rec.answered) throw Object.assign(new Error(`Already handled (${rec.answered.action})`), { status: 409 });
  if (timers.has(runId)) { deps.clearTimeout(timers.get(runId)); timers.delete(runId); }
  const done = (extra = {}) => { run.recovery = { ...rec, state: 'answered', options: [], answered: { action, at: new Date(deps.now()).toISOString(), ...extra } }; touch(run); };
  const live = deps.isLive(runId) && !run.endedAt;
  if (action === 'leave') { done(); return { ok: true }; }
  if (action === 'stop') { if (live) deps.stopRun(runId); done(); return { ok: true }; }
  if (live) {
    run.quietReport = true; // its "stopped" report would only say what the owner just chose
    deps.stopRun(runId);
    if (!(await waitEnded(runId))) throw Object.assign(new Error('It didn’t stop in time; try again in a moment'), { status: 409 });
  }
  let nr;
  if (action === 'resume' && run.sessionId) nr = await deps.followUp(runId, { text: RESUME_TEXT });
  else {
    nr = await deps.startRun(retryOpts(run));
    deps.say?.(`Starting ${deps.who(run)} over.`, { runId: nr.id, workspace: run.workspace, kind: 'dispatch', session: run.session });
  }
  done({ runId: nr?.id || null });
  return { ok: true, run: nr };
}

/** Runs markInterruptedRuns just ended (Orchy restarted mid-run), and retries a restart cut short: the owner's cards. */
export function boot(interruptedIds = []) {
  for (const id of interruptedIds) {
    const run = deps.db().runs[id];
    // a stuck-run card it had is replaced: it isn't running any more
    if (!run || quietOwn(run) || run.delegatedBy || (run.recovery && run.recovery.cls !== 'stalled')) continue;
    run.stalledAt = null;
    const steps = deps.events(id).filter(e => e.kind === 'tool').length;
    run.recovery = { cls: 'interrupted', label: L.interrupted, at: new Date(deps.now()).toISOString(), state: 'asking', options: optionsFor('interrupted') };
    touch(run);
    deps.say?.(`${deps.who(run)} in ${deps.wsName(run.workspace)} was cut off when I restarted${steps ? ` (${steps} step${steps === 1 ? '' : 's'} in)` : ''}. Resume picks up its conversation; Start over runs the task fresh.`, { runId: id, workspace: run.workspace, kind: 'report', outcome: 'failed', session: run.session, recover: { runId: id, cls: 'interrupted' } });
  }
  for (const run of Object.values(deps.db().runs)) {
    if (run.recovery?.state !== 'scheduled' || timers.has(run.id)) continue;
    run.recovery = { ...run.recovery, state: 'asking', options: optionsFor('engine_crash_before_tools') };
    touch(run);
    deps.say?.(`I was about to retry ${deps.who(run)} in ${deps.wsName(run.workspace)} when I restarted.`, { runId: run.id, workspace: run.workspace, kind: 'report', outcome: 'failed', session: run.session, recover: { runId: run.id, cls: run.recovery.cls } });
  }
}

/** A live run recorded a step again: it isn't stuck any more (runner.mjs#record calls this when stalledAt is set). */
export function moving(run) {
  run.stalledAt = null;
  if (run.recovery?.cls === 'stalled' && run.recovery.state === 'asking') run.recovery = { ...run.recovery, state: 'moving' };
  deps.emit('run.updated', { run: deps.publicRun(run) });
}

/**
 * The stall timer (every minute): a live run with no new step for `stallMin` minutes (default 20, 0 = off) is flagged
 * (`run.stalledAt`) and the owner gets one card; it keeps running. With `stopAfterMin` set, a run working past it is stopped.
 */
export function checkStalls(now = deps.now()) {
  const s = settings(), min = stallMinutes(s), cap = Math.max(0, Number(s.stopAfterMin) || 0);
  const flagged = [];
  for (const run of Object.values(deps.db().runs)) {
    if (run.endedAt || !deps.isLive(run.id) || run.huddleTalk) continue;
    if (cap && !['waiting', 'queued', 'paused-limit', 'stopping'].includes(run.status) && !run.capStopped && now - Date.parse(run.startedAt) > cap * 60_000) {
      run.capStopped = true;
      deps.note?.(run.id, `Stopped: it ran past ${cap} minutes (Settings → Stop runs after).`);
      deps.stopRun(run.id);
      continue;
    }
    if (!min || !['starting', 'working'].includes(run.status) || run.stalledAt) continue;
    const last = Date.parse(run.lastActivity || run.startedAt);
    if (!(now - last >= min * 60_000)) continue;
    run.stalledAt = new Date(now).toISOString();
    flagged.push(run.id);
    const mins = Math.round((now - last) / 60_000);
    if (!(run.client && !run.ownerReply) && !run.delegatedBy && !run.huddle && !run.missionId && (run.stallCards || 0) < 2) {
      run.stallCards = (run.stallCards || 0) + 1;
      run.recovery = { cls: 'stalled', label: L.stalled, at: run.stalledAt, since: run.lastActivity || run.startedAt, state: 'asking', options: optionsFor('stalled') };
      const doing = run.activity?.toolUseId && run.activity.label ? ` (still on: ${run.activity.label})` : '';
      deps.say?.(`${deps.who(run)} in ${deps.wsName(run.workspace)} hasn't recorded a step in ${mins} minutes${doing}. It's still running; I haven't stopped it.`, { runId: run.id, workspace: run.workspace, kind: 'report', session: run.session, recover: { runId: run.id, cls: 'stalled' } });
    }
    touch(run);
  }
  return flagged;
}

let ticker = null;
export function start(o = {}) {
  configure(o);
  if (!ticker) { ticker = setInterval(() => { try { checkStalls(); } catch (e) { console.error('[recover] stalls', e.message); } }, 60_000); ticker.unref?.(); }
}
export function pendingRetries() { return [...timers.keys()]; }
