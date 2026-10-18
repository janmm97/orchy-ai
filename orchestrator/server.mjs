// Orchy's server. `npm start` → http://localhost:8008
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, DASHBOARD_DIR, env, setEnv, reloadEnv, config, ownerName, saveConfig } from './lib/env.mjs';
import { db, save, flush, id } from './lib/store.mjs';
import { post, ensureSession, getSession, updateSession, listSessions, publicSession, sessionChat, recentChat, sweepSessions, migrateChat } from './lib/sessions.mjs';
import { bus, emit, attachSSE, cursor as busCursor } from './lib/bus.mjs';
import {
  workspaces, workspace, accountCheck, allConnections, identity, readMcp, shownMcp, upsertMcp, removeMcp, testMcp, loginHint,
  runtimes, runtimeLabel, modelsFor, modelFor, oneScope, oneLoginStatus, startOneLogin, oneAddStatus, startOneAdd, openLoginWindow, runtimeAvailability,
  addWorkspace, updateWorkspace, reorderWorkspaces, ensureInks, handles, retireWorkspace, restoreWorkspace, purgeRetired, listRetired, checkFolderName,
} from './lib/workspaces.mjs';
import { scaffoldWorkspace, ensureInstructions } from './lib/scaffold.mjs';
import { listPlatforms } from './lib/one.mjs';
import { toolStatus } from './lib/setupcheck.mjs';
import { quickClaude } from './lib/claude.mjs';
import { engine, engines } from './lib/engines/index.mjs';
import { listAgents, getAgent, saveAgent, deleteAgent, BUILDER_SLUG, departmentsOf } from './lib/agents.mjs';
import { syncAllResources } from './lib/resources.mjs';
import { route, remodel, earlierRuns } from './lib/router.mjs';
import { quickStatus } from './lib/status.mjs';
import { jevMode, jevLabel } from './lib/jev.mjs';
import { warm as warmPlan } from './lib/actionplan.mjs';
import * as runner from './lib/runner.mjs';
import * as inbox from './lib/inbox.mjs';
import { addRule, removeRule, DECISIONS } from './lib/policy.mjs';
import { gate, runCtx, resolveAction } from './lib/gate.mjs';
import { pickTools } from './lib/toolpick.mjs';
import { readLogs, computeUsage } from './lib/logs.mjs';
import { weeklyReview, startUsageReview, usageBrief, REVIEW_DAYS } from './lib/usagereview.mjs';
import * as orchy from './lib/orchy.mjs';
import * as voice from './lib/voice.mjs';
import * as voiceAgents from './lib/voiceagents.mjs';
import * as calls from './lib/calls.mjs';
import { startScheduler } from './lib/scheduler.mjs';
import { clients, clientById, addClient, updateClient, rotateLink, removeClient, clientBase, askFields, CLIENT_PORT } from './lib/clients.mjs';
import { startPortal } from './portal.mjs';
import { saveUpload, uploadInfo, publicUpload, handToWorkspace, withFiles } from './lib/uploads.mjs';
import { taskFiles, taskFile, sendTaskFile, removeHome } from './lib/clientspace.mjs';
import { r2Status } from './lib/r2.mjs';
import * as mcpAuth from './lib/mcpauth.mjs';
import * as artifacts from './lib/artifacts.mjs';
import * as media from './lib/media.mjs';
import * as validate from './lib/validate.mjs';
import * as recover from './lib/recover.mjs';
import { checkDelegation } from './lib/delegation.mjs';
import * as liveJev from './lib/livejev.mjs';
import * as huddles from './lib/huddle.mjs';
import * as standingRules from './lib/rules.mjs';
import { COACH } from './lib/huddlecoach.mjs';
import * as backend from './lib/backend.mjs';
import { BACKEND_ID, backendWorkspace } from './lib/workspaces.mjs';
import { fixRouting, unroutedModel } from './lib/router.mjs';
import * as owner from './lib/owner.mjs';
import * as missions from './lib/missions.mjs';
import { openTaskDir } from './lib/tasks.mjs';

const PORT = Number(env('PORT', '8008'));
// scripts/restart.mjs hands the Orchy it starts a one-time token, so only it can report how the restart went.
// Taken out of the environment at once: nothing Orchy starts (agents above all) inherits it.
const RESTART_TOKEN = process.env.ORCHY_RESTART_TOKEN || '';
delete process.env.ORCHY_RESTART_TOKEN;

function openDashboard(url) {
  if (env('NO_OPEN') || process.argv.includes('--no-open')) return;
  const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  // no browser opener (a server, WSL, a minimal Linux): say where to go instead of failing
  const page = url.split('?')[0];
  spawn(opener[0], opener[1], { detached: true, stdio: 'ignore', windowsHide: true })
    .on('error', () => console.log(`  Couldn't open a browser here. Open ${page} yourself (use the pairing link above if one is shown).\n`))
    .unref();
}

// Orchy already running (e.g. Start Orchy double-clicked twice)? Open it and step aside before touching
// any state, so two copies never fight over state.json or start the same scheduled run.
if (await fetch(`http://127.0.0.1:${PORT}/api/voice/config`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok).catch(() => false)) {
  console.log(`
  Orchy is already running → http://localhost:${PORT} (opening it)
`);
  openDashboard(`http://localhost:${PORT}`);
  setTimeout(() => process.exit(0), 300);
  await new Promise(() => {}); // stop here
}

runner.setPort(PORT);
// npm run setup's answer about scripts, applied once; Settings → Scripts changes it after
const setupScripts = String(env('SETUP_SCRIPTS') || '').trim().toLowerCase();
if (setupScripts === 'on' || setupScripts === 'off') { db().settings.scriptsFree = setupScripts === 'on'; save(); setEnv('SETUP_SCRIPTS', ''); }
ensureInks(); // any workspace from before colours: each gets its own
const interrupted = runner.markInterruptedRuns(); // recover.boot offers the owner Resume / Start over on each
migrateChat();
for (const item of inbox.pending()) if (!runner.isLive(item.runId)) inbox.expireForRun(item.runId);
// a team agent's run reports to the head that handed it over; the head's report reaches the owner.
// A client's own run reports to nobody but the client: their page shows it, the owner's chat doesn't.
// Orchy's fix of his own code reports with what it changed, and restarts him when it needs to (backend.mjs).
// Before Orchy reports, he checks the run (validate.mjs: flags only) and names what went wrong (recover.mjs: a safe
// automatic retry, or a card for the owner); a run the owner just chose to stop and resume (`quietReport`) isn't reported again.
runner.onRunFinished(async (run, ws) => {
  try {
    if (run.backend) await reportFix(run, ws);
    // a mission's step reports to its mission (missions.mjs): it checks it, decides the next step, and Orchy speaks once at the end
    else if (run.missionId) { try { await missions.onRunEnded(run); } catch (e) { console.error('[mission]', e.message); } }
    else {
      if (validate.shouldValidate(run)) await validate.applyValidation(run);
      let rec = null;
      try { rec = recover.afterRun(run); } catch (e) { console.error('[recover]', e.message); }
      if (!run.delegatedBy && !(run.client && !run.ownerReply) && !run.quietReport) {
        if (rec?.quiet) orchy.say(rec.quiet, { runId: run.id, workspace: ws.id, kind: 'report', outcome: run.outcome, session: ensureSession(run.session, { text: run.instruction, origin: 'run' }).id, ...rec.meta });
        else await orchy.reportRun(run, ws, rec ? { tail: rec.tail, meta: rec.meta } : {});
      }
    }
  } finally {
    backend.maybeRestart(anyLive); // a restart a fix left waiting goes ahead once nothing is running
  }
});
// an account hit its session/usage limit: its runs pause and start again by themselves when the window resets
runner.onSessionLimit(({ ws, run, reason }) => {
  orchy.say(`${ws.name}'s ${runtimeLabel(run.runtime)} account hit its usage limit while ${rn(run)} was working (${reason}). I've paused it, and any runs waiting on that account wait too; they start again by themselves when the window resets, or you can press Run now.`, { runId: run.id, workspace: ws.id, session: run.session, error: true });
});
// recovery (recover.mjs): retries go through startRun (account check, ungated-engine refusal, gate), resumes through
// followUp; the stall timer runs here too (it never starts work, so a test copy with NO_SCHEDULER keeps it)
recover.start({
  startRun: opts => runner.startRun(opts), stopRun: rid => runner.stopRun(rid), isLive: rid => runner.isLive(rid),
  followUp: (rid, body) => followUp(rid, { ...body, shown: 'Resume where you left off' }), note: (rid, text) => runner.ownerNote(rid, text),
  who: r => rn(r), wsName: wid => { try { return workspace(wid).name; } catch { return wid; } },
  say: (text, meta = {}) => orchy.say(text, { ...meta, session: ensureSession(meta.session, { text: 'Recovery', origin: 'run' }).id }),
});
recover.boot(interrupted);
// missions (missions.mjs): every step through startRun (account check, ungated-engine refusal, gate), Orchy's lines in
// the mission's session; after a restart a mission with live steps waits for the owner (Resume / Stop), nothing starts on its own
missions.start({
  startRun: opts => runner.startRun(opts), stopRun: rid => runner.stopRun(rid), isLive: rid => runner.isLive(rid),
  say: (text, meta = {}) => orchy.say(text, { ...meta, session: ensureSession(meta.session, { text: 'Mission', origin: 'run' }).id }),
  openTaskDir: (ws, r) => openTaskDir(ws, r, null), handFiles: (ws, names) => handToWorkspace(ws, names),
  nameOf: (w, s) => { try { return voiceAgents.nameOf(w, s); } catch { return null; } },
  fallback: m => missionFallback(m),
});
missions.boot();
// a huddle's turns report to the huddle; Orchy speaks for it at the start, the agreement and a failure
huddles.initHuddles({ say: (text, meta) => orchy.say(text, meta) });
// each scheduled run opens its own session, so its report has somewhere to land.
// NO_SCHEDULER=1 (a test copy's .env) keeps a second Orchy from starting the same scheduled runs.
if (!env('NO_SCHEDULER')) startScheduler({
  liveCount: runner.liveCount, // slots wait while two or more runs are live
  startRun: async ({ label, ...opts }) => {
    const sid = id('s');
    // an AI Agent Builder's scheduled run (a weekly review) gets its agents' week, to propose slimming the costliest
    if (opts.agentSlug === BUILDER_SLUG) opts.instruction += usageBrief(opts.workspace);
    const run = await runner.startRun({ ...opts, session: sid });
    ensureSession(sid, { text: label, origin: 'schedule' });
    return run;
  },
  onStarted: (run, a, { lateMinutes = 0, slot, passed = [] } = {}) => orchy.say(lateMinutes
    ? `Starting ${a.displayName}'s ${slot} run in ${workspace(a.workspace).name} ${lateMinutes} minutes late: I wasn't running then (or the PC was asleep).${passed.length ? ` It also missed ${passed.join(', ')}; this one run covers those.` : ''}`
    : `Starting ${a.displayName}'s scheduled run in ${workspace(a.workspace).name} (${a.scheduleText}).`, { runId: run.id, workspace: a.workspace, kind: 'dispatch', session: run.session }),
  onError: (e, a) => orchy.say(`I couldn't start ${a.displayName}'s scheduled run: ${e.message}`, {
    error: true, workspace: a.workspace, session: ensureSession(null, { text: `${a.displayName} · scheduled`, origin: 'schedule' }).id,
  }),
});

// the weekly usage review (usagereview.mjs): Orchy suggests 3–5 savings in chat, in a session of its own
function reviewSay(text, meta) {
  return orchy.say(text, { ...meta, session: ensureSession(null, { text: 'Weekly usage review', origin: 'review' }).id });
}
if (!env('NO_SCHEDULER')) startUsageReview({ say: reviewSay });
// Resources/ (resources.mjs): new skills filed and linked, MCP copies and INDEX.md refreshed, agent homes made, at boot
// and every 10 minutes; skill folders only move in a workspace with nothing live. A test copy (NO_SCHEDULER) leaves
// the workspace folders be.
if (!env('NO_SCHEDULER')) {
  const syncRes = () => syncAllResources(workspaces().filter(w => w.enabled), { busy: ws => runner.liveIn(ws.id) });
  setTimeout(syncRes, 5_000).unref();
  setInterval(syncRes, 10 * 60_000).unref();
}

// ── routing proposals (Jev's pick, shown as a card before dispatch) ──
const proposals = new Map();
// Jev's routing of a message that became a mission (memory only): its card falls back to a task card with it
const missionRoutes = new Map();

/** Not a mission after all (missions.mjs: one agent can do it, the plan didn't hold up, no account, or the owner's
 *  choice): a task card for the same words, held for the owner's Send, with the planner's one agent picked when it named one. */
function missionFallback(m) {
  const ws = workspace(m.workspace);
  const slug = m.fallback?.agent && m.fallback.agent !== 'general' ? m.fallback.agent : null;
  const a = slug ? listAgents(ws.id).find(x => x.slug === slug && !x.isBuilder && !x.error) : null;
  const r = missionRoutes.get(m.id) || {};
  missionRoutes.delete(m.id);
  const routing = { ...r, intent: 'task', workspace: ws.id, agent: a?.slug || null, needsChoice: false, holdReason: null, askChat: false, autoDispatchSeconds: r.autoDispatchSeconds ?? config.routing.autoDispatchSeconds };
  const model = a?.engine ? modelFor(ws, a.model, a.engine) : unroutedModel(ws, a, m.text);
  const p = {
    id: id('route'), session: m.session, text: m.text, routing, viaVoice: !!m.viaVoice, status: 'proposed', createdAt: new Date().toISOString(), held: true, fromMission: m.id,
    ...(m.files?.length && { files: m.files }),
    choice: { intent: 'task', workspace: ws.id, agent: a?.slug || null, model },
  };
  proposals.set(p.id, p);
  orchy.say(`A plain task fits that better: ${m.fallback?.why || 'one agent can do it'}. Here it is as a task card; press Send when it looks right.`, { missionId: m.id, workspace: ws.id, kind: 'mission-ask', session: m.session });
  emit('routing.proposed', { proposal: publicProposal(p) });
}
// cards that are done (sent, answered, cancelled, failed) leave the Map about an hour later
setInterval(() => {
  for (const [pid, p] of proposals) {
    if (p.status === 'proposed' || p.status === 'dispatching') continue;
    p.doneAt ||= Date.now();
    if (Date.now() - p.doneAt > 3600_000) proposals.delete(pid);
  }
}, 15 * 60_000).unref();

// ── Orchy fixing himself (backend.mjs) ──
/** Is any run live, or about to start? (A restart would cut it off.) */
const anyLive = () => Object.values(db().runs).some(r => runner.isLive(r.id)) || [...proposals.values()].some(p => p.status === 'dispatching') || huddles.listHuddles(20).some(h => h.status === 'talking' || h.status === 'wrapping'); // between turns too

