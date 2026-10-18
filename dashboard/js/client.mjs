// Client page (served by orchestrator/portal.mjs): one of the owner's clients gives the agents the owner shared with
// them a task, answers what they ask, okays decisions in their own apps, and reads what came back.
//   home: greeting, anything waiting on them (yellow), the task box, their tasks
//   #task=<id>: one task, live while it runs, its report and a follow-up box after
import { icon, orchySVG, agentSVG, createEl } from './pixel.mjs';
import { esc, md, timeShort, dateTime, dur, setTimezone } from './util.mjs';
import { fileTray } from './attach.mjs';
import { initCalls, startCall, callingWith } from './clientcall.mjs';
import { configureViewer, mountViewer, artifactChanged, kindIcon } from './viewer.mjs';

const token = location.pathname.split('/')[2] || '';
const BASE = `/c/${token}/api`;
const LIVE = new Set(['starting', 'working', 'waiting', 'stopping']);
const FEED_MAX = 40;
// the same file viewer as the owner's dashboard, on this page's own routes: only this client's files (portal.mjs → clientview.mjs)
configureViewer({ base: `${BASE}/artifacts`, client: true });

const S = { client: null, agents: [], runs: new Map(), inbox: new Map(), pick: null, maxLive: 3, feeds: new Map(), files: new Map(), arts: new Map(), calls: false, owner: '' };
/** Who runs this workspace, as the page says it (the state may carry `owner`, else "the owner"). */
const host = () => S.owner || 'the owner';
const drafts = {}; // what they've typed, kept through re-renders: key -> text

// files for a task: they go to the client's own folder on the owner's PC (portal.mjs → clientspace.mjs)
const ACCEPT = '.pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.md,.csv,.tsv,.json,.docx,.xlsx,.pptx,.odt,.ods,.odp';
const trays = new Map(); // 'ask' or 'fu-<run id>' -> tray
const trayFor = key => {
  if (!trays.has(key)) trays.set(key, fileTray(toast, { url: `${BASE}/files`, maxBytes: 25 * 1024 * 1024, accept: ACCEPT, thumb: null, keyOf: d => d.id, keptHint: '' }));
  return trays.get(key);
};
const fileURL = (rid, p) => `${BASE}/runs/${encodeURIComponent(rid)}/file?path=${encodeURIComponent(p)}`;
const fsize = n => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone); // their clock, not the owner's

// ── helpers ──
async function api(p, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${p}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('Lost the connection. Reload the page (you may need to sign in again).');
  }
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : {};
  if (!res.ok) throw new Error(data.error || `That didn’t work (${res.status}). Reload and try again.`);
  return data;
}

function toast(msg, kind = '') {
  const el = createEl(`<div class="toast ${kind}">${esc(msg)}</div>`);
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'warn' ? 7000 : 4000);
}

const agentOf = slug => S.agents.find(a => a.slug === slug);
const sprite = (slug, name) => agentSVG(`${S.client.workspace}/${slug || 'general'}`, S.client.workspace, { label: name || slug || '' });
const isLive = r => LIVE.has(r.status);
const mineToAnswer = () => [...S.inbox.values()].filter(i => i.status === 'pending' && i.answerer === 'client');
const asksFor = runId => [...S.inbox.values()].filter(i => i.status === 'pending' && i.runId === runId);
const runsSorted = () => [...S.runs.values()].sort((a, b) => (isLive(b) - isLive(a)) || b.startedAt.localeCompare(a.startedAt));
const linkify = s => /^https?:\/\/\S+$/.test(s) ? `<a href="${esc(s)}" target="_blank" rel="noopener noreferrer">${esc(s)}</a>` : esc(s);

function status(r) {
  const asks = asksFor(r.id);
  if (asks.some(i => i.answerer === 'client')) return { word: 'Needs you', cls: 'decide' };
  if (asks.length) return { word: `Waiting on ${host()}`, cls: 'decide' };
  if (r.status === 'starting') return { word: 'Starting', cls: 'blink' };
  if (r.status === 'working' || r.status === 'waiting') return { word: 'Working', cls: 'blink' };
  if (r.status === 'stopping') return { word: 'Stopping', cls: '' };
  const o = r.report?.status || r.outcome;
  if (o === 'completed') return { word: 'Done', cls: 'ok' };
  if (o === 'partial') return { word: 'Partly done', cls: 'ok' };
  if (o === 'blocked') return { word: 'Blocked', cls: 'bad' };
  if (o === 'stopped' || r.status === 'stopped') return { word: 'Stopped', cls: 'ok' };
  return { word: 'Failed', cls: 'bad' };
}
const plate = r => { const s = status(r); return `<span class="plate ${s.cls}">${s.word}</span>`; };

