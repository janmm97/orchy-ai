// LOGS.md: every finished agent task, with workspace, agent and a detailed summary.
import fs from 'node:fs';
import path from 'node:path';
import { LOGS_PATH, config, ownerName } from './env.mjs';
import { db } from './store.mjs';
import { accountFor, runtimeLabel } from './workspaces.mjs';

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
${run.delegatedBy ? `| **Delegated by** | ${run.delegatedByName} · run \`${run.delegatedBy}\` |\n` : ''}${run.taskDir ? `| **Task folder** | \`${path.basename(ws.dir)}/${run.client ? `.clients/${run.client}/` : ''}Tasks/${run.taskDir}\` |\n` : ''}
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

const HUDDLE_STATUS = { get agreed() { return `🤝 Agreed, waiting for ${ownerName()}`; }, approved: '🤝 Agreed and approved', get stopped() { return `⏹️ Huddle stopped by ${ownerName()}`; }, failed: '❌ Huddle failed' };

/** One entry for a huddle (huddle.mjs): who talked, about what, and what they agreed. Its turns aren't logged one by one. */
export function appendHuddleLog(h, ws) {
  ensureFile();
  const names = h.agents.map(a => a.name).join(' + ');
  const a = h.agreement || {};
  const entry = `
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
${h.taskDir ? `| **Transcript** | \`${path.basename(ws.dir)}/Tasks/${h.taskDir}/HUDDLE.md\` |\n` : ''}
**Summary**

${(a.summary || 'They ended without an agreement.').trim()}

**Decisions**
${bullets(a.decisions)}

**Work once ${ownerName()} approves**
${bullets((a.work || []).map(w => `${w.agent}: ${w.task}`))}

**Questions for ${ownerName()}**
${bullets(a.questions_for_owner)}
${h.workRunIds?.length ? `
**Started after ${ownerName()} approved**
${bullets(h.workRunIds.map(id => { const r = db().runs[id]; return r ? `${r.agentName} · run \`${id}\`` : `run \`${id}\``; }))}
` : ''}`;
  fs.appendFileSync(LOGS_PATH, entry);
  return entry;
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
    const kind = /complet/i.test(status) ? 'ok' : /fail|block/i.test(status) ? 'bad' : 'mid';
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
