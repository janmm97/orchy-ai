// Sessions: separate conversations with Orchy. Each has its own thread, its own Orchy memory
// (a resumable Claude session) and the runs it started, so several can be busy at once.
// Naming: `run.session` / `message.session` / `proposal.session` is the Orchy session;
// `run.sessionId` stays the agent's own Claude session (used to resume follow-ups).
import { db, save, id, addChat } from './store.mjs';
import { emit } from './bus.mjs';

const ID_RE = /^s_[a-z0-9]{6,40}$/;   // the dashboard names a new session before its first message
const STALE_MS = 24 * 3600_000;       // a session quiet this long leaves the tabs (History keeps it)

export const publicSession = ({ orchySessionId, ...s }) => s;
export const getSession = sid => (sid && Object.hasOwn(db().sessions, sid) && db().sessions[sid]) || null;

function titleFrom(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 59)}…` : t || 'New session';
}

/** The session `sid` names, created (titled from `text`) when it doesn't exist yet. */
export function ensureSession(sid, { text = '', origin = 'owner' } = {}) {
  const have = getSession(sid);
  if (have) return have;
  const at = new Date().toISOString();
  const s = { id: ID_RE.test(sid || '') ? sid : id('s'), title: titleFrom(text), origin, createdAt: at, lastAt: at, closed: false, orchySessionId: null };
  db().sessions[s.id] = s;
  save();
  emit('session.updated', { session: publicSession(s) });
  return s;
}

/** Add a message to a session's thread. With no session it only reaches Orchy's bubble (the daily greeting). */
export function post(role, text, meta = {}, sid = null, { speak = false } = {}) {
  const msg = addChat(role, text, meta, sid);
  const s = getSession(sid);
  if (s) {
    s.lastAt = msg.at;
    if (s.closed) { s.closed = false; emit('session.updated', { session: publicSession(s) }); }
    save();
  }
  emit('chat.message', { message: msg, speak });
  return msg;
}

export function updateSession(sid, patch = {}) {
  const s = getSession(sid);
  if (!s) throw Object.assign(new Error('That session is gone'), { status: 404 });
  if (typeof patch.title === 'string' && patch.title.trim()) s.title = titleFrom(patch.title);
  if ('closed' in patch) s.closed = !!patch.closed;
  save();
  emit('session.updated', { session: publicSession(s) });
  return publicSession(s);
}

// sessions client pages opened before their talks went private (origin 'client') stay out of the owner's tabs and History
export function listSessions(limit = 60) {
  return Object.values(db().sessions).filter(s => s.origin !== 'client').sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, limit).map(publicSession);
}

export function sessionChat(sid, limit = 200) {
  return db().chat.filter(m => m.session === sid).slice(-limit);
}

/** What the dashboard loads: each open session's recent thread, plus the latest bubble-only messages. */
export function recentChat({ perSession = 100, loose = 2 } = {}) {
  const open = new Set(Object.values(db().sessions).filter(s => !s.closed).map(s => s.id));
  const count = new Map();
  const out = [];
  const chat = db().chat;
  for (let i = chat.length - 1; i >= 0; i--) {
    const m = chat[i];
    const k = m.session || '';
    if (k && !open.has(k)) continue;
    const n = count.get(k) || 0;
    if (n >= (k ? perSession : loose)) continue;
    count.set(k, n + 1);
    out.push(m);
  }
  return out.reverse();
}

/** Close sessions nobody has touched in a day, unless `busy(sid)`. They leave the tabs; History keeps them. */
export function sweepSessions(busy = () => false) {
  const cutoff = Date.now() - STALE_MS;
  let n = 0;
  for (const s of Object.values(db().sessions)) {
    if (!s.closed && Date.parse(s.lastAt) < cutoff && !busy(s.id)) { s.closed = true; n++; }
  }
  if (n) save();
}

/** One-time: the single conversation from before sessions existed becomes the first session. */
export function migrateChat() {
  const st = db();
  if (st.chatMigrated) return;
  st.chatMigrated = true;
  // later bubble-only notices (session: null) stay loose; state that has sessions was migrated before this flag
  const loose = Object.keys(st.sessions).length ? [] : st.chat.filter(m => !m.session && m.meta?.kind !== 'greeting');
  if (!loose.length) { save(); return; }
  const at = new Date().toISOString();
  const s = {
    id: id('s'), title: titleFrom(loose.find(m => m.role === 'owner')?.text || 'Earlier conversation'), origin: 'owner',
    createdAt: loose[0].at || at, lastAt: loose.at(-1).at || at, closed: false, orchySessionId: st.orchySessionId || null,
  };
  st.sessions[s.id] = s;
  for (const m of loose) {
    m.session = s.id;
    const run = m.meta?.runId && st.runs[m.meta.runId];
    if (run && !run.session) run.session = s.id;
  }
  delete st.orchySessionId;
  save();
}
