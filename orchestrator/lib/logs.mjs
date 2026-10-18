// LOGS.md: every finished agent task, with workspace, agent and a detailed summary.
import fs from 'node:fs';
import path from 'node:path';
import { LOGS_PATH, DATA_DIR, config, ownerName } from './env.mjs';
import { db } from './store.mjs';
import { accountFor, runtimeLabel } from './workspaces.mjs';
import { taskRel } from './clientspace.mjs';

const HEADER = `# Orchy Logs

Every task an agent finishes is reported back to Orchy and logged here,
newest at the bottom. Times are in ${config.timezone}.
`;

export function fmtTime(iso, opts = {}) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone, year: 'numeric', month: 'short', day: '2-digit',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short', ...opts,
  }).format(new Date(iso));
}

function fmtDuration(ms) {
  if (!ms && ms !== 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function ensureFile() {
  const cur = fs.existsSync(LOGS_PATH) ? fs.readFileSync(LOGS_PATH, 'utf8') : '';
  if (!cur.trim()) fs.writeFileSync(LOGS_PATH, HEADER);
}

export const STATUS = {
  completed: '✅ Completed', partial: '🟡 Partly done', blocked: '⛔ Blocked', failed: '❌ Failed', get stopped() { return `⏹️ Stopped by ${ownerName()}`; },
};

export const bullets = arr => {
  const list = Array.isArray(arr) ? arr : arr ? [arr] : []; // older reports may hold one string
  return list.length ? list.map(x => `- ${String(x).replace(/\n+/g, ' ')}`).join('\n') : '- —';
};

/** What the run asked the owner, and what the owner said. */
export function qaLines(items = []) {
  const asks = items.filter(i => i.kind === 'question' && i.status === 'answered').map(i => `Asked ${i.askee || ownerName()}: "${i.message}" → "${i.answer?.text ?? i.answer}"`);
  const approvals = items.filter(i => i.kind === 'approval' && i.status === 'answered').map(i => `${i.answer?.approve ? 'Approved' : 'Denied'}${i.answerer === 'client' ? ` by ${i.askee}` : ''}: ${i.title}`);
  const picks = items.filter(i => i.kind === 'connections' && i.status === 'answered').map(i => `Connections chosen: ${(i.answer?.selected || []).map(s => s.name || s.key).join(', ') || 'none'}`);
  return [...asks, ...approvals, ...picks];
}

/** A head's hand-offs: which team agent, which run, how it went (each has its own entry). */
function handOffLines(run) {
  return run.subRuns.map(sid => {
    const s = db().runs[sid];
    if (!s) return `run \`${sid}\``;
    const how = s.report?.status || s.outcome || (s.status === 'stopping' ? 'stopped' : s.status);
    return `${s.agentName} (\`${s.agentSlug}\`) · run \`${sid}\` · ${STATUS[how] || how}: ${s.instruction.replace(/\s+/g, ' ').slice(0, 160)}`;
  });
}

/** Append one entry for a finished run. */
export function appendRunLog(run, ws, items = []) {
  ensureFile();
  const r = run.report || {};
  const status = r.status || run.outcome || 'completed';
  const route = run.delegatedBy ? ` (handed over by ${run.delegatedByName})` : run.clientName ? (run.ownerReply ? ` (${ownerName()}, on ${run.clientName}’s task)` : ` (started by ${run.clientName} from the client page)`) : run.routing?.source === 'schedule' ? ' (scheduled run)' : run.routing ? ` (routed by Jev${run.routing.confidence != null ? `, ${Math.round(run.routing.confidence * 100)}% sure` : ''}${run.routing.overridden ? `, adjusted by ${ownerName()}` : ''})` : ` (dispatched by ${ownerName()})`;

  const entry = `
---

### ${status === 'stopped' && run.stoppedBy ? `⏹️ Stopped by ${run.stoppedBy}` : STATUS[status] || status} · ${ws.name} · ${run.agentName}
**${fmtTime(run.endedAt || new Date().toISOString())}**

| | |
|---|---|
| **Workspace** | ${ws.name} — ${ws.client} (${runtimeLabel(run.runtime || ws.runtime)}: ${accountFor(ws, run.runtime || ws.runtime).email || accountFor(ws, run.runtime || ws.runtime).profileDir || 'own profile'}) |
| **Agent** | ${run.agentName} (\`${run.agentSlug || 'general'}\`) |
| **Model** | ${run.model}${run.effort ? ` · ${run.effort} effort` : ''}${route} |
| **Task** | ${run.instruction.replace(/\|/g, '\\|').replace(/\n+/g, ' ').slice(0, 400)} |
| **Duration** | ${fmtDuration(run.durationMs)}${run.numTurns ? ` · ${run.numTurns} turns` : ''} |
| **Run** | \`${run.id}\` |
${run.delegatedBy ? `| **Delegated by** | ${run.delegatedByName} · run \`${run.delegatedBy}\` |\n` : ''}${run.missionId ? `| **Mission** | step ${run.stepId} of \`${run.missionId}\` |\n` : ''}${run.taskDir ? `| **Task folder** | \`${path.basename(ws.dir)}/${run.client ? `.clients/${run.client}/` : ''}${taskRel(run)}\` |\n` : ''}
**Summary**

${(r.summary || run.resultText || 'The agent finished without writing a summary.').trim()}

**Actions taken**
${bullets(r.actions_taken)}

**Outputs**
${bullets(r.outputs)}

**Questions & approvals**
${bullets(qaLines(items))}
${run.subRuns?.length ? `
**Handed to the team**
${bullets(handOffLines(run))}
` : ''}
**Follow-ups**
${bullets(r.follow_ups)}
`;
  fs.appendFileSync(LOGS_PATH, entry);
  return entry;
}

/** One line per finished run in `<workspace>/.jos/costs.jsonl`, so a workspace's own agents (a weekly report, its
 *  AI Agent Builder's review) can read what their runs cost without reaching into Orchy's records. Client and fix
 *  runs stay out. */
export function appendCostLine(run, ws) {
  if (run.client || run.backend || !ws?.dir) return;
  const r = run.report || {};
  const line = {
    runId: run.id,
    agent: run.agentSlug || 'general',
    agentName: run.agentName,
    kind: run.huddle ? 'huddle' : run.kind || 'task',
    source: run.routing?.source === 'schedule' ? 'schedule' : run.delegatedBy ? 'handoff' : 'owner',
    date: run.endedAt,
    outcome: r.status || run.outcome,
    costUsd: typeof run.costUsd === 'number' ? Math.round(run.costUsd * 10000) / 10000 : null,
    tokens: run.tokens || null,
    numTurns: run.numTurns ?? null,
    durationMs: run.durationMs ?? null,
    model: run.model,
    summary: String(r.summary || run.resultText || '').replace(/\s+/g, ' ').trim().slice(0, 160),
  };
  const dir = path.join(ws.dir, '.jos');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'costs.jsonl'), JSON.stringify(line) + '\n');
}

const HUDDLE_STATUS = { get agreed() { return `🤝 Agreed, waiting for ${ownerName()}`; }, approved: '🤝 Agreed and approved', get stopped() { return `⏹️ Huddle stopped by ${ownerName()}`; }, failed: '❌ Huddle failed' };

/** One entry for a huddle (huddle.mjs): who talked, about what, and what they agreed. Its turns aren't logged one by one. */
export function appendHuddleLog(h, ws) {
  ensureFile();
  const entry = huddleLogEntry(h, ws);
  fs.appendFileSync(LOGS_PATH, entry);
  return entry;
}
/** The huddle's LOGS.md entry: its agreement, what's still contested, Orchy's take and what Orchy answered from the rules. */
export function huddleLogEntry(h, ws) {
  const names = h.agents.map(a => a.name).join(' + ');
  const a = h.agreement || {};
  return `
---

### ${HUDDLE_STATUS[h.status] || h.status} · ${ws.name} · Huddle: ${names}
**${fmtTime(h.endedAt || new Date().toISOString())}**

| | |
|---|---|
| **Workspace** | ${ws.name} — ${ws.client} |
| **Agents** | ${h.agents.map(x => `${x.name} (\`${x.slug}\`)`).join(', ')} |
| **Task** | ${h.topic.replace(/\|/g, '\\|').replace(/\n+/g, ' ').slice(0, 400)} |
| **Turns** | ${h.turns.filter(t => t.by !== 'owner' && t.by !== 'orchy').length} |
| **Huddle** | \`${h.id}\` |
${h.taskDir ? `| **Transcript** | \`${path.basename(ws.dir)}/${taskRel(h)}/HUDDLE.md\` |\n` : ''}
**Summary**

${(a.summary || 'They ended without an agreement.').trim()}

**Decisions**
${bullets(a.decisions)}

**Work once ${ownerName()} approves**
${bullets((a.work || []).map(w => `${w.agent}: ${w.task}`))}

**Questions for ${ownerName()}**
${bullets(a.questions_for_owner)}
${(a.questions || []).some(q => q.orchy) ? `
**Answered by Orchy from ${ownerName()}'s standing rules**
${bullets(a.questions.filter(q => q.orchy).map(q => `${q.q} → ${q.orchy.answer}${q.orchy.source ? ` (${q.orchy.source})` : ''}`))}
` : ''}${a.dissent?.length ? `
**Still contested**
${bullets(a.dissent)}
` : ''}${a.orchyTake?.take ? `
**Orchy's take** (advice; ${ownerName()} decides): ${a.orchyTake.take}${a.orchyTake.why ? ` ${a.orchyTake.why}` : ''}
` : ''}${h.workRunIds?.length ? `
**Started after ${ownerName()} approved**
${bullets(h.workRunIds.map(id => { const r = db().runs[id]; return r ? `${r.agentName} · run \`${id}\`` : `run \`${id}\``; }))}
` : ''}`;
}