/** Re-render a box without losing what they were typing or where the cursor was. */
function keep(box, html, wire) {
  if (!box) return;
  for (const el of box.querySelectorAll('[data-draft]')) drafts[el.dataset.draft] = el.value;
  const focus = document.activeElement?.dataset?.draft;
  box.innerHTML = html;
  for (const el of box.querySelectorAll('[data-draft]')) if (drafts[el.dataset.draft]) el.value = drafts[el.dataset.draft];
  if (focus) box.querySelector(`[data-draft="${CSS.escape(focus)}"]`)?.focus();
  wire?.(box);
}

// ── things waiting on them ──
function needsHTML(items) {
  return items.map(i => {
    const a = agentOf(i.runId && S.runs.get(i.runId)?.agent) || {};
    const who = `<span class="from"><span class="sprite">${sprite(a.slug, a.name)}</span>${esc(i.agentName)} ${i.kind === 'approval' ? 'needs your OK' : 'asks'}</span>`;
    if (i.kind === 'approval') return `<div class="needs" data-item="${esc(i.id)}">
      ${who}
      <p class="q">${esc(i.action?.title ? `${i.action.title}${i.action.connection ? ` in ${i.action.connection}` : ''}` : i.title)}</p>
      ${i.message ? `<p class="ctx">${esc(i.message)}</p>` : ''}
      ${i.detail ? `<details><summary>Details</summary><pre class="cmd">${esc(i.detail)}</pre></details>` : ''}
      <label class="sr-only" for="note-${esc(i.id)}">Note for the agent (optional)</label>
      <input class="input" id="note-${esc(i.id)}" data-draft="note-${esc(i.id)}" placeholder="Note for the agent (optional), e.g. use the other date">
      <div class="btnrow"><button class="btn primary" data-approve="${esc(i.id)}">${icon('check')}Approve</button><button class="btn" data-deny="${esc(i.id)}">${icon('x')}Deny</button></div>
    </div>`;
    return `<div class="needs" data-item="${esc(i.id)}">
      ${who}
      <p class="q">${esc(i.message || i.title)}</p>
      ${i.context ? `<p class="ctx">${esc(i.context)}</p>` : ''}
      ${i.options?.length ? `<div class="opts">${i.options.map(o => `<button class="btn" data-pick="${esc(i.id)}" data-val="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : ''}
      <label class="sr-only" for="ans-${esc(i.id)}">Your answer</label>
      <textarea class="textarea" id="ans-${esc(i.id)}" data-draft="ans-${esc(i.id)}" rows="3" placeholder="${i.options?.length ? 'Or write your own answer…' : 'Your answer…'}"></textarea>
      <div class="btnrow"><button class="btn primary" data-answer="${esc(i.id)}">${icon('send')}Send answer</button></div>
    </div>`;
  }).join('');
}

function wireNeeds(box) {
  const done = async (iid, body, btn) => {
    box.querySelectorAll(`[data-item="${CSS.escape(iid)}"] button`).forEach(b => { b.disabled = true; });
    try {
      await api(`/inbox/${encodeURIComponent(iid)}/answer`, { method: 'POST', body });
      delete drafts[`ans-${iid}`]; delete drafts[`note-${iid}`];
      S.inbox.delete(iid);
      renderAll();
      toast(body.approve === false ? 'Denied. The agent will adapt.' : 'Sent. The agent carries on.');
    } catch (e) {
      box.querySelectorAll(`[data-item="${CSS.escape(iid)}"] button`).forEach(b => { b.disabled = false; });
      toast(e.message, 'warn');
      btn?.focus();
    }
  };
  box.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => done(b.dataset.pick, { text: b.dataset.val }, b)));
  box.querySelectorAll('[data-answer]').forEach(b => b.addEventListener('click', () => {
    const v = box.querySelector(`[data-draft="ans-${CSS.escape(b.dataset.answer)}"]`)?.value.trim();
    if (!v) { toast('Write an answer first, or pick one of the choices.', 'warn'); return; }
    done(b.dataset.answer, { text: v }, b);
  }));
  const note = iid => box.querySelector(`[data-draft="note-${CSS.escape(iid)}"]`)?.value.trim() || '';
  box.querySelectorAll('[data-approve]').forEach(b => b.addEventListener('click', () => done(b.dataset.approve, { approve: true, note: note(b.dataset.approve) }, b)));
  box.querySelectorAll('[data-deny]').forEach(b => b.addEventListener('click', () => done(b.dataset.deny, { approve: false, note: note(b.dataset.deny) }, b)));
}

