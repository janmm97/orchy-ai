// Orchy in huddles: Orchy reads along after every agent turn and, now and then, speaks as himself through the same
// h.turns (so every agent reads it in its next prompt, no protocol fork). Cheap first: hard skips with no call at all
// (Settings off, its own line, budget spent, cooldown, too early, wrapping), then one Jev `choice` (purpose `coach`)
// over observe | challenge | advise (| withdraw once an agent pushed back on him). Only when Jev says speak does he
// write the line: one tool-less Claude call (config.orchy.coachModel, default sonnet) under the HUDDLE'S WORKSPACE
// Claude Code account, checked with workspaces.mjs#accountCheck first. Never Orchy's own (root) account for another
// workspace's huddle: a workspace with no Claude Code account of its own gets no coaching at all. The call is recorded
// in orchy-costs.jsonl as `huddle-coach`. A challenge makes everyone say ready again (readyFrom); advice doesn't. At
// wrap time, when the agreement has dissent, one more call writes `agreement.orchyTake` for the owner. Orchy never
// approves, never assigns work, never clears an ask, never runs the One CLI, and his lines never go to the owner's
// chat one by one. He uses the owner's standing rules and the team's settings (rules.mjs#rulesText) so agents stop
// asking what's already decided.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from './store.mjs';
import { config, ownerName } from './env.mjs';
import { ask as jevAsk, jevMode } from './jev.mjs';
import { quickClaude } from './claude.mjs';
import { workspace as wsOf, accountFor, accountCheck } from './workspaces.mjs';
import { engine } from './engines/index.mjs';
import { rulesText } from './rules.mjs';

/** Limits: 3 interventions by default (0–6 in Settings), quiet for 2 agent turns after he speaks. */
export const COACH = { max: 3, cap: 6, cooldown: 2, minTurns: 2, gateMs: 8_000, totalMs: 45_000, observeMin: 0.45, winMin: 0.5, chars: 12_000, field: 300, words: 120 };
// Orchy's own lines are written by Claude Code (quickClaude), so the coach needs the workspace's Claude Code login
const WRITER_ENGINE = 'claude';

// what the coach touches outside itself; test-coach.mjs swaps these (no Jev, no Claude, no account lookups)
const deps = {
  ask: jevAsk, think: quickClaude, accountCheck, workspace: wsOf, jevMode, rules: rulesText,
  settings: () => db().settings || {}, now: () => Date.now(), log: msg => console.log(`[coach] ${msg}`),
};
export function _testDeps(over) { Object.assign(deps, over); }

/** Settings → Huddles: "Orchy joins huddles" (huddleCoach, on) and "Orchy's interventions per huddle" (huddleCoachMax, 0–6, 3). */
export function coachSettings(s = deps.settings()) {
  const n = Number(s.huddleCoachMax);
  return {
    on: s.huddleCoach !== false,
    max: s.huddleCoachMax != null && Number.isFinite(n) ? Math.min(COACH.cap, Math.max(0, Math.round(n))) : COACH.max,
    model: config.orchy?.coachModel || 'sonnet',
  };
}

const isOwnerLine = t => t.by === 'owner';
const isTalk = t => !isOwnerLine(t) && t.by !== 'orchy';
const isCoach = t => t.by === 'orchy' && t.kind === 'coach';
const trim = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
const words = (s, n) => { const w = String(s || '').split(/\s+/).filter(Boolean); return w.length > n ? `${w.slice(0, n).join(' ')}…` : w.join(' '); };
const stateOf = h => (h.coach ||= { count: 0, issues: [], cost: 0, calls: 0 });
const nameOf = (h, slug) => h.agents.find(a => a.slug === slug)?.name || slug;
export const MODE_LABEL = { challenge: 'challenges', advise: 'suggests', withdraw: 'withdraws' };

// the same issue in other words: most of its content words already raised
const STOP = new Set('a an the of to for in on and or is are be it its this that with by from as at no not new'.split(' '));
const keyWords = s => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(w => w.length > 2 && !STOP.has(w)));
export function sameIssue(a, b) {
  const x = keyWords(a), y = keyWords(b);
  if (!x.size || !y.size) return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  const both = [...x].filter(w => y.has(w)).length;
  return both / Math.min(x.size, y.size) >= 0.6;
}