const MISSION_STATUS = { done: '🧭 Mission done', partial: '🟡 Mission partly done', get stopped() { return `⏹️ Mission stopped by ${ownerName()}`; }, failed: '❌ Mission failed' };

/** One entry for a mission (missions.mjs): its steps, who did each, and the runs (each step run has its own entry too). */
export function appendMissionLog(m, ws) {
  ensureFile();
  const entry = missionLogEntry(m, ws);
  fs.appendFileSync(LOGS_PATH, entry);
  return entry;
}
export function missionLogEntry(m, ws) {
  const num = id => m.steps.findIndex(x => x.id === id) + 1 || id;
  const steps = m.steps.map((s, i) => `${i + 1}. ${s.agentName} · ${s.status}${s.needs?.length ? ` (after step ${s.needs.map(num).join(', ')})` : ''}: ${String(s.task).replace(/\s+/g, ' ').slice(0, 160)}${s.runIds?.length ? ` · run${s.runIds.length > 1 ? 's' : ''} ${s.runIds.map(r => `\`${r}\``).join(', ')}` : ''}`);
  const files = [...new Set(m.steps.flatMap(s => s.files || []))];
  return `
---

### ${MISSION_STATUS[m.status] || m.status} · ${ws.name} · Mission: ${String(m.objective || m.text).replace(/\s+/g, ' ').slice(0, 120)}
**${fmtTime(m.endedAt || new Date().toISOString())}**

| | |
|---|---|
| **Workspace** | ${ws.name}${ws.client ? ` — ${ws.client}` : ''} |
| **${ownerName()} asked** | ${String(m.text).replace(/\|/g, '\\|').replace(/\n+/g, ' ').slice(0, 400)} |
| **Steps** | ${m.steps.length} · ${m.steps.filter(s => s.status === 'done').length} done${m.autoFixes ? ` · ${m.autoFixes} automatic fix${m.autoFixes === 1 ? '' : 'es'}` : ''}${m.replanned ? ` · replanned ${m.replanned}×` : ''} |
| **Cost** | $${(Number(m.cost) || 0).toFixed(2)} (plan $${(Number(m.costs?.plan) || 0).toFixed(2)}, ceiling $${(Number(m.ceiling) || 0).toFixed(2)}) |
| **Mission** | \`${m.id}\` |
${m.taskDir ? `| **Task folder** | \`${path.basename(ws.dir)}/${taskRel(m)}\` |\n` : ''}
**Steps**
${bullets(steps)}

