// The approval gate. Every tool call an agent wants to make passes through here: Claude Code's
// through the bridge's permission-prompt tool, Codex's through its app-server approval requests.
// Reads and own-folder work pass; outward actions become an Approve/Deny pop-up for the owner (in a client's
// run, the ones about the client's own apps go to the client's page instead: see clients.mjs#askFields).
import { db, save } from './store.mjs';
import { emit } from './bus.mjs';
import { workspace, allConnections, oneScope } from './workspaces.mjs';
import { getAgent, listAgents } from './agents.mjs';
import { decide, ruleMatches, parseOneCommands } from './policy.mjs';
import * as inbox from './inbox.mjs';
import { describeAction } from './one.mjs';
import { askFields, clientShared } from './clients.mjs';
import { clientHome, clientReadDirs } from './clientspace.mjs';
import { jevDecision } from './jevdecide.mjs';
import { ownerName } from './env.mjs';

/** Look up an action's title/method from what One told Orchy or its agents' lookups, else ask One. */
export async function resolveAction(ws, actionId, platform) {
  const cache = db().actionCache;
  if (cache[actionId]?.method) return cache[actionId];
  // no One login of its own: running `one` here would use the orchestrator's account
  if (!oneScope(ws).own) return { method: null, title: null, platform };
  const info = await describeAction(ws.dir, actionId);
  cache[actionId] = { ...info, platform: info.platform || platform };
  save();
  return cache[actionId];
}

/** The run, its workspace and agent, and how it signs pop-ups. */
export function runCtx(runId) {
  const run = db().runs[runId];
  if (!run) throw Object.assign(new Error('No such run'), { status: 404 });
  const ws = workspace(run.workspace);
  let agent = null;
  if (run.agentSlug && !run.isBuilder) { try { agent = getAgent(ws.id, run.agentSlug); } catch {} }
  return { run, ws, agent, who: { slug: run.agentSlug || 'general', displayName: run.agentName } };
}

/**
 * Decide on one tool call. Returns { decision: 'allow'|'deny'|'ask', reason, itemId? }.
 * 'ask' has already put an approval pop-up in the owner's inbox; the caller waits for it.
 */
export async function gate(runId, toolName, input = {}) {
  const { run, ws, agent, who } = runCtx(runId);
  let connections = (await allConnections(ws)).one;
  // a key the cached list doesn't know may be an app reconnected minutes ago: look again before refusing it
  const keys = parseOneCommands(String(input.command || ''), toolName).filter(c => c.kind === 'execute').map(c => c.connectionKey);
  if (keys.some(k => !connections.some(c => c.key === k))) {
    const fresh = await allConnections(ws, { force: true });
    if (!fresh.oneError) connections = fresh.one;
  }
  const s = db().settings;
  // a client's run: its own folder is all it has (clientspace.mjs), and the owner's "always allow" rules from their own
  // runs of the same agent don't carry over: each of its asks is decided afresh
  const home = run.client ? clientHome(ws, run.client) : null;
  const remembered = key => !run.client && ruleMatches(run, key);
  const verdict = await decide(toolName, input, {
    run, ws, agent, connections, oneScoped: oneScope(ws).own, remembered,
    ...(home ? { home, readRoots: clientReadDirs(ws, home) } : {}),
    // a team agent's run that a head handed over: every outward decision asks the owner, whatever Settings switched off
    mode: s.approvals === 'all' ? 'all' : 'decisions', askFor: run.delegatedBy ? {} : s.askFor || {},
    // Settings → Scripts (on unless the owner switched it off): scripts run on their own unless they look like one of the
    // decisions in askFor, and in a head's hand-offs, where askFor is empty, that's every kind of decision
    scriptsFree: s.scriptsFree !== false,
    // this workspace's agents (they never run inside another run); in a client's run, which of them are theirs
    // (Orchy's own backend has no agents: the helpers in the root .claude/agents are generic)
    clientAgents: clientShared(run), wsAgents: run.backend ? [] : listAgents(ws.id).map(a => a.slug),
    resolveAction: (aid, platform) => resolveAction(ws, aid, platform),
    // Jev's second look at an action whose name matched no decision (can only add an ask)
    classify: async info => { const d = await jevDecision(info); return d && { ...d, byJev: true }; },
  });
  // the run ended (or is being stopped) while this was decided: nothing more runs, and no pop-up for it
  if (run.endedAt || run.status === 'stopping') return { decision: 'deny', reason: 'This run has ended.' };
  if (verdict.decision === 'allow') return { decision: 'allow' };
  if (verdict.decision === 'deny') {
    emit('run.event', { runId: run.id, workspace: ws.id, event: { t: new Date().toISOString(), kind: 'denied', text: verdict.reason } });
    return { decision: 'deny', reason: verdict.reason };
  }
  // "always allow" never covers an outward action in a handed-over run: the owner sees each one (for shell lines and One
  // actions decide() already skipped the remembered pieces and returned the first that isn't)
  const handedOutward = !!run.delegatedBy && !!verdict.outward;
  if (!handedOutward && remembered(verdict.ruleKey)) return { decision: 'allow' };
  const item = inbox.createItem('approval', {
    runId: run.id, workspace: ws.id, agent: who, title: verdict.summary, message: verdict.reason,
    detail: verdict.detail, ruleKey: verdict.ruleKey, tool: toolName, action: verdict.action || null,
    delegatedBy: run.delegatedByName || null, noRemember: handedOutward || !!run.client,
    ...askFields(run, verdict.ruleKey || ''),
  });
  return { decision: 'ask', itemId: item.id };
}

/** Wait until the owner answers an inbox item (or the run ends and it expires). */
export async function waitAnswered(itemId) {
  for (;;) {
    const item = await inbox.waitFor(itemId, 25_000);
    if (!item) return { status: 'expired' };
    if (item.status !== 'pending') return item;
  }
}

/** gate() + wait: resolves { allow, reason, byOwner } once it's settled. onAsk() runs while the owner decides. */
export async function gateAndWait(runId, toolName, input, { onAsk } = {}) {
  const v = await gate(runId, toolName, input);
  if (v.decision === 'allow') return { allow: true };
  if (v.decision === 'deny') return { allow: false, reason: v.reason, byOwner: false };
  onAsk?.(v.itemId);
  const item = await waitAnswered(v.itemId);
  if (item.status === 'answered' && item.answer?.approve) return { allow: true };
  const who = item.askee || ownerName();
  const reason = item.status === 'expired' ? `No answer from ${who}.` : `${who} denied this${item.answer?.note ? `: ${item.answer.note}` : '.'}`;
  return { allow: false, reason, byOwner: true };
}