/**
 * What each new agent turn does to Orchy's open points (no model): naming Orchy in its `challenge` disputes the
 * point (the gate may then withdraw it); otherwise the first turn after it (the addressed agent's, if he named one)
 * answers it, so the "Orchy raised" line stops going to the next speakers.
 */
export function track(h, turn) {
  if (!turn || !isTalk(turn)) return;
  const c = stateOf(h);
  const at = h.turns.indexOf(turn);
  for (const i of c.issues) {
    if (i.status !== 'open' || at <= i.i) continue;
    if (turn.challenge && /\borchy\b/i.test(turn.challenge)) { i.pushback = { by: turn.by, name: turn.name, text: trim(turn.challenge, 400) }; continue; }
    if (!i.pushback && (!i.to || i.to === turn.by)) { i.status = 'answered'; i.answeredBy = turn.name; }
  }
}

const disputed = h => stateOf(h).issues.filter(i => i.status === 'open' && i.pushback);

/** The hard skips: a reason to stay quiet with no call at all, or null. */
export function skipWhy(h, turn, s = coachSettings()) {
  if (!s.on) return 'off';
  if (!turn || !isTalk(turn)) return 'own line'; // never reacts to its own lines, join lines or the owner's
  if (h.status !== 'talking' || turn.wrap) return 'wrapping';
  if (h.turns.filter(isTalk).length < COACH.minTurns) return 'too early';
  const last = h.turns.findLastIndex(isCoach);
  if (last >= 0 && h.turns.slice(last + 1).filter(isTalk).length < COACH.cooldown) return 'cooldown';
  // budget spent: only a withdrawal (a concession, not more pressure) is still possible
  if ((stateOf(h).count || 0) >= s.max && !disputed(h).length) return s.max ? 'budget' : 'off';
  return null;
}

/**
 * Whose Claude Code account Orchy writes under in this huddle: the huddle workspace's own, or none (then no
 * coaching). The workspace must name its own Claude Code account (claudeAccount), and its profile must be logged in
 * as exactly that account (the same accountCheck every run passes).
 */
