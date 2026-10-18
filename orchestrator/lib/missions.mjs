// Missions: one ask of the owner's that needs several of ONE workspace's agents in a row ("research X, then make a
// short PDF report from it"). Never across workspaces: one client's outputs never reach another client's agents.
//   plan       one tool-less Claude Code call (config.orchy.missionModel, default sonnet) under the MISSION'S WORKSPACE
//              Claude Code account (claudeAccount in config.json), checked with workspaces.mjs#accountCheck first. A
//              workspace with no Claude Code account of its own gets no mission (a plain task card instead): Orchy never
//              plans a workspace's work from another account. Recorded in orchy-costs.jsonl as `mission-plan`. Checked
//              before anything shows (validatePlan): agents of this workspace only (no builder, no client-shared agent,
//              engines the workspace has an account for), 2–6 steps, needs point at earlier steps (no loops), at least
//              two different agents. A refused plan is asked again once with the errors, then it falls back to a task card.
//   card       Orchy's chat shows the steps. A sure mission (Jev's mission intent ≥ 0.7, the plan passed on the first
//              try, no hold) starts on its own after a countdown the owner can stop (Settings "Start missions when Jev's
//              sure"); otherwise it waits for Go. The owner can edit a step's words, swap its agent or remove it while it waits.
//   supervise  every step is an ordinary runner.startRun (account check, ungated-engine refusal, policy and the gate
//              unchanged) with missionId/stepId and the mission's shared Tasks/ folder. Steps whose needs are done start
//              (2 live at most); each gets its predecessors' report summaries/results (trimmed) and file lists, never
//              transcripts. A finished step is checked (validate.mjs, with its expected files; Jev's read on for
//              missions). One automatic "fix this" follow-up per step, only when the step did nothing outward (max 2 per
//              mission); otherwise the owner decides. Failures go through recover.mjs (a safe retry only when retryGate
//              allows), else the owner: Retry · Give to another agent · Skip · Replan · Stop.
//   limits     $15 per mission (Settings), then it pauses and asks; no steps beyond the plan; a time cap (off by default).
//   end        one Jev "objective met?" read, then Orchy reports once, LOGS.md gets one mission entry, TASK.md in the
//              shared folder. A restart turns a mission with live steps into `waiting` with Resume/Stop.
// Orchy never approves anything here: every ask the gate makes still goes to the owner.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db as storeDb, save as storeSave, id as storeId, runEventsPath } from './store.mjs';
import { emit as busEmit } from './bus.mjs';
import { config, ownerName } from './env.mjs';
import { workspace as wsById, accountFor, accountCheck as realAccountCheck } from './workspaces.mjs';
import { engine, ungatedRefusal } from './engines/index.mjs';
import { listAgents, BUILDER_SLUG } from './agents.mjs';
import { clientSharedSlugs } from './delegation.mjs';
import { quickClaude } from './claude.mjs';
import { ask as jevAsk } from './jev.mjs';
import * as validate from './validate.mjs';
import * as recover from './recover.mjs';
import { listArtifacts } from './artifacts.mjs';
import { itemsForRun } from './inbox.mjs';
import { fmtTime, bullets, appendMissionLog } from './logs.mjs';
import { tasksBase, taskRel as folderRel } from './clientspace.mjs';

/** Limits. `ceiling` and `maxLive` are Settings defaults. */
export const LIMITS = { minSteps: 2, maxSteps: 6, maxLive: 2, liveCap: 3, ceiling: 15, autoFixes: 2, retries: recover.MAX_AUTO, inputChars: 3000, taskChars: 1500, countdown: 10, objectiveMin: 0.4 };
export const SURE = 0.7; // Jev's mission probability for a card that starts on its own (router.mjs#MISSION_SURE)
// the planner is a Claude Code call (quickClaude), so it needs the workspace's own Claude Code login
const PLANNER_ENGINE = 'claude';

const LIVE_STEP = new Set(['running', 'fixing', 'retrying']);
const DONE_STEP = new Set(['done', 'skipped']);
const nOf = (m, s) => m.steps.indexOf(s) + 1; // "step 2" for the owner; ids stay internal

/** Can this workspace run an agent pinned to `id`? An adapter, allowed if ungated, and an account of its own for it. */
function engineReady(ws, id) {
  const e = engine(id);
  if (!e || ungatedRefusal(ws, e)) return false;
  const a = accountFor(ws, id);
  return a.model === 'profile' ? !!a.profileDir : !!a.email;
}