/** A fix finished: say what it changed, then restart (once nothing runs), offer a reload, or leave it to the owner. */
async function reportFix(run, ws) {
  const list = run.backendChanges || [];
  const restart = backend.needsRestart(list), reload = backend.needsReload(list);
  const files = list.map(({ file, change }) => ({ file, change }));
  const go = restart && run.outcome === 'completed';
  let restartState = null, tail = '';
  if (go) {
    restartState = anyLive() ? 'queued' : 'now';
    const running = Object.values(db().runs).filter(r => runner.isLive(r.id)).length;
    tail = restartState === 'now' ? 'Restarting myself now to load it; I’ll be back in a few seconds.'
      : `I’ll restart to load it once ${running === 1 ? 'the task that’s running finishes' : running ? `the ${running} running tasks finish` : 'what’s starting is done'}.`;
  } else if (restart) {
    restartState = 'offer';
    tail = 'It changed my server code without finishing, so I haven’t restarted: restart to try it, or undo it.';
  } else if (reload) tail = 'Reload the dashboard to see it.';
  run.fix = { files: files.length, restart: restartState, reload };
  save();
  emit('run.updated', { run: runner.publicRun(run) }); // its buttons read run.fix
  // the report is said first: a restart right away ends this process
  try {
    await orchy.reportRun(run, ws, { tail, meta: { fix: { runId: run.id, files: files.length, restart: restartState, reload: reload && !restart, undo: files.length > 0 } } });
  } finally {
    if (go) backend.queueRestart({ runId: run.id, session: run.session, files, reload, why: 'fix' }, anyLive);
  }
}

/** The owner's buttons on a fix's report: restart now, or after a stopped fix, or undo it. */
function fixRun(rid) {
  const run = runner.getRun(rid);
  if (!run.backend) throw Object.assign(new Error('That run wasn’t Orchy fixing himself'), { status: 400 });
  return run;
}
function sayRestarted(r) {
  if (!r || typeof r !== 'object') return;
  // Node's crash output: the error line, and the file and line it points at (not its version banner)
  const lines = String(r.error || '').split('\n').map(s => s.trim()).filter(Boolean);
  const what = lines.find(l => /^\w*Error\b|Error:|Cannot |EADDRINUSE/.test(l)) || lines.find(l => !/^Node\.js v|^at /.test(l)) || '';
  const where = lines.map(l => l.match(/([\w.-]+\.m?js):(\d+)/)).find(Boolean);
  const err = `${what}${where && !what.includes(where[0]) ? ` (${where[1]} line ${where[2]})` : ''}`.slice(0, 300);
  const text = r.stillDown ? `Last time I restarted after a fix I couldn't come back up, not even on my old code, so ${ownerName()} started me by hand.${err ? ` The error: ${err}` : ''}`
    : r.rolledBack ? `That fix stopped me from starting, so I put my code back the way it was before it and I'm running the old version.${err ? ` What broke: ${err}` : ''} Tell me and I'll try again.`
    : r.ok ? (r.why === 'undo' ? 'I’m back, on the code from before that fix.' : 'I’m back, with the fix loaded.') : `My restart didn't go as planned${err ? `: ${err}` : '.'}`;
  if (r.runId && db().runs[r.runId]) { db().runs[r.runId].fix = { ...db().runs[r.runId].fix, restart: r.rolledBack ? 'rolled-back' : r.ok ? 'done' : 'failed' }; save(); emit('run.updated', { run: runner.publicRun(db().runs[r.runId]) }); }
  orchy.say(text, { session: typeof r.session === 'string' && getSession(r.session) ? r.session : null, workspace: BACKEND_ID, error: !r.ok || !!r.rolledBack, ...(r.ok && r.reload ? { fix: { reload: true } } : {}), ...(r.runId && db().runs[r.runId] ? { runId: r.runId, kind: 'report' } : {}) });
}
// a restart a fix left waiting also goes ahead when a card or huddle that held it finishes without a run ending
setInterval(() => backend.maybeRestart(anyLive), 30_000).unref();

/** Is anything still going on in this session? (Busy sessions never auto-close.) */
const sessionBusy = sid => Object.values(db().runs).some(r => r.session === sid && runner.isLive(r.id))
  || [...proposals.values()].some(p => p.session === sid && p.status === 'proposed')
  || missions.listMissions(50).some(m => m.session === sid && ['planning', 'planned', 'running', 'waiting'].includes(m.status));
sweepSessions(sessionBusy);

/** A run started from a window (agent card, Build, follow-up) is said into a session like any other. */
function sayDispatched(run, ownerText, orchyText, files = []) {
  ensureSession(run.session, { text: ownerText, origin: 'window' });
  post('owner', ownerText, files.length ? { files: files.map(n => uploadInfo(n)).filter(Boolean).map(publicUpload) } : {}, run.session);
  orchy.say(orchyText, { runId: run.id, workspace: run.workspace, kind: 'dispatch', session: run.session });
}

function publicProposal(p) {
  const { timer, doneAt, ...rest } = p;
  return rest;
}

function scheduleAutoDispatch(p) {
  clearTimeout(p.timer);
  const secs = p.routing.autoDispatchSeconds;
  if (!secs || p.routing.needsChoice || p.held) return;
  p.dispatchAt = new Date(Date.now() + secs * 1000).toISOString();
  p.timer = setTimeout(() => dispatchProposal(p.id).catch(e => fail(p, e)), secs * 1000);
}

/** Jev's action plan for the card's current pick starts now, so the run finds it ready (actionplan.mjs). */
function warmProposalPlan(p) {
  const c = p.choice;
  if (c.intent === 'task' && c.workspace && !c.followUp) warmPlan({ wsId: c.workspace, agentSlug: c.agent, instruction: p.text });
}

function fail(p, e) {
  p.status = 'error';
  p.error = e.message;
  emit('routing.updated', { proposal: publicProposal(p) });
  orchy.say(`I couldn't dispatch that: ${e.message}`, { error: true, proposalId: p.id, session: p.session });
}

async function dispatchProposal(pid, overrides = {}) {
  const p = proposals.get(pid);
  if (!p) throw Object.assign(new Error('That routing card expired'), { status: 404 });
  if (p.status !== 'proposed') throw Object.assign(new Error(`Already ${p.status}`), { status: 409 });
  clearTimeout(p.timer);
  const choice = { ...p.choice, ...overrides };
  if (['workspace', 'agent', 'intent'].some(k => k in overrides)) choice.followUp = null;
  if (!choice.workspace) throw Object.assign(new Error('Pick a workspace first'), { status: 400 });
  p.status = 'dispatching';
  emit('routing.updated', { proposal: publicProposal(p) });
  // the owner turned the card into a mission (Do → Mission): Orchy plans it, and the mission card waits for Go
  if (choice.intent === 'mission') {
    let m;
    try { m = missions.propose({ text: p.text, workspace: choice.workspace, session: p.session, routing: { ...p.routing, missionSure: false }, files: p.files || [], viaVoice: p.viaVoice }); }
    catch (e) { Object.assign(p, { status: 'proposed', held: true, dispatchAt: null }); emit('routing.updated', { proposal: publicProposal(p) }); throw e; }
    missionRoutes.set(m.id, p.routing);
    p.status = 'dispatched';
    p.missionId = m.id;
    emit('routing.updated', { proposal: publicProposal(p) });
    return { mission: missions.publicMission(m) };
  }
  // a huddle: the agents talk it through first (huddle.mjs); Orchy says so in the session
  if (choice.intent === 'huddle') {
    const topic = p.files?.length ? withFiles(p.text, handToWorkspace(workspace(choice.workspace), p.files)) : p.text;
    const h = await huddles.startHuddle({ workspace: choice.workspace, agents: choice.huddle, topic, session: p.session }).catch(e => {
      if (p.status === 'dispatching') { Object.assign(p, { status: 'proposed', held: true, dispatchAt: null }); emit('routing.updated', { proposal: publicProposal(p) }); }
      throw e;
    });
    p.status = 'dispatched';
    p.huddleId = h.id;
    emit('routing.updated', { proposal: publicProposal(p) });
    return { huddle: h };
  }
  // continuing an earlier run (Jev read it as a follow-up): resume its conversation and task folder,
  // unless it has started again meanwhile, then it's a fresh run
  const prev = choice.followUp ? db().runs[choice.followUp] : null;
  const resume = prev && !runner.isLive(prev.id) ? { resumeSessionId: prev.sessionId, parentRunId: prev.id } : {};
  const fix = choice.intent === 'fix_orchy';
  // files the owner attached ride along (they're in Uploads already): copied into the workspace's own Uploads/,
  // or for more work on a client's task into that client's folder, like a follow-up from its run window
  const clientFiles = p.files?.length && resume.parentRunId && prev.client ? uploadInfos(p.files) : [];
  const paths = p.files?.length && !clientFiles.length ? handToWorkspace(fix ? backendWorkspace() : workspace(choice.workspace), p.files) : [];
  const run = await runner.startRun({
    workspace: fix ? BACKEND_ID : choice.workspace,
    agentSlug: fix ? null : choice.intent === 'build_agent' ? BUILDER_SLUG : choice.agent,
    kind: fix ? 'fix' : choice.intent === 'build_agent' ? 'build' : 'task',
    model: choice.model,
    instruction: withFiles(p.text, paths),
    ownerFiles: clientFiles,
    routing: { ...p.routing, overridden: p.overridden || Object.keys(overrides).length > 0 },
    session: p.session,
    ...resume,
  }).catch(e => {
    // the card stays open (held), so the owner can fix what's wrong and send it again
    if (p.status === 'dispatching') {
      Object.assign(p, { status: 'proposed', held: true, dispatchAt: null });
      emit('routing.updated', { proposal: publicProposal(p) });
    }
    throw e;
  });
  p.status = 'dispatched';
  p.runId = run.id;
  emit('routing.updated', { proposal: publicProposal(p) });
  const ws = workspace(choice.workspace);
  const n = p.files?.length || 0;
  const withYours = n ? `, with ${n > 1 ? `your ${n} files` : 'your file'}` : '';
  const pr = p.routing.probabilities || {};
  const routing = {
    text: p.text, workspace: choice.workspace, intent: choice.intent, agentLabel: run.agentName, model: run.model,
    source: p.routing.source, ms: p.routing.jev?.ms ?? null, overridden: !!(p.overridden || Object.keys(overrides).length), live: !!p.routing.live,
    client: Object.fromEntries(workspaces().filter(w => w.enabled).map(w => [w.id, pr.workspace?.[w.id] ?? null])),
    agentPct: pr.agent?.[`${choice.workspace}/${choice.agent || 'general'}`] ?? null,
  };
  orchy.say(fix
    ? (resume.parentRunId ? 'Back into my code where I left off. I’ll report when it’s done.' : `Opening up my own code to look at that, on ${run.model}. I’ll report back, and restart myself if the fix needs it.`)
    : resume.parentRunId
    ? `Sent to ${rn(run)} in ${ws.name} as a follow-up${withYours}: it picks up where it left off.`
    : choice.intent === 'build_agent'
    ? `Passing that to the Chief of AI Agents in ${ws.name}${withYours}. I'll shout if it needs you.`
    : `On it. ${rn(run)} in ${ws.name} has it${withYours}, running on ${run.model}.`, { runId: run.id, workspace: ws.id, kind: 'dispatch', speak: p.viaVoice, routing, session: p.session });
  return run;
}

// ── tiny HTTP helpers ──
function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
async function readBody(req) {
  // decoded once at the end, so a character split across chunks stays whole
  const chunks = [];
  let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 2_000_000) throw Object.assign(new Error('Body too large'), { status: 413 }); chunks.push(chunk); }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.wasm': 'application/wasm' };
// frames: the viewer's sandboxed HTML (same origin) and click-to-load players from these hosts only (viewer.mjs#embedOf)
const FRAME_SRC = "frame-src 'self' https://www.youtube-nocookie.com https://player.vimeo.com https://www.loom.com https://drive.google.com";
function serveFile(res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found');
  const ext = path.extname(file).toLowerCase();
  // scripts only from Orchy itself (the ElevenLabs worklets, the resampler's and pdf.js's WebAssembly and pdf.js's worker
  // included), so injected markup can't run code
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...(ext === '.html' && { 'Content-Security-Policy': `script-src 'self' 'wasm-unsafe-eval'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; ${FRAME_SRC}` }) });
  fs.createReadStream(file).pipe(res);
}
function safeJoin(base, rel) {
  const root = path.resolve(base);
  const p = path.resolve(root, '.' + path.sep + decodeURIComponent(rel));
  if (p !== root && !p.startsWith(root + path.sep)) throw Object.assign(new Error('Bad path'), { status: 400 });
  return p;
}

/** Engines this workspace's agents pin besides its own (e.g. a Codex designer in a Claude workspace), each with its account check. */
async function extraAccounts(ws, force) {
  const byEngine = {};
  for (const a of listAgents(ws.id)) if (a.engine && a.engine !== ws.runtime) (byEngine[a.engine] ||= []).push(a.displayName);
  return Promise.all(Object.entries(byEngine).map(async ([rt, agents]) => ({ ...(await accountCheck(ws, { force, runtime: rt })), agents })));
}

async function workspaceSummary(ws, { force = false } = {}) {
  const [account, extra] = await Promise.all([accountCheck(ws, { force }), extraAccounts(ws, force)]);
  return {
    id: ws.id, name: ws.name, client: ws.client, blurb: ws.blurb, color: ws.color || null, aliases: ws.aliases || [], handles: handles(ws), folder: ws.folder, departments: departmentsOf(ws),
    runtime: ws.runtime, runtimeLabel: runtimeLabel(ws.runtime), models: modelsFor(ws),
    availableModels: account.availableModels || null, plan: account.plan || account.subscription || null, tier: account.tier || null,
    enabled: ws.enabled,
    claudeAccount: ws.claudeAccount || null, codexAccount: ws.codexAccount || null, ownProfile: !!ws[engine(ws.runtime)?.fields.profile],
    // every registered engine's account and profile for this workspace, and whether it may run an engine Orchy can't gate
    accounts: Object.fromEntries(engines().map(e => [e.id, { account: ws[e.fields.account] || null, ownProfile: !!ws[e.fields.profile] }])), allowUngated: ws.allowUngated === true, gated: engine(ws.runtime)?.capabilities.gated !== false,
    account, extraAccounts: extra, oneScoped: oneScope(ws).own, oneLogin: oneLoginStatus(ws.id), oneAdd: oneAddStatus(ws.id), createdAt: ws.createdAt || null,
    mcpCount: Object.keys(readMcp(ws)).length,
  };
}
const retiredSummary = () => listRetired().map(r => ({ id: r.id, name: r.name, client: r.client, color: r.color || null, runtime: r.runtime || 'claude', runtimeLabel: runtimeLabel(r.runtime || 'claude'), archivedFolder: r.archivedFolder, retiredAt: r.retiredAt, dirExists: r.dirExists }));

const ENV_KEYS = ['TYPESAFE_API_KEY', 'TYPESAFE_MODEL', 'OPENROUTER_API_KEY', 'DEEPGRAM_API_KEY', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID', 'ELEVENLABS_MODEL', 'CLIENT_URL', 'CF_ACCESS_TEAM_DOMAIN', 'CF_ACCESS_AUD',
  'JEV_PROVIDER', 'AI_GATEWAY_API_KEY', 'OPENCODE_API_KEY', 'OPENCODE_JEV_MODEL', 'VOICE_ENABLED', 'VOICE_PROVIDER'];
const JEV_PROVIDERS = ['', 'typesafe', 'openrouter', 'vercel', 'opencode', 'off'];
const SECRET = k => /KEY$/.test(k);

// ── routes ──
const routes = [];
const on = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });

// replayable (bus.mjs): Last-Event-ID from the browser's own reconnect, or `?last=BOOT:seq` from a fresh EventSource
on('GET', '/api/events', (req, res) => attachSSE(req, res, { lastEventId: req.headers['last-event-id'] || new URL(req.url, 'http://x').searchParams.get('last') || '' }));

