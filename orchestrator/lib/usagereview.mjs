// Orchy keeps an eye on usage.
//  - weeklyReview(): once a week (Settings: usageReviewDay, default Friday, from usageReviewHour, default 15:00 in the
//    owner's time zone) a cheap Haiku pass (no tools) over the week's numbers writes the owner 3–5 concrete suggestions
//    in chat, each with a one-tap action where one exists (the builder with the change prefilled, a Settings toggle,
//    or the run/chain it's about). Actions are checked here, never taken: the owner taps them.
//  - budgetPace(): this week's agent spend vs a usual week, for Jev's routing (router.mjs leans cheaper on close calls).
//  - usageBrief(ws): the workspace's own week per agent, handed to its AI Agent Builder's scheduled review.
import { config, ownerName } from './env.mjs';
import { db, save } from './store.mjs';
import { enabledWorkspaces } from './workspaces.mjs';
import { quickClaude } from './claude.mjs';

const DAY = 86400_000;
const WEEK = 7 * DAY;
const money = n => `$${(Number(n) || 0).toFixed(2)}`;
const cost = r => Number(r.costUsd) || 0;
const done = r => (r.report?.status || r.outcome) === 'completed';
const half = r => (r.report?.status || r.outcome) === 'partial';
// the owner's own work only: clients' runs and Orchy's fixes of himself aren't the workspace's agents' habits
const counted = r => !r.client && !r.backend;

function runsBetween(from, to) {
  return Object.values(db().runs || {}).filter(r => {
    const t = Date.parse(r.startedAt || '');
    return t >= from && t < to && counted(r);
  });
}

/** This week's agent spend vs a usual week (the mean of the 4 weeks before, weeks with no runs left out). Cached 10 min. */
let paceCache = null;
export function budgetPace(now = Date.now()) {
  if (paceCache && now - paceCache.at < 10 * 60_000) return paceCache.value;
  const week = runsBetween(now - WEEK, now + 1).reduce((s, r) => s + cost(r), 0);
  const past = [1, 2, 3, 4].map(i => runsBetween(now - (i + 1) * WEEK, now - i * WEEK).reduce((s, r) => s + cost(r), 0)).filter(x => x > 0);
  const usual = past.length ? past.reduce((a, b) => a + b, 0) / past.length : 0;
  const pace = usual > 0 ? Math.round((week / usual) * 100) / 100 : null;
  const value = { week: Math.round(week * 100) / 100, usual: Math.round(usual * 100) / 100, pace, tight: pace != null && pace >= 1.15 };
  paceCache = { at: now, value };
  return value;
}

/** One line for Jev's routing state, or null when there's no history to compare with. */
export function budgetLine(now = Date.now()) {
  if (db().settings?.budgetRouting === false) return null;
  const b = budgetPace(now);
  if (b.pace == null) return null;
  const pct = Math.round(b.pace * 100);
  return `Agent runs in the last 7 days: ${money(b.week)}, ${pct}% of a usual week (${money(b.usual)}). ${b.tight
    ? `Usage is running high: on a close call pick the lower effort, and for a small ask prefer the workspace generalist over a heavy specialist. Never override an agent ${ownerName()} names.`
    : 'Usage is within the usual range.'}`;
}

/** Per-agent numbers for one window of runs. */
function perAgent(runs) {
  const m = new Map();
  for (const r of runs) {
    if (r.huddleTalk) continue;
    const slug = r.isBuilder ? 'agent-builder' : r.agentSlug || 'general';
    const k = `${r.workspace}/${slug}`;
    let a = m.get(k);
    if (!a) m.set(k, a = { ws: r.workspace, slug, name: r.agentName || slug, runs: 0, done: 0, costUsd: 0, turns: 0, followUps: 0, models: {} });
    a.runs++;
    a.done += done(r) ? 1 : half(r) ? 0.5 : 0;
    a.costUsd += cost(r);
    a.turns += Number(r.numTurns) || 0;
    if (r.parentRunId) a.followUps++;
    if (r.model) a.models[r.model] = (a.models[r.model] || 0) + 1;
  }
  return [...m.values()].map(a => ({
    ...a,
    costUsd: Math.round(a.costUsd * 100) / 100,
    costPerDone: a.done ? Math.round((a.costUsd / a.done) * 100) / 100 : null,
    avgTurns: a.runs ? Math.round(a.turns / a.runs) : 0,
    model: Object.entries(a.models).sort((x, y) => y[1] - x[1])[0]?.[0] || null,
  })).sort((x, y) => y.costUsd - x.costUsd);
}