// everything outside this file goes through deps, so test-missions.mjs runs it with no runner, Claude, Jev or disk
const deps = {
  db: storeDb, save: storeSave, emit: busEmit, id: storeId, now: () => Date.now(),
  setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: t => clearTimeout(t),
  workspace: wsById, agents: wsId => listAgents(wsId), shared: wsId => clientSharedSlugs(wsId),
  allAgents: () => listAgents(), engineOk: engineReady, plannerReady: () => !!engine(PLANNER_ENGINE)?.available(),
  accountCheck: realAccountCheck, think: quickClaude, ask: jevAsk, nameOf: () => null,
  events: runId => { try { return fs.readFileSync(runEventsPath(runId), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } },
  items: runId => itemsForRun(runId),
  validate: (run, opts) => validate.applyValidation(run, opts),
  classify: (run, o) => recover.classify(run, o), retryGate: (run, o) => recover.retryGate(run, o), retryDelay: n => recover.retryDelay(n),
  artifactsFor: run => listArtifacts({ run, limit: 200 }),
  openTaskDir: null, handFiles: (_ws, names) => names, writeTask: null, appendLog: (m, ws) => appendMissionLog(m, ws),
  // wired by server.mjs#missions.start
  startRun: null, stopRun: () => {}, isLive: () => false, say: () => null, fallback: null,
  log: msg => console.log(`[mission] ${msg}`),
};
export function configure(o) { Object.assign(deps, o); }

const all = () => (deps.db().missions ||= {});
export const getMission = mid => all()[mid] || null;
export function listMissions(limit = 20) {
  return Object.values(all()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, limit);
}
/** The whole mission is public (no prompts, no secrets in it). */
export const publicMission = m => { const { timer, ...rest } = m; return rest; };
const touch = (m, type = 'mission.updated') => { deps.save(); deps.emit(type, { mission: publicMission(m) }); };
const iso = () => new Date(deps.now()).toISOString();
const trim = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
const line = (s, n) => trim(String(s ?? '').replace(/\s+/g, ' '), n);
const money = n => `$${(Number(n) || 0).toFixed(2)}`;
const round = n => Math.round((Number(n) || 0) * 100000) / 100000;
const timers = new Map(); // missionId → countdown timer; `${mid}:${stepId}` → retry timer
/** The mission's shared folder, relative to its workspace (`Marketing/Tasks/<folder>`, `Tasks/<folder>`), or null before Go. */
export const taskRel = m => folderRel(m);

/** Settings → Missions. Sure missions start on their own only while both auto-dispatch and this are on. */
export function missionSettings(s = deps.db().settings || {}) {
  const n = (v, d, lo, hi) => (v == null || !Number.isFinite(Number(v)) ? d : Math.min(hi, Math.max(lo, Number(v))));
  return {
    autoStart: s.missionAutoStart !== false && s.autoDispatch !== false,
    ceiling: n(s.missionCeiling, LIMITS.ceiling, 1, 500),
    maxLive: Math.round(n(s.missionMaxLive, LIMITS.maxLive, 1, LIMITS.liveCap)),
    jev: s.validateJevMissions !== false,
    maxMin: Math.round(n(s.missionMaxMin, 0, 0, 24 * 60)),
    countdown: Math.round(n(config.routing?.missionSeconds, LIMITS.countdown, 3, 120)),
  };
}

// ── who can take a step ──
/** This workspace's agents a mission may use: the generalist plus every agent that isn't the builder, shared with a
 *  client, broken, or on an engine this workspace can't run (no adapter, no account, or ungated and not allowed). */
export function roster(ws, agents = deps.agents(ws.id)) {
  const shared = deps.shared(ws.id);
  const out = [{ slug: 'general', name: `${ws.name} generalist`, role: 'Generalist', does: line(`Any task for ${ws.client || ws.name} when no specialist fits. ${ws.blurb || ''}`, 240), engine: ws.runtime, team: [] }];
  for (const a of agents) {
    if (a.isBuilder || a.slug === BUILDER_SLUG || a.error || shared.has(a.slug)) continue;
    const eng = a.engine || ws.runtime;
    if (eng !== ws.runtime && !deps.engineOk(ws, eng)) continue;
    out.push({ slug: a.slug, name: deps.nameOf(ws.id, a.slug) || a.callName || a.displayName, role: a.displayName, does: line(a.description, 240), engine: eng, team: a.team || [] });
  }
  return out;
}
const agentLabel = (R, slug) => { const a = R.find(x => x.slug === slug); return a ? (a.slug === 'general' ? a.name : `${a.name}${a.role && a.role !== a.name ? `, ${a.role}` : ''}`) : slug; };

// ── the plan, checked ──
const ID_RE = /^[a-z0-9][\w-]{0,23}$/i;
const KINDS = new Set(['pdf', 'doc', 'markdown', 'csv', 'sheet', 'slides', 'image', 'video', 'audio', 'html', 'text', 'json', 'code', 'document', 'report', 'spreadsheet', 'table', 'deck', 'presentation', 'file', 'any']);
const KIND_ALIAS = { md: 'markdown', docx: 'doc', word: 'doc', xlsx: 'sheet', excel: 'sheet', pptx: 'slides', png: 'image', jpg: 'image', jpeg: 'image', mp4: 'video', mp3: 'audio', txt: 'text' };

/** Any loop in the needs (ids → needs), whatever order the steps come in. */
function loopIn(steps) {
  const needs = new Map(steps.map(s => [s.id, s.needs]));
  const state = new Map();
  const visit = id => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2 || !needs.has(id)) return false;
    state.set(id, 1);
    for (const n of needs.get(id)) if (visit(n)) return true;
    state.set(id, 2);
    return false;
  };
  return steps.some(s => visit(s.id));
}

/**
 * validatePlan(raw, { ws, roster, others, frozen }) → { ok, errors[], single, plan }.
 * `others` = agents of other workspaces (to say "that's another workspace's agent"), `frozen` = done steps a replan keeps.
 * `single`: the plan is valid but one agent can do it all (fewer than 2 steps, or one agent for every step) → a task card.
 */
export function validatePlan(raw, { ws, roster: R = roster(ws), others = [], frozen = [] } = {}) {
  const errors = [];
  const p = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(p.steps) ? p.steps : [];
  const mine = new Map(R.map(a => [a.slug, a]));
  const wsAgents = deps.agents(ws.id);
  const shared = deps.shared(ws.id);
  if (!list.length) errors.push('the plan has no steps');
  if (frozen.length + list.length > LIMITS.maxSteps) errors.push(`${frozen.length + list.length} steps; a mission has at most ${LIMITS.maxSteps}`);
  const steps = [];
  const seen = new Set(frozen.map(s => s.id));
  list.forEach((s, i) => {
    const rawId = String(s?.id ?? '').trim();
    const sid = ID_RE.test(rawId) ? rawId : `s${frozen.length + i + 1}`;
    if (seen.has(sid)) errors.push(`two steps are called "${sid}"`);
    seen.add(sid);
    let agent = String(s?.agent ?? '').trim().replace(/^@/, '').toLowerCase();
    if (agent.includes('/')) {
      const [w, slug] = agent.split('/');
      if (w && w !== String(ws.id).toLowerCase()) errors.push(`step ${sid}: ${agent} belongs to another workspace; a mission stays inside ${ws.name}`);
      agent = slug || '';
    }
    if (!agent || /^(general|generalist)$/.test(agent)) agent = 'general';
    if (!mine.has(agent)) {
      const here = wsAgents.find(a => a.slug === agent);
      const elsewhere = others.find(a => a.slug === agent && a.workspace !== ws.id);
      errors.push(agent === BUILDER_SLUG || here?.isBuilder ? `step ${sid}: the AI Agent Builder builds agents, it doesn't take mission steps`
        : shared.has(agent) ? `step ${sid}: ${agent} works with one of ${ownerName()}'s clients, so a mission can't use it`
        : here ? `step ${sid}: ${agent} can't run here (${here.error ? 'its file is broken' : 'no account for its engine'})`
        : elsewhere ? `step ${sid}: ${agent} is ${elsewhere.workspace}'s agent, not ${ws.name}'s; a mission stays inside one workspace`
        : `step ${sid}: there's no agent "${agent}" in ${ws.name}`);
    }
    const task = trim(s?.task, LIMITS.taskChars);
    if (!task) errors.push(`step ${sid} has no task`);
    const needs = [...new Set((Array.isArray(s?.needs) ? s.needs : s?.needs ? [s.needs] : []).map(x => String(x).trim()).filter(Boolean))];
    const expects = (Array.isArray(s?.expects) ? s.expects : []).slice(0, 4).map(x => {
      const k = String((typeof x === 'string' ? x : x?.kind) || '').toLowerCase().replace(/^\./, '');
      return { kind: KIND_ALIAS[k] || k, note: line(typeof x === 'string' ? '' : x?.note, 120) };
    }).filter(x => KINDS.has(x.kind));
    steps.push({ id: sid, agent, task, needs, expects, done_when: line(s?.done_when, 240) });
  });
  const ids = new Set([...frozen.map(s => s.id), ...steps.map(s => s.id)]);
  for (const s of steps) for (const n of s.needs) {
    if (n === s.id) errors.push(`step ${s.id} needs itself`);
    else if (!ids.has(n)) errors.push(`step ${s.id} needs "${n}", which isn't a step`);
  }
  if (loopIn([...frozen.map(s => ({ id: s.id, needs: s.needs || [] })), ...steps])) errors.push('the steps need each other in a loop');
  else {
    const order = [...frozen.map(s => s.id)];
    for (const s of steps) {
      for (const n of s.needs) if (n !== s.id && ids.has(n) && !order.includes(n)) errors.push(`step ${s.id} needs ${n}, which comes later; list steps in the order they run`);
      order.push(s.id);
    }
  }
  const everyAgent = [...frozen, ...steps].map(s => s.agent);
  const single = !errors.length && (everyAgent.length < LIMITS.minSteps || new Set(everyAgent).size < 2);
  return {
    ok: !errors.length && !single, errors: [...new Set(errors)], single,
    plan: { objective: line(p.objective, 300), done_when: line(p.done_when, 300), steps },
  };
}