on('GET', '/api/state', async () => {
  sweepSessions(sessionBusy);
  const events = busCursor(); // taken first: the dashboard's stream replays whatever happens while this is built
  return {
    events,
    now: new Date().toISOString(),
    timezone: config.timezone,
    owner: { name: ownerName(), set: !!(config.owner?.name || '').trim(), hideBusinessNames: !!config.owner?.hideBusinessNames },
    workHours: config.workHours,
    settings: db().settings,
    liveJev: { ...liveJev.limits(), today: liveJev.readsToday(), minWords: liveJev.MIN_WORDS },
    voice: voice.voiceConfig(),
    jev: { mode: jevMode(), label: jevLabel() },
    workspaces: await Promise.all(workspaces().map(w => workspaceSummary(w))),
    retired: retiredSummary(),
    runtimes: runtimes(),
    approvalKinds: DECISIONS.map(({ key, label, hint }) => ({ key, label, hint })),
    agents: listAgents(),
    runs: runner.listRuns(60).map(runner.publicRun),
    inbox: inbox.pending(),
    sessions: listSessions(200).filter(s => !s.closed),
    chat: recentChat(),
    proposals: [...proposals.values()].filter(p => p.status === 'proposed').map(publicProposal),
    huddles: huddles.listHuddles(20),
    missions: missions.listMissions(20).map(missions.publicMission),
    backend: { id: BACKEND_ID, name: backendWorkspace().name, client: backendWorkspace().client, models: modelsFor(backendWorkspace()), pendingRestart: backend.pendingRestart()?.runId || null },
    envStatus: Object.fromEntries(ENV_KEYS.map(k => [k, SECRET(k) ? !!env(k) : env(k)])),
    clients: clients(),
    clientPages: clientPages(),
    voiceAgents: (() => { try { return voiceAgents.publicRoster(); } catch { return null; } })(),
    ringing: calls.ringing(),
  };
});

// Files the owner gives Orchy: the raw body is the file, X-File-Name its name. Saved in the Uploads folder.
on('POST', '/api/uploads', async (req) => {
  const name = decodeURIComponent(String(req.headers['x-file-name'] || ''));
  if (!name.trim()) throw Object.assign(new Error('The file has no name'), { status: 400 });
  return publicUpload(await saveUpload(req, name));
});
on('GET', '/api/uploads/:name', async (_req, res, { name }) => {
  const u = uploadInfo(decodeURIComponent(name));
  if (!u) throw Object.assign(new Error('That file is gone from Uploads'), { status: 404 });
  // only types that can't run script open in the tab; anything else (HTML, SVG…) downloads
  const type = UPLOAD_INLINE[path.extname(u.name).toLowerCase()];
  res.writeHead(200, {
    'Content-Type': type || 'application/octet-stream', 'Content-Length': u.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `${type ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(u.name)}`,
  });
  fs.createReadStream(u.file).pipe(res);
});
const UPLOAD_INLINE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8' };

// The owner says something in a session (the dashboard names a new one before its first message).
// Files attached go to Jev too: work for an agent gets a card and the files ride along to its workspace;
// a question about them (or files with no words) Orchy reviews himself.
on('POST', '/api/chat', async (req) => chat(await readBody(req)));
async function chat({ text, viaVoice, session: sid, files: names, live, pick: rawPick }) {
  const clean = String(text || '').trim();
  const files = (Array.isArray(names) ? names : []).slice(0, 10).map(n => {
    const u = uploadInfo(String(n));
    if (!u) throw Object.assign(new Error(`${n} isn't in Uploads any more. Attach it again.`), { status: 400 });
    return u;
  });
  if (!clean && !files.length) throw Object.assign(new Error('Say something first'), { status: 400 });
  const pick = livePick(rawPick);
  // Jev's read of this draft as the owner typed it (livejev.mjs): 'new' at home, else the session on screen.
  // The context fingerprint is taken before the owner's message lands in the session.
  const liveSid = live === 'new' ? null : getSession(live) ? live : undefined;
  const liveFp = liveSid !== undefined && !files.length ? liveJev.fingerprint(liveSid) : null;
  const session = ensureSession(sid, { text: clean || `Review ${files.map(f => f.name).join(', ')}` });
  const msg = post('owner', clean, { viaVoice: !!viaVoice, ...(files.length && { files: files.map(publicUpload) }) }, session.id);
  // a screenshot of what's wrong with Orchy, with "fix this": a fix card, the files riding along (else Orchy reviews them)
  const fixCard = files.length ? fixRouting(clean) : null;
  if (fixCard) {
    const p = { id: id('route'), session: session.id, text: clean, files: files.map(f => f.name), routing: fixCard, viaVoice: !!viaVoice, status: 'proposed', createdAt: new Date().toISOString(), messageId: msg.id, choice: { intent: 'fix_orchy', workspace: BACKEND_ID, agent: null, model: fixCard.model } };
    proposals.set(p.id, p);
    emit('routing.proposed', { proposal: publicProposal(p) });
    return { kind: 'proposal', proposal: publicProposal(p), session: session.id };
  }
  const review = () => {
    orchy.review(clean, files, { viaVoice, session, messageId: msg.id });
    return { kind: 'review', session: session.id };
  };
  if (files.length && !clean) return review();
  emit('orchy.state', { state: 'routing', session: session.id });
  let routing = null;
  // a read made at home only fits a brand-new session; one made in a session only fits that session
  const liveFits = liveFp != null && (liveSid ? liveSid === session.id : sessionChat(session.id, 2).length === 1);
  try {
    const read = liveFits ? await liveJev.take(liveSid, clean, liveFp) : null;
    if (read) routing = { ...read, live: true };
    else {
      const runs = earlierRuns(Object.values(db().runs), session.id);
      routing = await route(clean, { recent: sessionChat(session.id, 6), runs, files: files.map(f => f.name) });
    }
  } finally { emit('orchy.state', { state: 'idle', session: session.id }); }

  // The owner picked the client and agent on the live line under the chat box: that's the work, whatever Jev read
  if (pick) routing = { ...routing, intent: routing.intent === 'build_agent' ? 'build_agent' : 'task', needsChoice: false, holdReason: null, askChat: false };
  if (routing.intent === 'ignored') {
    const off = routing.switchedOff;
    orchy.say(`${off.name} is switched off, so I'm leaving that one alone. Switch it back on in Workspace if you want it done.`, { session: session.id, speak: !!viaVoice });
    return { kind: 'ignored', routing, session: session.id };
  }
  // the common status questions are answered from Orchy's records, without a Claude call (status.mjs)
  const quick = !files.length && quickStatus(routing);
  if (quick) {
    orchy.say(quick.text, { session: session.id, speak: !!viaVoice, kind: quick.runId ? 'report' : 'status', ...(quick.runId && { runId: quick.runId }) });
    return { kind: 'reply', routing, session: session.id, quick: true };
  }
  if (routing.intent === 'chat' || routing.intent === 'status') {
    if (files.length) return { ...review(), routing };
    orchy.reply(clean, { viaVoice, model: routing.effortScore > 1.5 ? 'sonnet' : config.orchy.chatModel, session, messageId: msg.id });
    return { kind: 'reply', routing, session: session.id };
  }
  // several agents of one workspace in a row (missions.mjs): Orchy plans it and the mission card shows the steps;
  // with no client picked it's an ordinary card that waits for the owner to pick one
  if (routing.intent === 'mission') {
    if (routing.workspace) {
      const m = missions.propose({ text: clean, workspace: routing.workspace, session: session.id, routing, files: files.map(f => f.name), viaVoice: !!viaVoice });
      missionRoutes.set(m.id, routing);
      return { kind: 'mission', mission: missions.publicMission(m), routing, session: session.id };
    }
    routing = { ...routing, intent: 'task' };
  }
  const p = {
    id: id('route'), session: session.id, text: clean, routing, viaVoice: !!viaVoice, status: 'proposed', createdAt: new Date().toISOString(), messageId: msg.id,
    ...(files.length && { files: files.map(f => f.name) }),
    choice: (!pick && followUpChoice(routing)) || { intent: routing.intent, workspace: routing.workspace, agent: routing.agent, model: routing.model, ...(routing.intent === 'huddle' ? { huddle: routing.huddle || [] } : {}) },
  };
  if (pick) {
    const build = routing.intent === 'build_agent';
    const ws = workspace(pick.workspace);
    const a = !build && pick.agent ? listAgents(ws.id).find(x => x.slug === pick.agent) : null;
    const model = routing.workspace === ws.id ? routing.model : remodel(routing.workspace ? workspace(routing.workspace) : null, ws, routing.model);
    p.choice = { intent: routing.intent, workspace: ws.id, agent: build ? BUILDER_SLUG : a?.slug || null, model: a?.engine ? modelFor(ws, a.model, a.engine) : modelFor(ws, model) };
    p.overridden = true;
  }
  proposals.set(p.id, p);
  // The owner saw Jev's pick under the chat box before pressing Enter: a sure pick starts now, no countdown
  const now = (routing.live || pick) && !routing.needsChoice && liveStartOn();
  if (now) p.dispatchAt = new Date().toISOString();
  else scheduleAutoDispatch(p);
  warmProposalPlan(p);
  emit('routing.proposed', { proposal: publicProposal(p) });
  if (now) dispatchProposal(p.id).catch(e => fail(p, e));
  return { kind: 'proposal', proposal: publicProposal(p), session: session.id };
}

const liveOn = () => db().settings.liveJev !== false;

/** The client (and agent) the owner picked on the live line: only a switched-on workspace and one of its own agents. */
function livePick(b) {
  if (!b || typeof b !== 'object' || !b.workspace) return null;
  const ws = workspaces().find(w => w.id === String(b.workspace));
  if (!ws?.enabled) throw Object.assign(new Error(`${ws ? ws.name : 'That workspace'} can't take work right now`), { status: 409 });
  const agent = b.agent ? String(b.agent) : null;
  if (agent && !listAgents(ws.id).some(a => a.slug === agent && !a.isBuilder)) throw Object.assign(new Error(`${agent} isn't one of ${ws.name}'s agents`), { status: 400 });
  return { workspace: ws.id, agent };
}
const liveStartOn = () => liveOn() && db().settings.liveStart !== false && db().settings.autoDispatch !== false;

// Jev reads the draft as the owner types (livejev.mjs). Nothing starts here: this only routes, and on a pause
// (`settle`) warms the action plan for a sure pick, so Enter finds it ready.
on('POST', '/api/chat/live', async (req) => {
  const b = await readBody(req);
  if (!liveOn()) return { off: true };
  const text = String(b.text || '').trim();
  const sid = b.session && getSession(b.session) ? b.session : null;
  if (b.settle) {
    const d = liveJev.peek(sid, text);
    const r = d?.routing;
    const fu = r && followUpChoice(r);
    if (r?.intent === 'task' && r.workspace && !r.needsChoice && !fu) warmPlan({ wsId: r.workspace, agentSlug: r.agent, instruction: d.raw });
    return { ok: true };
  }
  if (text.length > 4000) return { long: true };
  if (liveJev.wordCount(text) < liveJev.MIN_WORDS) return { short: true };
  // the slot this read sits in: the chat box hands it back on Enter (`live` in /api/chat)
  const slot = sid || 'new';
  const res = await liveJev.read(sid, text);
  if (!res.routing) return { ...res, slot, ...(res.capped && { limits: liveJev.limits() }) };
  const r = res.routing;
  const fu = followUpChoice(r);
  return {
    text,
    slot,
    routing: r,
    followUp: fu ? { runId: fu.followUp, workspace: fu.workspace, agent: fu.agent } : null,
    quick: !!quickStatus(r),
    startsNow: liveStartOn() && !r.needsChoice && r.source !== 'heuristic',
  };
});

/** Jev read the message as more work on an earlier run of this session: the card continues that run. */
function followUpChoice(routing) {
  const prev = routing.earlierRun && ['task', 'build_agent', 'fix_orchy'].includes(routing.intent) ? db().runs[routing.earlierRun.runId] : null;
  if (!prev || runner.isLive(prev.id)) return null;
  // "that didn't work" after Orchy fixed himself continues the fix; a fix never continues a client's run
  if (prev.backend) return routing.intent === 'build_agent' ? null : { intent: 'fix_orchy', workspace: BACKEND_ID, agent: null, model: prev.model, followUp: prev.id };
  if (routing.intent === 'fix_orchy' || !workspaces().find(w => w.id === prev.workspace)?.enabled) return null;
  // a client the owner named wins over Jev's reading
  if (routing.source === 'jev+mention' && routing.workspace !== prev.workspace) return null;
  return { intent: prev.isBuilder ? 'build_agent' : 'task', workspace: prev.workspace, agent: prev.isBuilder ? BUILDER_SLUG : prev.agentSlug, model: prev.model, followUp: prev.id };
}

// Sessions: History lists them all; closing one only takes it off the tabs
on('GET', '/api/sessions', async () => {
  const runs = Object.values(db().runs);
  return listSessions(200).map(s => {
    const mine = runs.filter(r => r.session === s.id);
    return { ...s, runs: mine.length, live: mine.some(r => runner.isLive(r.id)), workspaces: [...new Set(mine.map(r => r.workspace))] };
  });
});
on('GET', '/api/sessions/:id', async (_req, _res, { id: sid }) => {
  const s = getSession(sid);
  if (!s) throw Object.assign(new Error('That session is gone'), { status: 404 });
  return { session: publicSession(s), chat: sessionChat(sid, 200) };
});
on('PATCH', '/api/sessions/:id', async (req, _res, { id: sid }) => updateSession(sid, await readBody(req)));

on('PATCH', '/api/routing/:id', async (req, _res, { id: pid }) => {
  const p = proposals.get(pid);
  if (!p || p.status !== 'proposed') throw Object.assign(new Error('That routing card is no longer open'), { status: 404 });
  const body = await readBody(req);
  // fixing Orchy is its own kind of work: picking it (or Orchy as the client) sets both; a client or another kind leaves it
  if (body.intent === 'fix_orchy' || body.workspace === BACKEND_ID) Object.assign(body, { intent: 'fix_orchy', workspace: BACKEND_ID, agent: null, ...('model' in body ? {} : { model: 'opus' }) });
  else if (p.choice.intent === 'fix_orchy' && (body.intent || body.workspace)) Object.assign(body, { intent: body.intent || 'task', workspace: body.workspace || null });
  if (p.choice.intent === 'fix_orchy' && body.intent !== 'fix_orchy' && !('model' in body) && body.workspace) body.model = remodel(backendWorkspace(), workspace(body.workspace), p.choice.model);
  if (body.workspace && !workspace(body.workspace).enabled) throw Object.assign(new Error(`${workspace(body.workspace).name} is switched off`), { status: 409 });
  const before = p.choice.workspace;
  for (const k of ['intent', 'workspace', 'agent', 'model']) if (k in body) p.choice[k] = body[k];
  // a huddle: the owner picks its agents on the card, two or more (another workspace starts them over)
  if (Array.isArray(body.huddle)) p.choice.huddle = [...new Set(body.huddle.map(String).filter(Boolean))];
  if (p.choice.intent === 'huddle' && (!Array.isArray(p.choice.huddle) || (body.workspace && body.workspace !== before && !Array.isArray(body.huddle)))) p.choice.huddle = [];
  // building an agent is the Builder's job; a task is never the Builder's
  if (body.intent === 'build_agent') p.choice.agent = BUILDER_SLUG;
  else if (body.intent === 'task' && p.choice.agent === BUILDER_SLUG) p.choice.agent = null;
  // a different client, agent or kind of work is a new task; "Start fresh" on the card says so outright
  if ('followUp' in body || ['intent', 'workspace', 'agent'].some(k => k in body)) p.choice.followUp = null;
  if (body.workspace && p.choice.agent) {
    const a = listAgents(body.workspace).find(x => x.slug === p.choice.agent);
    if (!a) p.choice.agent = p.choice.intent === 'build_agent' ? BUILDER_SLUG : null;
  }
  // a different engine has different models: keep the same strength
  if (body.workspace && body.workspace !== before && !('model' in body)) {
    p.choice.model = remodel(before ? workspace(before) : null, workspace(body.workspace), p.choice.model);
  }
  // an agent pinned to its own engine brings its own model; switching back off it returns to the workspace's engine
  if (p.choice.workspace && ('agent' in body || body.workspace) && !('model' in body)) {
    const wsNow = workspace(p.choice.workspace);
    const a = p.choice.agent ? listAgents(wsNow.id).find(x => x.slug === p.choice.agent) : null;
    p.choice.model = a?.engine ? modelFor(wsNow, a.model, a.engine) : modelFor(wsNow, p.choice.model);
  }
  p.overridden = true;
  p.held = true;
  clearTimeout(p.timer);
  p.dispatchAt = null;
  warmProposalPlan(p);
  emit('routing.updated', { proposal: publicProposal(p) });
  return publicProposal(p);
});
on('POST', '/api/routing/:id/dispatch', async (req, _res, { id: pid }) => runner.publicRun(await dispatchProposal(pid, await readBody(req))));