/** Follow-up chains in the window, by total turns. */
function chains(runs) {
  const byId = db().runs || {};
  const rootOf = r => { let c = r; const seen = new Set(); while (c.parentRunId && byId[c.parentRunId] && !seen.has(c.id)) { seen.add(c.id); c = byId[c.parentRunId]; } return c; };
  const g = new Map();
  for (const r of runs) {
    if (r.huddleTalk || !r.parentRunId) continue;
    const root = rootOf(r);
    const list = g.get(root.id) || [];
    list.push(r);
    g.set(root.id, list);
  }
  return [...g.entries()].map(([rootId, list]) => {
    const all = [byId[rootId], ...list].filter(Boolean);
    const latest = all.reduce((a, b) => (String(b.startedAt) > String(a.startedAt) ? b : a));
    return {
      runId: latest.id, ws: latest.workspace, agent: latest.agentName || latest.agentSlug || 'general',
      rounds: all.length, turns: all.reduce((s, x) => s + (Number(x.numTurns) || 0), 0),
      costUsd: Math.round(all.reduce((s, x) => s + cost(x), 0) * 100) / 100,
      task: String(byId[rootId]?.instruction || '').replace(/\s+/g, ' ').slice(0, 100),
    };
  }).sort((a, b) => b.costUsd - a.costUsd).slice(0, 5);
}

/** The numbers the review reads: this week, last week, per agent, kinds, chains and the costliest runs. */
export function weekNumbers(now = Date.now()) {
  const runs = runsBetween(now - WEEK, now + 1);
  const prev = runsBetween(now - 2 * WEEK, now - WEEK);
  const kinds = {};
  for (const r of runs) {
    const k = r.huddleTalk || r.huddle ? 'huddle' : r.isBuilder ? 'build' : r.delegatedBy ? 'handoff' : r.routing?.source === 'schedule' ? 'scheduled' : r.parentRunId ? 'follow-up' : 'task';
    kinds[k] = Math.round(((kinds[k] || 0) + cost(r)) * 100) / 100;
  }
  const total = runs.reduce((s, r) => s + cost(r), 0);
  const top = runs.slice().sort((a, b) => cost(b) - cost(a)).slice(0, 5).map(r => ({
    runId: r.id, ws: r.workspace, agent: r.agentName || r.agentSlug || 'general', model: r.model, costUsd: Math.round(cost(r) * 100) / 100,
    turns: r.numTurns || 0, outcome: r.report?.status || r.outcome || r.status, task: String(r.instruction || '').replace(/\s+/g, ' ').slice(0, 100),
  }));
  return {
    totalUsd: Math.round(total * 100) / 100,
    lastWeekUsd: Math.round(prev.reduce((s, r) => s + cost(r), 0) * 100) / 100,
    runs: runs.length,
    pace: budgetPace(now),
    byKind: kinds,
    agents: perAgent(runs).slice(0, 12),
    chains: chains(runs),
    topRuns: top,
  };
}

// what a suggestion's button may do; anything else the model proposes is dropped
const SETTING_KEYS = {
  actionPlan: 'boolean', liveJev: 'boolean', liveStart: 'boolean', autoDispatch: 'boolean', callDone: 'boolean', budgetRouting: 'boolean',
  maxLivePerAccount: 'number',
};

