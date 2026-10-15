// The inbox holds every interruption that needs the owner: agent questions, approvals and
// connection picks. The agent's MCP bridge long-polls until the owner answers in the dashboard.
import { db, save, id } from './store.mjs';
import { emit } from './bus.mjs';

const waiters = new Map(); // itemId -> Set<resolve>

/**
 * kind: 'question' | 'approval' | 'connections'
 * Item fields: runId, workspace, agent{slug,displayName}, title, message, options, payload
 */
export function createItem(kind, fields) {
  const item = {
    id: id(kind[0]),
    kind,
    status: 'pending',
    createdAt: new Date().toISOString(),
    answer: null,
    ...fields,
  };
  db().inbox[item.id] = item;
  save();
  emit('inbox.created', { item });
  return item;
}

export function pending() {
  return Object.values(db().inbox).filter(i => i.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getItem(itemId) {
  return db().inbox[itemId];
}

export function answer(itemId, answerValue) {
  const item = db().inbox[itemId];
  if (!item) throw Object.assign(new Error('That message is gone'), { status: 404 });
  if (item.status !== 'pending') throw Object.assign(new Error('Already answered'), { status: 409 });
  item.status = 'answered';
  item.answer = answerValue;
  item.answeredAt = new Date().toISOString();
  save();
  emit('inbox.answered', { item });
  for (const r of waiters.get(itemId) || []) r(item);
  waiters.delete(itemId);
  return item;
}

/** Wait up to ms for an answer. Resolves to the item (status may still be pending). */
export function waitFor(itemId, ms = 25_000) {
  const item = db().inbox[itemId];
  if (!item || item.status !== 'pending') return Promise.resolve(item);
  return new Promise(resolve => {
    const set = waiters.get(itemId) || new Set();
    const done = it => { clearTimeout(t); set.delete(done); resolve(it); };
    const t = setTimeout(() => done(db().inbox[itemId]), ms);
    set.add(done);
    waiters.set(itemId, set);
  });
}

/** When a run ends, anything it was still waiting on is void. */
export function expireForRun(runId) {
  for (const item of Object.values(db().inbox)) {
    if (item.runId === runId && item.status === 'pending') {
      item.status = 'expired';
      item.expiredAt = new Date().toISOString();
      emit('inbox.expired', { item });
      for (const r of waiters.get(item.id) || []) r(item);
      waiters.delete(item.id);
    }
  }
  // keep the inbox from growing forever
  const all = Object.values(db().inbox).filter(i => i.status !== 'pending').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const old of all.slice(300)) delete db().inbox[old.id];
  save();
}

export function itemsForRun(runId) {
  return Object.values(db().inbox).filter(i => i.runId === runId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