// ── home ──
function homeHTML() {
  const c = S.client;
  const names = S.agents.map(a => a.name);
  return `
    <section class="hello">
      <h1>Hi ${esc(c.name)}</h1>
      <p>${names.length ? `Give ${esc(names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0])} a task. Progress and results show up here, and anything an agent needs from you shows up in yellow.` : `${host()} hasn’t shared any agents with you yet.`}</p>
      ${c.open ? '' : `<p class="closed">${esc(host())} has paused this workspace for now, so new tasks won’t start. Anything already running finishes.</p>`}
    </section>
    <section id="needs-box" aria-live="polite"></section>
    ${S.agents.length ? `<section class="ask" id="ask-box" aria-labelledby="ask-h"></section>` : ''}
    <section id="tasks-box" aria-labelledby="tasks-h"></section>
    <p class="foot">${esc(host())} can see these tasks too. Steps that touch ${esc(host())}’s computer wait for their OK.</p>`;
}

function askHTML() {
  const a = agentOf(S.pick) || S.agents[0];
  const live = [...S.runs.values()].filter(isLive).length;
  return `<h2 id="ask-h">New task</h2>
    ${S.agents.length > 1 ? `<div class="picker" role="group" aria-label="Pick an agent">${S.agents.map(x => `
      <button type="button" class="pick" data-agent="${esc(x.slug)}" aria-pressed="${x.slug === a.slug}">
        <span class="sprite">${sprite(x.slug, x.name)}</span><span><b>${esc(x.name)}</b>${x.role && x.role !== x.name ? `<small>${esc(x.role)}</small>` : ''}</span>
      </button>`).join('')}</div>` : ''}
    ${a.about ? `<p class="about">${esc(a.about)}</p>` : ''}
    ${callBtn(a)}
    <div class="field" data-zone>
      <label class="sr-only" for="task">Task for ${esc(a.name)}</label>
      <textarea class="textarea task" id="task" data-draft="task-${esc(a.slug)}" placeholder="What should ${esc(a.name)} do? A Notion task link works too. Drop or paste files here."></textarea>
      ${trayFor('ask').chips()}
    </div>
    <div class="row"><span class="hint">${live >= S.maxLive ? `${S.maxLive} tasks are running. The next one can start when one finishes.` : 'Ctrl+Enter sends. Files: PDF, images, text, Word, Excel, PowerPoint (25 MB each).'}</span>
      <span class="btnrow">${trayFor('ask').button()}<button class="btn primary" id="send" ${live >= S.maxLive || !S.client.open ? 'disabled' : ''}>${icon('send')}Send to ${esc(a.name)}</button></span></div>`;
}

/** Talk to an agent: its voice agent made for this client (only when the owner switched calls on and it has a voice). */
const callBtn = a => (S.calls && a?.callName ? `<button type="button" class="btn" data-callagent="${esc(a.slug)}" aria-pressed="${callingWith() === a.slug}">${icon('phone')}${callingWith() === a.slug ? 'Hang up' : `Call ${esc(a.callName)}`}</button>` : '');
const wireCall = box => box.querySelectorAll('[data-callagent]').forEach(b => b.addEventListener('click', () => { const a = agentOf(b.dataset.callagent); if (a) startCall(a.slug, a.callName); }));