// Missions (missions.mjs): the card's edits while it waits, and the owner's answers (go, hold, stop, as-task, and an
// open ask's accept / followup / skip / retry / reassign / replan / use-replan / keep-plan / raise / continue / resume).
// The changes are owner-only like every other mutating route (ownerOnly); every step still starts through startRun.
on('GET', '/api/missions', async () => missions.listMissions(30).map(missions.publicMission));
on('GET', '/api/missions/:id', async (_req, _res, { id: mid }) => {
  const m = missions.getMission(mid);
  if (!m) throw Object.assign(new Error('That mission is gone'), { status: 404 });
  return missions.publicMission(m);
});
on('PATCH', '/api/missions/:id', async (req, _res, { id: mid }) => missions.publicMission(missions.patch(mid, await readBody(req))));
on('POST', '/api/missions/:id/act', async (req, _res, { id: mid }) => {
  const b = await readBody(req);
  const action = String(b.action || '');
  if (!missions.ACTIONS.includes(action)) throw Object.assign(new Error(`Unknown choice "${action.slice(0, 40)}"`), { status: 400 });
  const m = await missions.act(mid, { action, agent: b.agent ? String(b.agent).slice(0, 80) : null, text: String(b.text || '').slice(0, 4000) });
  return missions.publicMission(m);
});
// "Just answer": the owner meant a question after all (a card Jev held between chat and task)
on('POST', '/api/routing/:id/answer', async (_req, _res, { id: pid }) => {
  const p = proposals.get(pid);
  if (!p || p.status !== 'proposed') throw Object.assign(new Error('That routing card is no longer open'), { status: 404 });
  clearTimeout(p.timer);
  // files on the card: answering means Orchy opens them himself
  const files = uploadInfos(p.files);
  p.status = 'answered';
  emit('routing.updated', { proposal: publicProposal(p) });
  if (files.length) orchy.review(p.text, files, { viaVoice: p.viaVoice, session: ensureSession(p.session), messageId: p.messageId });
  else orchy.reply(p.text,{ viaVoice: p.viaVoice, model: config.orchy.chatModel, session: ensureSession(p.session), messageId: p.messageId, direct: true });
  return publicProposal(p);
});
on('POST', '/api/routing/:id/cancel', async (_req, _res, { id: pid }) => {
  const p = proposals.get(pid);
  if (!p) throw Object.assign(new Error('Gone'), { status: 404 });
  clearTimeout(p.timer);
  p.status = 'cancelled';
  emit('routing.updated', { proposal: publicProposal(p) });
  return publicProposal(p);
});

// Orchy fixing himself: the buttons on a fix's report, and scripts/restart.mjs saying how a restart went
on('POST', '/api/backend/:id/restart', async (_req, _res, { id: rid }) => {
  const run = fixRun(rid);
  if (runner.isLive(run.id)) throw Object.assign(new Error('The fix is still running'), { status: 409 });
  const p = backend.pendingRestart();
  if (p && p.runId !== run.id) throw Object.assign(new Error('Another fix is waiting to restart Orchy; restart from that one'), { status: 409 });
  if (!p && run.fix?.restart !== 'offer') throw Object.assign(new Error('Orchy already restarted with that fix'), { status: 409 });
  if (run.undoneAt) throw Object.assign(new Error('That fix was undone'), { status: 409 });
  const files = (run.backendChanges || []).map(({ file, change }) => ({ file, change }));
  run.fix = { ...run.fix, restart: 'now' };
  save();
  emit('run.updated', { run: runner.publicRun(run) });
  orchy.say(`Restarting myself now${anyLive() ? ', which stops what’s running' : ''}. Back in a few seconds.`, { session: run.session, workspace: BACKEND_ID });
  backend.restartNow(p || { runId: run.id, session: run.session, files, reload: backend.needsReload(files), why: 'fix' });
  return { ok: true };
});
on('POST', '/api/backend/:id/undo', async (_req, _res, { id: rid }) => {
  const run = fixRun(rid);
  if (runner.isLive(run.id)) throw Object.assign(new Error('The fix is still running: stop it first'), { status: 409 });
  const { restart, reload } = backend.undo(run);
  run.undoneAt = new Date().toISOString();
  if (backend.pendingRestart()?.runId === run.id) backend.cancelRestart();
  save();
  emit('run.updated', { run: runner.publicRun(run) });
  const n = run.backendChanges.length;
  // only code this Orchy loaded needs a restart to drop (a restart still waiting was just cancelled)
  const restarted = restart && (run.fix?.restart === 'now' || run.fix?.restart === 'done');
  orchy.say(`Undone: ${n} file${n === 1 ? ' is' : 's are'} back the way ${n === 1 ? 'it was' : 'they were'} before that fix. ${restarted ? (anyLive() ? 'I’ll restart once nothing is running.' : 'Restarting myself now.') : reload ? 'Reload the dashboard to see it.' : ''}`.trim(),
    { session: run.session, workspace: BACKEND_ID, ...(reload && !restarted ? { fix: { reload: true } } : {}) });
  // the old code was running fine before the fix: nothing to roll back to if this restart fails
  if (restarted) backend.queueRestart({ runId: null, session: run.session, files: [], reload, why: 'undo' }, anyLive);
  return { ok: true };
});
// scripts/restart.mjs telling the new Orchy how his restart went
on('POST', '/api/backend/restarted', async (req) => {
  const t = Buffer.from(String(req.headers['x-orchy-restart'] || ''));
  if (!RESTART_TOKEN || t.length !== RESTART_TOKEN.length || !crypto.timingSafeEqual(t, Buffer.from(RESTART_TOKEN))) throw Object.assign(new Error('Bad restart token'), { status: 401 });
  sayRestarted(await readBody(req));
  return { ok: true };
});

// Workspaces & connections
on('GET', '/api/workspaces/:ws', async (req, _res, { ws: wsId }) => {
  const ws = workspace(wsId);
  const force = new URL(req.url, 'http://x').searchParams.has('refresh');
  const [summary, conns, ident] = await Promise.all([workspaceSummary(ws, { force }), allConnections(ws, { force }), identity(ws)]);
  return { ...summary, connections: conns, identity: ident, loginHint: loginHint(ws) };
});
on('GET', '/api/workspaces/:ws/connections', async (req, _res, { ws: wsId }) => allConnections(workspace(wsId), { force: new URL(req.url, 'http://x').searchParams.has('refresh') }));
// MCP servers: their values (env, headers, arguments, the URL past its host, any other field) only go to a browser
// the owner paired; any other gets names and shape. Changing, removing and testing one are owner-only like every non-GET.
// A remote server's sign-in state (signed in or not, waiting, the last error) shows to any browser: never its token,
// which stays in orchestrator/data/mcp-auth.json (mcpauth.mjs).
on('GET', '/api/workspaces/:ws/mcp', async (req, _res, { ws: wsId }) => {
  const ws = workspace(wsId);
  const servers = readMcp(ws);
  const shown = shownMcp(servers, owner.isOwner(req, PORT));
  return Object.fromEntries(Object.entries(shown).map(([n, s]) => [n, servers[n]?.url && s && typeof s === 'object' ? { ...s, auth: mcpAuth.authStatus(ws, n, servers[n]) } : s]));
});
on('PUT', '/api/workspaces/:ws/mcp/:name', async (req, _res, { ws: wsId, name }) => {
  const def = upsertMcp(workspace(wsId), decodeURIComponent(name), await readBody(req));
  emit('connections.changed', { workspace: wsId });
  return def;
});
on('DELETE', '/api/workspaces/:ws/mcp/:name', async (_req, _res, { ws: wsId, name }) => {
  removeMcp(workspace(wsId), decodeURIComponent(name));
  mcpAuth.forget(workspace(wsId), decodeURIComponent(name));
  emit('connections.changed', { workspace: wsId });
  return { ok: true };
});
on('POST', '/api/workspaces/:ws/mcp-test', async (req, _res, { ws: wsId }) => {
  const { name, auth: _auth, ...def } = await readBody(req);
  const ws = workspace(wsId);
  // a saved server's own sign-in rides along (only for the URL it was made for)
  const r = await testMcp(typeof name === 'string' && name ? await mcpAuth.withAuth(ws, name, def) : def);
  // signed in through Claude Code: runs use that token, but Orchy never holds it, so its own Test can't
  if (r.needsLogin && name && mcpAuth.claudeSignedIn(ws, name, def.url)) return { ok: false, viaClaude: true, error: 'signed in through Claude Code, which the agents’ runs use. Orchy never holds that token, so this Test can’t check it; a task that uses it will.' };
  return r;
});
// OAuth sign-in for a remote MCP server with no API key: opens the owner's browser; the window updates when it's done
on('POST', '/api/workspaces/:ws/mcp/:name/login', async (_req, _res, { ws: wsId, name }) => {
  const ws = workspace(wsId), n = decodeURIComponent(name);
  const def = readMcp(ws)[n];
  if (!def) throw Object.assign(new Error(`No MCP server called ${n}`), { status: 404 });
  let r;
  try { r = await mcpAuth.startLogin(ws, n, def, { onDone: () => emit('connections.changed', { workspace: wsId }) }); }
  catch (e) {
    // a service that only lets approved apps register: sign the workspace's own Claude Code account in instead
    if (e.code !== 'register-refused' || !ws.claudeAccount) throw Object.assign(e, { status: e.status || 400 });
    r = mcpAuth.openClaudeLogin(ws, n, def);
  }
  emit('connections.changed', { workspace: wsId });
  return { status: r.status };
});

// ── Adding, switching off and retiring workspaces ("agents" to the owner) ──
const wsChanged = async (wsId, extra = {}) => emit('workspaces.changed', {
  workspaces: await Promise.all(workspaces().map(w => workspaceSummary(w))), retired: retiredSummary(), changed: wsId, ...extra,
});
const liveIn = wsId => Object.values(db().runs).filter(r => r.workspace === wsId && runner.isLive(r.id));

// What the Add window needs: engines on this PC and who their default profiles are signed in as.
on('GET', '/api/runtimes', async () => {
  const have = runtimeAvailability();
  const cfg = runtimes();
  // an opt-in engine the owner hasn't switched on (engineOffered) only shows for a workspace already on it
  const shown = engines().filter(e => cfg[e.id]?.offered !== false || workspaces().some(w => w.runtime === e.id));
  const rows = await Promise.all(shown.map(async e => {
    // only an engine that runs here is asked who its default profile is signed in as
    const a = have[e.id]?.available ? await e.account(null).catch(() => null) : null;
    // one sign-in per computer: the account the other workspaces on it already use comes first
    const shared = e.sharedLogin ? workspaces().map(w => w[e.fields.account]).find(Boolean) || null : null;
    return [e.id, {
      ...cfg[e.id],
      available: !!have[e.id]?.available,
      version: have[e.id]?.available ? e.version?.() || null : null,
      defaultAccount: shared || a?.email || a?.label || null,
      loggedIn: !!a?.loggedIn,
      plan: a?.plan || a?.subscriptionType || a?.subscription || null,
      tier: a?.tier || null,
      availableModels: Array.isArray(a?.models) && a.models.length ? a.models : null,
      sandbox: a?.sandbox || null,
    }];
  }));
  return Object.fromEntries(rows);
});
on('POST', '/api/workspaces/check-name', async (req) => ({ folder: checkFolderName((await readBody(req)).name) }));

// Add: register it, create and configure its folder, and have Orchy say what's left (accounts).
on('POST', '/api/workspaces', async (req) => {
  const b = await readBody(req);
  const ws = addWorkspace(b);
  let made;
  try { made = scaffoldWorkspace(ws); }
  catch (e) { updateWorkspace(ws.id, { enabled: false }); throw Object.assign(new Error(`Registered ${ws.name} but couldn't finish its folder: ${e.message}`), { status: 500 }); }
  const summary = await workspaceSummary(ws, { force: true });
  await wsChanged(ws.id, { added: true });
  const sid = ensureSession(b.session, { text: `Set up ${ws.name}`, origin: 'window' }).id;
  post('owner', `Add a new agent: ${ws.name}${ws.client !== ws.name ? ` (client ${ws.client})` : ''}, on ${runtimeLabel(ws.runtime)}.`, {}, sid);
  const todo = [!summary.account.ok && (summary.account.accountModel === 'profile' ? `log its ${runtimeLabel(ws.runtime)} profile in to a provider` : `log its ${runtimeLabel(ws.runtime)} profile in as ${summary.account.expected}`), 'sign it in to its own One account'].filter(Boolean);
  orchy.say(`${ws.name} is set up in ${ws.folder}: instructions, its own Chief of AI Agents, and a spot for its connections. It runs on ${runtimeLabel(ws.runtime)}${summary.account.ok ? ` as ${summary.account.actual}` : ''}${ws.allowUngated ? ', WITHOUT Orchy’s approvals (you allowed that)' : ''}. Before it can work: ${todo.join(' and ')}. Both are one click in its setup card.`, { workspace: ws.id, session: sid });
  return { workspace: summary, made, session: sid };
});

// Switch on/off, or change engine, account, client or what it's for.
on('PATCH', '/api/workspaces/:ws', async (req, _res, { ws: wsId }) => {
  const b = await readBody(req);
  const wasOn = workspace(wsId).enabled;
  const ws = updateWorkspace(wsId, b);
  if (b.runtime) ensureInstructions(ws);
  if (ws.enabled !== wasOn) voiceRefresh(true); // Orchy's voice team only lists agents of switched-on workspaces
  if ('enabled' in b && !ws.enabled) {
    // anything Jev was about to send there now waits for the owner to pick another client
    for (const p of proposals.values()) {
      if (p.status !== 'proposed' || p.choice.workspace !== wsId) continue;
      clearTimeout(p.timer);
      Object.assign(p, { held: true, dispatchAt: null });
      p.choice.workspace = null;
      p.routing = { ...p.routing, needsChoice: true };
      emit('routing.updated', { proposal: publicProposal(p) });
    }
  }
  await wsChanged(wsId);
  const live = liveIn(wsId).length;
  return { workspace: await workspaceSummary(ws, { force: true }), liveRuns: live };
});

