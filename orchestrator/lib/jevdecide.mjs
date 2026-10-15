// Jev's second look at an action the keyword rules call routine. policy.mjs#decisionFor reads an action's
// title ("Send Email", "Create Refund"); a title without the words ("Create Message" on Twilio texts someone)
// slips through. For an action that changes data and matched none of the rules, Jev classifies it as one of
// The owner's decision kinds (money, sending, calendar, deleting, sharing) or none, and a decision asks as usual.
// It can only add an ask, never remove one. Verdicts are kept per action, so each action costs one call ever;
// when Jev is slow or down the rules decide alone, as they did before.
import { db, save } from './store.mjs';
import { ask as jevAsk } from './jev.mjs';
import { DECISIONS } from './policy.mjs';
import { ownerName } from './env.mjs';

const TIMEOUT_MS = 4_000;
const inflight = new Map(); // key -> promise (two calls to one new action share a single question)

/** The question Jev answers about an action (exported for tests). */
export function decisionQuestion() {
  return {
    kind: {
      type: 'choice',
      instructions: `An AI agent is about to run this app action on ${ownerName()}'s or a client's account. Which kind of decision is it? Judge what the action does when it runs, not only the words in its name: sending a text, chat message, post or notification is sending even when the action is called "Create Message".`,
      criteria: {
        ...Object.fromEntries(DECISIONS.map(d => [d.key, `${d.label}: ${d.hint}`])),
        none: 'None of these: it reads, or it creates or changes something inside the app that no one else is told about (a draft, a label, a note, a page, a record, a task)',
      },
    },
  };
}

/**
 * The decision kind Jev sees in an action, as a DECISIONS entry (or null for none / no answer).
 * info: { key (actionId, or "mcp:<tool>"), title, platform, method, path, description }
 */
export async function jevDecision(info, { ask = jevAsk, store = db(), persist = save } = {}) {
  const cache = (store.jevDecisions ||= {});
  const hit = cache[info.key];
  if (hit) return DECISIONS.find(d => d.key === hit.kind) || null;
  if (!inflight.has(info.key)) {
    const state = { app: info.platform || 'unknown', action: info.title || 'unknown', http_method: info.method || 'unknown', endpoint: info.path || 'unknown', ...(info.description ? { description: String(info.description).slice(0, 600) } : {}) };
    inflight.set(info.key, ask(state, decisionQuestion(), { purpose: 'decision', timeoutMs: TIMEOUT_MS, fallback: false })
      .then(res => {
        const a = res.answers?.kind || {};
        cache[info.key] = { kind: a.choice || 'none', confidence: a.confidence ?? null, title: info.title || null, model: res.model || null, at: new Date().toISOString() };
        persist();
        return cache[info.key];
      })
      .catch(e => { console.warn('[jevdecide]', info.key, e.message); return null; }) // not cached: asked again next time
      .finally(() => inflight.delete(info.key)));
  }
  const v = await inflight.get(info.key);
  return v ? DECISIONS.find(d => d.key === v.kind) || null : null;
}