function wireAsk(box) {
  wireCall(box);
  box.querySelectorAll('[data-agent]').forEach(b => b.addEventListener('click', () => { S.pick = b.dataset.agent; renderAsk(); box.querySelector('#task')?.focus(); }));
  const ta = box.querySelector('#task');
  const send = box.querySelector('#send');
  const tray = trayFor('ask');
  tray.mount(box, box.querySelector('[data-zone]'));
  const go = async () => {
    const text = ta.value.trim();
    const a = agentOf(S.pick) || S.agents[0];
    if (tray.busy()) { toast('Still saving your files. Send again in a moment.', 'warn'); return; }
    const files = tray.ready();
    if (!text && !files.length) { toast(`Tell ${a.name} what to do first.`, 'warn'); ta.focus(); return; }
    send.disabled = true;
    try {
      const run = await api('/runs', { method: 'POST', body: { agent: a.slug, text, files } });
      S.runs.set(run.id, run);
      delete drafts[`task-${a.slug}`];
      ta.value = '';
      tray.clear();
      location.hash = `task=${run.id}`;
    } catch (e) { toast(e.message, 'warn'); send.disabled = false; }
  };
  send?.addEventListener('click', go);
  ta?.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); } });
}

function tasksHTML() {
  const runs = runsSorted();
  return `<h2 id="tasks-h">Your tasks <span class="count">${runs.length}</span></h2>
    ${runs.length ? `<div class="tasks">${runs.map(r => `
      <button class="trow" data-open="${esc(r.id)}">
        <span class="sprite">${sprite(r.agent, r.agentName)}</span>
        <span><b>${esc(r.agentName)}</b><span class="what">${r.by ? `${esc(r.by)}: ` : ''}${esc(r.instruction || (r.files?.length ? `${r.files.length} file${r.files.length > 1 ? 's' : ''}` : ''))}</span></span>
        <span class="when">${plate(r)}<span>${isLive(r) ? dur(Date.now() - Date.parse(r.startedAt)) : dateTime(r.startedAt)}</span></span>
      </button>`).join('')}</div>`
    : '<div class="empty"><strong>No tasks yet</strong>Your first one shows up here as soon as you send it.</div>'}`;
}
const wireTasks = box => box.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => { location.hash = `task=${b.dataset.open}`; }));

const renderNeeds = () => keep(document.getElementById('needs-box'), mineToAnswer().length ? `<h2>Needs you <span class="count">${mineToAnswer().length}</span></h2>${needsHTML(mineToAnswer())}` : '', wireNeeds);
const renderAsk = () => keep(document.getElementById('ask-box'), askHTML(), wireAsk);
const renderTasks = () => keep(document.getElementById('tasks-box'), tasksHTML(), wireTasks);

// ── one task ──
const EV_ICON = { system: 'bolt', text: 'chat', tool: 'term', tool_error: 'bang', error: 'bang', note: 'doc', report: 'check', denied: 'x' };
// the agent's steps never show here (portal.mjs sends a bare "tick"): while it works, one playful word stands in
const WORDS = ['Pondering', 'Tinkering', 'Brewing', 'Noodling', 'Mulling it over', 'Piecing it together', 'Cooking', 'Sketching', 'Untangling', 'Polishing',
  'Crunching', 'Sifting', 'Puzzling', 'Weaving', 'Percolating', 'Conjuring', 'Fiddling', 'Simmering', 'Doodling', 'Wrangling', 'Connecting the dots', 'Rummaging', 'Beating up dots', 'Beating up bots'];
let wordAt = Math.floor(Math.random() * WORDS.length);
let wordSince = 0;
function nextWord() {
  if (Date.now() - wordSince < 1500) return; // a burst of steps doesn't flicker
  wordSince = Date.now();
  wordAt = (wordAt + 1 + Math.floor(Math.random() * (WORDS.length - 1))) % WORDS.length;
  const el = document.querySelector('#busyword span');
  if (el) el.textContent = `${WORDS[wordAt]}…`;
}
setInterval(nextWord, 3200);
const busyHTML = () => `<div class="busyword" id="busyword">${icon('spark')}<span>${esc(WORDS[wordAt])}…</span></div>`;
const shownEvs = evs => evs.filter(e => e.kind !== 'tick');
const evRow = e => `<div class="ev ${esc(e.kind)}">${icon(EV_ICON[e.kind] || 'term')}<span>${e.kind === 'text' ? md(e.text) : esc(e.text)}</span><time>${timeShort(e.t)}</time></div>`;