// The owner dragged a tab: the new order goes to config.json and every open window follows.
on('PUT', '/api/workspaces-order', async (req) => {
  reorderWorkspaces((await readBody(req)).order);
  await wsChanged(null);
  return { order: workspaces().map(w => w.id) };
});

on('POST', '/api/workspaces/:ws/retire', async (req, _res, { ws: wsId }) => {
  const ws = workspace(wsId);
  const { confirm } = await readBody(req);
  if (String(confirm || '').trim().toLowerCase() !== ws.name.toLowerCase()) throw Object.assign(new Error(`Type "${ws.name}" to confirm`), { status: 400 });
  if (liveIn(wsId).length) throw Object.assign(new Error(`${ws.name} has work running. Stop it (or let it finish) first.`), { status: 409 });
  for (const p of proposals.values()) if (p.status === 'proposed' && p.choice.workspace === wsId) { clearTimeout(p.timer); p.status = 'cancelled'; emit('routing.updated', { proposal: publicProposal(p) }); }
  const r = await retireWorkspace(wsId);
  await wsChanged(wsId, { retired: retiredSummary() });
  if (r.clientsOff?.length) clientsChanged(); // its client links are switched off with it
  voiceRefresh(true);
  orchy.say(`${ws.name} is retired. Its folder is in Retired/${r.archivedFolder}, and I won't send it anything. You can bring it back from the Workspaces window.`, { session: null });
  return r;
});
on('GET', '/api/workspaces-retired', async () => retiredSummary());
on('POST', '/api/workspaces-retired/:ws/restore', async (_req, _res, { ws: wsId }) => {
  const ws = await restoreWorkspace(wsId);
  await wsChanged(wsId);
  voiceRefresh(true);
  return workspaceSummary(ws, { force: true });
});
on('DELETE', '/api/workspaces-retired/:ws', async (req, _res, { ws: wsId }) => {
  const r = listRetired().find(x => x.id === wsId);
  if (!r) throw Object.assign(new Error('Nothing retired by that name'), { status: 404 });
  const { confirm } = await readBody(req);
  if (String(confirm || '').trim().toLowerCase() !== r.name.toLowerCase()) throw Object.assign(new Error(`Type "${r.name}" to confirm`), { status: 400 });
  const p = purgeRetired(wsId);
  mcpAuth.forgetWorkspace(wsId); // its MCP sign-ins go with it
  if (p?.clientsRemoved?.length) clientsChanged();
  db().rules = db().rules.filter(x => x.workspace !== wsId);
  save();
  await wsChanged(wsId);
  return { ok: true };
});

// Accounts: open a login window for its profile, or sign the folder in to its own One account.
on('POST', '/api/workspaces/:ws/login', async (req, _res, { ws: wsId }) => {
  const { runtime } = await readBody(req); // which engine's profile (an agent can pin one besides the workspace's)
  openLoginWindow(workspace(wsId), runtime || undefined);
  return { ok: true };
});
on('POST', '/api/workspaces/:ws/one-login', async (_req, _res, { ws: wsId }) => {
  const ws = workspace(wsId);
  const st = startOneLogin(ws, {
    onDone: async s => {
      await wsChanged(wsId);
      emit('connections.changed', { workspace: wsId });
      if (s.status === 'done') orchy.say(`${ws.name} is signed in to One${s.account?.user ? ` as ${s.account.user}${s.account.org ? ` (${s.account.org})` : ''}` : ''}. Add its apps from Connect → Add app.`, { workspace: wsId, session: null });
    },
  });
  await wsChanged(wsId);
  return st;
});
// Connect an app (Gmail, Slack, …) to a workspace's own One account, from the dashboard.
// The app list comes from the workspace's own One login, run in its own folder: never Orchy's, never another workspace's
on('GET', '/api/workspaces/:ws/one/platforms', async (_req, _res, { ws: wsId }) => {
  const ws = workspace(wsId);
  if (!oneScope(ws).own) throw Object.assign(new Error(`Sign in to One for this workspace first (Connections → ${ws.name} → Sign in to One).`), { status: 409, code: 'one-signin' });
  return listPlatforms(ws.dir);
});
on('POST', '/api/workspaces/:ws/one-add', async (req, _res, { ws: wsId }) => {
  const ws = workspace(wsId);
  const { platform } = await readBody(req);
  const st = await startOneAdd(ws, platform, {
    onDone: async s => {
      await wsChanged(wsId);
      emit('connections.changed', { workspace: wsId });
      if (s.status === 'done') orchy.say(`${s.added.map(c => c.name).join(' and ')} ${s.added.length === 1 ? 'is' : 'are'} connected to ${ws.name}. Its Chief of AI Agents can hand ${s.added.length === 1 ? 'it' : 'them'} to agents now.`, { workspace: wsId, session: null });
    },
  });
  await wsChanged(wsId);
  return st;
});

// Agents
on('GET', '/api/agents', async () => listAgents());
on('GET', '/api/agents/:ws/:slug', async (_req, _res, { ws, slug }) => getAgent(ws, slug));
on('PUT', '/api/agents/:ws/:slug', async (req, _res, { ws, slug }) => {
  const { markdown } = await readBody(req);
  const a = saveAgent(ws, slug, markdown);
  emit('agent.updated', { workspace: ws, slug });
  return a;
});
on('DELETE', '/api/agents/:ws/:slug', async (_req, _res, { ws, slug }) => {
  deleteAgent(ws, slug);
  emit('agent.retired', { workspace: ws, slug });
  return { ok: true };
});
on('POST', '/api/agents/:ws/build', async (req, _res, { ws }) => {
  const { instruction, model } = await readBody(req);
  if (!instruction?.trim()) throw Object.assign(new Error('Tell the Chief what to build'), { status: 400 });
  const run = await runner.startRun({ workspace: ws, kind: 'build', model: model || 'opus', instruction, session: id('s') });
  const name = workspace(ws).name;
  sayDispatched(run, `Build an agent in ${name}: ${instruction.trim()}`, `Passing that to the Chief of AI Agents in ${name}. I'll shout if it needs you.`);
  return run;
});
on('POST', '/api/agents/:ws/:slug/run', async (req, _res, { ws, slug }) => runAgent(ws, slug, await readBody(req)));
async function runAgent(ws, slug, { instruction, model, files }) {
  const text = String(instruction || '').trim();
  if (!text && !files?.length) throw Object.assign(new Error('Give the agent a task'), { status: 400 });
  // files the owner attached go into the workspace's own Uploads/, where the agent can open them
  const paths = handToWorkspace(workspace(ws), files);
  const run = await runner.startRun({ workspace: ws, agentSlug: slug === 'general' ? null : slug, model, instruction: withFiles(text, paths), session: id('s') });
  sayDispatched(run, `${rn(run)}: ${text || `${paths.length} file${paths.length > 1 ? 's' : ''}`}`, `On it. ${rn(run)} in ${workspace(ws).name} has it${paths.length ? `, with ${paths.length > 1 ? `your ${paths.length} files` : 'your file'}` : ''}, running on ${run.model}.`, files);
  return run;
}

