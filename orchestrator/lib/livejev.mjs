// Jev reads as the owner types. After each pause the chat box sends its draft here; Jev answers the same routing
// questions it answers on Enter (logged as purpose 'live'), and the dashboard shows the pick under the box.
// On Enter, chat() takes the read of that exact text instead of asking Jev again, so a sure pick starts at
// once. Nothing ever runs on a draft: a read only routes, and at most warms the action plan.
// One read at a time per session (a newer draft supersedes a waiting one); caps per message and per day
// live in Settings (0 = no cap).
import { db, save } from './store.mjs';
import { route, earlierRuns } from './router.mjs';
import { sessionChat } from './sessions.mjs';

export const LIVE_DEFAULTS = { perMessage: 12, perDay: 1000 };
export const MIN_WORDS = 3;
const KEEP_MS = 5 * 60_000; // a read older than this is routed again on Enter

const slots = new Map(); // session id ('new' at home) → { latest, busy, done, reads, at }

/** The same message for routing purposes: spacing and a trailing full stop don't change Jev's pick (case does: "for One"). */
export const norm = s => String(s || '').replace(/\s+/g, ' ').trim().replace(/[\s.!?…]+$/u, '');
export const wordCount = s => (norm(s).match(/[\p{L}\p{N}@]+/gu) || []).length;

const key = sid => sid || 'new';

/**
 * What the read depends on besides the text: the session's latest message and its runs' states. A reply
 * that landed or a run that finished since the read can change Jev's answer (a follow-up, a status).
 */
export function fingerprint(sid) {
  if (!sid) return 'new';
  const last = sessionChat(sid, 1)[0]?.id || '';
  const runs = earlierRuns(Object.values(db().runs), sid).map(r => `${r.id}:${r.status}`).join(',');
  return `${last}|${runs}`;
}

/** Same context route() gets in chat(), where the owner's message is already the newest in the session. */
function context(sid, text) {
  const me = { role: 'owner', text };
  if (!sid) return { recent: [me], runs: [] };
  return { recent: [...sessionChat(sid, 5), me], runs: earlierRuns(Object.values(db().runs), sid) };
}

export function limits() {
  const s = db().settings;
  const n = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d);
  return { perMessage: n(s.liveReadsPerMessage, LIVE_DEFAULTS.perMessage), perDay: n(s.liveReadsPerDay, LIVE_DEFAULTS.perDay) };
}

const today = () => new Date().toISOString().slice(0, 10);
export function readsToday() {
  const c = db().liveReads;
  return c?.day === today() ? c.n : 0;
}
function countRead() {
  db().liveReads = { day: today(), n: readsToday() + 1 };
  save();
}

function sweep() {
  for (const [k, s] of slots) if (!s.busy && Date.now() - s.at > KEEP_MS) slots.delete(k);
}

/**
 * Jev reads this draft. Returns { routing } (fresh or already read), { superseded } when the owner kept typing
 * while it waited, or { capped: 'message' | 'day' }. `routeFn` lets tests fake the router; `counting: false`
 * keeps a test's reads off the daily count.
 */
export async function read(sid, text, { routeFn = route, counting = true } = {}) {
  sweep();
  const k = key(sid);
  const t = norm(text);
  const s = slots.get(k) || { latest: null, busy: null, done: null, reads: 0, at: Date.now() };
  slots.set(k, s);
  s.latest = t;
  s.at = Date.now();
  // one read at a time: wait for the one in flight, then only the newest draft goes on
  while (s.busy) {
    await s.busy.catch(() => {});
    if (s.latest !== t) return { superseded: true };
  }
  const fp = fingerprint(sid);
  if (s.done?.text === t && s.done.fp === fp) return { routing: s.done.routing, cached: true };

  const { perMessage, perDay } = limits();
  if (perMessage && s.reads >= perMessage) return { capped: 'message' };
  if (perDay && readsToday() >= perDay) return { capped: 'day' };
  s.reads++;
  if (counting) countRead();

  const raw = text.trim();
  s.busy = routeFn(raw, { ...context(sid, raw), purpose: 'live' });
  try {
    const routing = await s.busy;
    s.done = { text: t, raw, routing, fp, at: Date.now() };
    return { routing };
  } finally {
    s.busy = null;
  }
}

/** The latest read of this draft, if it still holds (same text, same context, not too old). */
export function peek(sid, text, fp = fingerprint(sid)) {
  const d = slots.get(key(sid))?.done;
  if (!d || d.text !== norm(text) || d.fp !== fp || Date.now() - d.at > KEEP_MS) return null;
  return d;
}

/**
 * Enter: the routing Jev already read for this text, or null (then chat() asks Jev as before). Waits for a
 * read of this very text that is still landing. `fp` is the session's fingerprint taken before the owner's message
 * was posted. A heuristic guess (Jev was offline) is never reused. Clears the session's draft either way.
 */
export async function take(sid, text, fp) {
  const k = key(sid);
  const s = slots.get(k);
  if (!s) return null;
  const t = norm(text);
  while (s.busy && s.latest === t) await s.busy.catch(() => {});
  const d = peek(sid, text, fp);
  slots.delete(k);
  return d && d.routing.source !== 'heuristic' ? d.routing : null;
}

/** Tests: forget every draft. */
export function reset() { slots.clear(); }