function taskHTML(r) {
  const asks = asksFor(r.id);
  const theirs = asks.filter(i => i.answerer === 'client');
  const ownerAsks = asks.filter(i => i.answerer !== 'client');
  const live = isLive(r);
  const rep = r.report;
  const evs = shownEvs(S.feeds.get(r.id) || []).slice(-FEED_MAX);
  return `
    <button class="btn sm back" data-back>${icon('home')}All tasks</button>
    <div class="thead"><span class="sprite">${sprite(r.agent, r.agentName)}</span>
      <span><b>${esc(r.agentName)}</b><small>${live ? `Started ${timeShort(r.startedAt)} · <span data-timer="${esc(r.startedAt)}">${dur(Date.now() - Date.parse(r.startedAt))}</span>` : `${dateTime(r.startedAt)}${r.endedAt ? ` · took ${dur(Date.parse(r.endedAt) - Date.parse(r.startedAt))}` : ''}`}</small></span>
      ${plate(r)}</div>
    ${r.parentRunId && S.runs.has(r.parentRunId) ? `<button class="btn sm ghost" data-open="${esc(r.parentRunId)}">Follow-up to an earlier task</button>` : ''}
    ${r.instruction || r.by ? `<p class="said">${r.by ? `<b class="by">${esc(r.by)} added:</b> ` : ''}${esc(r.instruction)}</p>` : ''}
    ${r.files?.length ? `<div class="attachments">${r.files.map(n => `<span class="fchip ready">${icon('doc')}<span class="t" title="${esc(n)}">${esc(n)}</span></span>`).join('')}</div>` : ''}
    <div id="task-needs" aria-live="polite">${needsHTML(theirs)}</div>
    ${ownerAsks.length ? `<div class="waiting-owner">${icon('clock')}<span>${esc(ownerAsks[0].title)}. It carries on once ${esc(host())} has looked.</span></div>` : ''}
    ${live || evs.length && !rep ? `<section><h2>${live ? 'What it’s doing' : 'What it said'}</h2>${evs.length ? `<div class="feed" id="feed" aria-live="polite">${evs.map(evRow).join('')}</div>` : ''}${live ? busyHTML() : ''}</section>` : ''}
    ${rep ? `<section class="report"><span class="label">What came back</span><div class="md">${md(rep.summary)}</div>
      ${rep.outputs?.length ? `<span class="label">Links and results</span><ul class="outs">${rep.outputs.map(o => `<li>${outLink(r, o)}</li>`).join('')}</ul>` : ''}
      ${rep.follow_ups?.length ? `<span class="label">Next steps</span><ul class="outs">${rep.follow_ups.map(o => `<li>${esc(o)}</li>`).join('')}</ul>` : ''}</section>` : ''}
    ${filesHTML(r)}
    ${!rep && r.error && !live ? `<pre class="cmd">${esc(r.error)}</pre>` : ''}
    ${!rep && !live && !r.error && r.status === 'stopped' ? `<p class="note">Stopped${r.stoppedBy ? ` by ${esc(r.stoppedBy)}` : ''}.</p>` : ''}
    ${live ? `<div class="btnrow"><button class="btn" data-stop="${esc(r.id)}" ${r.status === 'stopping' ? 'disabled' : ''}>${icon('stop')}Stop this task</button>${callBtn(agentOf(r.agent))}</div>`
      : agentOf(r.agent) ? `<div class="followup"><div class="field" data-zone><label class="label" for="fu">Follow up with ${esc(r.agentName)}</label>
        <textarea class="textarea" id="fu" data-draft="fu-${esc(r.id)}" rows="3" placeholder="It remembers this task. Ask for changes or a next step. Drop or paste files here."></textarea>
        ${trayFor(`fu-${r.id}`).chips()}</div>
        <div class="btnrow end">${callBtn(agentOf(r.agent))}${trayFor(`fu-${r.id}`).button()}<button class="btn primary" data-reply="${esc(r.id)}" ${S.client.open ? '' : 'disabled'}>${icon('send')}Send follow-up</button></div></div>` : ''}`;
}