// ── the planner (one Claude Code call under the workspace's own account) ──
/** Whose Claude Code account plans this workspace's mission: its own, logged in as it should be, or none (no mission). */
export async function planAccount(ws) {
  if (!deps.plannerReady()) return { ok: false, why: 'this Orchy has no Claude Code adapter to plan with' };
  const a = accountFor(ws, PLANNER_ENGINE);
  if (!a.email) return { ok: false, why: `${ws.name} has no Claude Code account of its own (claudeAccount in config.json), and Orchy never plans its work from another account` };
  let chk;
  try { chk = await deps.accountCheck(ws, { runtime: PLANNER_ENGINE }); } catch (e) { chk = { ok: false, error: e.message }; }
  if (!chk?.ok) return { ok: false, why: `${ws.name}'s Claude Code profile isn't logged in as ${a.email}${chk?.actual ? ` (it's ${chk.actual})` : ''}` };
  return { ok: true, email: a.email, configDir: a.profileDir || null };
}

// a neutral folder: no workspace or Orchy CLAUDE.md lands in the planner's context
function planCwd() {
  const d = path.join(os.tmpdir(), 'orchy-mission');
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}
export function parseJSON(text) {
  const s = String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

export function planPrompt({ ws, text, files = [], R, frozen = [], errors = null, why = '' }) {
  const who = ownerName();
  return `You are Orchy, planning a MISSION for ${who}: one ask that needs several of ${ws.name}'s agents (client ${ws.client || ws.name}) in sequence, each step's output feeding the next. You only plan; you run nothing.

Rules:
- ${LIMITS.minSteps} to ${LIMITS.maxSteps} steps${frozen.length ? ' in total, counting the done steps below' : ''}. Each step is ONE agent from the roster below, by its slug (or "general" for the generalist). Never an agent that isn't listed.
- "needs": the ids of earlier steps whose output this step uses. Steps with no needs between them may run at the same time. List steps in the order they run.
- "expects": the files the step must leave, as [{"kind": "pdf|doc|markdown|csv|sheet|slides|image|video|audio|html|text|document|report|spreadsheet|deck|file", "note": "…"}]. Only when the step makes a file; [] otherwise.
- "task": what that agent must do, in plain words, as ${who} would brief it. "done_when": how to tell the step is done.
- If one agent (or the generalist) can do it all, or one department head's team covers it (a head hands work to its own team), return ONE step for that agent.
- An agent ${who} names does the part ${who} gives it; if ${who} names one agent for all of it, return ONE step for that agent.
- Plan only what ${who} asked: no extra review, sending, posting, publishing, paying or deleting steps unless ${who} asked for them (those still ask ${who} when they run).
- Reply with JSON only, no prose: {"objective": "…", "done_when": "…", "steps": [{"id": "s1", "agent": "slug", "task": "…", "needs": [], "expects": [], "done_when": "…"}]}

${who.toUpperCase()}'S ASK:
${trim(text, 4000)}
${files.length ? `\nFILES ${who.toUpperCase()} ATTACHED (they go to every step): ${files.join(', ')}\n` : ''}
ROSTER (${ws.name} only):
${R.map(a => `- ${a.slug} · ${a.slug === 'general' ? a.name : `${a.name}${a.role !== a.name ? `, ${a.role}` : ''}`}${a.engine !== ws.runtime ? ` (${a.engine})` : ''}: ${a.does}${a.team?.length ? ` Heads a team: ${a.team.join(', ')}.` : ''}`).join('\n')}
${frozen.length ? `\nALREADY DONE (keep them: don't repeat or re-plan them; later steps may need their ids):\n${frozen.map(s => `- ${s.id} · ${s.agent}: ${line(s.task, 200)} → ${line(s.summary || 'done', 300)}`).join('\n')}\n${why ? `Why ${who} asked for a new plan: ${why}\n` : ''}Plan only the steps still to do; new ids must not reuse the ones above.\n` : ''}${errors?.length ? `\nYOUR LAST PLAN WAS REFUSED: ${errors.join('; ')}. Fix exactly that.\n` : ''}`;
}

/**
 * Plan (or replan) under the workspace's own account. One re-ask with the errors when the plan doesn't hold up.
 * → { ok, plan, attempts, firstTry, cost, ms } | { ok:false, single?, plan?, why, errors?, attempts, cost }
 */
export async function plan({ ws, text, files = [], frozen = [], why = '', purpose = 'mission-plan' }) {
  const acct = await planAccount(ws);
  if (!acct.ok) return { ok: false, why: acct.why, attempts: 0, cost: 0, noAccount: true };
  const R = roster(ws);
  const others = deps.allAgents().filter(a => a.workspace !== ws.id);
  const model = config.orchy?.missionModel || 'sonnet';
  const t0 = deps.now();
  let errors = null, cost = 0, attempts = 0;
  while (attempts < 2) {
    attempts++;
    let r;
    try { r = await deps.think({ prompt: planPrompt({ ws, text, files, R, frozen, errors, why }), model, tools: '', timeoutMs: 120_000, configDir: acct.configDir, cwd: planCwd(), purpose, workspace: ws.id }); }
    catch (e) { return { ok: false, why: `the planner failed: ${line(e.message, 200)}`, attempts, cost }; }
    cost += Number(r?.costUsd) || 0;
    const raw = parseJSON(r?.text);
    const v = raw ? validatePlan(raw, { ws, roster: R, others, frozen }) : { ok: false, errors: ["the planner's reply wasn't JSON"] };
    if (v.ok) return { ok: true, plan: v.plan, attempts, firstTry: attempts === 1, cost: round(cost), ms: deps.now() - t0, model };
    if (v.single) return { ok: false, single: true, plan: v.plan, attempts, cost: round(cost), why: 'one agent can do this end to end' };
    errors = v.errors;
  }
  return { ok: false, errors, attempts, cost: round(cost), why: `the plan didn't hold up twice (${errors.join('; ')})` };
}

// ── propose: the owner's ask → a planned mission card ──
const newStep = (s, R) => ({ ...s, agentName: agentLabel(R, s.agent), status: 'pending', runId: null, runIds: [], attempts: { runs: 0, fixes: 0, retries: 0 }, validation: null, summary: '', result: '', outputs: [], files: [], cost: 0 });

/**
 * Jev read the owner's message as a mission (router.mjs intent `mission`). Makes the mission (status `planning`), puts
 * its card in the session, plans in the background. `routing` = the router's answer (missionP, missionSure, holdReason).
 */
export function propose({ text, workspace: wsId, session, routing = {}, files = [], viaVoice = false }) {
  const ws = deps.workspace(wsId);
  if (!ws.enabled) throw Object.assign(new Error(`${ws.name} is switched off, so Orchy isn't sending it work.`), { status: 409 });
  if (ws.builtin) throw Object.assign(new Error('Missions are for client workspaces'), { status: 400 });
  const m = {
    id: deps.id('mis'), workspace: ws.id, session: session || null, text: String(text || '').trim(), files: files.slice(0, 10),
    status: 'planning', createdAt: iso(), startedAt: null, endedAt: null, objective: '', done_when: '', steps: [],
    routing: { p: routing.missionP ?? null, sure: !!routing.missionSure, holdReason: routing.holdReason || null, source: routing.source || 'jev' },
    sure: false, startAt: null, held: false, taskDir: null, cost: 0, costs: { plan: 0, steps: 0 }, ceiling: missionSettings().ceiling,
    autoFixes: 0, ask: null, asks: [], plan: null, replan: null, result: null, notes: [], viaVoice: !!viaVoice,
  };
  all()[m.id] = m;
  touch(m, 'mission.created');
  const msg = deps.say(`That needs several of ${ws.name}'s agents, so I'm planning it as a mission.`, { missionId: m.id, workspace: ws.id, kind: 'mission', session: m.session, speak: !!viaVoice });
  m.messageId = msg?.id || null;
  const p = planNow(m).catch(e => { deps.log(`${m.id}: planning failed: ${e.message}`); toFallback(m, { why: `planning failed: ${e.message}` }); }).finally(() => planning.delete(m.id));
  planning.set(m.id, p);
  return m;
}
const planning = new Map(); // missionId → the planner call in flight
/** Resolves once the mission's plan is in (tests, and anything that must wait for the card). */
export const whenPlanned = mid => planning.get(mid) || Promise.resolve();

async function planNow(m) {
  const ws = deps.workspace(m.workspace);
  const r = await plan({ ws, text: m.text, files: m.files });
  m.cost = round(m.cost + r.cost);
  m.costs.plan = round(m.costs.plan + r.cost);
  m.plan = { attempts: r.attempts, firstTry: !!r.firstTry, cost: r.cost, model: r.model || null, ms: r.ms || null, at: iso() };
  if (m.status !== 'planning') { touch(m); return; } // the owner cancelled it meanwhile
  if (!r.ok) return toFallback(m, r);
  const R = roster(ws);
  Object.assign(m, { objective: r.plan.objective || line(m.text, 200), done_when: r.plan.done_when, steps: r.plan.steps.map(s => newStep(s, R)), status: 'planned' });
  m.sure = !!m.routing.sure && r.firstTry && !m.routing.holdReason;
  const s = missionSettings();
  if (m.sure && s.autoStart) arm(m, s.countdown);
  touch(m);
}

/** Not a mission after all (one agent can do it, the plan didn't hold up, no account): a plain task card instead. */
function toFallback(m, r) {
  m.status = 'fallback';
  m.fallback = { why: r.why || 'it fits a plain task better', single: !!r.single, agent: r.single ? r.plan?.steps?.[0]?.agent || null : null, at: iso() };
  m.endedAt = iso();
  touch(m);
  try { deps.fallback?.(m); } catch (e) { deps.log(`${m.id}: fallback card failed: ${e.message}`); }
}

function arm(m, secs) {
  disarm(m);
  m.startAt = new Date(deps.now() + secs * 1000).toISOString();
  m.held = false;
  timers.set(m.id, deps.setTimeout(() => { timers.delete(m.id); go(m.id, { auto: true }).catch(e => deps.log(`${m.id}: auto start failed: ${e.message}`)); }, secs * 1000));
}
function disarm(m) {
  if (timers.has(m.id)) { deps.clearTimeout(timers.get(m.id)); timers.delete(m.id); }
  m.startAt = null;
}

const need = (m, statuses, what) => {
  if (!m) throw Object.assign(new Error('That mission is gone'), { status: 404 });
  if (!statuses.includes(m.status)) throw Object.assign(new Error(`The mission is ${m.status}; it can't ${what} now`), { status: 409 });
};

/**
 * The owner edits the card while it waits: `steps: [{id, task?, agent?, remove?}]`. The countdown stops (like a
 * routing card the owner touched). The edited plan is checked again; it must still be a mission.
 */
export function patch(mid, body = {}) {
  const m = getMission(mid);
  need(m, ['planned'], 'be edited');
  disarm(m);
  m.held = true;
  const ws = deps.workspace(m.workspace);
  const R = roster(ws);
  const edits = new Map((Array.isArray(body.steps) ? body.steps : []).map(e => [String(e?.id), e || {}]));
  const removed = new Set([...edits.values()].filter(e => e.remove).map(e => String(e.id)));
  const raw = m.steps.filter(s => !removed.has(s.id)).map(s => {
    const e = edits.get(s.id) || {};
    return { id: s.id, agent: e.agent != null ? String(e.agent) : s.agent, task: e.task != null ? String(e.task) : s.task, needs: s.needs.filter(n => !removed.has(n)), expects: s.expects, done_when: s.done_when };
  });
  const v = validatePlan({ objective: m.objective, done_when: m.done_when, steps: raw }, { ws, roster: R, others: deps.allAgents().filter(a => a.workspace !== ws.id) });
  if (v.single) throw Object.assign(new Error('That leaves one agent doing it all: send it as a plain task instead'), { status: 400, single: true });
  if (!v.ok) throw Object.assign(new Error(v.errors.join('; ')), { status: 400 });
  const before = new Map(m.steps.map(s => [s.id, s]));
  m.steps = v.plan.steps.map(s => ({ ...before.get(s.id), ...s, agentName: agentLabel(R, s.agent) }));
  m.edited = true;
  touch(m);
  return m;
}

/** Hold the countdown (Stop on a sure card): the card waits for Go. */
export function hold(mid) {
  const m = getMission(mid);
  need(m, ['planned', 'planning'], 'be held');
  disarm(m);
  m.held = true;
  touch(m);
  return m;
}

/** Go: open the shared task folder and start the first steps. */
export async function go(mid, { auto = false } = {}) {
  const m = getMission(mid);
  need(m, ['planned'], 'start');
  disarm(m);
  const ws = deps.workspace(m.workspace);
  if (!ws.enabled) throw Object.assign(new Error(`${ws.name} is switched off`), { status: 409 });
  m.status = 'running';
  m.startedAt = iso();
  m.autoStarted = !!auto;
  // one shared folder (tasks.mjs#openTaskDir names it after the day and the objective), in the department of the
  // agent that takes the first step (tasks.mjs#taskRootFor; `general` = the generalist's), else the workspace's Tasks/
  if (deps.openTaskDir) {
    const t = { instruction: m.objective || m.text, startedAt: m.startedAt, workspace: ws.id, client: null, lead: m.steps[0]?.agent || 'general' };
    m.taskDir = deps.openTaskDir(ws, t);
    m.taskRoot = t.taskRoot || null;
  }
  m.filePaths = m.files.length ? deps.handFiles(ws, m.files) : [];
  touch(m);
  await tick(m);
  return m;
}

/** Stop: the countdown, every live step (quietly) and the mission. */
export function stop(mid, { why = `${ownerName()} stopped it` } = {}) {
  const m = getMission(mid);
  if (!m) throw Object.assign(new Error('That mission is gone'), { status: 404 });
  if (['done', 'partial', 'failed', 'stopped', 'fallback'].includes(m.status)) return m;
  disarm(m);
  for (const [k, t] of timers) if (k.startsWith(`${m.id}:`)) { deps.clearTimeout(t); timers.delete(k); }
  const wasPlanned = ['planning', 'planned'].includes(m.status);
  m.status = 'stopped';
  m.stopWhy = why;
  m.ask = null;
  m.asks = [];
  for (const s of m.steps) {
    if (LIVE_STEP.has(s.status)) {
      const r = s.runId && deps.db().runs[s.runId];
      if (r && deps.isLive(s.runId)) { r.quietReport = true; try { deps.stopRun(s.runId); } catch {} }
      s.status = 'stopped';
    } else if (!DONE_STEP.has(s.status) && s.status !== 'failed') s.status = 'stopped';
  }
  m.endedAt = iso();
  touch(m);
  if (!wasPlanned) wrapUp(m);
  return m;
}

// ── the supervisor ──
const ready = (m, s) => s.status === 'pending' && s.needs.every(n => DONE_STEP.has(m.steps.find(x => x.id === n)?.status));
const liveSteps = m => m.steps.filter(s => LIVE_STEP.has(s.status)).length;

/** Start what may start, end the mission when every step is done or skipped. Never starts steps beyond the plan. */
export async function tick(m) {
  if (!['running', 'waiting'].includes(m.status)) return;
  let ws;
  try { ws = deps.workspace(m.workspace); } catch { return pause(m, { kind: 'gone', text: `${m.workspace} is gone, so the mission can't go on.`, options: ['stop'] }); }
  if (!ws.enabled) {
    if ([m.ask, ...m.asks].some(a => a?.kind === 'off')) return;
    return pause(m, { kind: 'off', text: `${ws.name} was switched off, so I'm not starting its next steps.`, options: ['stop'] });
  }
  const s = missionSettings();
  if (m.cost >= m.ceiling && !m.asks.some(a => a.kind === 'ceiling') && m.ask?.kind !== 'ceiling') {
    pause(m, { kind: 'ceiling', text: `This mission has cost ${money(m.cost)}, at its ${money(m.ceiling)} ceiling, so I've paused it before the next step.`, options: ['raise', 'stop'] });
  }
  if (s.maxMin && m.startedAt && deps.now() - Date.parse(m.startedAt) > s.maxMin * 60_000 && !m.timeAsked) {
    m.timeAsked = true;
    pause(m, { kind: 'time', text: `This mission has run past ${s.maxMin} minutes (Settings → Missions), so I've paused it.`, options: ['continue', 'stop'] });
  }
  const blocked = [m.ask, ...m.asks].some(a => a && ['ceiling', 'time', 'restart', 'replan'].includes(a.kind));
  if (!blocked) {
    for (const st of m.steps) {
      if (liveSteps(m) >= s.maxLive) break;
      if (ready(m, st)) await startStep(m, st);
    }
  }
  if (m.steps.length && m.steps.every(x => DONE_STEP.has(x.status))) return finish(m);
  m.status = m.ask ? 'waiting' : 'running';
  touch(m);
}

function pause(m, a) {
  const ask = { ...a, at: iso(), options: (a.options || []).map(k => ({ action: k, label: ACTION_LABEL[k] || k })) };
  const queued = !!m.ask;
  if (queued) m.asks.push(ask); else m.ask = ask;
  m.status = 'waiting';
  touch(m);
  // one ask at a time in the chat: a queued one is said when it comes up (closeAsk)
  if (!queued) deps.say(a.text, { missionId: m.id, workspace: m.workspace, kind: 'mission-ask', askAt: ask.at, session: m.session });
}
export const ACTION_LABEL = { accept: 'Accept as is', followup: 'Follow up', skip: 'Skip it', retry: 'Retry', reassign: 'Give to another agent', replan: 'Replan', stop: 'Stop the mission', raise: 'Raise the ceiling', continue: 'Keep going', resume: 'Resume', 'use-replan': 'Use the new plan', 'keep-plan': 'Keep the old plan' };

/** What a step's agent gets: its task, the mission, the shared folder, and its predecessors' outputs (never transcripts). */
export function stepInstruction(m, s) {
  const who = ownerName();
  const n = m.steps.indexOf(s) + 1;
  const kinds = s.expects.map(x => (x.note ? `${x.kind} (${x.note})` : x.kind)).join(', ');
  const inputs = s.needs.map(id => m.steps.find(x => x.id === id)).filter(Boolean).map(p => {
    if (p.status === 'skipped') return `### ${p.id} · ${p.agentName}: skipped by ${who}\n(No output from this step.)`;
    const body = trim([p.summary && `Summary: ${p.summary}`, p.result && `Result:\n${p.result}`].filter(Boolean).join('\n'), LIMITS.inputChars);
    return `### ${p.id} · ${p.agentName}: ${line(p.task, 160)}\n${body || '(It reported no summary.)'}${p.files.length ? `\nFiles: ${p.files.slice(0, 20).join(', ')}` : ''}`;
  });
  return `${s.task}

(Orchy: this is step ${n} of ${m.steps.length} of a mission for ${who}: "${m.objective}".${s.done_when ? ` This step is done when: ${s.done_when}.` : ''}
${m.taskDir ? `Work in the mission's shared folder ${taskRel(m)}/ and save every file you make there.` : 'Save the files you make in your Tasks/ folder.'}${kinds ? ` This step must leave: ${kinds}.` : ''} Do only this step: earlier steps are done (use what they left), later ones are other agents'.${m.filePaths?.length ? `\n${who} attached: ${m.filePaths.join(', ')}` : ''}${inputs.length ? `\n\nInputs from earlier steps:\n\n${inputs.join('\n\n')}` : ''})`;
}

async function startStep(m, s, { followUpOf = null, text = null, retryOf = null, fix = false } = {}) {
  const ws = deps.workspace(m.workspace);
  s.status = fix ? 'fixing' : retryOf ? 'retrying' : 'running';
  s.attempts.runs++;
  s.startedAt ||= iso();
  touch(m);
  try {
    const run = await deps.startRun({
      workspace: ws.id, agentSlug: s.agent === 'general' ? null : s.agent, kind: 'task', instruction: text || stepInstruction(m, s),
      session: m.session, missionId: m.id, stepId: s.id, taskDir: m.taskDir, taskRoot: m.taskRoot || null, routing: { source: 'mission', missionId: m.id },
      ...(followUpOf ? { resumeSessionId: followUpOf.sessionId, parentRunId: followUpOf.id } : {}),
      ...(retryOf ? { retryOf: retryOf.id, retries: s.attempts.retries } : {}),
    });
    s.runId = run.id;
    s.runIds = [...new Set([...s.runIds, run.id])];
    if (s.status === 'retrying') s.status = 'running';
    if (m.status === 'stopped') { try { deps.stopRun(run.id); } catch {} return null; }
    touch(m);
    return run;
  } catch (e) {
    // the account check, the ungated-engine refusal, a switched-off workspace or a broken agent refuses it: the owner decides
    s.status = 'waiting';
    pause(m, { kind: 'failed', stepId: s.id, text: `I couldn't start ${s.agentName} on step ${nOf(m, s)}: ${line(e.message, 300)}`, options: ['retry', 'reassign', 'skip', 'stop'] });
    return null;
  }
}

// What counts as outward for the one automatic correction: anything that could have reached past the workspace.
// Reads and the step's own file writes don't; One executes, flows, network commands, writing MCP tools, pushes, an
// approval the owner was asked, a hand-off or an agent change do.
const LOCAL_WRITE = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'TodoWrite']);
const NET_SHELL = /\b(?:actions\s+execute|flow\s+execute|relay\s+create|curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|scp|ssh|ftp|sendmail|git\s+push|gh\s+(?:pr|issue|release|api|repo)|npm\s+publish|fetch\s*\(|https?:\/\/)/i;
const MCP_READ = /(?:^|__|_)(?:get|list|search|read|fetch|find|query|describe|retrieve|lookup|look_up|scrape|crawl|browse|extract|download|view|show|count)(?:_|$)/i;
const SHELL = new Set(['Bash', 'PowerShell']); // every engine's adapter records its commands as Bash (codex.mjs, acp.mjs)
export function outwardSteps(events = [], items = [], run = {}) {
  const out = [];
  for (const e of events) {
    if (e.kind !== 'tool' || recover.readOnlyStep(e) || LOCAL_WRITE.has(e.tool) || /^mcp__jos__(note|report_done|ask_user)$/.test(e.tool || '')) continue;
    const name = String(e.tool || '');
    const outward = SHELL.has(name) ? NET_SHELL.test(`${e.input?.command || ''} ${e.summary || ''}`)
      : /^mcp__/.test(name) ? !MCP_READ.test(name.split('__').pop())
      : true; // any other tool Orchy can't read as local counts as outward
    if (outward) out.push({ tool: name, summary: line(e.summary || e.input?.command || '', 120) });
  }
  for (const i of items) if (i.kind === 'approval') out.push({ tool: 'approval', summary: line(i.title || i.message, 120) });
  if (run.subRuns?.length) out.push({ tool: 'delegate', summary: `${run.subRuns.length} hand-off(s)` });
  if (run.createdAgents?.length) out.push({ tool: 'agents', summary: 'changed agents' });
  return out;
}

const stepOf = run => { const m = getMission(run.missionId); return { m, s: m?.steps.find(x => x.id === run.stepId) || null }; };
const filesOf = run => { try { return deps.artifactsFor(run).filter(a => a.status !== 'missing' && ((a.runIds || [a.runId]).includes(run.id) || String(a.updatedAt) >= String(run.startedAt))).map(a => a.rel); } catch { return []; } };

/** A step's run ended (server.mjs#onRunFinished, instead of Orchy's report and recover.afterRun). */
export async function onRunEnded(run) {
  const { m, s } = stepOf(run);
  // a stale run the step moved past, or a step (or mission) that's already settled
  if (!m || !s || s.runId !== run.id || DONE_STEP.has(s.status) || ['done', 'partial', 'fallback'].includes(m.status)) return false;
  s.cost = round(s.cost + (Number(run.costUsd) || 0));
  m.costs.steps = round(m.steps.reduce((t, x) => t + (x.cost || 0), 0));
  m.cost = round(m.costs.plan + m.costs.steps);
  s.files = [...new Set([...s.files, ...filesOf(run)])];
  if (m.status === 'stopped') { touch(m); return true; }
  const ok = run.outcome === 'completed' || run.outcome === 'partial';
  if (run.outcome === 'stopped') {
    s.status = 'waiting';
    pause(m, { kind: 'stopped', stepId: s.id, text: `Step ${nOf(m, s)} (${s.agentName}) was stopped before it finished.`, options: ['retry', 'skip', 'stop'] });
    await tick(m); // steps that don't need this one go on while the owner decides
    return true;
  }
  if (ok) {
    s.status = 'checking';
    touch(m);
    const v = await deps.validate(run, { semantic: missionSettings().jev, expects: s.expects });
    s.validation = { verdict: v.verdict, checks: (v.checks || []).filter(c => !c.ok), at: v.at };
    s.summary = trim(run.report?.summary || run.resultText, 1500);
    s.result = trim(run.report?.result, LIMITS.inputChars);
    s.outputs = (run.report?.outputs || []).slice(0, 20);
    if (m.status === 'stopped') { touch(m); return true; }
    if (v.verdict === 'ok') {
      s.status = 'done';
      s.endedAt = iso();
      await tick(m);
      return true;
    }
    const out = outwardSteps(deps.events(run.id), deps.items(run.id), run);
    if (s.attempts.fixes === 0 && !out.length && m.autoFixes < LIMITS.autoFixes) {
      s.attempts.fixes++;
      m.autoFixes++;
      m.notes.push({ at: iso(), text: `Step ${nOf(m, s)}: Orchy's check found ${line(validate.problems(v), 200)}; one automatic fix sent.` });
      await startStep(m, s, { followUpOf: run, text: validate.fixPrompt(v), fix: true });
      return true;
    }
    s.status = 'waiting';
    const why = validate.problems(v);
    pause(m, {
      kind: 'check', stepId: s.id,
      text: `My check of step ${nOf(m, s)} (${s.agentName}) found: ${line(why, 300)}. ${s.attempts.fixes ? 'It already had its one automatic fix.' : out.length ? `I didn't ask it to fix this on its own: it had already done something outward (${out[0].summary || out[0].tool}).` : 'The mission has used its automatic fixes.'}`,
      options: ['accept', 'followup', 'skip', 'stop'],
    });
    await tick(m);
    return true;
  }
  // failed or blocked: recover.mjs names it; a safe retry goes on its own, the rest is the owner's
  const c = deps.classify(run);
  if (c?.retry === 'auto' && s.attempts.retries < LIMITS.retries) {
    const g = deps.retryGate({ ...run, retries: s.attempts.retries });
    if (g.ok) {
      s.attempts.retries++;
      s.status = 'retrying';
      const wait = deps.retryDelay(s.attempts.retries);
      m.notes.push({ at: iso(), text: `Step ${nOf(m, s)}: ${c.label}, before it changed anything; retrying in ${Math.round(wait / 1000)}s.` });
      touch(m);
      const key = `${m.id}:${s.id}`;
      timers.set(key, deps.setTimeout(() => {
        timers.delete(key);
        if (m.status === 'stopped' || s.status !== 'retrying') return null;
        return startStep(m, s, { retryOf: run }).then(() => touch(m));
      }, wait));
      return true;
    }
  }
  s.status = 'waiting';
  s.failure = { cls: c?.cls || 'failed', label: c?.label || 'it failed', why: line(c?.why || run.error || run.report?.summary, 300) };
  pause(m, { kind: 'failed', stepId: s.id, text: `Step ${nOf(m, s)} (${s.agentName}) ${run.report?.status === 'blocked' ? 'is blocked' : 'failed'}: ${s.failure.label}${s.failure.why ? ` (${s.failure.why})` : ''}.`, options: ['retry', 'reassign', 'skip', 'replan', 'stop'] });
  await tick(m);
  return true;
}

/** Jev picks who else could take a step (the owner confirms on the card). Falls back to the first other agent. */
async function suggestAgent(m, s) {
  const ws = deps.workspace(m.workspace);
  const R = roster(ws).filter(a => a.slug !== s.agent);
  if (!R.length) return null;
  try {
    const res = await deps.ask({ task: s.task, mission: m.objective, failed_with: s.failure?.label || s.validation?.checks?.map(c => c.note).join('; ') || '' },
      { agent: { type: 'choice', instructions: 'Which of these agents is best placed to do this task instead?', criteria: Object.fromEntries(R.map(a => [a.slug, `${agentLabel(R, a.slug)}: ${a.does}`])) } },
      { purpose: 'mission-reassign', timeoutMs: 8_000, fallback: false });
    const c = res.answers?.agent;
    if (c?.choice && R.some(a => a.slug === c.choice)) return { agent: c.choice, agentName: agentLabel(R, c.choice), p: c.confidence ?? null };
  } catch (e) { deps.log(`${m.id}: reassign pick failed: ${e.message}`); }
  return { agent: R[0].slug, agentName: agentLabel(R, R[0].slug), p: null };
}

function closeAsk(m) {
  m.ask = m.asks.shift() || null;
  if (m.ask) deps.say(m.ask.text, { missionId: m.id, workspace: m.workspace, kind: 'mission-ask', askAt: m.ask.at, session: m.session });
}

/** Every answer the card can send (POST /api/missions/:id/act). */
export const ACTIONS = ['go', 'hold', 'stop', 'as-task', 'accept', 'followup', 'skip', 'retry', 'reassign', 'replan', 'use-replan', 'keep-plan', 'raise', 'continue', 'resume'];

/**
 * The owner's answer on the mission card (POST /api/missions/:id/act): go | hold | stop | as-task, and for an open ask
 * accept | followup (text) | skip | retry | reassign (agent; without one Jev suggests and the card asks to confirm) |
 * replan | use-replan | keep-plan | raise | continue | resume.
 */
export async function act(mid, { action, agent = null, text = '' } = {}) {
  const m = getMission(mid);
  if (!m) throw Object.assign(new Error('That mission is gone'), { status: 404 });
  if (action === 'go') return go(mid);
  if (action === 'hold') return hold(mid);
  if (action === 'stop') return stop(mid);
  if (action === 'as-task') { need(m, ['planned', 'planning'], 'become a task'); disarm(m); toFallback(m, { why: `${ownerName()} sent it as a plain task`, single: false }); return m; }
  need(m, ['waiting', 'running'], 'take that');
  const a = m.ask;
  if (!a) throw Object.assign(new Error('Nothing is waiting on you in this mission'), { status: 409 });
  if (!a.options.some(o => o.action === action)) {
    throw Object.assign(new Error(`"${action}" isn't one of the choices here`), { status: 400 });
  }
  const s = a.stepId ? m.steps.find(x => x.id === a.stepId) : null;
  const lastRun = s?.runId ? deps.db().runs[s.runId] : null;
  m.notes.push({ at: iso(), text: `${ownerName()}: ${ACTION_LABEL[action] || action}${s ? ` (step ${nOf(m, s)})` : ''}${agent ? ` → ${agent}` : ''}` });
  switch (action) {
    case 'accept': s.status = 'done'; s.endedAt = iso(); s.accepted = true; break;
    case 'skip': s.status = 'skipped'; s.endedAt = iso(); break;
    case 'followup': {
      const t = String(text || '').trim();
      if (!t) throw Object.assign(new Error('Write what it should do'), { status: 400 });
      if (!lastRun) throw Object.assign(new Error('That step has no run to follow up'), { status: 409 });
      closeAsk(m); m.status = 'running';
      await startStep(m, s, { followUpOf: lastRun, text: t });
      await tick(m);
      return m;
    }
    case 'retry': closeAsk(m); m.status = 'running'; s.status = 'pending'; s.failure = null; await tick(m); return m;
    case 'reassign': {
      if (!agent) { a.suggest = await suggestAgent(m, s); touch(m); return m; }
      const R = roster(deps.workspace(m.workspace));
      if (!R.some(x => x.slug === agent)) throw Object.assign(new Error(`${agent} can't take a step in this mission`), { status: 400 });
      s.agent = agent; s.agentName = agentLabel(R, agent); s.status = 'pending'; s.failure = null; s.attempts.fixes = 0;
      break;
    }
    case 'replan': {
      const ws = deps.workspace(m.workspace);
      const frozen = m.steps.filter(x => DONE_STEP.has(x.status));
      a.planning = true; touch(m);
      const r = await plan({ ws, text: m.text, files: m.files, frozen, why: s?.failure?.label || a.text, purpose: 'mission-replan' });
      a.planning = false;
      m.cost = round(m.cost + r.cost); m.costs.plan = round(m.costs.plan + r.cost);
      if (!r.ok && !r.single) { a.replanError = r.why; touch(m); return m; }
      const R = roster(ws);
      m.replan = { steps: (r.plan?.steps || []).map(x => newStep(x, R)), at: iso(), cost: r.cost };
      closeAsk(m);
      pause(m, { kind: 'replan', text: `New plan for the rest of the mission: ${m.replan.steps.map(x => `${x.agentName}: ${line(x.task, 60)}`).join(' → ')}. The done steps stay as they are.`, options: ['use-replan', 'keep-plan', 'stop'] });
      return m;
    }
    case 'use-replan': {
      if (!m.replan) throw Object.assign(new Error('There is no new plan'), { status: 409 });
      for (const x of m.steps) if (LIVE_STEP.has(x.status) && x.runId && deps.isLive(x.runId)) { const r = deps.db().runs[x.runId]; if (r) r.quietReport = true; try { deps.stopRun(x.runId); } catch {} }
      m.steps = [...m.steps.filter(x => DONE_STEP.has(x.status)), ...m.replan.steps];
      m.replanned = (m.replanned || 0) + 1;
      m.replan = null;
      break;
    }
    case 'keep-plan': m.replan = null; break;
    case 'raise': m.ceiling = round(m.ceiling + missionSettings().ceiling); break;
    case 'continue': break;
    case 'resume': {
      closeAsk(m); m.status = 'running';
      for (const x of m.steps.filter(y => y.status === 'interrupted')) {
        const r = x.runId ? deps.db().runs[x.runId] : null;
        if (r?.sessionId) await startStep(m, x, { followUpOf: r, text: recover.RESUME_TEXT }); else x.status = 'pending';
      }
      await tick(m);
      return m;
    }
    default: throw Object.assign(new Error('Unknown choice'), { status: 400 });
  }
  closeAsk(m);
  m.status = 'running';
  await tick(m);
  return m;
}

// ── the end ──
async function objectiveMet(m) {
  try {
    const res = await deps.ask({
      mission_objective: m.objective, owner_asked: trim(m.text, 1500), done_when: m.done_when || '',
      steps: m.steps.map(s => `${s.id} · ${s.agentName} · ${s.status}: ${line(s.summary || s.task, 400)}${s.files.length ? ` (files: ${s.files.slice(0, 6).join(', ')})` : ''}`).join('\n'),
    }, { met: { type: 'noul', instructions: `Do the steps' reports show the mission's objective is met, as ${ownerName()} asked it?` } }, { purpose: 'mission-check', timeoutMs: 8_000, fallback: false });
    const p = Number(res.answers?.met?.noul);
    return Number.isFinite(p) ? Math.round(p * 100) / 100 : null;
  } catch (e) { deps.log(`${m.id}: objective check skipped: ${e.message}`); return null; }
}

async function finish(m) {
  if (['done', 'partial'].includes(m.status)) return;
  const p = await objectiveMet(m);
  const skipped = m.steps.filter(s => s.status === 'skipped').length;
  m.result = { met: p, skipped, at: iso() };
  m.status = skipped || (p != null && p < LIMITS.objectiveMin) ? 'partial' : 'done';
  m.endedAt = iso();
  m.ask = null;
  touch(m);
  wrapUp(m);
}

/** One report in the session, one LOGS.md entry, TASK.md in the shared folder. */
function wrapUp(m) {
  let ws = null;
  try { ws = deps.workspace(m.workspace); } catch {}
  const files = [...new Set(m.steps.flatMap(s => s.files))];
  if (ws) {
    try { deps.appendLog?.(m, ws); } catch (e) { deps.log(`${m.id}: LOGS.md failed: ${e.message}`); }
    try { (deps.writeTask || writeTask)(m, ws); } catch (e) { deps.log(`${m.id}: TASK.md failed: ${e.message}`); }
  }
  const done = m.steps.filter(s => s.status === 'done').length;
  const head = m.status === 'stopped' ? `Mission stopped in ${ws?.name || m.workspace}: ${done} of ${m.steps.length} steps done.`
    : `Mission ${m.status === 'done' ? 'done' : 'partly done'} in ${ws?.name || m.workspace}: ${m.objective}.`;
  const how = m.steps.map(s => `${s.agentName} ${s.status === 'done' ? (s.accepted ? 'finished (you accepted it as is)' : 'finished') : s.status}${s.summary ? `: ${line(s.summary, 160).replace(/[.;\s…]+$/, '')}` : ''}`).join('; ');
  const met = m.result?.met != null && m.status !== 'stopped' ? ` Jev reads the objective as ${m.result.met >= LIMITS.objectiveMin ? 'met' : 'not quite met'} (${Math.round(m.result.met * 100)}%).` : '';
  deps.say(`${head} ${how}.${met} Cost ${money(m.cost)}.${files.length ? ` ${files.length} file${files.length === 1 ? '' : 's'} in ${taskRel(m) || 'Tasks/'}.` : ''}`, {
    missionId: m.id, workspace: m.workspace, kind: 'mission-report', outcome: m.status, session: m.session, speak: !!m.viaVoice,
  });
}

/** <Tasks>/<folder>/TASK.md for the whole mission (its steps' own rounds aren't written one by one: tasks.mjs#saveTask). */
export function writeTask(m, ws) {
  if (!m.taskDir) return null;
  const who = ownerName();
  const dir = path.join(tasksBase(ws, m), m.taskDir);
  fs.mkdirSync(dir, { recursive: true });
  const title = line(m.objective || m.text, 90);
  const STEP = { done: 'Done', skipped: 'Skipped', stopped: 'Stopped', waiting: `Waiting on ${who}`, failed: 'Failed', pending: 'Not started', running: 'Running', fixing: 'Fixing', retrying: 'Retrying', checking: 'Being checked', interrupted: 'Cut off' };
  const text = `# Mission · ${title}

| | |
|---|---|
| **Status** | ${{ done: 'Done', partial: 'Partly done', stopped: 'Stopped', failed: 'Failed', running: 'Running', waiting: `Waiting on ${who}` }[m.status] || m.status} |
| **Started** | ${m.startedAt ? fmtTime(m.startedAt) : '—'} |
| **Finished** | ${m.endedAt ? fmtTime(m.endedAt) : '—'} |
| **Workspace** | ${ws.name}${ws.client ? ` — ${ws.client}` : ''} |
| **Mission** | \`${m.id}\` · cost ${money(m.cost)} (plan ${money(m.costs.plan)}) |
| **Runs** | ${m.steps.flatMap(s => s.runIds).map(r => `\`${r}\``).join(', ') || '—'} |