/** Keep only actions the owner's dashboard can take: the workspace's builder with a change prefilled, a known setting, a real run. */
export function cleanAction(a) {
  if (!a || typeof a !== 'object') return null;
  const wss = new Set(enabledWorkspaces().map(w => w.id));
  if (a.type === 'build' && wss.has(a.ws) && String(a.text || '').trim()) return { type: 'build', ws: a.ws, text: String(a.text).trim().slice(0, 600) };
  if (a.type === 'setting' && SETTING_KEYS[a.key]) {
    const v = SETTING_KEYS[a.key] === 'boolean' ? !!a.value : Math.min(6, Math.max(1, Math.round(Number(a.value)) || 0));
    if (SETTING_KEYS[a.key] === 'number' && !v) return null;
    return { type: 'setting', key: a.key, value: v };
  }
  if (a.type === 'run' && db().runs?.[a.runId]) return { type: 'run', runId: a.runId };
  return null;
}

const PROMPT = (nums, wsList, settings) => `You are Orchy, the orchestrator that runs ${ownerName()}'s AI agents. Agent runs share their accounts' usage limits, so once a week you look at what the agents spent and suggest how to spend less without losing quality.

The levers that exist:
- An agent's file can be slimmed (core rules only, playbooks moved to reference files read on demand) or put on a cheaper model (sonnet for drafting and routine work; opus only for builders and strategy). Its workspace's AI Agent Builder makes that change (action type "build").
- A long follow-up chain (many rounds and turns) is better started fresh with the report attached than continued (action type "run" opens it).
- Visual QA done frame by frame is expensive; contact sheets (ffmpeg tiles) or a Sonnet/Haiku subagent's text verdict are cheap.
- Settings (action type "setting"): maxLivePerAccount (1-6, runs at once per account), actionPlan (Jev pre-plans app actions), liveJev (Jev reads while ${ownerName()} types), autoDispatch, budgetRouting (lean cheaper when the week runs high).

Workspaces: ${wsList}
Current settings: ${JSON.stringify(settings)}

THIS WEEK (last 7 days, API-equivalent dollars; costPerDone = cost per finished task, partly done counts half):
${JSON.stringify(nums, null, 1)}

Write 3 to 5 suggestions, the biggest saving first. Each must name the agent, chain or setting and the number behind it, and say what to change. Skip anything you can't back with a number above. Plain words, one or two sentences each, no jargon.

Reply with JSON only, no fences:
{"headline":"one short sentence on how the week went vs last week","suggestions":[{"text":"…","label":"button label, 2-4 words","action":{"type":"build","ws":"<workspace id>","text":"the instruction for the builder"}|{"type":"setting","key":"…","value":…}|{"type":"run","runId":"…"} (it only opens the run for ${ownerName()})|null}]}`;

function parseJson(text) {
  const s = String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch {}
  return null;
}

/** Run the review now and say it in chat. `say(text, meta)` is orchy.say. Returns what was said. */
export async function weeklyReview({ say, now = Date.now(), think = quickClaude } = {}) {
  const nums = weekNumbers(now);
  if (!nums.runs) {
    const text = 'Weekly usage review: no agent runs in the last 7 days, so nothing to trim.';
    say?.(text, { kind: 'usage-review', session: null });
    return { text, suggestions: [] };
  }
  const wsList = enabledWorkspaces().map(w => `${w.id} (${w.name})`).join(', ');
  const s = db().settings || {};
  const settings = Object.fromEntries(Object.keys(SETTING_KEYS).map(k => [k, s[k] ?? (k === 'maxLivePerAccount' ? 3 : k === 'budgetRouting' ? true : null)]));
  const res = await think({ prompt: PROMPT(nums, wsList, settings), model: 'haiku', tools: '', timeoutMs: 120_000, purpose: 'usage-review' });
  const out = parseJson(res.text);
  if (!out?.suggestions?.length) throw new Error('the review came back without suggestions');
  const suggestions = out.suggestions.slice(0, 5).map(x => ({
    text: String(x.text || '').trim().slice(0, 400),
    label: String(x.label || '').trim().slice(0, 40) || null,
    action: cleanAction(x.action),
  })).filter(x => x.text);
  const head = String(out.headline || '').trim() || `Agents spent ${money(nums.totalUsd)} this week (last week ${money(nums.lastWeekUsd)}).`;
  const text = `**Weekly usage review.** ${head}\n\n${suggestions.map((x, i) => `${i + 1}. ${x.text}`).join('\n')}`;
  say?.(text, { kind: 'usage-review', session: null, suggestions: suggestions.map(({ label, action }, i) => action ? { n: i + 1, label: action.type === 'run' ? 'Open the run' : label || `Do #${i + 1}`, action } : null).filter(Boolean) });
  return { text, suggestions, numbers: nums };
}