/** The task's files: what the agent made and what they attached, each opens the viewer (downloads from there). */
const KIND_WORD = { image: 'Image', pdf: 'PDF', video: 'Video', audio: 'Audio', markdown: 'Text', text: 'Text', code: 'Code', json: 'Data', csv: 'Table', sheet: 'Spreadsheet', doc: 'Document', slides: 'Slides', html: 'Web page', other: 'File' };
const uploadedArt = a => /^Tasks\/[^/]+\/files\//i.test(a.rel || '');
function artRow(a) {
  const th = a.media?.thumb ? `<img src="${esc(`${BASE}/artifacts/${encodeURIComponent(a.id)}/media/thumb?v=${a.version}`)}" alt="" loading="lazy">` : icon(kindIcon(a.kind));
  return `<button type="button" class="vfile" data-art="${esc(a.id)}"><span class="th" aria-hidden="true">${th}</span><span class="nm"><b>${esc(a.name)}</b><span>${esc(KIND_WORD[a.kind] || 'File')}${a.status === 'draft' ? ' · draft' : ''}</span></span><span class="tag">${fsize(a.size || 0)}</span></button>`;
}
function filesHTML(r) {
  const arts = S.arts.get(r.id);
  if (arts?.length) {
    const made = arts.filter(a => !uploadedArt(a) && a.name !== 'TASK.md'), given = arts.filter(uploadedArt);
    if (!made.length && !given.length) return '';
    return `<section class="tfiles"><h2>Files</h2>
      ${made.length ? `<span class="label">Made for this task</span><div class="vfiles">${made.map(artRow).join('')}</div>` : ''}
      ${given.length ? `<span class="label">Attached</span><div class="vfiles">${given.map(artRow).join('')}</div>` : ''}</section>`;
  }
  // the viewer's list isn't there (yet): the folder's files, each a download
  const list = S.files.get(r.id) || [];
  if (!list.length) return '';
  const made = list.filter(f => !f.uploaded && f.name !== 'TASK.md');
  const given = list.filter(f => f.uploaded);
  const row = f => `<li><a href="${esc(fileURL(r.id, f.path))}" target="_blank" rel="noopener noreferrer">${icon('doc')}${esc(f.name)}</a> <span class="sz">${fsize(f.size)}</span></li>`;
  return `<section class="tfiles"><h2>Files</h2>
    ${made.length ? `<span class="label">Made for this task</span><ul class="outs files">${made.map(row).join('')}</ul>` : ''}
    ${given.length ? `<span class="label">Attached</span><ul class="outs files">${given.map(row).join('')}</ul>` : ''}</section>`;
}

/** A result line: a web link, a file from the task's folder (downloadable), or plain text. */
function outLink(r, o) {
  const arts = S.arts.get(r.id) || [];
  const a = arts.find(x => o === x.rel || o.endsWith(`/${x.rel}`)) || arts.find(x => o === x.name || o.endsWith(`/${x.name}`));
  if (a) return `<a href="#" data-art="${esc(a.id)}">${esc(a.name)}</a>`;
  const f = (S.files.get(r.id) || []).find(x => o === x.path || o.endsWith(`/${x.path}`));
  return f ? `<a href="${esc(fileURL(r.id, f.path))}" target="_blank" rel="noopener noreferrer">${esc(f.name)}</a>` : linkify(o);
}

async function loadFiles(rid) {
  const [files, arts] = await Promise.all([
    api(`/runs/${encodeURIComponent(rid)}/files`).catch(() => null),
    api(`/artifacts?run=${encodeURIComponent(rid)}`).catch(() => null),
  ]);
  if (files) S.files.set(rid, files);
  if (arts) S.arts.set(rid, arts.artifacts || []);
  if ((files || arts) && currentTask() === rid) renderTask();
}