export async function coachAccount(h) {
  let ws;
  try { ws = deps.workspace(h.workspace); } catch { return { ok: false, why: 'its workspace is gone' }; }
  const eng = engine(WRITER_ENGINE);
  if (!eng) return { ok: false, why: 'this Orchy has no Claude Code adapter' };
  const a = accountFor(ws, WRITER_ENGINE);
  if (!a.email) return { ok: false, why: `${ws.name} has no ${eng.label} account of its own (${eng.fields.account} in config.json), and Orchy never speaks in its huddle from another account` };
  let chk;
  try { chk = await deps.accountCheck(ws, { runtime: WRITER_ENGINE }); } catch (e) { chk = { ok: false, error: e.message }; }
  if (!chk?.ok) return { ok: false, why: `${ws.name}'s ${eng.label} profile isn't logged in as ${a.email}${chk?.actual ? ` (it's ${chk.actual})` : ''}` };
  return { ok: true, ws, email: a.email, configDir: a.profileDir || null };
}

const roster = h => h.agents.map(a => `- ${a.name} · ${a.role} (\`${a.slug}\`)${a.does ? `: ${trim(a.does, 200)}` : ''}`).join('\n');
const raisedList = h => stateOf(h).issues.map(i => `- [${i.mode}, ${i.status}${i.pushback ? `, ${i.pushback.name} pushed back: ${trim(i.pushback.text, 200)}` : ''}] ${i.about}`).join('\n');
const lineOf = t => `${isOwnerLine(t) ? ownerName() : t.name}${isCoach(t) ? ` (Orchy ${MODE_LABEL[t.mode] || ''})` : ''}: ${t.text}${t.challenge ? `\n  Pushes back: ${t.challenge}` : ''}${t.questions?.length ? `\n  For ${ownerName()}: ${t.questions.join(' · ')}` : ''}${t.ready ? ' (ready to agree)' : ''}`;
/** The talk, newest kept, capped at ~12k characters. */
export function transcript(h, max = COACH.chars) {
  const out = [];
  let n = 0;
  for (const t of [...h.turns].reverse()) {
    const l = lineOf(t);
    if (n + l.length > max) { out.push('[earlier turns cut]'); break; }
    out.push(l);
    n += l.length + 2;
  }
  return out.reverse().join('\n\n');
}

const gateCriteria = who => ({
  observe: 'Stay quiet: the talk is productive, or the issue is minor, or Orchy already raised it (see orchy_already_raised), or the agents are handling it themselves.',
  challenge: `Challenge: a flaw they must answer before agreeing. The proposal adds infrastructure, a service or a dependency where an existing part would do; a risk, dependency or failure path nobody addressed; they go round in circles (the same point two or more turns with no movement); they disagree on a major point; the plan drifts from what ${who} asked; or someone proposes an irreversible or outward action.`,
  advise: `Advise: a clearly better order, parallelism or option they can take or leave; or a question for ${who}, or a choice they argue about, that ${who}'s standing rules or the team's settings (owner_rules) already settle.`,
  withdraw: 'Withdraw: an agent pushed back on a point Orchy raised (see orchy_already_raised) with a sound reason, so Orchy concedes instead of repeating it.',
});

/** The Jev gate: one choice call. Observe wins unless P(observe) < 0.45 and the winner ≥ 0.5. */
export async function gate(h, { withdrawOnly = false, rules = '' } = {}) {
  const ws = deps.workspace(h.workspace);
  const who = ownerName();
  const G = gateCriteria(who);
  const canWithdraw = disputed(h).length > 0;
  const criteria = withdrawOnly ? { observe: G.observe, withdraw: G.withdraw }
    : { observe: G.observe, challenge: G.challenge, advise: G.advise, ...(canWithdraw ? { withdraw: G.withdraw } : {}) };
  const state = {
    workspace: ws.name,
    owner_asked: trim(h.topic, 1500),
    team: roster(h),
    recent_turns: h.turns.slice(-6).map(t => trim(lineOf(t), 900)).join('\n\n'),
    orchy_already_raised: raisedList(h) || 'nothing yet',
    owner_rules: trim(rules, 2500) || 'none written',
  };
  const res = await deps.ask(state, {
    mode: {
      type: 'choice',
      instructions: `Orchy moderates a huddle where ${ws.name}'s AI agents talk a task for ${who} through before anything is built. Should Orchy speak after this turn? Most turns he should not: speak only when it changes the outcome. Never raise again what orchy_already_raised lists.`,
      criteria,
    },
  }, { purpose: 'coach', timeoutMs: COACH.gateMs, fallback: false });
  const a = res?.answers?.mode || {};
  const p = a.probabilities || {};
  const conf = Number.isFinite(a.confidence) ? a.confidence : null;
  const observe = p.observe ?? (a.choice === 'observe' ? conf ?? 1 : conf != null ? 1 - conf : 1);
  const win = a.choice && a.choice !== 'observe' ? (p[a.choice] ?? conf ?? 0) : 0;
  const mode = a.choice && a.choice !== 'observe' && criteria[a.choice] && observe < COACH.observeMin && win >= COACH.winMin ? a.choice : 'observe';
  return { mode, observe, win, ms: res?.ms ?? null };
}

function withTimeout(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} took over ${ms / 1000}s`)), ms); })]).finally(() => clearTimeout(t));
}
// a neutral folder for the writer: no workspace or Orchy CLAUDE.md gets loaded into its context
function coachCwd() {
  const d = path.join(os.tmpdir(), 'orchy-coach');
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

const PERSONA = ws => `You are Orchy, the orchestrator who moderates a huddle of ${ws.name}'s AI agents for ${ownerName()}. You read along and step in only when it changes the outcome. You never approve anything, never assign work and never decide for ${ownerName()}; the agents may disagree with you, and that's fine. Speak like a sharp, friendly teammate: plain words, concrete, no flattery.`;

function linePrompt(h, ws, mode, rules) {
  const who = ownerName();
  return `${PERSONA(ws)}

${who} asked:
> ${trim(h.topic, 1500)}

Who's in the room:
${roster(h)}
${rules ? `\n${rules.trim()}\nWhen an agent asks ${who}, or argues about, something these already settle, point to the rule instead: that's a good reason to speak.\n` : ''}
What you already raised in this huddle (never repeat one):
${raisedList(h) || '- nothing yet'}

The talk so far (oldest cut first):
${transcript(h)}

A quick check says you should ${mode === 'challenge' ? 'CHALLENGE: name a flaw they must answer before they agree' : 'ADVISE: offer a better option they can take or leave'}. Look for: infrastructure, services or dependencies added where an existing part would do; a risk, dependency or failure path nobody addressed; going round in circles; a major disagreement; drifting from ${who}'s ask; an irreversible or outward action; a clearly better order or parallelism; a question for ${who} that a rule above already answers. If on reading it you find nothing worth saying, decline.

Reply with JSON only, no prose around it:
{"speak": true, "mode": "challenge" or "advise", "about": "the issue in at most 8 words", "to": "the slug of the one agent it's for, or empty", "observation": "what you see", "concern": "why it matters", "alternative": "what else they could do", "tradeoff": "what the alternative costs", "recommendation": "what you'd do", "basis": "the rule or setting you rely on, or empty"}
or {"speak": false}. Each field one or two sentences under 300 characters, under ${COACH.words} words in all.`;
}

function takePrompt(h, ws, rules) {
  const g = h.agreement;
  const who = ownerName();
  return `${PERSONA(ws)}

${who} asked:
> ${trim(h.topic, 1500)}

They wrote this agreement:
${trim(g.summary, 2000)}
${g.decisions?.length ? `Decisions:\n${g.decisions.map(d => `- ${trim(d, 300)}`).join('\n')}\n` : ''}
Still contested (${who} decides):
${g.dissent.map(d => `- ${trim(d, 500)}`).join('\n')}
${rules ? `\n${rules.trim()}\n` : ''}
The talk (oldest cut first):
${transcript(h, 9000)}

Give ${who} your take on the contested point${g.dissent.length > 1 ? 's' : ''}: compare the options and say which you'd pick and why. It's advice: ${who} still decides and approves. Reply with JSON only:
{"take": "which option you'd pick, in one sentence", "why": "the reason, one or two sentences"}. Under 80 words in all.`;
}

const parseJSON = text => {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
};

/** The structure as one line agents read (`**Orchy:** …`) and HUDDLE.md keeps. */
export function renderLine({ mode, about, to, parts }, h) {
  const head = `${mode === 'challenge' ? 'I challenge' : 'A suggestion'}${to ? ` for ${nameOf(h, to)}` : ''}: ${about}.`;
  const rows = [['Observation', parts.observation], ['Concern', parts.concern], ['Alternative', parts.alternative], ['Trade-off', parts.tradeoff], ['Recommendation', parts.recommendation]]
    .filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  return [head, ...rows].join('\n');
}

const recordCost = (h, r) => {
  const c = stateOf(h);
  c.calls = (c.calls || 0) + 1;
  if (typeof r?.costUsd === 'number') c.cost = Math.round(((c.cost || 0) + r.costUsd) * 100000) / 100000;
};
const rulesOf = h => { try { return deps.rules(h.workspace) || ''; } catch { return ''; } };

/**
 * After an agent's turn (huddle.mjs#onTurnEnded, before who speaks next): maybe one Orchy line in h.turns.
 * Returns the line pushed, or null. `busy(on)` lets the huddle window show "Orchy is thinking" while he writes.
 */
export async function coach(h, turn, { busy = () => {} } = {}) {
  const s = coachSettings();
  const c = stateOf(h);
  track(h, turn);
  const why = skipWhy(h, turn, s);
  if (why) { c.last = why; return null; }
  const t0 = deps.now();
  const acct = await coachAccount(h);
  if (!acct.ok) {
    if (c.off !== acct.why) deps.log(`${h.id}: Orchy stays out of this huddle: ${acct.why}.`);
    c.off = acct.why;
    return null;
  }
  c.off = null;
  if (deps.jevMode() === 'none') { c.last = 'no Jev'; deps.log(`${h.id}: Jev is off (no provider key), so no coaching.`); return null; }
  const rules = rulesOf(h);
  const open = disputed(h);
  let g;
  try { g = await withTimeout(gate(h, { withdrawOnly: c.count >= s.max, rules }), COACH.gateMs + 500, 'the gate'); }
  catch (e) { c.last = 'gate down'; deps.log(`${h.id}: gate failed, staying quiet: ${e.message}`); return null; }
  c.gates = (c.gates || 0) + 1;
  if (g.mode === 'observe' || h.status !== 'talking') { c.last = 'observe'; return null; }

  // conceding needs no writer call: the agent's reason stands
  if (g.mode === 'withdraw') {
    const i = open.at(-1);
    if (!i) return null;
    const line = { by: 'orchy', name: 'Orchy', kind: 'coach', mode: 'withdraw', about: i.about, text: `Orchy withdraws: ${i.about}. ${i.pushback.name}'s answer holds: ${trim(i.pushback.text.replace(/^orchy[,:\s]+/i, ''), 140)} Carry on.`, at: new Date().toISOString() };
    h.turns.push(line);
    i.status = 'withdrawn';
    i.withdrawnAt = h.turns.length - 1;
    return line;
  }
  if (c.count >= s.max) return null;
  const left = COACH.totalMs - (deps.now() - t0);
  if (left < 5_000) { c.last = 'out of time'; return null; }
  let out;
  busy(true);
  try {
    const r = await deps.think({ prompt: linePrompt(h, acct.ws, g.mode, rules), model: s.model, tools: '', timeoutMs: left, configDir: acct.configDir, cwd: coachCwd(), purpose: 'huddle-coach', workspace: h.workspace });
    recordCost(h, r);
    out = parseJSON(r?.text);
  } catch (e) { c.last = 'writer failed'; deps.log(`${h.id}: Orchy's line failed, staying quiet: ${e.message}`); return null; }
  finally { busy(false); }
  if (!out || out.speak === false || h.status !== 'talking') { c.last = 'declined'; return null; }
  const mode = out.mode === 'challenge' || out.mode === 'advise' ? out.mode : g.mode;
  const about = words(trim(out.about, 80), 8).replace(/[.\s]+$/, '');
  if (!about || c.issues.some(i => sameIssue(i.about, about))) { c.last = 'repeat'; return null; }
  const field = k => words(trim(out[k], COACH.field), 30);
  const parts = { observation: field('observation'), concern: field('concern'), alternative: field('alternative'), tradeoff: field('tradeoff'), recommendation: field('recommendation') };
  if (!parts.concern && !parts.recommendation) { c.last = 'empty'; return null; }
  const to = h.agents.some(a => a.slug === out.to) ? out.to : null;
  const basis = trim(out.basis, 200);
  const line = { by: 'orchy', name: 'Orchy', kind: 'coach', mode, about, parts, ...(to ? { to } : {}), ...(basis ? { basis } : {}), at: new Date().toISOString() };
  line.text = renderLine(line, h);
  h.turns.push(line);
  const at = h.turns.length - 1;
  // a challenge reopens the talk: everyone says ready again after answering it; advice doesn't
  if (mode === 'challenge') h.readyFrom = at;
  c.count++;
  c.issues.push({ about, mode, status: 'open', ...(to ? { to } : {}), i: at, at: line.at });
  c.last = mode;
  return line;
}