// Client access: a private link per client to chosen agents of one workspace (served by portal.mjs).
// A link's secret is shown once, when it's made; a lost link is replaced.
function clientPages() {
  const base = clientBase();
  // client video plays only through R2 links (r2.mjs); the Clients window says when it's off
  return { port: CLIENT_PORT(), base, online: /^https:\/\//.test(base), video: r2Status().on };
}
const clientsChanged = () => emit('clients.changed', { clients: clients(), clientPages: clientPages() });
on('GET', '/api/clients', async () => clients());
on('POST', '/api/clients', async (req) => {
  const r = addClient(await readBody(req));
  clientsChanged();
  orchy.say(`${r.client.name} has a client link now, for ${r.client.agents.map(s => getAgent(r.client.workspace, s).displayName).join(' and ')} in ${workspace(r.client.workspace).name}.`, { workspace: r.client.workspace, session: null });
  return r;
});
on('PATCH', '/api/clients/:id', async (req, _res, { id: cid }) => {
  const c = updateClient(cid, await readBody(req));
  // an agent no longer shared (or calls switched off): the client's voice agents for it go
  voiceAgents.removeClientVoices(cid, c.calls === false ? [] : c.agents).catch(e => console.warn('[voice] client voices not removed:', e.message));
  clientsChanged();
  return c;
});
on('POST', '/api/clients/:id/link', async (_req, _res, { id: cid }) => {
  const r = rotateLink(cid);
  clientsChanged();
  return r;
});
on('DELETE', '/api/clients/:id', async (req, _res, { id: cid }) => {
  const c = clientById(cid);
  if (!c) throw Object.assign(new Error('No such client'), { status: 404 });
  if (Object.values(db().runs).some(r => r.client === cid && runner.isLive(r.id))) throw Object.assign(new Error(`${c.name} has a task running. Stop it first.`), { status: 409 });
  // a retired workspace's folder is in Retired/ now: the client's files stay there with it
  const ws = workspaces().find(w => w.id === c.workspace);
  removeClient(cid);
  // ?files=delete: their folder (tasks, uploads, what the agents made) goes too
  try { if (ws && new URL(req.url, 'http://x').searchParams.get('files') === 'delete') removeHome(ws, cid); }
  finally {
    voiceAgents.removeClientVoices(cid).catch(e => console.warn('[voice] client voices not removed:', e.message));
    clientsChanged();
  }
  return { ok: true };
});
// Orchy drafts the client's brief from the workspace's notes; the owner reads and edits it before it's saved (PATCH brief)
on('POST', '/api/clients/:id/brief-draft', async (_req, _res, { id: cid }) => {
  const c = clientById(cid);
  if (!c) throw Object.assign(new Error('No such client'), { status: 404 });
  return { draft: await draftBrief(c) };
});
async function draftBrief(c) {
  const ws = workspace(c.workspace);
  // drafted on the workspace's own Claude account, never the PC's default one
  const acct = await accountCheck(ws, { runtime: 'claude' });
  if (!acct.ok) {
    const fix = acct.error && /install/i.test(acct.error) ? acct.error : `In PowerShell: ${acct.fix}`;
    throw Object.assign(new Error(!acct.expected
      ? `${ws.name} has no Claude Code account set, so I can't draft its brief. Write it yourself, or set its Claude account first.`
      : acct.loggedIn
      ? `${ws.name} must use ${acct.expected} on Claude Code, but its profile is logged in as ${acct.actual || 'another account'}. Not drafting. ${fix}`
      : `${ws.name}'s Claude Code profile isn't logged in yet (needs ${acct.expected}). ${fix}`), { status: 409, code: 'ACCOUNT_MISMATCH' });
  }
  let notes = '';
  try { notes = fs.readFileSync(path.join(ws.dir, 'CLAUDE.md'), 'utf8').slice(0, 30_000); } catch {}
  const agents = c.agents.map(s => { try { const a = getAgent(ws.id, s); return `- ${a.displayName}: ${a.description}`; } catch { return null; } }).filter(Boolean).join('\n');
  const prompt = `Write a short brief (at most 200 words, plain Markdown bullets) for AI agents that work directly for ${c.name}, a client of ${ownerName()}'s business (${ws.client}). ${c.name} starts tasks from their own page; the agents shared with them:
${agents}

Use only facts from the workspace notes below that help those agents serve ${c.name}: who ${c.name} is, their business, preferences, tone, and how their accounts and data are organised.
Leave out everything else, because ${c.name} may see what the agents say: ${ownerName()}'s other clients or workspaces, Orchy and how it works, other people's email addresses, file paths and folders, credentials or keys, ${ownerName()}'s private opinions or notes about ${c.name}, internal pricing, and any instruction about how agents should treat ${ownerName()}.
If the notes hold nothing useful, write a two-line brief from the agent list alone. Reply with the brief only.

<workspace_notes>
${notes || '(none)'}
</workspace_notes>`;
  const { text } = await quickClaude({ prompt, model: 'sonnet', configDir: ws.claudeConfigDir || null, timeoutMs: 120_000, purpose: 'brief', workspace: ws.id });
  return text.trim().slice(0, 6000);
}

// Runs
on('GET', '/api/runs', async () => runner.listRuns(100).map(runner.publicRun));
on('GET', '/api/runs/:id', async (_req, _res, { id: rid }) => ({ run: runner.publicRun(runner.getRun(rid)), events: runner.runEvents(rid), items: inbox.itemsForRun(rid), live: runner.isLive(rid) }));
// a queued or limit-paused run starts at once (it jumps its account's queue)
on('POST', '/api/runs/:id/run-now', async (_req, _res, { id: rid }) => runner.runNow(rid));
on('POST', '/api/runs/:id/stop', async (_req, _res, { id: rid }) => runner.stopRun(rid));
// the owner's answer on a recovery card: resume | restart | stop | leave (recover.mjs#act; restart goes through startRun)
on('POST', '/api/runs/:id/recover', async (req, _res, { id: rid }) => {
  runner.getRun(rid);
  const { action } = await readBody(req);
  const r = await recover.act(rid, String(action || ''));
  return { ok: true, run: r.run ? runner.publicRun(r.run) : null };
});
on('POST', '/api/runs/:id/reply', async (req, _res, { id: rid }) => followUp(rid, await readBody(req)));
// `shown`: what the owner's line in the session says when the words sent aren't theirs (a recovery card's Resume)
async function followUp(rid, { text, model, files, shown = null }) {
  const prev = runner.getRun(rid);
  if (!prev) throw Object.assign(new Error('No such run'), { status: 404 });
  if (runner.isLive(rid)) throw Object.assign(new Error('Still running; wait for it to finish'), { status: 409 });
  const clean = String(text || '').trim();
  if (!clean && !files?.length) throw Object.assign(new Error('Write a follow-up first'), { status: 400 });
  // a reply on a client's task stays in the client's folder (runner.mjs): the owner's files go there, not into the workspace
  const ownerFiles = prev.client ? uploadInfos(files) : [];
  const paths = prev.client ? [] : handToWorkspace(workspace(prev.workspace), files);
  // the follow-up stays in the session of the run it follows (a client's task has none the owner sees: their reply opens one)
  const session = getSession(prev.session)?.origin === 'client' ? id('s') : prev.session || id('s');
  const run = await runner.startRun({ workspace: prev.workspace, agentSlug: prev.isBuilder ? BUILDER_SLUG : prev.agentSlug, kind: prev.kind, model: model || prev.model, instruction: prev.client ? clean : withFiles(clean, paths), ownerFiles, resumeSessionId: prev.sessionId, parentRunId: prev.id, session });
  const n = paths.length || ownerFiles.length;
  sayDispatched(run, (typeof shown === 'string' && shown.trim().slice(0, 200)) || clean || `${n} file${n > 1 ? 's' : ''}`, prev.client ? `Follow-up sent on ${prev.clientName}’s task. ${rn(run)} picks up where it left off, and ${prev.clientName} sees it on their page.` : `Follow-up sent. ${rn(run)} picks up where it left off.`, files);
  return run;
}

// The owner calls the agent from a run's window: the run's own voice agent (Orchy for a generalist), told which run this is
on('POST', '/api/runs/:id/call', async (_req, _res, { id: rid }) => {
  const run = runner.getRun(rid);
  if (!run) throw Object.assign(new Error('No such run'), { status: 404 });
  const key = voiceAgents.voiceKey(run.workspace, run.isBuilder ? BUILDER_SLUG : run.agentSlug);
  const live = runner.isLive(run.id);
  const report = String(run.report?.summary || run.resultText || '').slice(0, 1500);
  const s = await voiceAgents.callSession(key, {
    firstMessage: key === 'orchy' ? `Hey ${ownerName()}, Orchy here. What do you need on this one?` : `Hey ${ownerName()}! What do you need on this one?`,
    context: `# Why ${ownerName()} called
${ownerName()} called you from the window of ${key === 'orchy' ? `${rn(run)}'s run (it has no voice of its own, so you speak for it)` : 'your run'} ${run.id} in Orchy, to talk about it.
- The task: ${String(run.instruction || '').slice(0, 800)}
- ${live ? `It's still ${run.status}.` : `It ended ${run.outcome || run.status}.${report ? ` The report: ${report}` : ''}`}
- ${live ? `When it's done, use get_result with run_id "${run.id}".` : `If ${ownerName()} wants changes or a next step, send it with follow_up, run_id "${run.id}" and ${ownerName()}'s words, then say it's started.`}
- Keep it short; say bye and end the call once it's settled.`,
  });
  return { ...s, key };
});

/** Files from the owner's Uploads, checked (for a reply on a client's task, copied into it by the runner). */
function uploadInfos(names = []) {
  if (!Array.isArray(names) || !names.length) return [];
  if (names.length > 10) throw Object.assign(new Error('Up to 10 files per task'), { status: 400 });
  return names.map(n => uploadInfo(n) || (() => { throw Object.assign(new Error(`"${n}" isn't in Uploads any more; attach it again`), { status: 400 }); })());
}

// What a task's folder holds (a client's task, or a generalist's): uploads and what the agent made
on('GET', '/api/runs/:id/files', async (_req, _res, { id: rid }) => {
  const run = runner.getRun(rid);
  return taskFiles(workspace(run.workspace), run);
});
on('GET', '/api/runs/:id/file', async (req, res, { id: rid }) => {
  const run = runner.getRun(rid);
  const file = taskFile(workspace(run.workspace), run, new URL(req.url, 'http://x').searchParams.get('path'));
  if (!file) throw Object.assign(new Error('That file isn’t in the task’s folder'), { status: 404 });
  sendTaskFile(res, file, {}, { req });
});

// ── Artifacts: what agents made, for the dashboard's viewer (the owner's dashboard only; client pages have none yet).
// Every file is re-resolved through artifacts.mjs#resolveFile (realpath inside the workspace, no setup, hidden or
// other clients' files) on each request. File contents need a paired browser's cookie (FILE_READS below). ──
const qs = req => new URL(req.url, 'http://x').searchParams;
on('GET', '/api/artifacts', async req => {
  const q = qs(req);
  const run = q.get('run') ? runner.getRun(q.get('run')) : null;
  if (run) artifacts.syncRun(run, { ended: !!run.endedAt && !runner.isLive(run.id) });
  if (q.get('huddle')) { try { artifacts.syncHuddle(huddles.getHuddle(q.get('huddle'))); } catch {} }
  const list = artifacts.listArtifacts({ run, workspace: q.get('workspace'), agent: q.get('agent'), huddle: q.get('huddle'), kind: q.get('kind'), limit: Number(q.get('limit')) || 300 });
  return { artifacts: list, links: run?.links || [] };
});
on('GET', '/api/artifacts/:id', async (_req, _res, { id: aid }) => {
  try { return { artifact: artifacts.publicArtifact(artifacts.openArtifact(aid).artifact) }; }
  catch (e) { if (e.artifact) return { artifact: e.artifact }; throw e; }
});
on('GET', '/api/artifacts/:id/raw', async (req, res, { id: aid }) => {
  const { artifact: a, file } = artifacts.openArtifact(aid);
  sendTaskFile(res, file, {}, { req, media: true, types: artifacts.VIEW_TYPES, download: qs(req).has('download'), name: a.name });
});
on('GET', '/api/artifacts/:id/preview', async (_req, _res, { id: aid }) => {
  const { artifact: a, file } = artifacts.openArtifact(aid);
  return { ...(await artifacts.previewFile(file, a.name)), version: a.version };
});
on('GET', '/api/artifacts/:id/media/:what', async (req, res, { id: aid, what }) => {
  const { artifact: a } = artifacts.openArtifact(aid); // the guard, and a fresh version
  if (!media.MEDIA_FILES.includes(what)) throw Object.assign(new Error('No such preview'), { status: 404 });
  const file = media.mediaFile(aid, what);
  if (!file) throw Object.assign(new Error(a.media?.state === 'transcoding' ? 'The playable copy isn’t ready yet' : 'No preview for this file'), { status: 404 });
  // previews are per version (the URL carries ?v=), so they can be cached; the original never is
  sendTaskFile(res, file, {}, { req, media: true, types: artifacts.VIEW_TYPES, name: what === 'play' ? a.name : `${what}.webp`, cache: what === 'play' && a.media?.play === 'original' ? null : 'private, max-age=86400' });
});
// the research sources: the URLs a run fetched and the searches it ran (from its recorded events only)
on('GET', '/api/runs/:id/sources', async (_req, _res, { id: rid }) => artifacts.sourcesFor(runner.getRun(rid).id));
// a file the owner gave Orchy, as the viewer previews it (Office, CSV, JSON, text)
on('GET', '/api/uploads/:name/preview', async (_req, _res, { name }) => {
  const u = uploadInfo(decodeURIComponent(name));
  if (!u) throw Object.assign(new Error('That file is gone from Uploads'), { status: 404 });
  return artifacts.previewFile(u.file, u.name);
});

// Inbox (the owner's answers)
on('GET', '/api/inbox', async () => inbox.pending());
on('POST', '/api/inbox/:id/answer', async (req, _res, { id: iid }) => answerItem(iid, await readBody(req)));
function answerItem(iid, body) {
  const item = inbox.getItem(iid);
  if (!item) throw Object.assign(new Error('That message is gone'), { status: 404 });
  let ans;
  if (item.kind === 'question') ans = { text: String(body.text || '').trim() || '(no answer)' };
  else if (item.kind === 'approval') ans = { approve: !!body.approve, note: body.note || '', remember: !!body.remember };
  else if (item.kind === 'connections') {
    const pool = item.payload.connections;
    const picked = (body.selected || []).map(s => {
      const key = typeof s === 'string' ? s : s.key;
      const c = pool.find(x => x.key === key);
      return c ? { ...c, access: (typeof s === 'object' && s.access) || 'full' } : null;
    }).filter(Boolean);
    ans = { selected: picked, note: body.note || '' };
  }
  const done = inbox.answer(iid, ans);
  const run = db().runs[item.runId];
  // remembered only once the answer went through; an outward action in a handed-over run is asked every time
  if (run && item.kind === 'approval' && ans.approve && ans.remember && !item.noRemember) addRule(run, item.ruleKey, item.title);
  if (run && !inbox.pending().some(i => i.runId === run.id)) runner.setRunStatus(run, 'working');
  return done;
}

// Bridge (called by agents' MCP bridge)
function bridgeAuth(req) {
  if (req.headers['x-jos-token'] !== runner.BRIDGE_TOKEN) throw Object.assign(new Error('Bad bridge token'), { status: 401 });
}
on('POST', '/api/bridge/ask', async (req) => {
  bridgeAuth(req);
  const b = await readBody(req);
  const { run, ws, who } = runCtx(b.runId);
  const item = inbox.createItem('question', { runId: run.id, workspace: ws.id, agent: who, title: b.question, message: b.question, context: b.context || '', options: b.options || [], ...askFields(run) });
  runner.setRunStatus(run, 'waiting');
  return { itemId: item.id };
});
on('POST', '/api/bridge/connections', async (req) => {
  bridgeAuth(req);
  const b = await readBody(req);
  const { run, ws, who } = runCtx(b.runId);
  // it shows the owner every connection in the workspace: never from a client's task
  if (run.client) throw Object.assign(new Error('Picking connections is for building agents, not for a client’s task'), { status: 403 });
  const conns = await allConnections(ws);
  const pool = [...conns.one, ...conns.mcp.map(m => ({ ...m, key: `mcp:${m.name}` }))];
  const item = inbox.createItem('connections', {
    runId: run.id, workspace: ws.id, agent: { ...who, displayName: 'AI Agent Builder' },
    title: `Connections for ${b.agent_name}`, message: b.message,
    payload: { agentName: b.agent_name, purpose: b.purpose || '', suggested: b.suggested || [], suggestedAccess: b.suggested_access || {}, connections: pool },
  });
  runner.setRunStatus(run, 'waiting');
  return { itemId: item.id };
});
on('POST', '/api/bridge/jev-tools', async (req) => {
  bridgeAuth(req);
  const b = await readBody(req);
  const { run, ws } = runCtx(b.runId);
  if (!run.isBuilder) throw Object.assign(new Error('Only the AI Agent Builder picks tools with Jev'), { status: 403 });
  const conns = await allConnections(ws);
  const pool = [...conns.one, ...conns.mcp];
  const picks = await pickTools({ agentName: String(b.agent_name || 'the new agent'), job: String(b.job || ''), pool, actions: Array.isArray(b.actions) ? b.actions : [], resolve: (aid, platform) => resolveAction(ws, aid, platform) });
  runner.addNote(run.id, `Jev picked ${picks.connections.map(c => `${c.name} (${c.access})`).join(', ') || 'no connections'}; ${picks.actions.length} action${picks.actions.length === 1 ? '' : 's'}.`.slice(0, 500));
  return picks;
});
on('POST', '/api/bridge/voice-agent', async (req) => {
  bridgeAuth(req);
  const b = await readBody(req);
  const { run, ws } = runCtx(b.runId);
  if (!run.isBuilder) throw Object.assign(new Error('Only the AI Agent Builder sets up voice agents'), { status: 403 });
  const v = await voiceAgents.buildVoice(ws.id, String(b.slug || '').trim());
  emit('voice.agents', { voiceAgents: voiceAgents.publicRoster() });
  runner.addNote(run.id, `${v.name} is on voice${v.isNew ? ' now' : ', updated'} (ElevenLabs voice ${v.voice}).`);
  return v;
});
on('POST', '/api/bridge/approval', async (req) => {
  bridgeAuth(req);
  const b = await readBody(req);
  const v = await gate(b.runId, b.tool_name, b.input || {}, { toolUseId: b.tool_use_id });
  if (v.decision === 'ask') runner.setRunStatus(runner.getRun(b.runId), 'waiting');
  return v;
});
// Antigravity's and Hermes's pre-tool hook (mcp/tool-hook.mjs): every tool call, through the same gate. It may hold the
// request while the owner decides (runner.mjs#toolHook).
on('POST', '/api/bridge/tool-hook', async (req) => {
  bridgeAuth(req);
  const b = await readBody(req);
  return runner.toolHook({ engine: String(b.engine || ''), sessionId: String(b.sessionId || ''), calls: b.calls, maxWaitMs: b.maxWaitMs });
});
on('POST', '/api/bridge/report', async (req) => {
  bridgeAuth(req);
  const b = await readBody(req);
  runner.setReport(b.runId, {
    status: b.status || 'completed', summary: b.summary || '',
    actions_taken: b.actions_taken || [], outputs: b.outputs || [], follow_ups: b.follow_ups || [],
  });
  return { ok: true };
});
// A huddle turn's words (huddle.mjs reads them when the turn's run ends)
on('POST', '/api/bridge/huddle-reply', async (req) => {
  bridgeAuth(req);
  const b = await readBody(req);
  const run = runner.getRun(b.runId);
  if (!run.huddleTalk) throw Object.assign(new Error('Not a huddle turn'), { status: 403 });
  const message = String(b.message || '').trim();
  if (!message) throw Object.assign(new Error('Say something in message'), { status: 400 });
  const strs = v => (Array.isArray(v) ? v : []).map(x => String(x).trim()).filter(Boolean).slice(0, 20);
  const g = b.agreement && typeof b.agreement === 'object' ? b.agreement : null;
  // bring another agent in (huddle.mjs#bringIn checks who when the turn ends)
  const inv = b.invite && typeof b.invite === 'object' && String(b.invite.agent || '').trim() ? { agent: String(b.invite.agent).trim().slice(0, 80), why: String(b.invite.why || '').slice(0, 600) } : null;
  // pushback this turn (huddle.mjs: ready only counts once an agent has challenged something)
  const challenge = String(b.challenge || '').trim();
  run.huddleReply = {
    message: message.slice(0, 6000), ready: !!b.ready, questions_for_owner: strs(b.questions_for_owner), ...(inv ? { invite: inv } : {}), ...(challenge ? { challenge: challenge.slice(0, 2000) } : {}),
    ...(g ? { agreement: { summary: String(g.summary || '').slice(0, 4000), decisions: strs(g.decisions), questions_for_owner: huddles.questionsIn(g.questions_for_owner), dissent: strs(g.dissent),
      work: (Array.isArray(g.work) ? g.work : []).slice(0, 60).map(w => ({ agent: String(w?.agent || ''), task: String(w?.task || '').slice(0, 6000) })) } } : {}),
  };
  save();
  runner.addNote(run.id, `${g ? 'Agreement' : 'Said'}: ${message.replace(/\s+/g, ' ').slice(0, 300)}${challenge ? ' (pushes back)' : ''}${b.ready ? ' (ready to agree)' : ''}${inv ? ` (bringing in ${inv.agent})` : ''}`);
  // huddle_reply is the turn's last action: end the harness process now so it doesn't take extra trailing turns
  // (runner.endHuddleTurn, when this build's runner has it)
  if (typeof runner.endHuddleTurn === 'function') setTimeout(() => { try { runner.endHuddleTurn(run.id); } catch {} }, 50);
  return { ok: true };
});
on('POST', '/api/bridge/note', async (req) => {
  bridgeAuth(req);
  const b = await readBody(req);
  runner.addNote(b.runId, String(b.text || '').slice(0, 500));
  return { ok: true };
});
on('GET', '/api/bridge/wait/:id', async (req, _res, { id: iid }) => {
  bridgeAuth(req);
  return (await inbox.waitFor(iid, 25_000)) || { status: 'expired' };
});
// A department head hands a task to its team agent: a run of its own, linked by delegatedBy (delegation.mjs)
on('POST', '/api/bridge/delegate', async (req) => {
  bridgeAuth(req);
  const b = await readBody(req);
  const head = runner.getRun(b.runId);
  const target = checkDelegation(head, String(b.agent || '').trim());
  const task = String(b.task || '').trim();
  if (!task) throw Object.assign(new Error('Write the task for your team agent first'), { status: 400 });
  if (!runner.isLive(head.id)) throw Object.assign(new Error('Your run has ended'), { status: 409 });
  const sub = await runner.startRun({ workspace: head.workspace, agentSlug: target.slug, instruction: task, delegatedBy: head.id, session: head.session });
  (head.subRuns ||= []).push(sub.id);
  save();
  runner.addNote(head.id, `Handed to ${target.displayName}: ${task.replace(/\s+/g, ' ').slice(0, 160)}`);
  return { runId: sub.id, agentName: sub.agentName };
});
on('GET', '/api/bridge/subrun/:id', async (req, _res, { id: sid }) => {
  bridgeAuth(req);
  const parent = new URL(req.url, 'http://x').searchParams.get('parent');
  const sub = db().runs[sid];
  if (!sub) throw Object.assign(new Error('No such run'), { status: 404 });
  if (!parent || sub.delegatedBy !== parent) throw Object.assign(new Error('That run wasn’t handed over by you'), { status: 403 });
  const ended = () => !runner.isLive(sid) && !['queued', 'paused-limit', 'starting', 'working', 'waiting', 'stopping'].includes(sub.status);
  if (!ended()) {
    await new Promise(resolve => {
      const done = () => { clearTimeout(t); bus.off('event', onEvt); resolve(); };
      const onEvt = e => { if (e.type === 'run.ended' && e.run?.id === sid) done(); };
      const t = setTimeout(done, 25_000);
      bus.on('event', onEvt);
    });
  }
  if (!ended()) return { done: false };
  const r = sub.report || {};
  return { done: true, agentName: sub.agentName, outcome: sub.outcome || sub.status, summary: r.summary || sub.resultText || '', error: sub.error || null, actions_taken: r.actions_taken || [], outputs: r.outputs || [], follow_ups: r.follow_ups || [] };
});

// A C-suite agent pulls another agent of its workspace into a huddle (huddle.mjs#startFromRun); its run waits for the result
on('POST', '/api/bridge/huddle', async (req) => {
  bridgeAuth(req);
  const b = await readBody(req);
  const run = runner.getRun(b.runId);
  if (!runner.isLive(run.id)) throw Object.assign(new Error('Your run has ended'), { status: 409 });
  const h = await huddles.startFromRun(run, { agent: b.agent, agents: b.agents, topic: b.topic });
  (run.huddlesStarted ||= []).push(h.id);
  save();
  const others = huddles.nameList(h.agents.slice(1).map(a => a.name));
  runner.addNote(run.id, `Huddling with ${others}: ${String(b.topic || '').replace(/\s+/g, ' ').slice(0, 160)}`);
  return { huddleId: h.id, with: others };
});
on('GET', '/api/bridge/huddle/:id', async (req, _res, { id: hid }) => {
  bridgeAuth(req);
  const h = huddles.getHuddle(hid);
  if (h.startedBy?.runId !== new URL(req.url, 'http://x').searchParams.get('run')) throw Object.assign(new Error('You didn’t start that huddle'), { status: 403 });
  if (!huddles.outcomeFor(h).done) {
    await new Promise(resolve => {
      const done = () => { clearTimeout(t); bus.off('event', onEvt); resolve(); };
      const onEvt = e => { if (e.type === 'huddle.updated' && e.huddle?.id === hid && huddles.outcomeFor(e.huddle).done) done(); };
      const t = setTimeout(done, 25_000);
      bus.on('event', onEvt);
    });
  }
  return huddles.outcomeFor(huddles.getHuddle(hid));
});

// An agent rings the owner in the dashboard (calls.mjs); call_owner waits for the call to settle
on('POST', '/api/bridge/call', async (req) => {
  bridgeAuth(req);
  const b = await readBody(req);
  const c = calls.askedRing(runner.getRun(b.runId), b.reason);
  runner.addNote(b.runId, `Ringing ${ownerName()}: ${c.reason.slice(0, 200)}`);
  return { callId: c.id, name: c.name };
});
on('GET', '/api/bridge/call/:id', async (req, _res, { id: cid }) => {
  bridgeAuth(req);
  const c = await calls.waitCall(cid);
  if (!c) throw Object.assign(new Error('No such call'), { status: 404 });
  if (c.runId !== new URL(req.url, 'http://x').searchParams.get('run')) throw Object.assign(new Error('Not your call'), { status: 403 });
  if (!calls.isSettled(c)) return { done: false };
  return { done: true, status: c.status, seconds: c.seconds || null, summary: c.summary || '', transcript: c.transcript || '', error: c.transcriptError || null };
});

// ── Huddles: two agents of a workspace talk a task through; the owner approves what they agree (huddle.mjs) ──
on('GET', '/api/huddles', async () => huddles.listHuddles(30));
on('GET', '/api/huddles/:id', async (_req, _res, { id: hid }) => huddles.getHuddle(hid));
// from the Workspaces window (Jev's card starts one through dispatchProposal)
on('POST', '/api/huddles', async (req) => {
  const b = await readBody(req);
  const ws = workspace(String(b.workspace || ''));
  const { agents } = huddles.checkHuddle(ws.id, b.agents);
  const topic = String(b.topic || '').trim();
  if (!topic) throw Object.assign(new Error('Say what the huddle is about'), { status: 400 });
  // the huddle opens a session of its own (with the owner's ask); the one on screen, if any, gets a line pointing there
  return huddles.startHuddle({ workspace: ws.id, agents: agents.map(a => a.slug), topic, session: getSession(b.session)?.id || null, maxTurns: b.maxTurns });
});
on('POST', '/api/huddles/:id/say', async (req, _res, { id: hid }) => huddles.ownerSays(hid, (await readBody(req)).text));
on('POST', '/api/huddles/:id/continue', async (req, _res, { id: hid }) => { const b = await readBody(req); return huddles.keepTalking(hid, { text: b.text, more: b.more, answers: b.answers }); });
on('POST', '/api/huddles/:id/stop', async (_req, _res, { id: hid }) => huddles.stopHuddle(hid));
on('POST', '/api/huddles/:id/approve', async (req, _res, { id: hid }) => {
  const b = await readBody(req);
  const { huddle: h, runs, errors } = await huddles.approve(hid, { note: b.note, answers: b.answers });
  orchy.say(`Approved. ${runs.map(r => `${rn(r)} is on ${r.isBuilder ? 'the agent changes' : 'their part'}`).join(', ')} in ${workspace(h.workspace).name}, picking up from the huddle.${errors.length ? ` Couldn't start: ${errors.join(' · ')}` : ''}`, { workspace: h.workspace, kind: 'dispatch', session: h.session, ...(runs.length === 1 ? { runId: runs[0].id } : {}) });
  return { huddle: h, runs: runs.map(runner.publicRun), errors };
});
on('POST', '/api/huddles/:id/close', async (_req, _res, { id: hid }) => huddles.dismiss(hid));
// The owner's standing rules per workspace (rules.mjs): what Orchy answers for them in a huddle's proposal. Not the
// remembered approvals (/api/rules, policy.mjs): these never clear an ask.
on('GET', '/api/standing-rules/:ws', async (_req, _res, { ws: wsId }) => ({ rules: standingRules.rulesFor(workspace(wsId).id) }));
on('POST', '/api/standing-rules/:ws', async (req, _res, { ws: wsId }) => {
  const w = workspace(wsId);
  standingRules.addRule(w.id, (await readBody(req)).text);
  return { rules: standingRules.rulesFor(w.id) };
});
on('DELETE', '/api/standing-rules/:ws/:rule', async (_req, _res, { ws: wsId, rule }) => ({ rules: standingRules.removeRule(workspace(wsId).id, rule) }));

// Logs, rules, settings
on('POST', '/api/greeting', async () => orchy.dailyGreeting());
on('GET', '/api/logs', async () => readLogs());
// tokens and cost per workspace, agent, model and kind, chains, top runs, Orchy's own calls (logs.mjs#computeUsage)
on('GET', '/api/usage', async (req) => computeUsage(new URL(req.url, 'http://x').searchParams.get('period') || 'month'));
// the weekly usage review, now
on('POST', '/api/usage/review', async () => {
  const r = await weeklyReview({ say: reviewSay });
  return { ok: true, suggestions: r.suggestions.length };
});
on('GET', '/api/rules', async () => db().rules);
on('DELETE', '/api/rules/:i', async (_req, _res, { i }) => {
  const n = Number(i);
  if (!Number.isInteger(n) || n < 0 || n >= db().rules.length) throw Object.assign(new Error('No such rule'), { status: 400 });
  removeRule(n);
  return db().rules;
});
on('POST', '/api/settings', async (req) => {
  const b = await readBody(req);
  for (const k of ['voiceReplies', 'sound', 'autoDispatch', 'actionPlan', 'callStuck', 'callAsk', 'callDone', 'liveJev', 'liveStart', 'scriptsFree', 'budgetRouting']) if (k in b) db().settings[k] = !!b[k];
  // runs at once per account (1–10, default 3; more wait in the queue), and when the weekly usage review runs
  if ('maxLivePerAccount' in b) db().settings.maxLivePerAccount = Math.min(10, Math.max(1, Math.round(Number(b.maxLivePerAccount)) || 3));
  // Orchy's check of finished runs (validate.mjs, on unless off; Jev's read off unless on) and his retries (recover.mjs)
  for (const k of ['validateRuns', 'validateJev', 'autoRetry']) if (k in b) db().settings[k] = !!b[k];
  // recovery: flag a run with no new step after N minutes (0 = off, default 20); stop runs after N minutes (0 = off)
  if ('stallMin' in b) db().settings.stallMin = Math.min(240, Math.max(0, Math.round(Number(b.stallMin)) || 0));
  if ('stopAfterMin' in b) db().settings.stopAfterMin = Math.min(1440, Math.max(0, Math.round(Number(b.stopAfterMin)) || 0));
  if ('usageReviewDay' in b) db().settings.usageReviewDay = b.usageReviewDay === 'off' || REVIEW_DAYS.includes(b.usageReviewDay) ? b.usageReviewDay : 'Fri';
  if ('usageReviewHour' in b) db().settings.usageReviewHour = Math.min(23, Math.max(0, Math.round(Number(b.usageReviewHour)) || 0));
  // Jev's reads as the owner types: caps per message and per day (0 = no cap)
  if ('liveReadsPerMessage' in b) db().settings.liveReadsPerMessage = Math.min(200, Math.max(0, Math.round(Number(b.liveReadsPerMessage)) || 0));
  if ('liveReadsPerDay' in b) db().settings.liveReadsPerDay = Math.min(100000, Math.max(0, Math.round(Number(b.liveReadsPerDay)) || 0));
  if ('huddleTurns' in b) db().settings.huddleTurns = Math.min(huddles.TURNS.max, Math.max(huddles.TURNS.min, Math.round(Number(b.huddleTurns)) || huddles.TURNS.default));
  // Orchy in huddles (huddlecoach.mjs): on/off, and interventions per huddle, 0–6 (default 3)
  if ('huddleCoach' in b) db().settings.huddleCoach = !!b.huddleCoach;
  if ('huddleCoachMax' in b) db().settings.huddleCoachMax = Math.min(COACH.cap, Math.max(0, Math.round(Number(b.huddleCoachMax)) || 0));
  // missions (missions.mjs): start a sure one on its own, Jev's read of each step, the cost ceiling per mission
  // ($1–500, default 15), live steps at once (1–3, default 2), a time cap in minutes (0 = off)
  for (const k of ['missionAutoStart', 'validateJevMissions']) if (k in b) db().settings[k] = !!b[k];
  if ('missionCeiling' in b) db().settings.missionCeiling = Math.min(500, Math.max(1, Math.round(Number(b.missionCeiling)) || missions.LIMITS.ceiling));
  if ('missionMaxLive' in b) db().settings.missionMaxLive = Math.min(missions.LIMITS.liveCap, Math.max(1, Math.round(Number(b.missionMaxLive)) || missions.LIMITS.maxLive));
  if ('missionMaxMin' in b) db().settings.missionMaxMin = Math.min(1440, Math.max(0, Math.round(Number(b.missionMaxMin)) || 0));
  if ('callStuckMin' in b) db().settings.callStuckMin = Math.min(120, Math.max(1, Math.round(Number(b.callStuckMin)) || 10));
  if (b.approvals === 'decisions' || b.approvals === 'all') db().settings.approvals = b.approvals;
  if (b.askFor && typeof b.askFor === 'object') {
    const cur = db().settings.askFor ||= {};
    for (const d of DECISIONS) if (d.key in b.askFor) cur[d.key] = !!b.askFor[d.key];
  }
  save();
  emit('settings.updated', { settings: db().settings });
  return db().settings;
});
on('POST', '/api/settings/env', async (req) => {
  const { key, value } = await readBody(req);
  if (!ENV_KEYS.includes(key)) throw Object.assign(new Error('Not an editable setting'), { status: 400 });
  let v = String(value ?? '').replace(/[\r\n]+/g, '').trim(); // one line in .env
  if (key === 'VOICE_ENABLED') v = /^(0|false|off|no)$/i.test(v) ? '0' : '1';
  if (key === 'VOICE_PROVIDER' && !voice.VOICE_PROVIDERS.includes(v = v.toLowerCase())) throw Object.assign(new Error('Voice provider is elevenlabs or deepgram'), { status: 400 });
  if (key === 'JEV_PROVIDER' && !JEV_PROVIDERS.includes(v.toLowerCase())) throw Object.assign(new Error(`Jev provider is one of: ${JEV_PROVIDERS.filter(Boolean).join(', ')}`), { status: 400 });
  if (key === 'CLIENT_URL' && v) {
    if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
    try { v = new URL(v).origin; } catch { throw Object.assign(new Error('That doesn’t look like a web address (e.g. https://clients.example.com)'), { status: 400 }); }
  }
  setEnv(key, v);
  emit('settings.updated', { envKey: key, voice: voice.voiceConfig(), jev: { mode: jevMode(), label: jevLabel() }, envStatus: Object.fromEntries(ENV_KEYS.map(k => [k, SECRET(k) ? !!env(k) : env(k)])) });
  if (key === 'CLIENT_URL') clientsChanged();
  if (key === 'VOICE_ENABLED' || key === 'ELEVENLABS_API_KEY') voiceRefresh(false); // voice back on: its agents get made
  return { ok: true, set: !!env(key) };
});
// First-run setup guide: what is installed, which keys are set, how far the owner got
on('GET', '/api/setup', async (req) => {
  const force = new URL(req.url, 'http://x').searchParams.has('force');
  const tools = await toolStatus({ force });
  const keys = [
    { id: 'jev', label: 'Jev routing (a TypeSafe, OpenRouter, Vercel AI Gateway or OpenCode Zen key)', set: jevMode() !== 'none', envKeys: ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'AI_GATEWAY_API_KEY', 'OPENCODE_API_KEY'],
      unlocks: 'Jev reads each message and picks the business, agent and model, and plans which app actions a task needs.',
      withoutIt: 'Routing falls back to keyword matching: simple, but it guesses wrong more often and you may have to pick the agent yourself.' },
    { id: 'elevenlabs', label: 'ElevenLabs', set: !!env('ELEVENLABS_API_KEY'), envKeys: ['ELEVENLABS_API_KEY'],
      unlocks: 'Orchy and your agents speak in natural voices, and you can call them from the dashboard.',
      withoutIt: 'Orchy speaks with your browser’s built-in voice, and voice calls are off.' },
    { id: 'deepgram', label: 'Deepgram', set: !!env('DEEPGRAM_API_KEY'), envKeys: ['DEEPGRAM_API_KEY'],
      unlocks: 'A backup voice for Orchy when ElevenLabs is not set or is down.',
      withoutIt: 'Nothing breaks: Orchy uses the browser’s voice.' },
  ];
  const list = workspaces().map(w => ({ id: w.id, name: w.name, oneSignedIn: oneScope(w).own, hasAgents: listAgents(w.id).some(a => a.slug !== BUILDER_SLUG) }));
  return {
    owner: { name: (config.owner?.name || '').trim(), set: !!(config.owner?.name || '').trim() },
    timezone: config.timezone,
    os: process.platform,
    tools, harness: tools.some(t => t.kind === 'harness' && t.found), keys,
    workspaces: { count: list.length, list },
    done: !!db().settings.setupDone,
  };
});
// This browser (lib/owner.mjs): pairing it, and pairing another from it
// stale: this browser's cookie is known but its page sent no key (paired before keys, or its storage was cleared)
on('GET', '/api/owner', async (req) => { const st = owner.ownerState(req, PORT); return { paired: st === 'paired', stale: st === 'stale', browsers: owner.pairedCount() }; });
on('POST', '/api/pair', async (req, res) => {
  // the key goes to the page only (it keeps it in this port's own storage), never in a cookie
  const { cookie, key } = owner.pair((await readBody(req)).code, req, PORT);
  send(res, 200, { ok: true, key }, { 'Set-Cookie': cookie });
});
on('POST', '/api/pair/new', async () => {
  const code = owner.newPairCode();
  return { code, url: `http://localhost:${PORT}/?pair=${code}`, minutes: 15 };
});
on('POST', '/api/pair/unpair-others', async (req) => ({ removed: owner.unpairOthers(req, PORT) }));
on('POST', '/api/setup/owner', async (req) => {
  const b = await readBody(req);
  const name = String(b.name ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (name.length > 60) throw Object.assign(new Error('Keep the name to 60 characters'), { status: 400 });
  const tz = String(b.timezone ?? '').trim();
  if (tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { throw Object.assign(new Error('That is not a timezone Orchy knows (e.g. America/New_York)'), { status: 400 }); } }
  config.owner = { ...(config.owner || {}), name };
  if (tz) { config.owner.timezone = tz; config.timezone = tz; }
  saveConfig();
  emit('settings.updated', { owner: { name: ownerName(), set: !!name }, timezone: config.timezone });
  return { ok: true, owner: { name, set: !!name }, timezone: config.timezone };
});
on('POST', '/api/setup/done', async (req) => {
  const { done } = await readBody(req);
  db().settings.setupDone = !!done;
  save();
  emit('settings.updated', { settings: db().settings });
  return { ok: true, done: !!done };
});
on('POST', '/api/accounts/refresh', async () => {
  const list = await Promise.all(workspaces().map(w => workspaceSummary(w, { force: true })));
  emit('workspaces.changed', { workspaces: list, retired: retiredSummary() });
  return list;
});

// Voice
on('GET', '/api/voice/voices', async () => voice.listVoices());
on('POST', '/api/voice/speak', async (req, res) => {
  if (!voice.voiceEnabled()) throw Object.assign(new Error('Voice is switched off in Orchy (Settings → Voice)'), { status: 409 });
  const { text } = await readBody(req);
  const before = voice.voiceConfig().tts;
  try { await voice.speak(text, res); }
  finally { if (voice.voiceConfig().tts !== before) emit('settings.updated', { voice: voice.voiceConfig() }); }
  return undefined;
});
on('GET', '/api/voice/config', async () => voice.voiceConfig());

// Voice agents: the owner calls Orchy or any agent by name (ElevenLabs, in the dashboard).
// Their tools land here, so a call can only do what the owner can do from the dashboard.
on('GET', '/api/voice/agents', async () => voiceAgents.publicRoster());
on('GET', '/api/voice/agents/:key/session', async (_req, _res, { key }) => (!voice.voiceEnabled() ? Promise.reject(Object.assign(new Error('Voice is switched off in Orchy (Settings → Voice)'), { status: 409 })) : decodeURIComponent(key) === 'orchy' ? voiceAgents.orchySession() : voiceAgents.signedUrl(decodeURIComponent(key))));
on('POST', '/api/voice/tool/:name', async (req, _res, { name }) => {
  const p = await readBody(req);
  try { return { text: await voiceTool(name, p) }; }
  catch (e) { return { text: `That didn't work: ${e.message}` }; }
});

// Calls agents placed: the owner answers (or calls back a missed one), declines, hangs up
on('POST', '/api/calls/:id/answer', async (_req, _res, { id: cid }) => calls.answer(cid));
on('POST', '/api/calls/:id/decline', async (req, _res, { id: cid }) => calls.decline(cid, await readBody(req)));
on('POST', '/api/calls/:id/end', async (req, _res, { id: cid }) => calls.end(cid, await readBody(req)));

const mins = iso => Math.max(1, Math.round((Date.now() - new Date(iso)) / 60_000));
const ownerItems = () => inbox.pending().filter(i => i.answerer !== 'client');
// "Chloe (Head of Social)": the name the owner calls the agent by, with its role
function rn(r) { return voiceAgents.callName(r.workspace, r.isBuilder ? BUILDER_SLUG : r.agentSlug, r.agentName); }
async function voiceTool(name, p) {
  const ws = p.workspace ? String(p.workspace).trim().toLowerCase() : null;
  const slug = p.agent ? String(p.agent).trim().toLowerCase() : null;
  if (name === 'send_task') {
    const task = String(p.task || '').trim();
    if (!task) return 'No task given.';
    if (ws && slug) {
      const run = await runAgent(ws, slug, { instruction: task });
      return `Started. ${rn(run)} in ${workspace(ws).name} is on it (run ${run.id}).`;
    }
    const r = await chat({ text: ws ? `for ${workspace(ws).name}: ${task}` : task, session: undefined });
    if (r.kind === 'proposal') {
      const c = r.proposal.choice;
      if (!c.workspace || r.proposal.routing.needsChoice) return `Orchy wasn't sure where that goes, so nothing started yet: the task is waiting for ${ownerName()} in the dashboard.`;
      const who = c.agent && c.agent !== 'general' ? voiceAgents.callName(c.workspace, c.agent, listAgents(c.workspace).find(a => a.slug === c.agent)?.displayName) : 'the generalist';
      return `Orchy routed it to ${who} in ${workspace(c.workspace).name}. ${r.proposal.dispatchAt ? `It starts in a few seconds unless ${ownerName()} changes it in the dashboard.` : `It waits for ${ownerName()} to send it from the dashboard.`}`;
    }
    if (r.kind === 'mission') return `That needs several of ${workspace(r.mission.workspace).name}'s agents, so Orchy is planning it as a mission; ${ownerName()} sees the steps in the dashboard${missions.missionSettings().autoStart ? ', and a plan Jev is sure of starts after a short countdown' : ' and starts it there'}.`;
    if (r.kind === 'ignored') return `${r.routing.switchedOff.name} is switched off, so nothing was started.`;
    return 'Orchy took that as a question rather than a task; the answer is in the Orchy chat.';
  }
  if (name === 'check_status') {
    const runs = runner.listRuns(60).filter(r => (!ws || r.workspace === ws) && (!slug || r.agentSlug === slug));
    const live = runs.filter(r => runner.isLive(r.id));
    const recent = runs.filter(r => !runner.isLive(r.id) && r.endedAt && Date.now() - new Date(r.endedAt) < 24 * 3600_000).slice(0, 5);
    const items = ownerItems().filter(i => (!ws || i.workspace === ws) && (!slug || i.agent?.slug === slug));
    const lines = [];
    lines.push(live.length ? `Running: ${live.map(r => `${rn(r)} in ${r.workspace} (run ${r.id}, ${r.status}, ${mins(r.startedAt)} min): ${String(r.instruction || '').slice(0, 120)}`).join(' | ')}` : 'Nothing running.');
    if (recent.length) lines.push(`Finished in the last day: ${recent.map(r => `${rn(r)} (run ${r.id}, ${r.status}, ${mins(r.endedAt)} min ago): ${String(r.report?.summary || r.instruction || '').slice(0, 160)}`).join(' | ')}`);
    lines.push(items.length ? `Waiting on ${ownerName()}: ${items.map(i => `${i.kind} ${i.id} from ${voiceAgents.callName(i.workspace, i.agent?.slug, i.agent?.displayName)} in ${i.workspace}: ${String(i.title || '').slice(0, 200)}${i.message ? ` (${i.message})` : ''}`).join(' | ')}` : `Nothing waiting on ${ownerName()}.`);
    return lines.join('\n');
  }
  if (name === 'get_result') {
    const r = runner.getRun(String(p.run_id || ''));
    if (!r) return 'No run with that id.';
    if (runner.isLive(r.id)) return `${rn(r)} is still ${r.status} (${mins(r.startedAt)} min so far).`;
    return `${rn(r)}, ${r.status}: ${String(r.report?.summary || r.resultText || 'no report').slice(0, 1500)}`;
  }
  if (name === 'answer_item') {
    const item = inbox.getItem(String(p.item_id || ''));
    if (!item || item.status !== 'pending' || item.answerer === 'client') return `That item is gone or not ${ownerName()}'s to answer.`;
    if (item.kind === 'question') { answerItem(item.id, { text: p.answer }); return 'Answer sent.'; }
    if (item.kind === 'approval') {
      const d = String(p.decision || '').toLowerCase();
      if (!/^(approve|deny)$/.test(d)) return 'Say approve or deny.';
      answerItem(item.id, { approve: d === 'approve', note: 'by voice' });
      return d === 'approve' ? 'Approved.' : 'Denied.';
    }
    return 'That one needs the dashboard (picking connections).';
  }
  if (name === 'follow_up') {
    const run = await followUp(String(p.run_id || ''), { text: p.message });
    return `Sent. ${rn(run)} picks up where it left off (run ${run.id}).`;
  }
  return `Unknown tool ${name}.`;
}

// ── server ──
// Only this PC's own pages and programs: another site open in the owner's browser (or a name rebound to 127.0.0.1) can't drive the API
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'].map(h => `${h}:${PORT}`);
const LOCAL_ORIGINS = LOCAL_HOSTS.map(h => `http://${h}`);
function crossSite(req) {
  const origin = req.headers.origin;
  if (origin !== undefined && !LOCAL_ORIGINS.includes(String(origin).toLowerCase())) return true;
  return ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site']);
}
// Agents run on this PC too, and a program sends no Origin: so a change is only taken from a browser the owner
// paired (lib/owner.mjs): its cookie, plus the key its page sends, which no other port on localhost ever sees.
// The bridge, pairing itself and the restart report carry their own proof.
const OWNERLESS = /^\/api\/(bridge\/|pair$|backend\/restarted$)/;
const ownerOnly = (req, pathname) => req.method !== 'GET' && req.method !== 'HEAD' && !OWNERLESS.test(pathname);
// Reads stay open to this PC, except the contents of files in workspaces and Uploads (the viewer, task files, the
// owner's uploads): those need a paired browser's cookie (owner.mjs#isOwnerBrowser; an <img> or <video> can't send
// the key header). An agent's curl has no cookie, so it can't read another workspace's files through Orchy.
const FILE_READS = /^\/api\/(artifacts\/[^/]+\/(raw|preview|media\/[^/]+)|runs\/[^/]+\/file|uploads\/[^/]+(\/preview)?)$/;
const server = http.createServer(async (req, res) => {
  // The owner's dashboard has no login of its own: it's never served through Cloudflare (client pages are, on CLIENT_PORT)
  if (req.headers['cf-ray'] || req.headers['cf-connecting-ip']) {
    return send(res, 403, `This is ${ownerName()}'s private dashboard, and it isn't served through Cloudflare. Point the tunnel at port ${CLIENT_PORT()} (client pages), never at ${PORT}.`);
  }
  if (!LOCAL_HOSTS.includes(String(req.headers.host || '').toLowerCase())) return send(res, 403, `Open Orchy at http://localhost:${PORT}`);
  let pathname = req.url;
  try {
    pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
    if (pathname.startsWith('/api/')) {
      if (crossSite(req)) return send(res, 403, { error: 'Orchy only takes requests from its own dashboard' });
      if (ownerOnly(req, pathname) && !owner.isOwner(req, PORT)) {
        const stale = owner.ownerState(req, PORT) === 'stale';
        return send(res, 401, { error: stale ? 'Pair this browser again to make changes (Orchy now keeps a second key in the page)' : 'This browser isn’t paired with Orchy, so it can’t make changes', code: 'unpaired', stale });
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && FILE_READS.test(pathname) && !owner.isOwnerBrowser(req, PORT)) {
        return send(res, 401, { error: 'This browser isn’t paired with Orchy, so it can’t open workspace files', code: 'unpaired' });
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = pathname.match(r.re);
        if (!m) continue;
        const out = await r.handler(req, res, m.groups || {});
        if (out !== undefined && !res.headersSent) send(res, 200, out);
        return;
      }
      return send(res, 404, { error: `No route ${req.method} ${pathname}` });
    }
    if (pathname === '/' || pathname === '/index.html') return serveFile(res, path.join(DASHBOARD_DIR, 'index.html'));
    if (pathname.startsWith('/assets/')) return serveFile(res, safeJoin(path.join(ROOT, 'assets'), pathname.slice(8)));
    if (pathname === '/vendor/marked.js') return serveFile(res, path.join(ROOT, 'node_modules', 'marked', 'lib', 'marked.esm.js'));
    return serveFile(res, safeJoin(DASHBOARD_DIR, pathname.slice(1)));
  } catch (e) {
    if (![400, 401, 404, 409].includes(e.status)) console.error(`[${req.method} ${pathname}]`, e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.message, code: e.code });
    else res.end();
  }
});
// Edit .env while running: keys apply without a restart.
fs.watchFile(path.join(ROOT, '.env'), { interval: 1500 }, () => {
  reloadEnv();
  voice.clearVoiceIssues();
  emit('settings.updated', { voice: voice.voiceConfig(), jev: { mode: jevMode(), label: jevLabel() }, envStatus: Object.fromEntries(ENV_KEYS.map(k => [k, SECRET(k) ? !!env(k) : env(k)])) });
  console.log('[env] .env changed, reloaded');
});

server.requestTimeout = 0;
server.headersTimeout = 60_000;

server.on('error', e => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.error(`
  Port ${PORT} is taken by another program. Close it, or set PORT=… in .env, then start Orchy again.
`);
  process.exit(1);
});