// ── the file viewer: a sheet over the page (Esc or Close shuts it) ──
let sheet = null;
function openFile(rid, aid) {
  const list = S.arts.get(rid) || [];
  const art = list.find(a => a.id === aid);
  if (!art) return;
  if (!sheet) {
    const dlg = createEl(`<dialog class="cview" aria-labelledby="cv-t"><div class="cvbar"><b id="cv-t"></b><button type="button" class="btn sm" data-cv="close">${icon('x')}Close</button></div><div class="cvbody"></div></dialog>`);
    document.body.appendChild(dlg);
    sheet = { dlg, root: dlg.querySelector('.cvbody'), handle: null };
    dlg.querySelector('[data-cv="close"]').addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => { sheet.handle?.close(); sheet.handle = null; dlg.classList.remove('large'); });
  }
  const { dlg } = sheet;
  // "Open large" fills the screen; windows and pop-outs are the owner's dashboard only
  const frame = { setTitle: t => { dlg.querySelector('#cv-t').textContent = t; }, get popped() { return dlg.classList.contains('large'); }, popOut: () => dlg.classList.add('large'), popIn: () => dlg.classList.remove('large') };
  if (!dlg.open) dlg.showModal();
  sheet.handle = mountViewer(sheet.root, { artifact: art, list, frame });
}
/** artifact.updated from the stream (already scrubbed and only theirs): the list and an open viewer follow. */
function artUpdated(a) {
  let redraw = false;
  for (const [rid, list] of S.arts) {
    const i = list.findIndex(x => x.id === a.id);
    const was = i >= 0 ? list[i] : null;
    if (was) list[i] = a; else if (a.runId === rid) list.unshift(a);
    const sig = x => x && [x.version, x.status, x.size, x.media?.thumb].join('|');
    if (rid === currentTask() && sig(was) !== sig(a)) redraw = true;
  }
  artifactChanged(a);
  if (redraw) renderTask();
}

function wireTask(box) {
  wireNeeds(box);
  wireCall(box);
  box.querySelector('[data-back]')?.addEventListener('click', () => { location.hash = ''; });
  box.querySelectorAll('[data-art]').forEach(b => b.addEventListener('click', e => { e.preventDefault(); openFile(currentTask(), b.dataset.art); }));
  box.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => { location.hash = `task=${b.dataset.open}`; }));
  box.querySelector('[data-stop]')?.addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try { S.runs.set(btn.dataset.stop, await api(`/runs/${encodeURIComponent(btn.dataset.stop)}/stop`, { method: 'POST' })); toast('Stopping it.'); }
    catch (err) { toast(err.message, 'warn'); btn.disabled = false; }
  });
  const reply = box.querySelector('[data-reply]');
  const fu = box.querySelector('#fu');
  const tray = reply ? trayFor(`fu-${reply.dataset.reply}`) : null;
  if (tray) tray.mount(box.querySelector('.followup'), box.querySelector('.followup [data-zone]'));
  const go = async () => {
    const text = fu.value.trim();
    if (tray.busy()) { toast('Still saving your files. Send again in a moment.', 'warn'); return; }
    const files = tray.ready();
    if (!text && !files.length) { toast('Write the follow-up first.', 'warn'); fu.focus(); return; }
    reply.disabled = true;
    try {
      const run = await api(`/runs/${encodeURIComponent(reply.dataset.reply)}/reply`, { method: 'POST', body: { text, files } });
      S.runs.set(run.id, run);
      delete drafts[`fu-${reply.dataset.reply}`];
      tray.clear();
      location.hash = `task=${run.id}`;
    } catch (e) { toast(e.message, 'warn'); reply.disabled = false; }
  };
  reply?.addEventListener('click', go);
  fu?.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); } });
  const feed = box.querySelector('#feed');
  if (feed) feed.scrollTop = feed.scrollHeight;
}

async function loadTask(rid) {
  try {
    const d = await api(`/runs/${encodeURIComponent(rid)}`);
    S.runs.set(rid, d.run);
    S.feeds.set(rid, d.events || []);
    for (const i of d.items || []) if (i.status === 'pending') S.inbox.set(i.id, i);
  } catch (e) { toast(e.message, 'warn'); location.hash = ''; return; }
  if (currentTask() === rid) renderTask();
  loadFiles(rid);
}

