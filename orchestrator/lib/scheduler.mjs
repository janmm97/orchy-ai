// Runs agents on their `schedule` (agent frontmatter), in the owner's timezone.
//   schedule: weekdays 9:00        schedule: daily 8:30        schedule: mon,thu 14:00
//   schedule: weekdays 9:00; fri 16:30   (several, separated by ;)
//   schedule_task: Run the morning triage.
import { config } from './env.mjs';
import { db, save } from './store.mjs';
import { listAgents } from './agents.mjs';
import { enabledWorkspaces } from './workspaces.mjs';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function parseSchedule(text) {
  if (!text) return [];
  const out = [];
  for (const part of String(text).split(';').map(s => s.trim().toLowerCase()).filter(Boolean)) {
    const m = part.match(/^(weekdays|weekends|daily|every ?day|(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*(?:\s*,\s*(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*)*)\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?$/);
    if (!m) continue;
    let days;
    if (m[1] === 'weekdays') days = [1, 2, 3, 4, 5];
    else if (m[1] === 'weekends') days = [0, 6];
    else if (/^(daily|every ?day)$/.test(m[1])) days = [0, 1, 2, 3, 4, 5, 6];
    else days = m[1].split(',').map(d => DAYS.indexOf(d.trim().slice(0, 3))).filter(d => d >= 0);
    let h = Number(m[2]);
    if (m[4] === 'pm' && h < 12) h += 12;
    if (m[4] === 'am' && h === 12) h = 0;
    out.push({ days, hh: String(h).padStart(2, '0'), mm: m[3] });
  }
  return out;
}

function nowParts(at = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(at).map(x => [x.type, x.value]));
  return { day: DAYS.indexOf(p.weekday.toLowerCase().slice(0, 3)), hh: p.hour === '24' ? '00' : p.hour, mm: p.minute, date: `${p.year}-${p.month}-${p.day}` };
}

const tzShort = () => new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, timeZoneName: 'short' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || config.timezone;

/** Next human-readable fire time, for the dashboard. */
export function describeSchedule(text) {
  const slots = parseSchedule(text);
  if (!slots.length) return null;
  return slots.map(s => {
    const d = s.days.length === 7 ? 'Daily' : s.days.join() === '1,2,3,4,5' ? 'Weekdays' : s.days.join() === '0,6' ? 'Weekends' : s.days.map(x => DAYS[x][0].toUpperCase() + DAYS[x].slice(1)).join(', ');
    const h = Number(s.hh);
    return `${d} ${((h + 11) % 12) + 1}:${s.mm} ${h < 12 ? 'AM' : 'PM'} ${tzShort()}`;
  }).join('; ');
}

// A slot missed because the PC was asleep or Orchy wasn't running still runs once, late, the
// same day, if Orchy is back within this window. Agents created or edited after the slot don't
// count as having missed it.
const CATCH_UP_MINUTES = 180;

/** The scheduled slots due at `at` that haven't run yet: on time, or late within the catch-up window. */
export function dueSlots(agents, at = new Date(), scheduled = {}) {
  const now = nowParts(at);
  const nowMin = Number(now.hh) * 60 + Number(now.mm);
  const due = [];
  for (const a of agents) {
    if (!a.schedule) continue;
    for (const s of parseSchedule(a.schedule)) {
      if (!s.days.includes(now.day)) continue;
      const late = nowMin - (Number(s.hh) * 60 + Number(s.mm));
      if (late < 0 || late > CATCH_UP_MINUTES) continue;
      const key = `${a.workspace}/${a.slug}@${now.date}T${s.hh}:${s.mm}`;
      if (scheduled[key]) continue;
      if (late > 1 && Date.parse(a.updatedAt) > at.getTime() - late * 60_000) continue; // created or changed after that time
      due.push({ agent: a, key, late: late > 1 ? late : 0, slot: `${s.hh}:${s.mm}` });
    }
  }
  // An agent that missed several slots (an hourly one after the PC slept) runs once, for the latest;
  // the earlier slots count as `passed`. Copies started together would repeat the same work and race
  // each other for the Claude sign-in.
  const byAgent = new Map();
  for (const d of due) {
    const k = `${d.agent.workspace}/${d.agent.slug}`;
    byAgent.set(k, [...(byAgent.get(k) || []), d]);
  }
  return [...byAgent.values()].map(list => {
    list.sort((x, y) => x.late - y.late);
    return { ...list[0], passed: list.slice(1).reverse().map(d => ({ key: d.key, slot: d.slot })) };
  });
}

// Scheduled slots wait while this many runs are live: a slot held back still runs within its lateness window
export const HOLD_AT_LIVE = 2;

export function startScheduler({ startRun, liveCount = () => 0, onStarted, onError }) {
  const st = db();
  st.scheduled ||= {};
  let ticking = false; // starting runs can outlast the 20s interval: one tick at a time, so no slot starts twice
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const on = new Set(enabledWorkspaces().map(w => w.id));
      const agents = listAgents();
      // a switched-off workspace's agents stay idle: their slots pass, and don't fire late once it's back on
      const idle = dueSlots(agents.filter(a => !on.has(a.workspace)), new Date(), st.scheduled);
      for (const d of idle) for (const k of [d.key, ...d.passed.map(p => p.key)]) st.scheduled[k] = new Date().toISOString();
      if (idle.length) save();
      // while HOLD_AT_LIVE or more runs are live, scheduled slots wait (they catch up within the window once fewer are)
      const busy = () => (Number(liveCount()) || 0) >= HOLD_AT_LIVE;
      for (const { agent: a, key, late, slot, passed } of busy() ? [] : dueSlots(agents.filter(a => on.has(a.workspace)), new Date(), st.scheduled)) {
        if (busy()) break;
        if (st.scheduled[key]) continue;
        st.scheduled[key] = new Date().toISOString();
        for (const p of passed) st.scheduled[p.key] = st.scheduled[key];
        save();
        try {
          const run = await startRun({
            workspace: a.workspace, agentSlug: a.slug, model: a.model !== 'inherit' ? a.model : undefined,
            instruction: a.scheduleTask || `Scheduled run (${describeSchedule(a.schedule)}): do your job as described in your instructions.`,
            routing: { source: 'schedule', confidence: 1 },
            label: `${a.displayName} · scheduled ${slot}`,
          });
          onStarted?.(run, a, { lateMinutes: late, slot, passed: passed.map(p => p.slot) });
        } catch (e) {
          onError?.(e, a);
        }
      }
      // forget old keys
      const cutoff = Date.now() - 3 * 86400_000;
      for (const [k, v] of Object.entries(st.scheduled)) if (Date.parse(v) < cutoff) delete st.scheduled[k];
    } finally {
      ticking = false;
    }
  };
  setInterval(() => tick().catch(e => console.error('[scheduler]', e)), 20_000);
  tick().catch(e => console.error('[scheduler]', e));
}
