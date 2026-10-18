// Jev's action plan: before an agent starts, Jev picks the One actions the task needs and Orchy loads their
// docs, so the agent can execute straight away instead of spending turns on `one actions find` / `load`.
//   An agent whose file lists action IDs (conn_mod_def::…) → those are the candidates.
//   Otherwise (the generalist, or an agent without IDs) → Jev picks which of its connections the task is
//   about (which Gmail account, say), and Orchy runs `one actions find` on those platforms itself.
// Jev then answers one yes/no per candidate ("does this task need it?"), and the docs of the top picks ride
// in the run's system prompt (prompts.mjs). A plan never blocks a run: when it's slow or fails, the agent
// looks things up itself as before. It only saves turns; the approval gate checks every action as usual.
import { db, save } from './store.mjs';
import { ask as jevAsk } from './jev.mjs';
import { one, listConnections, platformBlurbs } from './one.mjs';
import { workspace, oneScope } from './workspaces.mjs';
import { getAgent } from './agents.mjs';
import { isReadOnlyAction } from './policy.mjs';

export const LIMITS = {
  threshold: 0.5,       // Jev's yes-probability an action needs to make the plan
  maxActions: 3,        // actions in a plan (top 3)
  docsChars: 12_000,    // docs in the prompt, all actions together (~3k tokens), each one trimmed (trimActionDoc)
  maxCandidates: 40,    // action IDs from an agent file Jev looks at
  maxPlatforms: 3,      // platforms Orchy searches for an agent without IDs
  batch: 20,            // questions per Jev call
  budgetMs: 8_000,      // how long a run waits for its plan
  cacheMs: 3 * 60_000,  // a plan made during the routing countdown is kept this long for the dispatch
};

const ID_RE = /conn_mod_def::[\w-]+::[\w-]+/g;
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const platformOf = key => String(key || '').split('::')[1] || null;

// ── candidates ──

/** A connection from an agent's frontmatter or `one list`, with its platform. */
function normConn(c) {
  const key = typeof c === 'string' ? c : c?.key;
  if (!key) return null;
  return { key, platform: c.platform || platformOf(key), name: c.name || c.platform || platformOf(key) };
}

