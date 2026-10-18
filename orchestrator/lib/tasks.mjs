// Task folders: every task gets its own folder, holding the files made for it plus TASK.md, the record Orchy writes
// when it finishes (follow-ups add a round to the same file). Where the folder opens:
//   - an agent's task: its home's Tasks (`Marketing/Writer/Tasks`); the generalist's: `generalistHome`'s;
//   - a huddle or a mission: the lead's department's Tasks (`Marketing/Tasks`);
//   - a workspace or agent without homes: `<workspace>/Tasks`;
//   - a client's task: the client's own corner (<workspace>/.clients/<id>/Tasks, clientspace.mjs), always.
// The record keeps where it opened (`taskRoot`, relative to the workspace) next to its folder name (`taskDir`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from './store.mjs';
import { config, ROOT, ownerName } from './env.mjs';
import { itemsForRun } from './inbox.mjs';
import { fmtTime, STATUS, bullets, qaLines } from './logs.mjs';
import { clientHome, tasksBase, taskRootRel } from './clientspace.mjs';
import { getAgent, homeOf, departmentOf } from './agents.mjs';

export const tasksDir = ws => path.join(ws.dir, 'Tasks');
export const isGeneralist = run => !run.agentSlug && !run.isBuilder;
/** Runs that keep a task folder: task runs (generalist, specialist, handed over) and every client's. */
export const hasTaskDir = run => !run.backend && !run.huddleTalk && !run.isBuilder; // Orchy fixing himself, huddle talk turns and agent builds keep no TASK.md folder
const rootFor = tasksBase;

/**
 * The Tasks folder a new task opens in, relative to the workspace: its agent's home (`agentSlug`; none = the
 * generalist), or for a huddle or a mission the department of its `lead`; `Tasks` while there are no homes.
 */
export function taskRootFor(ws, { agentSlug = null, lead = null } = {}) {
  const find = slug => { try { return getAgent(ws.id, slug); } catch { return null; } };
  if (lead) {
    const dept = departmentOf(ws, find(lead));
    return dept ? `${dept}/Tasks` : 'Tasks';
  }
  const agent = agentSlug ? find(agentSlug) : null;
  const home = agentSlug && !agent ? null : homeOf(ws, agent);
  return home ? `${home}/Tasks` : 'Tasks';
}
/** Whose words a round is. */
const askerOf = run => (run.client && !run.ownerReply ? run.clientName : ownerName());

const FILLER = new Set('i im i\'m we you me my our us your it its this that these those the a an to of for from in on at by with and or but so if is are was were be been am do does did can could would will should shall may might must please pls need want like just also all any some there here what whats how when where which who why hey hi ok okay thanks thank'.split(' '));

/** `2026-10-06-triage-customer-support-emails`: the day in the owner's timezone + the task's first real words. */
function folderName(run) {
  const day = new Date(run.startedAt).toLocaleDateString('en-CA', { timeZone: config.timezone });
  const words = String(run.instruction).toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w && !FILLER.has(w)).slice(0, 6);
  return `${day}-${words.join('-') || 'task'}`.slice(0, 64).replace(/-+$/, '');
}

/**
 * A new folder for a task (a follow-up keeps its parent's, in the parent's Tasks). Sets `run.taskRoot` (not for a
 * client's) and returns the folder's name inside it.
 */
export function openTaskDir(ws, run, parent) {
  if (parent?.taskDir && parent.workspace === ws.id && (parent.client || null) === (run.client || null)) {
    if (!run.client) run.taskRoot = taskRootRel(parent);
    fs.mkdirSync(path.join(rootFor(ws, run), parent.taskDir), { recursive: true });
    return parent.taskDir;
  }
  if (!run.client) run.taskRoot = taskRootFor(ws, run);
  const root = rootFor(ws, run);
  const base = folderName(run);
  let name = base;
  for (let n = 2; fs.existsSync(path.join(root, name)); n++) name = `${base}-${n}`;
  fs.mkdirSync(path.join(root, name), { recursive: true });
  return name;
}

function listFiles(dir, rel = '', out = []) {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (out.length >= 60) break;
    if (e.name.startsWith('.')) continue;
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) listFiles(dir, p, out);
    else if (p !== 'TASK.md') out.push(p);
  }
  return out;
}

