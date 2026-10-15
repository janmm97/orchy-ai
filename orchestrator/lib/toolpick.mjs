// Jev picks a new agent's tools. The AI Agent Builder lists the workspace's connections (`one --agent list`),
// finds candidate actions (`one --agent actions find`), and hands them over; Jev answers one question per
// connection (skip / read / full) and one per action (use / skip). The builder then confirms with the owner
// (request_connections) with Jev's picks pre-switched-on.
import { ask } from './jev.mjs';
import { isReadOnlyAction } from './policy.mjs';
import { ownerName } from './env.mjs';

const BATCH = 20;          // questions per Jev call
const MAX_ACTIONS = 40;
const SURE = 0.7;          // below this, the builder should ask the owner

/** Read or write the way the approval gate sees it (its method from One, not the builder's guess). */
async function classify(a, resolve) {
  let info = null;
  try { info = resolve ? await resolve(a.action_id, a.platform) : null; } catch {}
  const method = info?.method || a.method || null;
  const title = info?.title || a.title;
  return { ...a, title: a.title || title, method, kind: isReadOnlyAction(method, title) ? 'read' : 'write', builderKind: a.kind || null };
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } }));
  return out;
}

/**
 * @param {object} p
 * @param {string} p.agentName
 * @param {string} p.job        what the agent does: trigger, inputs, output, cadence
 * @param {Array}  p.pool       the workspace's connections ({key, name, platform, source, description})
 * @param {Array}  p.actions    candidates from `one actions find` ({platform, action_id, title, method?, kind?})
 * @param {Function} [p.resolve] (actionId, platform) → {method, title}: the gate's own action lookup
 */
export async function pickTools({ agentName, job, pool, actions = [], resolve }) {
  const acts = await mapLimit(actions.filter(a => a && a.action_id && a.platform).slice(0, MAX_ACTIONS), 6, a => classify(a, resolve));
  const conns = pool.filter(c => c.enabled !== false);
  if (!conns.length && !acts.length) throw new Error('Nothing to choose from: no connections in this workspace and no actions given');

  const state = {
    agent_name: agentName,
    agent_job: job,
    connections_in_workspace: conns.map(c => `${c.name} (${c.source === 'mcp' ? 'MCP server' : `platform ${c.platform}`})${c.description ? ` — ${c.description}` : ''}`).join('\n') || '(none)',
    candidate_actions: acts.map(a => `${a.platform}: ${a.title} [${a.kind}]`).join('\n') || '(none)',
    rule: 'Least privilege: give the agent only what its job needs. Read access allows only the actions marked [read]; any action marked [write] needs full access on that connection, even if it only fetches something (Orchy counts every non-GET request that is not clearly a search or lookup as a write). When a platform has several accounts, pick only the account(s) the job is about.',
  };
  const writesBy = p => acts.filter(a => a.platform === p && a.kind === 'write').map(a => `"${a.title}"`);
  const questions = {};
  conns.forEach((c, i) => {
    const w = writesBy(c.platform);
    questions[`c${i}`] = {
      type: 'choice',
      instructions: `Does ${agentName} need the connection "${c.name}" (${c.source === 'mcp' ? 'MCP server' : c.platform}) to do its job?${w.length ? ` On read access Orchy would block ${w.join(', ')}.` : ''}`,
      criteria: {
        skip: `Not needed for this job, or it is a different account than the one the job is about`,
        read: `Needed, and every action the job uses on ${c.name} is a [read] action`,
        full: `Needed, and the job uses at least one [write] action on ${c.name}${w.length ? ` (${w.join(', ')})` : ''}`,
      },
    };
  });
  acts.forEach((a, i) => {
    questions[`a${i}`] = {
      type: 'choice',
      instructions: `Should ${agentName} use the ${a.platform} action "${a.title}" [${a.kind}]${a.kind === 'write' && a.builderKind === 'read' ? ' (it only fetches data, but Orchy counts it as a write)' : ''}?`,
      criteria: { use: `The job needs this action`, skip: `Not needed, or another candidate action does it better` },
    };
  });

  const names = Object.keys(questions);
  const chunks = [];
  for (let i = 0; i < names.length; i += BATCH) chunks.push(names.slice(i, i + BATCH));
  const results = await Promise.all(chunks.map(ch => ask(state, Object.fromEntries(ch.map(n => [n, questions[n]])), { purpose: 'toolpick' })));
  const A = Object.assign({}, ...results.map(r => r.answers || {}));

  const chosenActions = acts.map((a, i) => ({ ...a, pick: A[`a${i}`]?.choice, confidence: A[`a${i}`]?.confidence ?? 0 }));
  const used = chosenActions.filter(a => a.pick === 'use');
  const writesOn = new Set(used.filter(a => a.kind === 'write').map(a => a.platform));

  const notes = [];
  const connections = conns.map((c, i) => ({ ...c, pick: A[`c${i}`]?.choice || 'skip', confidence: A[`c${i}`]?.confidence ?? 0 }))
    .filter(c => c.pick !== 'skip')
    .map(c => {
      if (c.pick === 'read' && writesOn.has(c.platform)) {
        notes.push(`${c.name}: raised from read to full, because Orchy counts ${used.filter(a => a.platform === c.platform && a.kind === 'write').map(a => `"${a.title}"`).join(', ')} as a write and read access would block it.`);
        return { ...c, pick: 'full' };
      }
      return c;
    });
  for (const p of new Set(used.map(a => a.platform))) {
    if (!connections.some(c => c.platform === p)) notes.push(`Jev chose ${p} actions but no ${p} connection. Ask ${ownerName()} which ${p} account to use.`);
  }
  // every MCP server is its own app (their platform is just "mcp")
  const app = c => (c.source === 'mcp' ? c.key : c.platform);
  const multi = [...new Set(connections.map(app))].filter(p => connections.filter(c => app(c) === p).length > 1);
  for (const p of multi) notes.push(`Jev picked several ${p} accounts (${connections.filter(c => app(c) === p).map(c => c.name).join(', ')}). Check that the job really needs each.`);

  const unsure = [
    ...connections.filter(c => c.confidence < SURE).map(c => `connection ${c.name}`),
    ...used.filter(a => a.confidence < SURE).map(a => `action ${a.platform}: ${a.title}`),
  ];
  return {
    connections: connections.map(c => ({ key: c.key, name: c.name, platform: c.platform, access: c.pick, confidence: +c.confidence.toFixed(2) })),
    actions: used.map(a => ({ platform: a.platform, action_id: a.action_id, title: a.title, kind: a.kind, confidence: +a.confidence.toFixed(2) })),
    skippedActions: chosenActions.filter(a => a.pick !== 'use').map(a => `${a.platform}: ${a.title}`),
    notes,
    unsure,
    jev: { model: results[0]?.model, calls: results.length, ms: Math.max(...results.map(r => r.ms || 0)) },
  };
}
