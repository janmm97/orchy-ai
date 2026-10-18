// The owner's standing rules: answers given once that they never want to be asked again, per workspace
// ("video work always runs on the strong model"). Huddle agents read them, the wrap-up writer leaves out what they
// answer, and before the owner sees a proposal Orchy (Jev) checks each question against them and against the team's
// settings (each agent's model and effort from its file). A question a rule fully answers is filled in as
// "Orchy answered", with its source, and the owner can still change it. It only fills in huddle questions: it never
// clears an approval (those are policy.mjs's remembered approvals, a different list), and anything no written rule
// decides stays the owner's. The owner adds a rule by ticking "Remember this" on an answer, or in the Huddles window,
// and removes one there too. Stored in db().standingRules[workspaceId].
import { db, save, id } from './store.mjs';
import { ownerName } from './env.mjs';
import { listAgents } from './agents.mjs';
import { nameOf } from './voiceagents.mjs';
import { ask as jevAsk } from './jev.mjs';

export const RULES = { max: 60, chars: 600 };
const all = () => (db().standingRules ||= {});
export const rulesFor = wsId => all()[wsId] || [];

export function addRule(wsId, text, { question = null } = {}) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, RULES.chars);
  if (!t) throw Object.assign(new Error('Write the rule first'), { status: 400 });
  const list = (all()[wsId] ||= []);
  const same = list.find(r => r.text.toLowerCase() === t.toLowerCase());
  if (same) return same;
  const rule = { id: id('rule'), text: t, ...(question ? { question: String(question).slice(0, 400) } : {}), at: new Date().toISOString() };
  list.push(rule);
  if (list.length > RULES.max) list.splice(0, list.length - RULES.max);
  save();
  return rule;
}

export function removeRule(wsId, rid) {
  const list = rulesFor(wsId);
  const i = list.findIndex(r => r.id === rid);
  if (i < 0) throw Object.assign(new Error('That rule is gone'), { status: 404 });
  list.splice(i, 1);
  save();
  return list;
}

/** What the team's files already settle: each agent's exact model and effort (as set in its own file). */
export function teamFacts(wsId, { agents = null } = {}) {
  let list = agents;
  if (!list) { try { list = listAgents(wsId).filter(a => !a.error); } catch { list = []; } }
  const each = list.filter(a => a.model && a.model !== 'inherit').map(a => {
    const name = nameOf(wsId, a.slug) || a.callName || a.displayName;
    const runs = `${a.model}${a.effort ? `, ${a.effort} effort` : ''}`;
    return { name, runs, text: `${name} (${a.displayName}) always runs on ${runs}: set in their agent file, and Orchy never routes them lower.`, source: `${name}'s agent file` };
  });
  // one line for "which model should X, Y and Z run on?", which no single agent's line answers
  return each.length > 1
    ? [{ text: `Every agent runs on exactly the model and effort in its own file (${each.map(f => `${f.name}: ${f.runs}`).join('; ')}), so which model an agent runs on is already decided.`, source: 'the agents\' files' }, ...each]
    : each;
}

/** The rules and team settings for an agent's instructions (huddle turns and the wrap-up). Empty when there are none. */
export function rulesText(wsId) {
  const rules = rulesFor(wsId);
  const team = teamFacts(wsId);
  if (!rules.length && !team.length) return '';
  const who = ownerName();
  return `${rules.length ? `${who}'s standing rules (already decided, never ask again):\n${rules.map(r => `- ${r.text}`).join('\n')}\n` : ''}${team.length ? `The team's models (set in each agent's file, exact; never ask ${who} which model to use):\n${team.slice(team.length > 1 ? 1 : 0).map(f => `- ${f.text}`).join('\n')}\n` : ''}`;
}

/**
 * Orchy's first look at a proposal's questions: each one a rule or a team setting already answers fully gets
 * `orchy: { answer, source }`. Jev picks the one rule that decides it, or none; a weak pick is left to the owner.
 * Jev off, down or slow: nothing is filled in, the owner answers everything.
 */
export async function preAnswer(wsId, questions, { ask = jevAsk, maxNone = 0.25, facts: given = null } = {}) {
  const facts = given || [
    ...rulesFor(wsId).map(r => ({ text: r.text, source: `Your standing rule (${String(r.at || '').slice(0, 10)})` })),
    ...teamFacts(wsId),
  ];
  if (!facts.length || !questions.length) return questions;
  const who = ownerName();
  const criteria = { none: `None of these decides it: it needs ${who}'s judgement, a preference, or a fact not written here`, ...Object.fromEntries(facts.map((f, i) => [`r${i}`, f.text])) };
  const qs = Object.fromEntries(questions.map((q, i) => [`q${i}`, {
    type: 'choice',
    instructions: `AI agents want ${who} to answer this question: "${q.q}"${q.why ? ` (${q.why})` : ''}. Does one of ${who}'s written rules or the team's settings below already answer it completely, so asking again would waste their time? Pick that rule only when it settles the whole question by itself. Pick none when the question asks about something else, asks to change or make an exception to the rule, or would still need ${who} to choose.`,
    criteria,
  }]));
  try {
    const res = await ask({ workspace: wsId }, qs, { purpose: 'huddle-preanswer', timeoutMs: 20_000, fallback: false });
    return questions.map((q, i) => {
      const a = res.answers?.[`q${i}`] || {};
      const k = a.choice;
      // two rules can both answer it and split Jev's confidence: what counts is how sure it is that something
      // written answers it, so "none" has to be unlikely
      const none = a.probabilities?.none ?? (a.confidence != null ? 1 - a.confidence : 1);
      if (!k || k === 'none' || !criteria[k] || none > maxNone) return q;
      const f = facts[Number(k.slice(1))];
      return f ? { ...q, orchy: { answer: f.text, source: f.source } } : q;
    });
  } catch (e) {
    if (e.code !== 'NO_JEV') console.warn('[rules] pre-answer skipped:', e.message);
    return questions;
  }
}
