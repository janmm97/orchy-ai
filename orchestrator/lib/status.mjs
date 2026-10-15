// Answers to the status questions the owner asks most ("what's running?", "anything waiting on me?", "how did
// Nora's inbox check go?"), written straight from Orchy's records. Jev reads which one it is while routing
// (router.mjs: status_about, earlier_run), so the answer comes back in well under a second instead of
// after a Claude call. Anything Jev isn't sure of, or any other question, still goes to Orchy (orchy.mjs#reply).
import { db } from './store.mjs';
import { listRuns, isLive } from './runner.mjs';
import { pending } from './inbox.mjs';
import { workspace } from './workspaces.mjs';
import { callName } from './voiceagents.mjs';

const MIN_CONFIDENCE = 0.6;
const LIST_MAX = 5;

const who = r => callName(r.workspace, r.isBuilder ? 'agent-builder' : r.agentSlug, r.agentName);
const wsName = id => { try { return workspace(id).name; } catch { return id; } };
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const minutes = iso => Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 60_000));
const since = iso => { const m = minutes(iso); return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`; };
const list = (xs, n = LIST_MAX) => xs.length > n ? `${xs.slice(0, n).join('; ')}; and ${xs.length - n} more` : xs.join('; ');

function running() {
  const live = listRuns(60).filter(r => isLive(r.id));
  const mine = pending().filter(i => i.answerer !== 'client').length;
  if (!live.length) return `Nothing's running right now.${mine ? ` ${mine === 1 ? 'One thing is' : `${mine} things are`} waiting on you, though.` : ''}`;
  const rows = live.map(r => `${who(r)} in ${wsName(r.workspace)}, ${since(r.startedAt)} in${r.status === 'waiting' ? ', waiting on an answer' : ''}: “${clip(r.instruction, 90)}”`);
  return `${live.length === 1 ? 'One run going' : `${live.length} runs going`}: ${list(rows)}.`;
}

function waiting() {
  const items = pending().filter(i => i.answerer !== 'client');
  if (!items.length) return 'Nothing\'s waiting on you.';
  const kind = { approval: 'an approval', question: 'a question', connections: 'a connections pick' };
  const rows = items.map(i => `${kind[i.kind] || 'something'} from ${callName(i.workspace, i.agent?.slug, i.agent?.displayName)} in ${wsName(i.workspace)}: ${clip(i.title, 100)}`);
  return `${items.length === 1 ? 'One thing is' : `${items.length} things are`} waiting on you: ${list(rows)}.`;
}

function oneRun(runId) {
  const r = db().runs[runId];
  if (!r) return null;
  const name = `${who(r)} in ${wsName(r.workspace)}`;
  if (isLive(r.id)) return `${name} is still on it (${since(r.startedAt)} so far${r.status === 'waiting' ? ', waiting on an answer' : ''}). I'll tell you when it's done.`;
  const what = clip(r.report?.summary || r.resultText || r.error || '', 700);
  const head = r.outcome === 'stopped' ? 'was stopped' : r.status === 'failed' ? 'ran into trouble' : r.report?.status === 'blocked' ? 'got blocked' : 'finished';
  const follow = (r.report?.follow_ups || []).slice(0, 2).map(f => clip(f, 160));
  return `${name} ${head} ${since(r.endedAt || r.lastActivity || r.startedAt)} ago${what ? `: ${what}` : '.'}${follow.length ? ` Follow-ups: ${follow.join('; ')}` : ''}`;
}

/**
 * The answer for a status question Jev read with confidence, or null (Orchy thinks it through instead).
 * Returns { text, runId? }.
 */
export function quickStatus(routing) {
  const s = routing?.statusAbout;
  if (routing?.intent !== 'status' || !s || (s.confidence ?? 0) < MIN_CONFIDENCE) return null;
  if (s.kind === 'running') return { text: running() };
  if (s.kind === 'waiting') return { text: waiting() };
  if (s.kind === 'run' && routing.earlierRun) {
    const text = oneRun(routing.earlierRun.runId);
    return text ? { text, runId: routing.earlierRun.runId } : null;
  }
  return null;
}