Orchy writes this file for the mission; everything else in this folder is what its steps made.

## ${who} asked

${m.text.split('\n').map(l => `> ${l}`).join('\n')}

**Objective:** ${m.objective}${m.done_when ? `\n**Done when:** ${m.done_when}` : ''}

${m.steps.map((s, i) => `## Step ${i + 1} · ${s.agentName} · ${STEP[s.status] || s.status}

**Task:** ${s.task}${s.needs.length ? `\n**After:** ${s.needs.join(', ')}` : ''}${s.expects.length ? `\n**Expected:** ${s.expects.map(x => x.kind).join(', ')}` : ''}

${s.summary || '—'}
${s.result ? `\n${s.result}\n` : ''}
**Files**
${bullets(s.files)}
${s.validation && s.validation.verdict !== 'ok' ? `\n**Orchy's check:** ${s.validation.checks.map(c => `${c.name}: ${c.note}`).join('; ')}\n` : ''}`).join('\n')}
${m.notes.length ? `## Notes\n${bullets(m.notes.map(n => `${fmtTime(n.at)}: ${n.text}`))}\n` : ''}`;
  fs.writeFileSync(path.join(dir, 'TASK.md'), text);
  return path.join(dir, 'TASK.md');
}

// ── a restart ──
/**
 * Orchy started again (server.mjs, after runner.markInterruptedRuns): a mission that was planning is stopped
 * (send it again), a counting-down card waits for Go, and a mission with live steps waits for the owner: Resume
 * (its cut-off steps pick up their own conversations) or Stop. Nothing starts on its own after a restart.
 */
export function boot() {
  for (const m of Object.values(all())) {
    if (m.status === 'planning') { m.status = 'stopped'; m.stopWhy = 'Orchy restarted while planning it'; m.endedAt = iso(); touch(m); deps.say('I restarted while planning that mission, so nothing started. Send it again when you like.', { missionId: m.id, workspace: m.workspace, kind: 'mission-ask', session: m.session }); continue; }
    if (m.status === 'planned' && m.startAt) { m.startAt = null; m.held = true; touch(m); continue; }
    if (!['running', 'waiting'].includes(m.status)) continue;
    const cut = m.steps.filter(s => LIVE_STEP.has(s.status) || s.status === 'checking');
    for (const s of cut) s.status = 'interrupted';
    // nothing was cut off: a mission waiting on the owner keeps its ask; one between steps goes on (the minute ticker)
    if (!cut.length) { if (!m.ask) m.status = 'running'; touch(m); continue; }
    pause(m, { kind: 'restart', text: `I restarted while the mission "${line(m.objective, 80)}" was going (${cut.map(s => s.agentName).join(', ')} cut off). Resume picks the cut-off steps up in their own conversations; nothing else starts until you say.`, options: ['resume', 'stop'] });
    // the restart ask goes first
    if (m.ask?.kind !== 'restart') {
      const r = m.asks.pop();
      m.asks.unshift(m.ask);
      m.ask = r;
      touch(m);
      deps.say(r.text, { missionId: m.id, workspace: m.workspace, kind: 'mission-ask', askAt: r.at, session: m.session });
    }
  }
}

let ticker = null;
/** server.mjs wires the runner and Orchy's voice; a minute ticker checks the duration cap and missions between steps. */
export function start(o = {}) {
  configure(o);
  if (!ticker) {
    // between steps (nothing live, nothing waiting on the owner) or with a time cap set, look again once a minute
    ticker = setInterval(() => {
      const capped = !!missionSettings().maxMin;
      for (const m of Object.values(all())) {
        if (m.status !== 'running' || (!capped && m.steps.some(s => LIVE_STEP.has(s.status) || s.status === 'checking'))) continue;
        tick(m).catch(e => deps.log(`${m.id}: tick failed: ${e.message}`));
      }
    }, 60_000);
    ticker.unref?.();
  }
}
export const _timers = timers;