// Voice agents follow the agent files: a new agent gets a name, a voice and its own ElevenLabs agent;
// an edited one gets a fresh prompt. Orchy tells the owner what to call the newcomers.
function voiceRefresh(full) {
  voiceAgents.refresh({
    full,
    onDone: added => {
      emit('voice.agents', { voiceAgents: voiceAgents.publicRoster() });
      for (const a of added) orchy.say(`${a.role} in ${workspace(a.workspace).name} is on voice now: call ${a.name}.`, { workspace: a.workspace, session: null });
    },
  });
}
bus.on('event', e => { if (e.type === 'agent.created' || e.type === 'agent.updated' || e.type === 'agent.retired') voiceRefresh(e.type !== 'agent.created'); });

// the artifact registry listens for file tools and run ends; media makes thumbs/posters/playable copies in the
// background when ffmpeg is installed (optional: without it the originals still open)
artifacts.start();
media.startMedia();

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  ▄▀▀▄  Orchy is up → ${url}\n  █▄▄█  Jev routing ${jevLabel() ? `via ${jevLabel()}` : 'off (npm run setup adds a key; routing uses keywords)'}\n  ▀  ▀  Logs → ${path.join(ROOT, 'LOGS.md')}\n`);
  // A one-time code pairs the browser Orchy opens (lib/owner.mjs). It only goes to a person: that browser, or a
  // terminal. Never to a log: a restart's output lands in data/server.log, which agents can read.
  const opens = !(env('NO_OPEN') || process.argv.includes('--no-open'));
  const code = opens || process.stdout.isTTY ? owner.newPairCode() : null;
  if (code && process.stdout.isTTY) console.log(`  Pair a browser → ${url}/?pair=${code}  (works once, for 15 minutes)\n`);
  openDashboard(code ? `${url}/?pair=${code}` : url);
  // a restart that couldn't tell this Orchy how it went (scripts/restart.mjs) left it in a file
  const restarted = backend.bootReport();
  if (restarted) sayRestarted(restarted);
  startPortal();
  calls.startCalls();
  voiceRefresh(false);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flush(); process.exit(0); });
process.on('uncaughtException', e => console.error('[uncaught]', e));
process.on('unhandledRejection', e => console.error('[unhandled]', e));