**Files**
${bullets(files)}
${m.result?.met != null ? `\n**Objective met (Jev):** ${Math.round(m.result.met * 100)}%\n` : ''}`;
}

/** Parse LOGS.md back into entries for the dashboard. */
export function readLogs() {
  ensureFile();
  const text = fs.readFileSync(LOGS_PATH, 'utf8');
  // an entry opens with a rule then its ### heading; a rule inside a summary isn't one
  const parts = text.split(/\n---\n(?=\n### )/).slice(1);
  const entries = parts.map(p => {
    const head = p.match(/^###\s+(.+)$/m)?.[1] || '';
    const [statusRaw, workspace, agent] = head.split(' · ').map(s => s.trim());
    const status = (statusRaw || '').replace(/^[^A-Za-z]+/, '').trim();
    const kind = /complet|^mission done/i.test(status) ? 'ok' : /fail|block/i.test(status) ? 'bad' : 'mid';
    return {
      status, kind, workspace, agent,
      when: p.match(/^\*\*(.+?)\*\*\s*$/m)?.[1] || '',
      runId: p.match(/\*\*Run\*\* \| `([^`]+)`/)?.[1] || null,
      task: p.match(/\*\*Task\*\* \| (.+) \|/)?.[1] || '',
      markdown: p.trim(),
    };
  });
  return { markdown: text, entries };
}