/** For an agent's next prompt: Orchy's open challenge it hasn't answered yet (for it, or for whoever speaks next). */
export function raisedFor(h, slug) {
  const i = (h.coach?.issues || []).find(x => x.status === 'open' && x.mode === 'challenge' && !x.pushback && (!x.to || x.to === slug) && !h.turns.slice(x.i + 1).some(t => t.by === slug));
  return i ? ` Orchy raised: ${i.about}. Answer it: agree and change course, or push back with evidence (name Orchy in \`challenge\`).` : '';
}

/**
 * At wrap time (advisor mode): when the agreement leaves points contested, Orchy compares the options for the owner
 * in `agreement.orchyTake {take, why}`. Advice only: the owner still decides and approves.
 */
export async function orchyTake(h) {
  const g = h.agreement;
  if (!g?.dissent?.length) return null;
  const s = coachSettings();
  if (!s.on) return null;
  const acct = await coachAccount(h);
  if (!acct.ok) { deps.log(`${h.id}: no take for ${ownerName()}: ${acct.why}.`); return null; }
  const rules = rulesOf(h);
  try {
    const r = await deps.think({ prompt: takePrompt(h, acct.ws, rules), model: s.model, tools: '', timeoutMs: COACH.totalMs, configDir: acct.configDir, cwd: coachCwd(), purpose: 'huddle-coach', workspace: h.workspace });
    recordCost(h, r);
    const out = parseJSON(r?.text);
    const take = words(trim(out?.take, COACH.field), 40);
    if (!take) return null;
    g.orchyTake = { take, why: words(trim(out.why, COACH.field), 50), at: new Date().toISOString() };
    return g.orchyTake;
  } catch (e) { deps.log(`${h.id}: Orchy's take failed: ${e.message}`); return null; }
}