function nowParts(at = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })
    .formatToParts(at).map(x => [x.type, x.value]));
  return { weekday: p.weekday, hour: Number(p.hour === '24' ? 0 : p.hour), date: `${p.year}-${p.month}-${p.day}` };
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** When the weekly review runs: Settings usageReviewDay ('Mon'…'Sun', or 'off') and usageReviewHour (0–23). Default Friday 15:00. */
export function reviewSchedule(settings = db().settings || {}) {
  const day = settings.usageReviewDay === 'off' ? 'off' : DAYS.includes(settings.usageReviewDay) ? settings.usageReviewDay : 'Fri';
  const h = Math.round(Number(settings.usageReviewHour));
  return { day, hour: Number.isFinite(h) && h >= 0 && h <= 23 ? h : 15 };
}
export const REVIEW_DAYS = DAYS;

/** On the review day from its hour (the owner's time zone), once that day (also when Orchy wakes later that day). Skipped with NO_SCHEDULER. */
export function startUsageReview({ say }) {
  const tick = async () => {
    const t = nowParts();
    const when = reviewSchedule();
    if (when.day === 'off' || t.weekday !== when.day || t.hour < when.hour) return;
    const st = db();
    if (st.usageReviewDate === t.date) return;
    st.usageReviewDate = t.date;
    save();
    try { await weeklyReview({ say }); } catch (e) { console.error('[usage-review]', e.message); }
  };
  setTimeout(() => tick().catch(() => {}), 60_000).unref?.();
  setInterval(() => tick().catch(() => {}), 15 * 60_000).unref?.();
}

/** For a workspace's AI Agent Builder's scheduled review: its agents' week, worst cost per finished task first. */
export function usageBrief(wsId, now = Date.now()) {
  const agents = perAgent(runsBetween(now - WEEK, now + 1).filter(r => r.workspace === wsId)).filter(a => a.slug !== 'agent-builder');
  if (!agents.length) return '';
  const rows = agents
    .sort((a, b) => (b.costPerDone ?? b.costUsd * 2) - (a.costPerDone ?? a.costUsd * 2))
    .slice(0, 10)
    .map(a => `| ${a.name} (${a.slug}) | ${a.runs} | ${a.done} | ${money(a.costUsd)} | ${a.costPerDone == null ? 'nothing finished' : money(a.costPerDone)} | ${a.avgTurns} | ${a.followUps} | ${a.model || '?'} |`);
  return `\n\n## This week's usage (from Orchy, last 7 days)\n| Agent | Runs | Finished | Cost | Per finished task | Avg turns | Follow-ups | Model |\n|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n\nAs part of this review, propose slimming or model changes for the agents with the worst cost per finished task: cut the agent file to its core (identity, job, rules, connection table; about 20k characters at most) with playbooks moved to reference files it reads on demand, and \`model: sonnet\` for drafting and routine work. Ask ${ownerName()} with ask_user before changing any agent.`;
}