function readOrchyCosts(sinceMs = 0) {
  const f = path.join(DATA_DIR, 'orchy-costs.jsonl');
  if (!fs.existsSync(f)) return [];
  const out = [];
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (!sinceMs || Date.parse(j.t || '') >= sinceMs) out.push(j);
    } catch {}
  }
  return out;
}

function runKindOf(r) {
  if (r.backend) return 'fix';
  if (r.huddleTalk || r.huddle) return 'huddle';
  if (r.isBuilder || r.kind === 'build') return 'build';
  if (r.missionId) return 'mission';
  if (r.delegatedBy) return 'delegated';
  if (r.routing?.source === 'schedule') return 'schedule';
  if (r.parentRunId) return 'follow-up';
  return 'task';
}

/**
 * Usage breakdown for the Logs → Usage tab: tokens + cost per workspace, agent, model and kind,
 * follow-up chains, top 10 runs, Orchy's own calls, and % spent at >=4 live runs.
 */
export function computeUsage(period = 'month') {
  const days = period === 'week' ? 7 : period === 'month' ? 30 : 0;
  const sinceMs = days ? Date.now() - days * 86400_000 : 0;
  const allRuns = Object.values(db().runs || {});
  const runs = allRuns.filter(r => !sinceMs || Date.parse(r.startedAt || '') >= sinceMs);
  const orchyCalls = readOrchyCosts(sinceMs);

  // Precompute intervals for concurrency overlap check (how many runs were live while each run ran)
  const intervals = allRuns.map(r => ({
    id: r.id,
    s: Date.parse(r.startedAt || '') || 0,
    e: Date.parse(r.endedAt || r.lastActivity || r.startedAt || '') || Date.now(),
  })).filter(x => x.s > 0);

  const overlappedGe4 = r => {
    if ((r.liveAtStart || 0) >= 4) return true;
    const s = Date.parse(r.startedAt || '') || 0;
    const e = Date.parse(r.endedAt || r.lastActivity || r.startedAt || '') || s;
    if (!s) return false;
    const mid = Math.floor((s + e) / 2);
    let n = 0;
    for (const iv of intervals) {
      if (iv.s <= mid && iv.e >= mid && ++n >= 4) return true;
    }
    return false;
  };

  const wsMap = new Map();
  const agentMap = new Map();
  const modelMap = new Map();
  const kindMap = new Map();
  const addBucket = (map, key, base, cost, tok) => {
    let b = map.get(key);
    if (!b) { b = { ...base, runs: 0, turns: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, costUsd: 0 }; map.set(key, b); }
    b.turns += tok.turns || 0;
    b.runs += 1;
    b.inputTokens += tok.input;
    b.outputTokens += tok.output;
    b.totalTokens += tok.total;
    b.cacheReadTokens += tok.cacheRead;
    b.costUsd = Math.round((b.costUsd + cost) * 10000) / 10000;
  };

  let runCostUsd = 0, ge4CostUsd = 0, ge4Runs = 0, inputTokens = 0, outputTokens = 0, totalTokens = 0, cacheReadTokens = 0;
  for (const r of runs) {
    const cost = Number(r.costUsd) || 0;
    const t = r.tokens || {};
    const tok = {
      input: Number(t.input) || 0,
      output: Number(t.output) || 0,
      total: Number(t.total) || ((Number(t.input) || 0) + (Number(t.output) || 0)),
      cacheRead: Number(t.cacheRead) || 0,
    };
    runCostUsd += cost;
    inputTokens += tok.input;
    outputTokens += tok.output;
    totalTokens += tok.total;
    cacheReadTokens += tok.cacheRead;
    if (overlappedGe4(r)) { ge4CostUsd += cost; ge4Runs++; }
    tok.turns = Number(r.numTurns) || 0;

    const wsId = r.workspace || 'orchy';
    const slug = r.isBuilder ? 'agent-builder' : r.agentSlug || 'general';
    const kind = runKindOf(r);
    const model = r.model || 'unknown';
    addBucket(wsMap, wsId, { ws: wsId }, cost, tok);
    addBucket(agentMap, `${wsId}/${slug}`, { ws: wsId, slug, name: r.agentName || slug }, cost, tok);
    addBucket(modelMap, model, { model }, cost, tok);
    addBucket(kindMap, kind, { kind }, cost, tok);
  }

  let orchyCostUsd = 0, orchyTokens = 0;
  for (const c of orchyCalls) {
    const cost = Number(c.costUsd) || 0;
    const t = c.tokens || {};
    const tok = {
      input: Number(t.input) || 0,
      output: Number(t.output) || 0,
      total: Number(t.total) || ((Number(t.input) || 0) + (Number(t.output) || 0)),
      cacheRead: Number(t.cacheRead) || 0,
    };
    orchyCostUsd += cost;
    orchyTokens += tok.total;
    inputTokens += tok.input;
    outputTokens += tok.output;
    totalTokens += tok.total;
    cacheReadTokens += tok.cacheRead;
    addBucket(kindMap, 'orchy', { kind: 'orchy' }, cost, tok);
    addBucket(modelMap, c.model || 'unknown', { model: c.model || 'unknown' }, cost, tok);
  }

  // Follow-up chains: group runs by their root run ID
  const byId = db().runs || {};
  const rootOf = r => {
    let cur = r;
    const seen = new Set();
    while (cur?.parentRunId && byId[cur.parentRunId] && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId[cur.parentRunId];
    }
    return cur || r;
  };
  const chainGroups = new Map();
  for (const r of runs) {
    if (r.huddleTalk) continue;
    const root = rootOf(r);
    let g = chainGroups.get(root.id);
    if (!g) { g = []; chainGroups.set(root.id, g); }
    g.push(r);
  }
  const chains = [...chainGroups.entries()]
    .filter(([, list]) => list.length > 1 || list.some(x => x.parentRunId))
    .map(([rootId, list]) => {
      list.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
      const first = byId[rootId] || list[0];
      const latest = list.at(-1);
      const costUsd = Math.round(list.reduce((s, x) => s + (Number(x.costUsd) || 0), 0) * 10000) / 10000;
      const tok = list.reduce((s, x) => s + (Number(x.tokens?.total) || 0), 0);
      const turns = list.reduce((s, x) => s + (Number(x.numTurns) || 0), 0);
      return {
        rootId,
        latestId: latest.id,
        lastRunId: latest.id,
        runs: list.length,
        agent: first.agentName || first.agentSlug || 'general',
        tokens: tok,
        ws: first.workspace,
        agentSlug: first.isBuilder ? 'agent-builder' : first.agentSlug,
        agentName: first.agentName,
        task: String(first.instruction || '').replace(/\s+/g, ' ').trim().slice(0, 140),
        rounds: list.length,
        totalTurns: turns,
        totalTokens: tok,
        costUsd,
        instruction: String(first.instruction || '').replace(/\s+/g, ' ').trim().slice(0, 140),
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd || b.rounds - a.rounds)
    .slice(0, 10);

  const topRuns = runs
    .slice()
    .sort((a, b) => (Number(b.costUsd) || 0) - (Number(a.costUsd) || 0) || (Number(b.tokens?.total) || 0) - (Number(a.tokens?.total) || 0))
    .slice(0, 10)
    .map(r => ({
      id: r.id,
      ws: r.workspace,
      agentSlug: r.isBuilder ? 'agent-builder' : r.agentSlug,
      agentName: r.agentName,
      task: String(r.instruction || '').replace(/\s+/g, ' ').trim().slice(0, 140),
      agent: r.agentName || r.agentSlug || 'general',
      tokens: Number(r.tokens?.total) || 0,
      isBuilder: !!r.isBuilder,
      model: r.model,
      kind: runKindOf(r),
      costUsd: Math.round((Number(r.costUsd) || 0) * 10000) / 10000,
      totalTokens: Number(r.tokens?.total) || 0,
      inputTokens: Number(r.tokens?.input) || 0,
      outputTokens: Number(r.tokens?.output) || 0,
      numTurns: r.numTurns || 0,
      startedAt: r.startedAt,
      instruction: String(r.instruction || '').replace(/\s+/g, ' ').trim().slice(0, 140),
    }));

  const sortCost = list => [...list].sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens || b.runs - a.runs);
  const totalCostUsd = Math.round((runCostUsd + orchyCostUsd) * 10000) / 10000;
  return {
    period,
    totals: {
      runs: runs.length,
      costUsd: Math.round(runCostUsd * 10000) / 10000,
      runCostUsd: Math.round(runCostUsd * 10000) / 10000,
      orchyCalls: orchyCalls.length,
      orchyCostUsd: Math.round(orchyCostUsd * 10000) / 10000,
      orchyTokens,
      totalCostUsd,
      inputTokens,
      outputTokens,
      totalTokens,
      cacheReadTokens,
      ge4CostUsd: Math.round(ge4CostUsd * 10000) / 10000,
      ge4Runs,
      ge4Pct: runCostUsd > 0 ? Math.round((ge4CostUsd / runCostUsd) * 1000) / 10 : 0,
    },
    byWorkspace: sortCost(wsMap.values()),
    byAgent: sortCost(agentMap.values()),
    byModel: sortCost(modelMap.values()),
    byKind: sortCost(kindMap.values()),
    chains,
    topRuns,
  };
}
