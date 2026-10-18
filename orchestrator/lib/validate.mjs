// Orchy checks a finished run: did it report, does the status hold up against its last steps, do the files it names
// exist, does it say it sent or changed something in an app with no step to show for it, and (a step that promised
// kinds of file) did it leave them. Deterministic, no model, a few ms. One optional Jev read (Settings "Jev also reads
// each report", off by default) asks whether the report answers the task. Flags only: a run is never re-run or
// followed up on its own (it could repeat outward work); the owner's "Ask it to fix" sends fixPrompt() as a follow-up.
// Result on `run.validation` = { verdict: 'ok'|'check'|'failed', checks: [{ name, ok, note, level }], at, ms, jev? }.
import fs from 'node:fs';
import path from 'node:path';
import { db as storeDb, save as storeSave, runEventsPath } from './store.mjs';
import { emit as busEmit } from './bus.mjs';
import { ownerName } from './env.mjs';
import { workspace as wsById } from './workspaces.mjs';
import { clientHome, taskRoot, taskRel } from './clientspace.mjs';
import { listAgents, homeOf, departmentOf, departmentsOf, wsRel } from './agents.mjs';
import { LABELS, nextActivity } from './activity.mjs';
import * as artifacts from './artifacts.mjs';
import { sideEffects } from './recover.mjs';

// Swappable for tests (scripts/test-validate.mjs).
const deps = {
  db: storeDb, save: storeSave, emit: busEmit, workspace: wsById,
  agents: wsId => listAgents(wsId),
  events: runId => { try { return fs.readFileSync(runEventsPath(runId), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } },
  artifactsFor: run => artifacts.listArtifacts({ run, limit: 1000 }),
  sync: run => artifacts.syncRun(run, { ended: true }),
  ask: null, // Jev (jev.mjs#ask), loaded on first use
  publicRun: run => { const { prompt, ...rest } = run; return rest; },
};
export function configure(o) { Object.assign(deps, o); }

/** The owner's own finished runs: not a client's own, not huddle talk turns, not fixes of Orchy (they have their diff). */
export function shouldValidate(run, settings = deps.db().settings || {}) {
  if (!run || settings.validateRuns === false) return false;
  if (run.backend || run.huddle || run.huddleTalk || (run.client && !run.ownerReply)) return false;
  return ['completed', 'partial', 'blocked'].includes(run.outcome);
}

// ── evidence from the run's own steps ──
const isBridge = tool => /^mcp__jos__/.test(String(tool || ''));
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'ToolSearch', 'Skill', 'NotebookRead', 'ACP_read', 'ACP_search', 'ACP_fetch', 'mcp__jos__note']);
const END = new Set(['tool_done', 'tool_error', 'denied']);

/** Says it's completed, but its last step before the report failed or was refused, with nothing working after it. */
function statusCheck(run, events) {
  if (run.report?.status !== 'completed') return null;
  const rep = events.findLastIndex(e => e.kind === 'report');
  const upto = rep >= 0 ? events.slice(0, rep) : events;
  const toolOf = new Map(upto.filter(e => e.kind === 'tool' && e.toolUseId).map(e => [e.toolUseId, e.tool]));
  const hasDone = upto.some(e => e.kind === 'tool_done');
  let last = null;
  for (const e of upto) {
    const tool = e.tool || toolOf.get(e.toolUseId) || '';
    if (isBridge(tool)) continue;
    // runs from before tool_done existed: a later step means it moved past the error
    if (e.kind === 'tool' && !hasDone && last && !last.ok) { last = { ok: true }; continue; }
    if (!END.has(e.kind)) continue;
    if (e.kind === 'tool_done') { last = e.ok === false ? { ok: false, e, tool } : { ok: true }; continue; }
    if (e.kind === 'tool_error' && READ_TOOLS.has(tool)) continue; // a file it looked for and didn't find isn't the work failing
    last = { ok: false, e, tool };
  }
  if (!last || last.ok) return { name: 'Status', ok: true, note: '' };
  const what = last.e.kind === 'denied' || last.e.brief === 'declined' ? 'was refused' : 'failed';
  const why = String(last.e.text || last.e.brief || '').split('\n')[0].slice(0, 140);
  return { name: 'Status', ok: false, level: 'warn', note: `Says it's done, but its last step${last.tool ? ` (${last.tool})` : ''} ${what}${why ? `: ${why}` : ''}` };
}