function round(run, first) {
  const r = run.report || {};
  const said = String(run.resultText || '').trim();
  const summary = String(r.summary || '').trim();
  return `${first ? `## Task

${String(run.instruction).trim().split('\n').map(l => `> ${l}`).join('\n')}

## What was done` : `## Follow-up · ${fmtTime(run.startedAt)}

**${askerOf(run)}:** ${String(run.instruction).trim()}

### What was done`}

${r.result ? `${String(r.result).trim()}

` : ''}${summary || said || run.error || (run.outcome === 'stopped' ? `${run.stoppedBy || ownerName()} stopped this before ${run.agentName} reported back.` : `${run.agentName} finished without writing a summary.`)}

**Actions taken**
${bullets(r.actions_taken)}

**Outputs**
${bullets(r.outputs)}

**Questions & approvals**
${bullets(qaLines(itemsForRun(run.id).filter(i => !run.client || i.answerer === 'client')))}

**Follow-ups**
${bullets(r.follow_ups)}
${said && summary && said !== summary ? `\n**Final message**\n\n${said}\n` : ''}${run.error && summary ? `\n**Error**\n\n${run.error}\n` : ''}`;
}

/**
 * A client's TASK.md is theirs to read: paths on the owner's PC (their own corner, the workspace, Orchy, the owner's home, any other
 * drive path) become "…", in every spelling an error or a final message prints them (C:\…, C:/…, C:\\…, /c/…).
 */
function pcScrub(ws, run) {
  const sep = String.raw`(?:\\{1,2}|/)`;
  const spell = d => {
    const [drive, ...parts] = path.resolve(d).split(/[\\/]+/).filter(Boolean);
    return `(?:${drive[0]}:|/${drive[0]})${sep}${parts.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(sep)}`;
  };
  const mine = new RegExp(`(?:${[clientHome(ws, run.client), ws.dir, ROOT, os.homedir()].map(spell).join('|')})(?:${sep}[^\\s'"\`)\\]]*)?`, 'gi');
  return s => String(s).replace(mine, '…').replace(/(?<![A-Za-z0-9])[A-Za-z]:(?:\\{1,2}|\/(?!\/))[^\s'"`)\]]*/g, '…')
    .replace(/(?<=^|[\s'"`(=])\/(?:[A-Za-z]\/)?(?:Users|home)\/[^\s'"`)\]]*/g, '…');
}

/** Write <Tasks>/<folder>/TASK.md from every round of the task so far. */
export function saveTask(run, ws) {
  // a mission's steps share one folder: the mission writes its TASK.md (missions.mjs#writeTask), not each step
  if (!run.taskDir || run.missionId) return null;
  const rounds = Object.values(db().runs).filter(r => r.workspace === ws.id && r.taskDir === run.taskDir && (r.client || null) === (run.client || null) && taskRootRel(r) === taskRootRel(run))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const first = rounds[0] || run, last = rounds[rounds.length - 1] || run;
  const status = last.report?.status || last.outcome || last.status;
  const dir = path.join(rootFor(ws, run), run.taskDir);
  fs.mkdirSync(dir, { recursive: true });
  const files = listFiles(dir);
  const title = String(first.instruction).trim().split('\n')[0].replace(/\s+/g, ' ');
  const text = `# ${title.length > 90 ? `${title.slice(0, 87).trim()}…` : title}

| | |
|---|---|
| **Status** | ${STATUS[status] || status || 'In progress'} |
| **Started** | ${fmtTime(first.startedAt)} |
| **Finished** | ${last.endedAt ? fmtTime(last.endedAt) : '—'} |
| **Workspace** | ${ws.name} — ${ws.client} |
${run.client ? `| **For** | ${run.clientName} |\n` : ''}| **Done by** | ${run.agentName} (${[...new Set(rounds.map(r => r.model))].join(', ') || run.model}) |
| **Runs** | ${rounds.map(r => `\`${r.id}\``).join(', ')} |

Orchy writes this file when ${run.agentName} finishes a round; everything else in this folder is what it made for the task${run.client ? ' (files/ holds what was attached)' : ''}.

${rounds.map((r, i) => round(r, i === 0)).join('\n')}
## Files in this folder
${bullets(files)}
`;
  fs.writeFileSync(path.join(dir, 'TASK.md'), run.client ? pcScrub(ws, run)(text) : text);
  return path.join(dir, 'TASK.md');
}