/** The line an action ID sits on, as words: "gmail · Create Draft — write" from a table row or bullet. */
function cleanLabel(line) {
  return line.replace(ID_RE, '').replace(/`/g, '')
    .split('|').map(s => s.trim()).filter(s => s && !/^(read|write|full|:?-{2,}:?)$/i.test(s)).join(' — ')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').replace(/[\s:—-]+$/, '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * The action IDs an agent's Markdown names, each with the words around it and its platform: the platform
 * named on its line, else the last one named above it (a "Notion:" heading over a bullet list), else the
 * agent's only platform.
 */
export function agentActions(markdown, platforms = []) {
  const body = String(markdown || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const plats = [...new Set(platforms.filter(Boolean))];
  const res = plats.map(p => [p, new RegExp(`(^|[^\\w-])${esc(p).replace(/-/g, '[- ]?')}(?![\\w-])`, 'i')]);
  const named = text => res.find(([, re]) => re.test(text))?.[0] || null;
  let current = plats.length === 1 ? plats[0] : null;
  const out = new Map();
  for (const line of body.split(/\r?\n/)) {
    const ids = line.match(ID_RE);
    const here = named(line.replace(ID_RE, ''));
    if (here) current = here;
    if (!ids) continue;
    for (const actionId of ids) if (!out.has(actionId)) out.set(actionId, { actionId, label: cleanLabel(line), platform: here || current });
  }
  return [...out.values()];
}

/** Text the owner typed can reach `one` through a shell on some installs: keep only plain words and punctuation. */
export function safeIntent(text) {
  return String(text || '').replace(/["'`$&|;<>^%!(){}[\]\\\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** `one actions find` on these platforms for the task: One's own pick per platform (with docs) and its alternatives. */
async function findActions(ws, platforms, task, oneFn) {
  const intent = safeIntent(task);
  if (!intent || !platforms.length) return [];
  const res = await oneFn(['actions', 'find', ...platforms.flatMap(p => [p, intent]), '--task', intent], { cwd: ws.dir, timeoutMs: 15_000 });
  const out = new Map();
  for (const a of res.answers || []) {
    for (const s of a.selected || []) if (!out.has(s.actionId)) out.set(s.actionId, { actionId: s.actionId, title: s.title, method: s.method, path: s.path, platform: a.platform, docs: s.knowledge || null });
    for (const s of a.alternatives || []) if (!out.has(s.actionId)) out.set(s.actionId, { actionId: s.actionId, title: s.title, method: s.method, path: s.path, platform: a.platform, docs: null });
  }
  return [...out.values()];
}

/** `one actions load` (up to 10 at once, served from One's local cache once seen): actionId → {docs, title, method, path}. */
async function loadDocs(ws, ids, oneFn) {
  if (!ids.length) return {};
  const res = await oneFn(['actions', 'load', ...ids.slice(0, 10)], { cwd: ws.dir, timeoutMs: 15_000 });
  return Object.fromEntries((res.loaded || []).map(l => [l.actionId, { docs: l.knowledge || null, title: l.title, method: l.method, path: l.path }]));
}

// ── Jev ──

async function askBatched(state, questions, askFn) {
  const names = Object.keys(questions);
  const chunks = [];
  for (let i = 0; i < names.length; i += LIMITS.batch) chunks.push(names.slice(i, i + LIMITS.batch));
  const results = await Promise.all(chunks.map(ch => askFn(state, Object.fromEntries(ch.map(n => [n, questions[n]])), { purpose: 'actionplan', timeoutMs: 6_000, fallback: false })));
  return { answers: Object.assign({}, ...results.map(r => r.answers || {})), ms: Math.max(0, ...results.map(r => r.ms || 0)), calls: results.length };
}

export function connectionQuestions(conns, blurbs = {}) {
  return Object.fromEntries(conns.map((c, i) => [`c${i}`, {
    type: 'noul',
    instructions: `Would an agent doing this task use the connection "${c.name}" (${c.platform}${blurbs[c.platform] ? `: ${blurbs[c.platform]}` : ''}) for any step of it? Several accounts of one app can be connected: say yes only for the account(s) the task is about.`,
  }]));
}

export function actionQuestions(cands) {
  return Object.fromEntries(cands.map((c, i) => [`a${i}`, {
    type: 'noul',
    instructions: `To do this task, will the agent run the ${c.platform || 'app'} action "${c.title || c.label}"${c.kind ? ` [${c.kind}]` : ''}${c.label && c.title && c.label !== c.title ? ` (its notes: ${c.label.slice(0, 160)})` : ''}?`,
  }]));
}

/** Jev's yes-probabilities → the picks: at least the threshold, most likely first, at most maxActions. */
export function choose(items, answers, prefix, { threshold = LIMITS.threshold, max = Infinity } = {}) {
  return items.map((x, i) => ({ ...x, p: answers[`${prefix}${i}`]?.noul ?? 0 }))
    .filter(x => x.p >= threshold).sort((a, b) => b.p - a.p).slice(0, max);
}

// ── the plan ──

const DROP_HEADING_RE = /^#{1,5}\s*(?:errors?|error\s+(?:codes?|responses?|handling|table|messages?)|status\s+codes?|http\s+status|troubleshooting|rate\s+limits?|common\s+(?:errors|issues|mistakes)|response\s+(?:schema|fields|body|format)|full\s+response|additional\s+examples?|more\s+examples?)\b/i;

/**
 * Trim an action doc to what the agent needs to execute: method, URL, required params, and at most one short sample.
 * Drops error tables, response-schema dumps, troubleshooting sections, and second/long code blocks.
 */
export function trimActionDoc(doc) {
  if (!doc) return doc;
  const lines = String(doc).split(/\r?\n/);
  const out = [];
  let inFence = false;
  let fenceLines = [];
  let samplesKept = 0;
  let dropLevel = 0; // >0 while inside a dropped heading section
  for (const line of lines) {
    const fenceMatch = /^\s*(```|~~~)/.exec(line);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceLines = [line];
      } else {
        inFence = false;
        if (!dropLevel && samplesKept < 1) {
          samplesKept++;
          const body = fenceLines.slice(1).join('\n');
          const trimmedBody = body.length > 600 ? `${body.slice(0, 590).trimEnd()}\n// …` : body;
          out.push(fenceLines[0], trimmedBody, line);
        }
        fenceLines = [];
      }
      continue;
    }
    if (inFence) {
      fenceLines.push(line);
      continue;
    }
    const hMatch = /^(#{1,5})\s+/.exec(line);
    if (hMatch) {
      const level = hMatch[1].length;
      if (DROP_HEADING_RE.test(line)) {
        dropLevel = dropLevel ? Math.min(dropLevel, level) : level;
        continue;
      }
      if (dropLevel && level <= dropLevel) dropLevel = 0;
    }
    if (dropLevel) continue;
    // Skip markdown table rows that look like HTTP error status code rows (| 400 | ... |, | 401 | ... |, | 429 | ... |, | 500 | ... |)
    if (/^\s*\|\s*`?(?:4\d\d|5\d\d)`?\s*\|/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Which actions get their docs in the prompt: most likely first, trimmed, until the size budget is used up. */
export function budgetDocs(picks, budget = LIMITS.docsChars) {
  let used = 0;
  return picks.map(a => {
    const docs = a.docs ? trimActionDoc(a.docs) : a.docs;
    const fits = !!docs && used + docs.length <= budget;
    if (fits) used += docs.length;
    return { ...a, docs, withDocs: fits };
  });
}

/** A doc's headings two levels down (outside code blocks), so its "## Endpoint" sits under its action, not beside the agent's own sections. */
export function demote(doc) {
  let fenced = false;
  return String(doc || '').split('\n').map(line => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    return !fenced && /^#{1,4}\s/.test(line) ? `##${line}` : line;
  }).join('\n');
}

/** The plan as the section of the agent's system prompt (prompts.mjs#protocolText). */
export function planText(actions, conns) {
  if (!actions.length) return '';
  const keysFor = a => conns.filter(c => c.platform === a.platform);
  const keyCell = a => keysFor(a).map(c => `\`${c.key}\` (${c.name})`).join(', ') || 'one of yours for this app';
  return `## Jev's plan for this task
Before you started, Orchy asked Jev which One actions this task needs and loaded their docs below. **These count as found and read**: run them straight away with \`one --agent actions execute <platform> <actionId> <connectionKey> ...\`, without \`actions find\` or \`actions load\` (and never \`actions load --full\`) for them first. Send every field a doc marks required, where it says (many want the connection key inside \`-d\` as \`connectionKey\` too). The plan is Jev's best guess: skip an action the task turns out not to need, and if it needs one that isn't here (or a doc says a section you need was left out), find or load it as usual. Approvals work as always.

| Action | Platform | Action ID | Connection key |
|---|---|---|---|
${actions.map(a => `| ${a.title || a.label}${a.kind ? ` (${a.kind})` : ''} | ${a.platform || '?'} | \`${a.actionId}\` | ${keyCell(a)} |`).join('\n')}
${actions.map(a => a.withDocs
    ? `\n### ${a.title || a.label} · \`${a.actionId}\`\n${demote(trimActionDoc(a.docs).trim())}\n`
    : `\n### ${a.title || a.label} · \`${a.actionId}\`\nDocs not included (over the size limit): run \`one --agent actions load ${a.actionId}\` before using it.\n`).join('')}`;
}

/** What the run record keeps (no docs): shown in the run window and the feed. */
function summary(status, { actions = [], considered = 0, source = null, connections = [], ms = 0, jevMs = 0, jevCalls = 0, note = null } = {}) {
  return {
    status, source, considered, ms, jevMs, jevCalls, note,
    connections: connections.map(c => c.name),
    actions: actions.map(a => ({ actionId: a.actionId, title: a.title || a.label, platform: a.platform || null, kind: a.kind || null, p: Math.round(a.p * 100) / 100, docs: !!a.withDocs })),
  };
}

/** One line for the run's feed. */
export function planLine(s) {
  if (s.status === 'planned') return `Jev planned ${s.actions.map(a => a.title).join(', ')} (${(s.ms / 1000).toFixed(1)}s)`;
  if (s.status === 'none') return `Jev: this task needs no app actions from ${s.source === 'agent-file' ? 'the agent\'s list' : 'its connections'} (${(s.ms / 1000).toFixed(1)}s)`;
  return `No plan from Jev (${s.note || s.status}); the agent looks actions up itself`;
}

/** Fill in what Orchy learned about these actions, so the gate needn't look them up again. */
function rememberActions(list) {
  const cache = db().actionCache;
  let n = 0;
  for (const a of list) {
    if (!a.actionId || !a.method || cache[a.actionId]?.method) continue;
    cache[a.actionId] = { ...cache[a.actionId], title: a.title || cache[a.actionId]?.title || null, method: a.method, path: a.path || null, ...(a.fromFind && a.platform ? { platform: a.platform } : {}) };
    n++;
  }
  if (n) save();
}

/**
 * Build the plan. deps lets tests swap Jev, the One CLI and the action cache.
 * Returns { summary, text } (text = the prompt section, '' when there's nothing to add).
 */
export async function buildPlan({ ws, agent, instruction, client = null }, deps = {}) {
  const { ask = jevAsk, oneFn = one, conns: connsFn = listConnections, cache = db().actionCache, remember = rememberActions, blurbs = () => platformBlurbs(ws.dir) } = deps;
  const t0 = Date.now();
  // the connections this run may use: the agent's own; a the owner run of an agent without a list may use the workspace's
  const own = (agent?.connections || []).map(normConn).filter(Boolean);
  const pool = own.length ? own : client ? [] : (await connsFn(ws.dir)).map(normConn).filter(Boolean);
  if (!pool.length) return { summary: summary('none', { ms: Date.now() - t0, note: 'no app connections' }), text: '' };

  const task = { task: String(instruction || '').slice(0, 4000), agent: agent ? `${agent.displayName}: ${String(agent.description || '').slice(0, 400)}` : `${ws.name} generalist for ${ws.client}` };
  let jevMs = 0, jevCalls = 0, connections = pool, source, cands;

  const listed = agent?.markdown ? agentActions(agent.markdown, pool.map(c => c.platform)) : [];
  if (listed.length) {
    source = 'agent-file';
    cands = listed.slice(0, LIMITS.maxCandidates).map(c => {
      const known = cache[c.actionId] || {};
      return { ...c, title: known.title || null, method: known.method || null, platform: c.platform || known.platform || null };
    });
  } else {
    // no list to pick from: Jev picks the connections, One's own search finds the actions on them
    source = 'find';
    const about = blurbs();
    const state = { ...task, connections: pool.map(c => `${c.name} (${c.platform}${about[c.platform] ? `: ${about[c.platform]}` : ''})`).join('\n') };
    const r = await askBatched(state, connectionQuestions(pool, about), ask);
    jevMs += r.ms; jevCalls += r.calls;
    connections = choose(pool, r.answers, 'c');
    const platforms = [...new Set(connections.map(c => c.platform))].slice(0, LIMITS.maxPlatforms);
    if (!platforms.length) return { summary: summary('none', { source, ms: Date.now() - t0, jevMs, jevCalls }), text: '' };
    cands = (await findActions(ws, platforms, instruction, oneFn)).map(c => ({ ...c, fromFind: true })).slice(0, LIMITS.maxCandidates);
  }
  if (!cands.length) return { summary: summary('none', { source, connections, ms: Date.now() - t0, jevMs, jevCalls }), text: '' };
  cands = cands.map(c => ({ ...c, kind: c.method ? (isReadOnlyAction(c.method, c.title || '') ? 'read' : 'write') : null }));

  const r = await askBatched({ ...task, candidate_actions: cands.map(c => `${c.platform || '?'}: ${c.title || c.label}`).join('\n') }, actionQuestions(cands), ask);
  jevMs += r.ms; jevCalls += r.calls;
  let picks = choose(cands, r.answers, 'a', { max: LIMITS.maxActions });
  if (!picks.length) return { summary: summary('none', { source, considered: cands.length, connections, ms: Date.now() - t0, jevMs, jevCalls }), text: '' };

  // docs: One's pick already came with them; load the rest in one go
  const missing = picks.filter(a => !a.docs).map(a => a.actionId);
  if (missing.length) {
    const loaded = await loadDocs(ws, missing, oneFn).catch(e => { console.warn('[actionplan] load failed:', e.message); return {}; });
    picks = picks.map(a => loaded[a.actionId] ? { ...a, docs: loaded[a.actionId].docs, title: a.title || loaded[a.actionId].title, method: a.method || loaded[a.actionId].method, path: a.path || loaded[a.actionId].path } : a);
    picks = picks.map(a => ({ ...a, kind: a.kind || (a.method ? (isReadOnlyAction(a.method, a.title || '') ? 'read' : 'write') : null) }));
  }
  remember([...cands, ...picks]);
  picks = budgetDocs(picks);
  return {
    summary: summary('planned', { actions: picks, source, considered: cands.length, connections: source === 'find' ? connections : [], ms: Date.now() - t0, jevMs, jevCalls }),
    text: planText(picks, connections),
  };
}

// ── when to plan, and the cache that lets the routing countdown do it early ──

/** Why this run gets no plan (null = plan it). */
export function skipReason({ ws, isBuilder = false, resume = false }) {
  if (db().settings.actionPlan === false) return 'switched off in Settings';
  if (isBuilder) return 'agent builds pick their tools with Jev already';
  if (resume) return 'a follow-up continues its own conversation';
  if (!oneScope(ws).own) return 'no One login for this workspace';
  return null;
}

const pending = new Map(); // key -> { at, promise }
const keyOf = (wsId, slug, instruction, client) => `${wsId}|${slug || 'general'}|${client || ''}|${instruction}`;

function cached(ws, agent, instruction, client, deps) {
  const key = keyOf(ws.id, agent?.slug, instruction, client?.id);
  for (const [k, v] of pending) if (Date.now() - v.at > LIMITS.cacheMs) pending.delete(k);
  let hit = pending.get(key);
  if (!hit) {
    const promise = buildPlan({ ws, agent, instruction, client }, deps)
      .catch(e => { console.warn('[actionplan]', e.message); pending.delete(key); return { summary: summary('failed', { note: e.message.slice(0, 160) }), text: '' }; });
    hit = { at: Date.now(), promise };
    pending.set(key, hit);
  }
  return hit;
}

/** Start planning while the owner looks at the routing card, so the dispatch finds it ready. */
export function warm({ wsId, agentSlug = null, instruction }) {
  try {
    const ws = workspace(wsId);
    if (!ws.enabled || skipReason({ ws })) return;
    const agent = agentSlug ? getAgent(ws.id, agentSlug) : null;
    if (agent?.error) return;
    cached(ws, agent, instruction, null);
  } catch (e) { console.warn('[actionplan] warm:', e.message); }
}

/**
 * The plan for a run that's starting, within the time budget. Returns null when the run gets none
 * (skipped), else { summary, text }; a plan still cooking at the deadline is reported as slow.
 */
export async function planFor({ ws, agent = null, instruction, client = null, isBuilder = false, resume = false }, { budgetMs = LIMITS.budgetMs, deps } = {}) {
  if (skipReason({ ws, isBuilder, resume })) return null;
  const hit = cached(ws, agent, instruction, client, deps);
  const left = Math.max(0, budgetMs - (Date.now() - hit.at));
  let timer;
  const slow = new Promise(res => { timer = setTimeout(() => res({ summary: summary('slow', { ms: Date.now() - hit.at, note: `not ready after ${Math.round(budgetMs / 1000)}s` }), text: '' }), Math.max(left, 1_500)); });
  try { return await Promise.race([hit.promise, slow]); } finally { clearTimeout(timer); }
}