// a bare name only counts as a file when it's a deliverable type (code names like Node.js are too often prose)
const DELIVERABLE = new Set('pdf docx doc xlsx xls pptx ppt csv tsv md markdown html htm png jpg jpeg gif webp svg avif mp4 mov webm m4v mkv mp3 wav m4a ogg txt json zip epub odt ods odp rtf srt vtt'.split(' '));
const DOMAIN = /^[\w-]+(\.[\w-]+)*\.(com|ai|io|org|net|dev|app|co|us|uk|so|me|xyz|gg|tv|info|biz|work|site|page|sh|to|ly|fm|club|store|shop)$/i;
/**
 * The file names in report outputs, as [{ p, dirs }]: `dirs` are the folders of the other paths on the same line, so
 * "d4a/sheet-01.png, sheet-02.png" looks for sheet-02.png next to sheet-01.png. Labels ("Brief: …"), lists, globs
 * and brace lists aren't one file; a line with a glob or brace list keeps only its full paths.
 */
export function fileCandidates(outputs = []) {
  const out = new Map();
  for (const line of outputs) {
    const bits = artifacts.outputBits(line).paths;
    const fuzzy = bits.some(b => /[{}*?]/.test(b)) || /[{}*]/.test(String(line));
    const keep = [];
    for (const raw of bits) {
      // "Task folder: Acme Workspace/Tasks/x/TASK.md" → the path after its label
      const p = String(raw).trim().replace(/^[^:\\/()]{1,40}:\s+(?=\S)/, '').replace(/^file:\/\/\/?/i, '').replace(/^[("'([]+/, '').replace(/[)"',.;:\]]+$/, '');
      const ext = path.extname(p).slice(1);
      if (!ext || !/[a-z]/i.test(ext) || p.length < 3) continue;
      if (/[{}*?<>|]/.test(p) || /^https?:/i.test(p) || /\s{2,}|,\s|\s\(|\)|\s(and|or|plus)\s/i.test(p)) continue;
      if (/:/.test(p.replace(/^[A-Za-z]:(?=[\\/])/, ''))) continue; // "Label: path" (only a drive letter has a colon)
      const slash = /[\\/]/.test(p);
      if (!slash && (fuzzy || DOMAIN.test(p) || !DELIVERABLE.has(ext.toLowerCase()))) continue;
      keep.push(p);
    }
    const dirs = [...new Set(keep.filter(p => /[\\/]/.test(p)).map(p => path.posix.dirname(p.replace(/\\/g, '/'))))];
    for (const p of keep) {
      const key = p.replace(/\\/g, '/').toLowerCase();
      if (!out.has(key)) out.set(key, { p, dirs: /[\\/]/.test(p) ? [] : dirs });
    }
  }
  // a path with spaces also comes back in pieces ("Workspace\Tasks\x.csv" from "…\Acme Workspace\Tasks\x.csv"): keep the whole one
  const keys = [...out.keys()];
  return keys.filter(k => !keys.some(o => o !== k && o.length > k.length && (o.endsWith(`/${k}`) || o.endsWith(` ${k}`)))).slice(0, 20).map(k => out.get(k));
}

const realOf = p => { try { return fs.realpathSync.native(p); } catch { return null; } };
const fold = s => (process.platform === 'win32' || process.platform === 'darwin' ? s.toLowerCase() : s);
const within = (child, root) => { const c = fold(child), r = fold(root).replace(/[\\/]+$/, ''); return c === r || c.startsWith(r + path.sep); };
// an absolute path as an agent writes it: C:\x, C:/x, /x (and on Windows, /c/x from Git Bash is not resolved)
const isAbs = p => path.isAbsolute(p) || /^[A-Za-z]:\//.test(p);

/**
 * Is the file there? 'yes' | 'no' | 'outside' (an absolute path out of the workspace, or out of a client's own folder
 * for a client's task: never looked at). Only a stat; nothing is read. Relative names are tried from the workspace
 * (the client's folder) and the run's task folder, and against the files the registry has for this run.
 */
export function fileState(ws, run, p, arts = [], dirs = []) {
  let norm = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  const base = run.client ? clientHome(ws, run.client) : ws.dir;
  // "Acme Workspace/out/x.md": named from Orchy's folder, starting with the workspace's own folder name
  const own = `${path.basename(path.resolve(base))}/`.toLowerCase();
  if (!run.client && norm.toLowerCase().startsWith(own)) norm = norm.slice(own.length);
  const low = norm.toLowerCase();
  if (arts.some(a => a.status !== 'missing' && (a.rel.toLowerCase() === low || a.rel.toLowerCase().endsWith(`/${low}`)))) return 'yes';
  const root = realOf(base) || path.resolve(base);
  const tdir = (() => { try { return taskRoot(ws, run); } catch { return null; } })();
  // on Linux/macOS a Windows path ("C:/x/y.pdf") is never this machine's: outside
  if (process.platform !== 'win32' && /^[A-Za-z]:\//.test(norm)) return 'outside';
  const tries = isAbs(norm) ? [path.resolve(norm)]
    : [path.resolve(base, norm), ...(tdir ? [path.resolve(tdir, norm)] : []), ...dirs.map(d => isAbs(d) ? path.resolve(d, norm) : path.resolve(base, d, norm))];
  let outside = 0;
  for (const abs of tries) {
    if (!within(path.resolve(abs), path.resolve(base)) && !within(realOf(abs) || abs, root)) { outside++; continue; }
    const real = realOf(abs);
    if (real && within(real, root)) { try { if (fs.statSync(real).isFile()) return 'yes'; } catch {} }
  }
  return outside === tries.length ? 'outside' : 'no';
}

function outputsCheck(run, ws, arts) {
  const names = fileCandidates(run.report?.outputs || []);
  if (!names.length || !ws) return null;
  const states = names.map(({ p, dirs }) => [p, fileState(ws, run, p, arts, dirs)]);
  const missing = [...new Set(states.filter(([, s]) => s === 'no').map(([p]) => path.posix.basename(p.replace(/\\/g, '/'))))];
  const outside = states.filter(([, s]) => s === 'outside').length;
  const checked = states.length - outside;
  if (!checked) return { name: 'Files it names', ok: true, note: `${outside} outside the workspace, not checked` };
  if (!missing.length) return { name: 'Files it names', ok: true, note: `${checked} found${outside ? ` · ${outside} outside the workspace, not checked` : ''}` };
  const list = missing.slice(0, 3).join(', ') + (missing.length > 3 ? ` and ${missing.length - 3} more` : '');
  return { name: 'Files it names', ok: false, level: missing.length === checked ? 'fail' : 'warn', note: `Can't find ${list}` };
}

// ── "says it sent, I don't see the send" ──
// What a line claims (a write verb + an app), and what the run's steps show (One `actions execute <platform>`, an MCP
// tool of that app, or a flow). Generic words (email, calendar, sheet) count only when the line names no local file.
const WRITE_VERB = /\b(sent|send|emailed|e-mailed|mailed|posted|published|replied|messaged|texted|tweeted|created|added|updated|edited|deleted|removed|archived|scheduled|booked|invited|uploaded|shared|commented|drafted|labell?ed|moved|charged|refunded|cancell?ed|pushed|merged|filed|logged|subscribed|unsubscribed)\b/i;
const NOT_DONE = /\b(not|no|never|didn['’]?t|did not|without|skipp(ed|ing)|ready to|to be|for (?:the )?owner|for you|for your|awaiting|pending|would|will|could|can['’]?t|cannot|proposed?|suggest(ed)?|needs? (your|the owner)|once you|if you|after you|unable)\b|n['’]t\b/i;
export const APPS = [
  // [label, words in a report line, what a step shows, generic word]
  ['Gmail', /\bgmail\b/i, /gmail|google-mail/i],
  ['email', /\be-?mails?\b|\bemailed\b|\binbox\b/i, /gmail|google-mail|outlook|resend|sendgrid|mailchimp|postmark|smtp|send[_-]?e?mail|mailgun/i, true],
  ['Slack', /\bslack\b/i, /slack/i],
  ['Notion', /\bnotion\b/i, /notion/i],
  ['Google Calendar', /\bgoogle calendar\b|\bgcal\b/i, /google-calendar|calendar/i],
  ['calendar', /\bcalendar\b|\binvites?\b|\bmeetings?\b/i, /google-calendar|calendar|outlook|calendly|zoom/i, true],
  ['Google Drive', /\bgoogle drive\b|\bdrive folder\b/i, /google-drive|\bdrive\b/i],
  ['Google Sheets', /\bgoogle sheets?\b|\bspreadsheet\b/i, /google-sheets|sheets|airtable/i, true],
  ['Google Docs', /\bgoogle docs?\b/i, /google-docs|docs/i],
  ['Stripe', /\bstripe\b|\brefund(ed)?\b|\bcharged?\b/i, /stripe/i],
  ['GitHub', /\bgithub\b|\bpull request\b|\bPR\b/, /github|\bgh\s+(pr|issue|release|api|repo)\b|git\s+push/i],
  ['HubSpot', /\bhubspot\b/i, /hubspot/i],
  ['Linear', /\blinear\b/i, /linear/i],
  ['Airtable', /\bairtable\b/i, /airtable/i],
  ['LinkedIn', /\blinkedin\b/i, /linkedin/i],
  ['X', /\btwitter\b|\btweet(ed)?\b|\bx\.com\b/i, /twitter|\bx-api\b|xapi|x\.com/i],
  ['Meta', /\binstagram\b|\bfacebook\b|\bmeta ads?\b/i, /instagram|facebook|\bmeta\b/i],
  ['Discord', /\bdiscord\b/i, /discord/i],
  ['Telegram', /\btelegram\b/i, /telegram/i],
  ['WhatsApp', /\bwhatsapp\b/i, /whatsapp/i],
  ['Twilio', /\btwilio\b|\bsms\b|\btext message\b/i, /twilio|sms/i],
  ['Shopify', /\bshopify\b/i, /shopify/i],
  ['Zendesk', /\bzendesk\b/i, /zendesk/i],
  ['Intercom', /\bintercom\b/i, /intercom/i],
  ['Trello', /\btrello\b/i, /trello/i],
  ['Asana', /\basana\b/i, /asana/i],
  ['Jira', /\bjira\b/i, /jira|atlassian/i],
  ['YouTube', /\byoutube\b/i, /youtube/i],
  ['WordPress', /\bwordpress\b/i, /wordpress/i],
  ['Webflow', /\bwebflow\b/i, /webflow/i],
  ['Mailchimp', /\bmailchimp\b/i, /mailchimp/i],
  ['Outlook', /\boutlook\b/i, /outlook|microsoft/i],
];
/**
 * The text of every step that could touch an app (commands and scripts, an MCP tool, a script it wrote), with how it
 * ended ('ok' | 'err' | 'open'). Lenient on purpose: a command that names the app counts, since agents often send
 * through a small script (`node -e` calling One), and Orchy's summary says "Running <action> on <platform>".
 */
export function appSteps(events = []) {
  const ends = new Map();
  for (const e of events) if (e.toolUseId && END.has(e.kind)) ends.set(e.toolUseId, e.kind === 'tool_done' && e.ok !== false ? 'ok' : 'err');
  const out = [];
  for (const e of events) {
    if (e.kind !== 'tool' || isBridge(e.tool)) continue;
    const shell = e.tool === 'Bash' || e.tool === 'PowerShell';
    if (!shell && !/^mcp__/.test(String(e.tool || '')) && !['Write', 'Edit', 'MultiEdit'].includes(e.tool) && !/^(ACP|AGY)_/.test(String(e.tool || ''))) continue;
    const text = `${e.tool || ''} ${e.summary || ''} ${e.input?.command || ''} ${shell || /^mcp__/.test(e.tool) ? '' : String(e.input?.content || e.input?.new_string || '').slice(0, 300)}`;
    out.push({ text, flow: /\bflow\s+execute\b/i.test(text), end: e.toolUseId ? ends.get(e.toolUseId) || 'open' : 'open' });
  }
  return out;
}

// A claim is a clause that starts with the verb ("Sent the recap in Slack", "… and emailed Sam"): "Read the sent
// emails" or "checked the YouTube Scheduled queue" aren't. Generic words need a verb of their own kind.
const LEAD = new RegExp(`^(?:also\\s+|then\\s+|and\\s+)?${WRITE_VERB.source.replace(/^\\b/, '')}`, 'i');
const GENERIC_VERB = { email: /^(?:also\s+|then\s+|and\s+)?(sent|send|emailed|e-mailed|mailed|replied|forwarded)\b/i, calendar: /^(?:also\s+|then\s+|and\s+)?(scheduled|booked|invited|sent|created|moved|cancell?ed|updated|added)\b/i, 'Google Sheets': LEAD };
const FAMILY = { email: /^(Gmail|Outlook|Mailchimp)$/, calendar: /^(Google Calendar|Outlook)$/, 'Google Sheets': /^Airtable$/ };
export function claimsIn(line) {
  const out = [];
  const clauses = String(line || '').split(/;|\.\s+(?=[A-Z])|,\s+(?=(?:and\s+|then\s+)?[a-z]+ed\b)|\s+(?:and|then)\s+(?=[a-z]+ed\b)/);
  for (const raw of clauses) {
    const c = raw.replace(/^[\s\-*•\d.)]+/, '').trim();
    const verb = c.match(LEAD);
    if (!verb || NOT_DONE.test(c)) continue;
    // the app must be what the verb acts on: look only at the head ("Updated the task" before ": … PR by Oct 27")
    const head = c.split(/:\s|\s\(|\s[—–-]\s/)[0].slice(0, 120);
    // a clause about a local file ("Updated brief.md to v3") is file work, whatever app it mentions
    if (artifacts.outputBits(head).paths.some(p => /[\\/]/.test(p) || /\.(md|mdx|json|ya?ml|txt|csv|html?|mjs|js|py|ts|pdf|docx|xlsx|png|jpe?g|mp4|mp3)$/i.test(p))) continue;
    const hits = APPS.filter(([label, says, , generic]) => says.test(head) && !(generic && !GENERIC_VERB[label]?.test(head)));
    // "Gmail" and "email" in one clause are one claim
    for (const h of hits) if (!(h[3] && hits.some(([l]) => FAMILY[h[0]]?.test(l)))) out.push({ app: h, verb: verb[0].replace(/^(also|then|and)\s+/i, '').toLowerCase(), clause: c });
  }
  return out;
}

function actionsCheck(run, events) {
  const lines = run.report?.actions_taken || [];
  const claims = lines.flatMap(l => claimsIn(l));
  if (!claims.length) return null;
  const steps = appSteps(events);
  const unseen = [], failed = [];
  for (const { verb, app: [label, , shows, generic] } of claims) {
    const match = steps.filter(s => s.flow || shows.test(s.text));
    if (!match.length) unseen.push({ label, verb, generic });
    else if (match.every(s => s.end === 'err')) failed.push({ label, verb, generic });
  }
  if (!unseen.length && !failed.length) return { name: 'App actions', ok: true, note: `${claims.length} claim${claims.length === 1 ? '' : 's'} match its steps` };
  const first = unseen[0] || failed[0];
  const said = `Says it ${first.verb}${first.generic ? '' : ` in ${first.label}`}`;
  const a = /^[aeiou]/i.test(first.label) ? 'an' : 'a';
  const more = unseen.length + failed.length > 1 ? ` (${unseen.length + failed.length} claims like this)` : '';
  const note = unseen.length ? `${said}, but I don't see ${a} ${first.label} step${more}` : `${said}, but every ${first.label} step failed${more}`;
  return { name: 'App actions', ok: false, level: 'warn', note };
}

// ── a step that promised kinds of file (`expects: [{kind, note}]`, for multi-step plans) ──
const KIND_ALIASES = {
  document: ['pdf', 'doc', 'markdown', 'html', 'text'], report: ['pdf', 'doc', 'markdown', 'html', 'text'],
  spreadsheet: ['csv', 'sheet'], table: ['csv', 'sheet'], deck: ['slides'], presentation: ['slides'],
  file: null, any: null,
};
function expectsCheck(expects, arts) {
  if (!Array.isArray(expects) || !expects.length) return null;
  const miss = [];
  for (const x of expects) {
    const k = String(x?.kind || '').toLowerCase();
    if (!k) continue;
    const kinds = k in KIND_ALIASES ? KIND_ALIASES[k] : [k];
    const have = arts.some(a => a.status !== 'missing' && a.status !== 'failed' && (!kinds || kinds.includes(a.kind)));
    if (!have) miss.push(x.note ? `${k} (${String(x.note).slice(0, 60)})` : k);
  }
  return miss.length ? { name: 'Expected files', ok: false, level: 'fail', note: `No ${miss.join(', ')} from this step` } : { name: 'Expected files', ok: true, note: `${expects.length} found` };
}

// ── organised by department: only in a workspace laid out that way (config `departments`) ──
/** A build that left an agent without `department` + `home` fails: the owner's "Ask it to fix" sends it back. */
function agentsCheck(run, ws) {
  if (!run.createdAgents?.length || !ws || !departmentsOf(ws).length) return null;
  let list = [];
  try { list = deps.agents(ws.id) || []; } catch { return null; }
  const touched = run.createdAgents.map(c => list.find(a => a.slug === c.slug)).filter(Boolean);
  const miss = touched.filter(a => !a.department || !a.home);
  const n = touched.length;
  if (!miss.length) return n ? { name: 'Agent homes', ok: true, note: `${n} agent file${n === 1 ? '' : 's'} with department + home` } : null;
  return { name: 'Agent homes', ok: false, level: 'fail', note: `${miss.map(a => a.callName || a.slug).join(', ')} ${miss.length === 1 ? 'has' : 'have'} no department + home in the frontmatter` };
}

/** Files a run saved outside its home, its task folder and its department's shared folders (teammates' homes aren't). */
function placesCheck(run, ws, arts) {
  if (!ws || run.client || run.isBuilder || run.backend || !departmentsOf(ws).length) return null;
  let list = [];
  try { list = deps.agents(ws.id) || []; } catch { return null; }
  const agent = run.agentSlug ? list.find(a => a.slug === run.agentSlug) || null : null;
  const own = homeOf(ws, agent), dept = departmentOf(ws, agent), task = taskRel(run);
  const homes = [...list.map(a => homeOf(ws, a)), ws.generalistHome ? wsRel(ws.generalistHome) : null].filter(h => h && h !== own);
  const under = (rel, p) => !!p && (rel === p.toLowerCase() || rel.startsWith(`${p.toLowerCase()}/`));
  const fine = rel => under(rel, task) || under(rel, own) || (under(rel, dept) && !homes.some(h => under(rel, h)));
  const mine = arts.filter(a => a.status !== 'missing' && (a.runIds || [a.runId]).includes(run.id));
  if (!mine.length) return null;
  const out = mine.filter(a => !fine(String(a.rel || '').toLowerCase()));
  if (!out.length) return { name: 'Where it saved', ok: true, note: '' };
  return { name: 'Where it saved', ok: false, level: 'warn', note: `${out.length} file${out.length === 1 ? '' : 's'} outside its home and department: ${out.slice(0, 3).map(a => a.rel).join(', ')}${out.length > 3 ? '…' : ''}` };
}

/**
 * The deterministic pass (sync, no model). `events` = the run's recorded events (plus its team runs' for app claims),
 * `arts` = its artifacts (artifacts.listArtifacts({run})), `expects` = a step's promised [{kind, note}].
 */
export function checkRun(run, { events = [], arts = [], ws = null, expects = null, teamEvents = [] } = {}) {
  const t0 = Date.now();
  const checks = [];
  // a quick read-only answer often comes as the last message instead of report_done: that's fine; work without one isn't
  const did = sideEffects(events).filter(e => !isBridge(e.tool));
  if (!run.report && run.resultText && !did.length) checks.push({ name: 'Report', ok: true, note: 'Answered in its last message (it only read)' });
  else if (!run.report) checks.push({ name: 'Report', ok: false, level: 'warn', note: `Finished without a report${did.length ? ` after ${did.length} step${did.length === 1 ? '' : 's'} that could change things` : ''}` });
  else checks.push({ name: 'Report', ok: true, note: run.report.status === 'completed' ? '' : `It says ${run.report.status}` });
  for (const c of [statusCheck(run, events), outputsCheck(run, ws, arts), actionsCheck(run, [...events, ...teamEvents]), expectsCheck(expects, arts), agentsCheck(run, ws), placesCheck(run, ws, arts)]) if (c) checks.push(c);
  return { verdict: verdictOf(checks), checks: checks.map(tidy), at: new Date().toISOString(), ms: Date.now() - t0 };
}
const tidy = c => ({ name: c.name, ok: !!c.ok, note: c.note || '', ...(c.ok ? {} : { level: c.level || 'warn' }) });
export const verdictOf = checks => (checks.some(c => !c.ok && c.level === 'fail') ? 'failed' : checks.some(c => !c.ok) ? 'check' : 'ok');

// ── the semantic read (one Jev call, three yes/no questions; the weakest one is the note) ──
const JEV_Q = () => ({
  did_task: ['it may not have done what you asked', `Does the report show the agent did what ${ownerName()} asked in the task: that task, not something else and not only part of it?`],
  delivered: ['it may not have delivered what you asked to see', `Did it deliver what the task asked ${ownerName()} to receive or see (the file, list, draft, answer or change), shown in the result or named in the outputs?`],
  consistent: ["the report may not hold up against Orchy's checks", "Is the report consistent with Orchy's checks below (no claim they contradict)?"],
});
export const JEV_THRESHOLD = 0.4;
export async function semanticCheck(run, checks, { ask = deps.ask, timeoutMs = 8_000 } = {}) {
  if (!ask) ask = deps.ask = (await import('./jev.mjs')).ask;
  const r = run.report || {};
  const cut = (s, n) => String(s || '').slice(0, n);
  const state = {
    task_owner_gave: cut(run.instruction, 1500),
    report_status: r.status || '(no report)',
    report_summary: cut(r.summary || run.resultText, 1500),
    report_result: cut(r.result, 2500),
    outputs: (r.outputs || []).slice(0, 12).join('\n').slice(0, 800) || '(none)',
    orchy_checks: checks.map(c => `${c.ok ? 'ok' : 'NOT OK'}: ${c.name}${c.note ? ` (${c.note})` : ''}`).join('\n'),
  };
  const qs = JEV_Q();
  const questions = Object.fromEntries(Object.entries(qs).map(([k, [, q]]) => [k, { type: 'noul', instructions: q }]));
  const res = await ask(state, questions, { purpose: 'validate', timeoutMs });
  const ps = Object.fromEntries(Object.keys(qs).map(k => [k, Number(res.answers?.[k]?.noul ?? NaN)]));
  const known = Object.entries(ps).filter(([, p]) => Number.isFinite(p));
  if (!known.length) return null;
  const [weakest, p] = known.sort((a, b) => a[1] - b[1])[0];
  return { p: Math.round(p * 100) / 100, weakest, ps, ms: res.ms || 0, ok: p >= JEV_THRESHOLD, note: qs[weakest][0] };
}

/** Everything a finished run left, checked. Doesn't store anything (applyValidation does). */
export async function validateRun(run, { semantic = deps.db().settings?.validateJev === true, expects = null, ask } = {}) {
  let ws = null;
  try { ws = deps.workspace(run.workspace); } catch {}
  try { deps.sync(run); } catch (e) { console.error('[validate] sync', e.message); } // the registry has its files before we look
  const events = deps.events(run.id) || [];
  const teamEvents = (run.subRuns || []).slice(0, 6).flatMap(id => deps.events(id) || []);
  let arts = [];
  try { arts = deps.artifactsFor(run) || []; } catch {}
  // steps that share one folder: a step's expected files are the ones it wrote, not an earlier step's
  if (expects || run.missionId) arts = arts.filter(a => (a.runIds || [a.runId]).includes(run.id) || String(a.updatedAt || '') >= String(run.startedAt || ''));
  const v = checkRun(run, { events, arts, ws, expects, teamEvents });
  if (semantic && run.report) {
    try {
      const j = await semanticCheck(run, v.checks, { ask });
      if (j) {
        v.jev = { p: j.p, weakest: j.weakest, ms: j.ms };
        v.checks.push(tidy({ name: "Jev's read", ok: j.ok, level: 'warn', note: j.ok ? `${Math.round(j.p * 100)}% sure it answers the task` : `${j.note} (${Math.round(j.p * 100)}%)` }));
        v.verdict = verdictOf(v.checks);
      }
    } catch (e) { v.jev = { error: String(e.message || e).slice(0, 160) }; }
  }
  return v;
}

/**
 * Orchy's step after a run ends: the run shows "Orchy is checking" (activity `validating`), the checks run, the
 * result lands on `run.validation`, and the run goes back to its outcome. Returns the result.
 */
export async function applyValidation(run, opts = {}) {
  const at = new Date().toISOString();
  run.activity = { state: 'validating', label: LABELS.validating, tool: null, app: null, toolUseId: null, since: at };
  deps.emit('run.updated', { run: deps.publicRun(run) });
  let v;
  try { v = await validateRun(run, opts); }
  catch (e) { v = { verdict: 'ok', checks: [], at, ms: 0, error: String(e.message || e).slice(0, 200) }; console.error('[validate]', e.message); }
  run.validation = v;
  run.activity = nextActivity(run);
  deps.save();
  deps.emit('run.updated', { run: deps.publicRun(run) });
  return v;
}

/** What's off, in a line (Orchy's report, the run window). '' when nothing is. */
export function problems(v) {
  return (v?.checks || []).filter(c => !c.ok).map(c => (c.note ? `${c.name}: ${c.note}` : c.name)).join('; ');
}

/** The follow-up "Ask it to fix" prefills (the owner sends it; nothing is sent on its own). */
export function fixPrompt(v) {
  const p = problems(v);
  return p ? `Orchy checked your report and found: ${p}. Fix only that (don't redo or resend anything that already went out), then report again.` : '';
}