// ── views ──
const currentTask = () => (location.hash.match(/^#task=([\w-]+)/) || [])[1] || null;
let shownTask = null;

function renderTask() {
  const r = S.runs.get(currentTask());
  if (!r) return;
  keep(document.getElementById('main'), taskHTML(r), wireTask);
}

function renderAll() {
  renderChrome();
  const rid = currentTask();
  if (rid) {
    if (!S.runs.has(rid)) { location.hash = ''; return; }
    if (shownTask !== rid) { shownTask = rid; window.scrollTo(0, 0); keep(document.getElementById('main'), taskHTML(S.runs.get(rid)), wireTask); loadTask(rid); return; }
    return renderTask();
  }
  if (shownTask !== null || !document.getElementById('tasks-box')) {
    shownTask = null;
    document.getElementById('main').innerHTML = homeHTML();
  }
  renderNeeds(); renderAsk(); renderTasks();
}

function renderChrome() {
  const n = mineToAnswer().length;
  const needs = document.getElementById('needs');
  needs.hidden = !n;
  needs.classList.toggle('hot', n > 0);
  document.getElementById('needs-n').textContent = n;
  document.title = `${n ? `(${n}) ` : ''}${S.client ? `${S.client.name}’s agents` : 'Your agents'} · Orchy`;
}

// ── live ──
function onEvents() {
  const es = new EventSource(`${BASE}/events`);
  const on = (type, fn) => es.addEventListener(type, e => { try { fn(JSON.parse(e.data)); } catch (err) { console.error(err); } });
  const runChanged = ({ run }) => {
    S.runs.set(run.id, { ...S.runs.get(run.id), ...run });
    if (currentTask() === run.id) renderTask(); else if (!currentTask()) { renderTasks(); renderAsk(); }
    renderChrome();
  };
  on('run.started', runChanged);
  on('run.updated', runChanged);
  on('run.ended', d => { runChanged(d); if (currentTask() === d.run.id) loadFiles(d.run.id); });
  on('run.event', ({ runId, event }) => {
    if (!S.feeds.has(runId)) return;
    S.feeds.get(runId).push(event);
    if (currentTask() !== runId) return;
    if (event.kind === 'tick') return nextWord();
    const feed = document.getElementById('feed');
    if (!feed) return renderTask();
    const near = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    feed.querySelector('.placeholder')?.remove();
    feed.insertAdjacentHTML('beforeend', evRow(event));
    while (feed.children.length > FEED_MAX) feed.firstElementChild.remove();
    if (near) feed.scrollTop = feed.scrollHeight;
  });
  const itemChanged = ({ item }) => {
    if (item.status === 'pending') S.inbox.set(item.id, item); else S.inbox.delete(item.id);
    if (currentTask()) renderTask(); else { renderNeeds(); renderTasks(); }
    renderChrome();
  };
  on('inbox.created', itemChanged);
  on('inbox.answered', itemChanged);
  on('inbox.expired', itemChanged);
  on('artifact.updated', ({ artifact }) => artUpdated(artifact));
  on('refresh', () => load().catch(() => {}));
  on('revoked', () => { es.close(); location.reload(); });
  let dropped = false;
  es.onerror = () => { dropped = true; };
  es.onopen = () => { if (dropped) { dropped = false; load().catch(() => {}); } };
}

async function load() {
  const s = await api('/state');
  S.client = s.client;
  S.owner = String(s.owner?.name ?? s.owner ?? '').trim();
  S.agents = s.agents;
  S.maxLive = s.maxLive || 3;
  S.calls = !!s.calls;
  S.runs = new Map(s.runs.map(r => [r.id, r]));
  S.inbox = new Map(s.inbox.map(i => [i.id, i]));
  if (!agentOf(S.pick)) S.pick = S.agents[0]?.slug || null;
  document.getElementById('who').innerHTML = `<span class="co">${esc(s.client.company)} · </span>${esc(s.client.name)}`;
  document.getElementById('main').removeAttribute('aria-busy');
  shownTask = undefined; // redraw whichever view from scratch
  renderAll();
}

document.getElementById('mark').innerHTML = orchySVG('idle', 0, { label: 'Orchy' });
// a call starting or ending redraws the Call buttons
initCalls({ base: BASE, toast, changed: () => { if (currentTask()) renderTask(); else if (S.client) renderAsk(); } });
document.addEventListener('input', e => { if (e.target.dataset?.draft) drafts[e.target.dataset.draft] = e.target.value; });
document.getElementById('needs').addEventListener('click', () => {
  if (currentTask()) location.hash = '';
  setTimeout(() => document.getElementById('needs-box')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
});
window.addEventListener('hashchange', renderAll);
setInterval(() => document.querySelectorAll('[data-timer]').forEach(el => { el.textContent = dur(Date.now() - Date.parse(el.dataset.timer)); }), 1000);
load().then(onEvents).catch(e => {
  document.getElementById('main').innerHTML = `<div class="empty"><strong>Couldn’t load</strong>${esc(e.message)}</div>`;
});
