// Impact: what the agents did and what that would have cost with people doing it. An estimate, not an
// invoice: a finished task is worth the time a person would need (the agent's working time x SPEEDUP,
// never under MIN_MINUTES, never over MAX_HOURS) at an hourly cost. The window shows these assumptions
// and lets the owner change the hourly cost and the speed-up.
import { db } from './store.mjs';
import { workspaces, listRetired } from './workspaces.mjs';
import { listAgents } from './agents.mjs';
import { config } from './env.mjs';

export const DEFAULTS = { rate: 45, speedup: 6 }; // $/hour fully loaded (pay + benefits + overhead), human minutes per agent minute
const MIN_MINUTES = 20;
const MAX_HOURS = 16;
const CREDIT = { completed: 1, partial: 0.5 }; // blocked, failed and stopped runs save nothing
const WEEKS = { week: 7, month: 30, all: 0 };

// A workspace's own name, or with `owner.hideBusinessNames` in config.json "Business A, B, C…" in list order (retired
// after), the same letters the dashboard draws (util.mjs#wsName). Agents show by role, not by name.
export const businessName = id => {
  const all = [...workspaces(), ...listRetired()];
  const i = all.findIndex(w => w.id === id);
  if (i < 0) return id;
  if (!config.owner?.hideBusinessNames) return all[i].name || id;
  return `Business ${String.fromCharCode(65 + i % 26)}${i >= 26 ? Math.floor(i / 26) + 1 : ''}`;
};
const roles = () => new Map(listAgents().map(a => [`${a.workspace}/${a.slug}`, a.role || 'Specialist']));
// an agent since removed: its role from its file name ("motion-graphics-designer" → "Motion Graphics Designer")
const roleFromSlug = slug => slug.split('-').map(w => ({ ai: 'AI', soc2: 'SOC 2', of: 'of', and: 'and' }[w] || w[0].toUpperCase() + w.slice(1))).join(' ');
const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const round = (n, p = 2) => Number(n.toFixed(p));

/** The calendar day (YYYY-MM-DD) a time falls on in the owner's timezone. */
export const dayOf = iso => new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date(iso));

/** `month` (YYYY-MM, the owner's calendar) reports that whole month; `start`..`end` (YYYY-MM-DD, both days
 * included) a span of days; otherwise `period` counts back from now. */
export function impact({ period = 'month', month, start, end, rate, speedup, formerRoles = false } = {}) {
  const r = num(rate, DEFAULTS.rate, 1, 1000), x = num(speedup, DEFAULTS.speedup, 1, 100);
  const days = WEEKS[period] ?? WEEKS.month;
  const from = days ? Date.now() - days * 86_400_000 : 0;
  const rows = Object.values(db().runs).filter(run =>
    run.endedAt && !run.backend && !run.huddleTalk && !run.isBuilder && // the AI Agent Builder isn't part of the comparison

    (month ? dayOf(run.endedAt).startsWith(month)
      : start || end ? (!start || dayOf(run.endedAt) >= start) && (!end || dayOf(run.endedAt) <= end)
      : Date.parse(run.endedAt) >= from));

  const agents = new Map(), spaces = new Map(), daily = new Map(), roleOf = roles();
  const tot = { tasks: 0, done: 0, partial: 0, notDone: 0, agentHours: 0, humanHours: 0, apiCost: 0 };
  for (const run of rows) {
    const how = run.report?.status || run.outcome || 'completed';
    const agentMin = (run.durationMs || 0) / 60_000;
    const credit = CREDIT[how] || 0;
    const humanH = credit ? Math.min(MAX_HOURS, Math.max(MIN_MINUTES, agentMin * x) / 60) * credit : 0;
    const cost = run.costUsd || 0;
    tot.tasks++; tot[how === 'completed' ? 'done' : how === 'partial' ? 'partial' : 'notDone']++;
    tot.agentHours += agentMin / 60; tot.humanHours += humanH; tot.apiCost += cost;
    const d = daily.get(dayOf(run.endedAt)) || { tasks: 0, humanHours: 0, apiCost: 0 };
    d.tasks++; d.humanHours += humanH; d.apiCost += cost;
    daily.set(dayOf(run.endedAt), d);
    const slug = run.agentSlug || 'general';
    for (const [map, key, name] of [[agents, `${run.workspace}/${slug}`, roleOf.get(`${run.workspace}/${slug}`) || (run.agentSlug ? (formerRoles ? roleFromSlug(run.agentSlug) : 'Former specialist') : 'Generalist')], [spaces, run.workspace, businessName(run.workspace)]]) {
      const a = map.get(key) || { name, ws: run.workspace, workspace: businessName(run.workspace), tasks: 0, done: 0, humanHours: 0, apiCost: 0 };
      a.tasks++; if (how === 'completed') a.done++; a.humanHours += humanH; a.apiCost += cost;
      map.set(key, a);
    }
  }
  const tidy = a => ({ ...a, humanHours: round(a.humanHours, 1), humanCost: Math.round(a.humanHours * r), apiCost: round(a.apiCost) });
  const byValue = (a, b) => b.humanHours - a.humanHours;
  const humanCost = tot.humanHours * r;
  return {
    period: month || (start || end ? `${start || ''}..${end || ''}` : period), rate: r, speedup: x,
    daily: [...daily].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, d]) => ({ date, tasks: d.tasks, humanHours: round(d.humanHours, 1), humanCost: Math.round(d.humanHours * r), apiCost: round(d.apiCost) })),
    since: rows.length ? rows.reduce((m, run) => (run.startedAt < m ? run.startedAt : m), rows[0].startedAt) : null,
    totals: {
      ...tot, agentHours: round(tot.agentHours, 1), humanHours: round(tot.humanHours, 1), apiCost: round(tot.apiCost),
      humanCost: Math.round(humanCost), saved: Math.round(humanCost - tot.apiCost),
      times: tot.apiCost > 0 ? Math.round(humanCost / tot.apiCost) : null,
      fteWeeks: round(tot.humanHours / 40, 1),
    },
    workspaces: [...spaces.values()].sort(byValue).map(tidy),
    agents: [...agents.values()].sort(byValue).map(tidy),
    assumptions: [
      `A finished task is worth what a person would need: the agent's working time x ${x}, at least ${MIN_MINUTES} minutes, at most ${MAX_HOURS} hours.`,
      'Partly done tasks count half. Blocked, failed and stopped tasks count nothing.',
      `A person costs $${r} an hour, fully loaded (pay, benefits, overhead).`,
      'The agents\' cost is what Claude reports for each run (Codex runs and Jev calls aren\'t priced). Your own time answering questions isn\'t counted on either side.',
    ],
  };
}
