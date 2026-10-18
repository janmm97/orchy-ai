// Windows for runs, agents and building agents.
import { openWindow, getWindow } from './windows.mjs';
import { icon, agentSVG, createEl, hatch } from './pixel.mjs';
import { fileTray } from './attach.mjs';
import { startCall } from './call.mjs';
import { mountLeadHuddle, openNewHuddle } from './huddles.mjs';
import { openConnections, openSettings } from './panels.mjs';
import { openViewer, embedOf, kindIcon, fsize } from './viewer.mjs';
import { esc, api, md, wsName, wsClass, wsModels, wsPlan, wsUsesModelDropdown, dropdownModels, modelChoices, modelIsFree, agentName, runName, nameRole, timeShort, dateTime, dur, stripHTML, voiceOf, runResult } from './util.mjs';

let ctx = null; // { toast }
export function initSheets(c) { ctx = c; }

export const spriteFor = (ws, slug) => agentSVG(slug === 'agent-builder' ? 'agent-builder' : `${ws}/${slug || 'general'}`, ws, { chief: slug === 'agent-builder', label: slug || 'generalist' });

const EV_ICON = { system: 'bolt', text: 'chat', tool: 'term', tool_error: 'bang', error: 'bang', note: 'doc', report: 'check', denied: 'x', plan: 'spark' };

/** The One actions Jev picked before the agent started (actionplan.mjs), with how sure it was. */
function planHTML(plan) {
  if (!plan.actions?.length) return esc(plan.note || 'no app actions needed');
  return `${plan.actions.map(a => `${esc(a.title)} <span class="hint">${esc(a.platform || '')}${a.platform ? ' · ' : ''}${Math.round((a.p || 0) * 100)}%</span>`).join(', ')}<span class="hint"> · ${(plan.ms / 1000).toFixed(1)}s</span>`;
}

function evRow(e) {
  if (e.kind === 'tool_done') return ''; // closes a step; no row of its own
  const txt = e.summary || e.text || '';
  return `<div class="ev ${esc(e.kind)}">${icon(EV_ICON[e.kind] || 'term')}<span>${e.kind === 'text' ? md(txt) : esc(txt)}</span><time>${timeShort(e.t)}</time></div>`;
}
/** One file in the run window's list: its thumb (or kind icon), name, place, and state. */
const SMALL_IMG = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif']);
function fileRow(f, i) {
  const m = f.media || {}, id = encodeURIComponent(f.id);
  const th = m.thumb ? `<img src="/api/artifacts/${id}/media/thumb?v=${f.version}" alt="" loading="lazy">`
    : f.kind === 'image' && SMALL_IMG.has(f.ext) && f.size < 2 * 1024 * 1024 ? `<img src="/api/artifacts/${id}/raw?v=${f.version}" alt="" loading="lazy">` : icon(kindIcon(f.kind));
  const attached = /(^|\/)Tasks\/[^/]+\/files\//.test(f.rel);
  const tag = [attached ? 'attached' : f.status === 'final' ? '' : f.status === 'failed' ? 'run failed' : f.status, f.version > 1 ? `v${f.version}` : ''].filter(Boolean).join(' · ');
  // where it sits, short: inside a task folder only the sub-folder shows (the full path is the tooltip)
  const dir = f.rel.split('/').slice(0, -1).join('/').replace(/^(\.clients\/[^/]+\/)?Tasks\/[^/]+\/?/, '');
  const dur = m.durationSec ? ` · ${Math.floor(m.durationSec / 60)}:${String(Math.round(m.durationSec % 60)).padStart(2, '0')}` : '';
  return `<button class="vfile" type="button" data-file="${i}" title="${esc(f.rel)}"><span class="th">${th}</span><span class="nm"><b>${esc(f.name)}</b><span>${esc([fsize(f.size) + dur, dir].filter(Boolean).join(' · '))}</span></span><span class="tag">${esc(tag)}</span></button>`;
}
/** artifact.created / artifact.updated: an open run window that made (or holds) the file refreshes its list. */
const fileTimers = new Map();
export function runArtifact(a) {
  for (const rid of a?.runIds || []) {
    const w = getWindow(`run-${rid}`);
    if (!w?.loadFiles) continue;
    clearTimeout(fileTimers.get(rid));
    fileTimers.set(rid, setTimeout(() => { fileTimers.delete(rid); w.loadFiles(); }, 400));
  }
}

// ── Orchy's check of a finished run (server: validate.mjs) and what went wrong (recover.mjs) ──
// Shared by the run window, the Live view's Work column and Orchy's chat cards. The check only flags: "Ask it to fix"
// prefills a follow-up the owner still sends. Recovery buttons are the owner's call, so the first one wears decision yellow.
const VERDICT = { ok: 'Orchy checked: looks right', check: 'Orchy checked: have a look', failed: 'Orchy checked: it doesn’t hold up' };
export function validationHTML(run, { fix = true } = {}) {
  const v = run?.validation;
  if (!v?.verdict) return run?.activity?.state === 'validating' ? `<div class="field vcheck is-busy"><span class="label">${icon('eye')}<span class="blink">Orchy is checking its report…</span></span></div>` : '';
  const off = (v.checks || []).filter(c => !c.ok).length;
  return `<div class="field vcheck is-${esc(v.verdict)}"><span class="label">${icon(v.verdict === 'ok' ? 'check' : 'bang')}${esc(VERDICT[v.verdict] || v.verdict)}</span>
    ${v.checks?.length ? `<div class="vlist">${v.checks.map(c => `<div class="${c.ok ? '' : 'off'}">${icon(c.ok ? 'check' : 'bang')}<span><b>${esc(c.name)}</b>${c.note ? ` <span class="hint">${esc(c.note)}</span>` : ''}</span></div>`).join('')}</div>` : ''}
    ${off && fix && run.id ? `<div class="btnrow"><button class="btn sm" data-fix-ask="${esc(run.id)}">${icon('edit')}Ask it to fix</button><span class="hint">Flags only: nothing was re-run or sent again.</span></div>` : ''}</div>`;
}
/** Orchy's fix-it follow-up text, from the checks that didn't pass. */
export function fixText(run) {
  const off = (run?.validation?.checks || []).filter(c => !c.ok).map(c => (c.note ? `${c.name}: ${c.note}` : c.name)).join('; ');
  return off ? `Orchy checked your report and found: ${off}. Fix only that (don't redo or resend anything that already went out), then report again.` : '';
}
const REC_ICON = { resume: 'play', restart: 'refresh', stop: 'stop', leave: 'x', login: 'user', followup: 'send', huddle: 'chat' };
const REC_STATE = { scheduled: 'Retrying on its own', asking: 'Needs you', moving: 'Moving again', answered: 'Handled', retried: 'Retried' };
/** The card's buttons (none once it's handled). */
export function recoverButtons(run) {
  const r = run?.recovery;
  if (!r || !['asking', 'scheduled', 'moving'].includes(r.state)) {
    if (r?.answered) return `<span class="hint">${esc({ resume: 'Resumed', restart: 'Started over', stop: 'Stopped', leave: 'Left as is' }[r.answered.action] || 'Handled')}${r.answered.runId ? ` · <button class="linkish" data-run="${esc(r.answered.runId)}">the new run</button>` : ''}</span>`;
    if (r?.state === 'retried' && r.retriedBy) return `<span class="hint">Retried · <button class="linkish" data-run="${esc(r.retriedBy)}">the new run</button></span>`;
    return '';
  }
  const moving = r.state === 'moving' ? `<span class="hint">It recorded a step again.</span>` : '';
  return moving + (r.options || []).map((o, i) => `<button class="btn sm${i === 0 && r.state === 'asking' ? ' decide' : ''}" data-recover="${esc(run.id)}" data-recover-act="${esc(o.action)}">${icon(REC_ICON[o.action] || 'play')}${esc(o.label)}</button>`).join('');
}
export function recoveryHTML(run) {
  const r = run?.recovery;
  if (!r?.cls || ['none', 'head'].includes(r.state) || r.cls === 'bad_output') return '';
  const due = r.state === 'scheduled' && r.dueAt ? ` · try ${r.attempt || 1} at ${timeShort(r.dueAt)}` : '';
  return `<div class="field vrec is-${esc(r.state || '')}"><span class="label">${r.state === 'asking' ? `<span class="plate decide">${esc(REC_STATE.asking)}</span>` : esc(REC_STATE[r.state] || 'What went wrong')} · ${esc(r.label || r.cls)}${due}</span>
    ${r.gate ? `<span class="hint">Not retried on its own: ${esc(r.gate)}.</span>` : ''}${r.error ? `<span class="hint">${esc(r.error)}</span>` : ''}
    <div class="btnrow">${recoverButtons(run)}</div></div>`;
}
/** A recovery button: Log in / Follow up / Huddle open windows; the rest go to the server (recover.mjs#act). */
export async function recoverAct(runId, action, { from, run, toast = ctx.toast } = {}) {
  run ||= (await api(`/api/runs/${runId}`).catch(() => null))?.run;
  if (action === 'login') return openSettings({ from });
  if (action === 'followup') return openRun(runId, { from, prefill: '' });
  if (action === 'huddle') {
    const w = openNewHuddle(run.workspace, { from, agents: [run.isBuilder ? 'agent-builder' : run.agentSlug].filter(Boolean) });
    const ta = w?.body?.querySelector('textarea');
    if (ta && !ta.value) ta.value = `Help ${runName(run)} get past this: ${String(run.report?.summary || run.error || '').slice(0, 600)}`;
    return w;
  }
  if (action === 'stop' && !confirm(`Stop ${runName(run)}?`)) return;
  try {
    const r = await api(`/api/runs/${runId}/recover`, { method: 'POST', body: { action } });
    toast({ resume: 'Resumed: it picks up its conversation.', restart: 'Started over as a fresh run.', stop: 'Stopping it.', leave: 'Left as is.' }[action] || 'Done.');
    return r;
  } catch (e) { toast(e.message, 'warn'); }
}

/** Where a follow-up picks up in the same window: what the owner asked. */
const followRow = run => `<div class="ev you">${icon('user')}<span><b>You:</b> ${esc(run.instruction)}</span><time>${timeShort(run.startedAt)}</time></div>`;

// ── Run window ──
export async function openRun(runId, { from, prefill } = {}) {
  const open = getWindow(`run-${runId}`);
  if (open) { const r = open.restore(); if (prefill !== undefined) open.prefill?.(prefill); return r; }
  let data;
  try { data = await api(`/api/runs/${runId}`); } catch (e) { return ctx.toast(e.message, 'warn'); }
  const r = data.run;
  const body = createEl(`<div style="display:grid;gap:var(--s4)"></div>`);
  const w = openWindow({ id: `run-${runId}`, title: `${runName(r)} · run`, size: 'wide', body, from, dockLabel: runName(r) });
  w.events = data.events;
  w.earlier = []; // runs this window showed before the owner followed up in it: [{ run, events }]
  // what the run made or touched (the artifact registry: its task folder, the files its tools wrote, the files its
  // report names, what changed while it ran) and the links its report gave; each opens in the viewer
  w.files = [];
  w.links = [];
  w.loadFiles = () => {
    const cur = w.run || r;
    return api(`/api/artifacts?run=${encodeURIComponent(cur.id)}`).then(d => {
      if ((w.run || r).id !== cur.id) return;
      const same = JSON.stringify(d.artifacts.map(a => [a.id, a.version, a.status, a.media?.thumb])) === JSON.stringify(w.files.map(a => [a.id, a.version, a.status, a.media?.thumb])) && (d.links || []).join() === w.links.join();
      w.files = d.artifacts; w.links = d.links || [];
      if (!same) w.render(w.run || r);
    }).catch(() => {});
  };
  const tray = fileTray(ctx.toast); // files for a follow-up, kept across re-renders
  w.render = run => {
    w.run = run;
    const live = ['queued', 'paused-limit', 'starting', 'working', 'waiting', 'stopping'].includes(run.status);
    const queued = run.status === 'queued' || run.status === 'paused-limit';
    const rep = run.report;
    const first = w.earlier[0]?.run;
    const callee = voiceOf(run.workspace, run.isBuilder ? 'agent-builder' : run.agentSlug);
    body.innerHTML = `
      <div class="from"><div class="sprite">${spriteFor(run.workspace, run.isBuilder ? 'agent-builder' : run.agentSlug)}</div>
        <div class="t"><b>${esc(runName(run))}</b><span><span class="plate ${wsClass(run.workspace)}">${esc(wsName(run.workspace))}</span> · ${esc(run.model)} · started ${dateTime(run.startedAt)}</span></div></div>
      <div class="btnrow" style="justify-content:space-between"><span class="btnrow">${stripHTML(run)}</span><span class="timer" ${live ? `data-start="${esc(run.startedAt)}"` : ''}>${dur((run.endedAt ? Date.parse(run.endedAt) : Date.now()) - Date.parse(run.startedAt))}</span></div>
      <dl class="kv">${run.clientName ? `<dt>For</dt><dd><span class="plate">${esc(run.clientName)}</span> ${run.ownerReply ? 'your follow-up on their task (they see it, labelled with your name)' : 'started from their client page'}</dd>` : ''}
        <dt>Task</dt><dd>${esc((first || run).instruction)}</dd>
        ${first ? `<dt>Follow-up</dt><dd>${esc(run.instruction)}</dd>` : ''}
        ${w.files?.length ? `<dt>Files</dt><dd><div class="vfiles">${w.files.map(fileRow).join('')}</div></dd>` : ''}
        ${w.links?.length ? `<dt>Links</dt><dd class="list">${w.links.map(u => `<div><a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>${embedOf(u) ? ` <button class="btn sm" data-embed="${esc(u)}">${icon('play')}Play here</button>` : ''}</div>`).join('')}</dd>` : ''}
        ${run.routing ? `<dt>Routed</dt><dd>${run.routing.source === 'schedule' ? 'on its schedule' : run.routing.source === 'heuristic' ? 'best guess (Jev was offline)' : `by Jev, ${Math.round((run.routing.confidence || 0) * 100)}% sure`}${run.routing.overridden ? ' · adjusted by you' : ''}</dd>` : ''}
        ${run.plan ? `<dt>Jev's plan</dt><dd>${planHTML(run.plan)}</dd>` : ''}
        ${run.parentRunId && !first ? `<dt>Follows</dt><dd><button class="linkish" data-run="${esc(run.parentRunId)}">earlier run</button></dd>` : ''}
        ${run.delegatedBy ? `<dt>Handed over by</dt><dd><button class="linkish" data-run="${esc(run.delegatedBy)}">${esc(run.delegatedByName || 'its head')}</button></dd>` : ''}
        ${run.subRuns?.length ? `<dt>Handed to</dt><dd>${run.subRuns.map((sid, i) => `<button class="linkish" data-run="${esc(sid)}">team run ${i + 1}</button>`).join(', ')}</dd>` : ''}
        ${run.createdAgents?.length ? `<dt>Agents</dt><dd>${run.createdAgents.map(a => `<button class="linkish" data-agent="${esc(a.slug)}" data-ws="${esc(run.workspace)}">${esc(a.slug)}</button>${a.isNew ? ' (new)' : ' (updated)'}`).join(', ')}</dd>` : ''}
      </dl>
      ${runResult(run) ? `<div class="field"><span class="label">${rep?.result ? 'Result' : 'Its last message'}</span><div class="result md">${md(runResult(run))}</div></div>` : ''}
      ${rep ? `<div class="field"><span class="label">Report to Orchy</span><div class="md">${md(rep.summary)}</div>
        ${rep.actions_taken?.length ? `<span class="label">Actions taken</span><div class="list">${rep.actions_taken.map(a => `<div>${esc(a)}</div>`).join('')}</div>` : ''}
        ${rep.outputs?.length ? `<span class="label">Outputs</span><div class="list">${rep.outputs.map(a => `<div class="md">${md(a)}</div>`).join('')}</div>` : ''}
        ${rep.follow_ups?.length ? `<span class="label">Follow-ups</span><div class="list">${rep.follow_ups.map(a => `<div>${esc(a)}</div>`).join('')}</div>` : ''}</div>` : ''}
      ${run.error ? `<pre class="cmd">${esc(run.error)}</pre>` : ''}
      ${live ? '' : validationHTML(run)}${recoveryHTML(run)}
      <div class="field"><span class="label">What happened</span><div class="timeline" data-tl>${w.earlier.map((seg, i) => (i ? followRow(seg.run) : '') + seg.events.map(evRow).join('')).join('')}${w.earlier.length ? followRow(run) : ''}${w.events.map(evRow).join('') || '<div class="ev"><span></span><span>Starting up…</span></div>'}</div></div>
      ${live
        ? `<div class="btnrow end">${queued ? `<button class="btn primary" data-act="run-now">${icon('play')}Run now</button>` : ''}<button class="btn" data-act="stop">${icon('stop')}Stop this run</button></div>`
        : `<div class="field" data-fu><label for="fu-${run.id}">Follow up with ${esc(runName(run))}</label><textarea class="textarea" id="fu-${run.id}" style="min-height:64px" placeholder="It remembers this conversation. Ask for changes, next steps…"></textarea>${tray.chips()}
           <div class="btnrow end">${callee ? `<button class="btn" type="button" data-act="call" data-call="${esc(callee.key)}" aria-pressed="false" title="Talk it through with ${esc(callee.name)} on a call">${icon('phone')}Call ${esc(callee.name)}</button>` : ''}${tray.button()}<button class="btn primary" data-act="reply">${icon('send')}Send follow-up</button></div></div>`}`;
    if (!live) tray.mount(body.querySelector('[data-fu]'), body.querySelector('[data-fu]'));
    // what the owner is typing survives the redraws (files arriving, Orchy's check landing)
    const fu = body.querySelector('[data-fu] textarea');
    if (fu) { fu.value = w.draft || ''; fu.addEventListener('input', () => { w.draft = fu.value; }); }
    body.querySelectorAll('[data-fix-ask]').forEach(b => b.addEventListener('click', () => w.prefill(fixText(run))));
    body.querySelectorAll('[data-recover]').forEach(b => b.addEventListener('click', () => recoverAct(run.id, b.dataset.recoverAct, { from: b, run })));
    body.querySelector('[data-act="run-now"]')?.addEventListener('click', async () => { try { await api(`/api/runs/${run.id}/run-now`, { method: 'POST' }); } catch (e) { ctx.toast(e.message, 'warn'); } });
    body.querySelector('[data-act="stop"]')?.addEventListener('click', async () => { try { await api(`/api/runs/${run.id}/stop`, { method: 'POST' }); } catch (e) { ctx.toast(e.message, 'warn'); } });
    body.querySelector('[data-act="reply"]')?.addEventListener('click', async e => {
      const ta = body.querySelector('textarea');
      if (tray.busy()) return ctx.toast('Still saving your files. Send again in a moment.');
      const files = tray.ready();
      if (!ta.value.trim() && !files.length) return ta.focus();
      const btn = e.currentTarget;
      btn.disabled = true;
      let nr;
      try { nr = await api(`/api/runs/${run.id}/reply`, { method: 'POST', body: { text: ta.value.trim(), files } }); }
      catch (err) { ctx.toast(err.message, 'warn'); btn.disabled = false; return; }
      ta.value = ''; w.draft = ''; tray.clear();
      // the follow-up carries on in this window: the earlier run stays above it
      w.earlier.push({ run, events: w.events });
      w.events = []; w.files = []; w.links = [];
      w.rekey(`run-${nr.id}`);
      w.render(nr);
      w.loadFiles();
      // steps it took before the window was refiled under the new run (later ones stream in as usual)
      try { const d = await api(`/api/runs/${nr.id}`); const last = d.events.at(-1)?.t || ''; w.events = [...d.events, ...w.events.filter(e => (e.t || '') > last)]; w.render(d.run); } catch {}
      w.body.querySelector('[data-tl]')?.lastElementChild?.scrollIntoView({ block: 'nearest' });
    });
    body.querySelector('[data-act="call"]')?.addEventListener('click', () => startCall(callee.key, callee.name, { runId: run.id }));
    body.querySelectorAll('[data-run]').forEach(b => b.addEventListener('click', () => openRun(b.dataset.run)));
    body.querySelectorAll('[data-agent]').forEach(b => b.addEventListener('click', () => openAgent(b.dataset.ws, b.dataset.agent)));
    body.querySelectorAll('[data-file]').forEach(b => b.addEventListener('click', () => openViewer({ artifact: w.files[Number(b.dataset.file)], list: w.files, from: b })));
    body.querySelectorAll('[data-embed]').forEach(b => b.addEventListener('click', () => openViewer({ embed: b.dataset.embed, list: w.links.map(embedOf).filter(Boolean), from: b })));
  };
  /** Put text in the follow-up box (Ask it to fix, Follow up on a card) and bring it into view; the owner still sends it. */
  w.prefill = text => {
    if (text) w.draft = text;
    const ta = body.querySelector('[data-fu] textarea');
    if (!ta) return;
    ta.value = w.draft || '';
    ta.scrollIntoView({ block: 'nearest' });
    ta.focus();
  };
  w.render(r);
  w.loadFiles();
  if (prefill !== undefined) w.prefill(prefill);
  return w;
}

/** Live updates for an open run window. */
export function runEvent(runId, event) {
  const w = getWindow(`run-${runId}`);
  if (!w) return;
  w.events.push(event);
  const tl = w.body.querySelector('[data-tl]');
  if (tl) { tl.insertAdjacentHTML('beforeend', evRow(event)); }
}
export function runUpdated(run) {
  const w = getWindow(`run-${run.id}`);
  if (w?.render) w.render(run);
  if (w && !/starting|working|waiting|stopping/.test(run.status || '')) w.loadFiles?.();
}

// ── Agent sheet ──
export async function openAgent(ws, slug, { from, isNew } = {}) {
  const id = `agent-${ws}-${slug}`;
  if (getWindow(id)) return getWindow(id).restore();
  let a;
  try { a = await api(`/api/agents/${ws}/${slug}`); } catch (e) { return ctx.toast(e.message, 'warn'); }
  const body = createEl(`<div style="display:grid;gap:var(--s4)"></div>`);
  const nm = () => agentName(a.workspace, a.slug, a.displayName); // the name the owner calls it by
  const w = openWindow({ id, title: nameRole(nm(), a.displayName), size: 'wide', body, from, dockLabel: nm() });
  let tab = 'overview';
  const tray = fileTray(ctx.toast); // files for Give a task, kept across tab switches
  const render = () => {
    const accessBadge = c => `<span class="chip">${esc(c.access || 'full')}</span>`;
    body.innerHTML = `
      <div class="sheet-head"><div class="sprite" data-sprite>${spriteFor(a.workspace, a.slug)}</div>
        <div><h3 class="px2">${esc(nm())}</h3><p><strong>${esc(a.role || (a.isBuilder ? 'Chief of AI Agents' : 'Agent'))}</strong> · ${esc(wsName(a.workspace))} · ${a.engine ? `${esc(a.engineLabel)} · ` : ''}model ${esc(a.model)}${a.effort ? ` (${esc(a.effort)})` : ''} · v${esc(a.version)}</p><p class="muted">${esc(a.identity || '')}</p></div></div>
      <div class="tabs" role="tablist"><button role="tab" data-tab="overview" aria-selected="${tab === 'overview'}">Overview</button><button role="tab" data-tab="md" aria-selected="${tab === 'md'}">Markdown</button><button role="tab" data-tab="task" aria-selected="${tab === 'task'}">Give a task</button>${a.executive ? `<button role="tab" data-tab="huddle" aria-selected="${tab === 'huddle'}" title="${esc(nm())} is C-suite: start a huddle with a colleague">Huddle</button>` : ''}</div>
      <div data-panel></div>`;
    const panel = body.querySelector('[data-panel]');
    if (tab === 'overview') {
      panel.innerHTML = `<div style="display:grid;gap:var(--s4)">
        <p style="margin:0">${esc(a.description)}</p>
        ${a.scheduleText ? `<div class="ctx">${icon('clock')} <b>Runs on its own:</b> ${esc(a.scheduleText)}${a.scheduleTask ? ` · “${esc(a.scheduleTask)}”` : ''}</div>` : ''}
        ${a.error ? `<pre class="cmd">${esc(a.error)}</pre>` : ''}
        <div class="field"><span class="label">Connections (${a.connections.length})</span>
          ${a.connections.length ? `<div class="list">${a.connections.map(c => `<div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><span><b>${esc(c.name || c.platform || '')}</b> <span class="data muted">${esc(c.platform || '')}</span></span>${accessBadge(c)}</div>`).join('')}</div>` : `<div class="empty">${a.isBuilder ? 'The Chief can see every connection in this workspace.' : 'No One connections. This agent works with files and the web only.'}</div>`}
          ${a.mcpServers.length ? `<span class="label">External (MCP)</span><div class="list">${a.mcpServers.map(s => `<div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><b>${esc(s)}</b><button class="btn sm" data-mcp="${esc(s)}" title="Edit ${esc(s)} in Connections: command, URL, keys, on/off">${icon('edit')}Edit</button></div>`).join('')}</div>` : ''}
        </div>
        ${a.limitations.length ? `<div class="field"><span class="label">Limitations</span><div class="list">${a.limitations.map(l => `<div class="limit">${icon('x')}<span>${esc(l)}</span></div>`).join('')}</div></div>` : ''}
        <div class="btnrow" style="justify-content:space-between"><span class="hint">Created ${esc(a.created)}${a.createdBy ? ` by ${esc(a.createdBy)}` : ''} · ${esc(a.path)}</span>
          ${a.isBuilder ? '' : `<button class="btn sm" data-act="retire">${icon('trash')}Retire</button>`}</div></div>`;
    } else if (tab === 'md') {
      panel.innerHTML = `<div style="display:grid;gap:var(--s3)"><textarea class="textarea mdedit" spellcheck="false" aria-label="Agent Markdown">${esc(a.markdown)}</textarea>
        <div class="btnrow" style="justify-content:space-between"><span class="hint">This file is the agent. Edits apply to its next run.</span><button class="btn primary" data-act="save">${icon('check')}Save</button></div></div>`;
    } else if (tab === 'huddle') {
      panel.innerHTML = `<div style="display:grid;gap:var(--s4)"><p class="hint" style="margin:0">${esc(nm())} opens a huddle with a colleague: they talk it through, turn by turn, and write up what they agree. They only talk; nothing changes until you approve the agreement. ${esc(nm())} can also start huddles from tasks you give.</p><div data-hform style="display:grid;gap:var(--s4)"></div></div>`;
      mountLeadHuddle(panel.querySelector('[data-hform]'), { wsId: a.workspace, slug: a.slug, onStarted: () => w.close() });
    } else {
      const ms = (a.models && !a.models.every(m => m === 'default')) ? a.models : wsModels(a.workspace);
      const choices = modelChoices(ms);
      const pick = choices.includes(a.model) ? a.model : choices[1] || choices[0];
      const useDropdown = wsUsesModelDropdown(a.workspace, a);
      const plan = wsPlan(a.workspace);
      panel.innerHTML = `<div style="display:grid;gap:var(--s3)"><div class="field" data-zone><label for="task-${id}">What should ${esc(nm())} do?</label><textarea class="textarea" id="task-${id}" placeholder="Describe the task… (drop or paste files here too)" autofocus></textarea>${tray.chips()}</div>
        <div class="btnrow" style="justify-content:space-between">${useDropdown
          ? `<div class="btnrow"><span class="label">Model</span><select class="select" data-model-select style="width:auto;min-height:32px;padding:2px 8px" aria-label="Model">${dropdownModels(choices, a.model).map(m => `<option value="${esc(m)}" ${m === (a.model || 'default') ? 'selected' : ''}>${esc(m === 'default' ? 'Default (tier automatic)' : m)}</option>`).join('')}</select>${plan ? `<span class="chip" title="Detected account plan / tier">${esc(plan)}</span>` : ''}</div>`
          : `<div class="seg" role="group" aria-label="Model">${choices.map(m => `<button type="button" data-model="${esc(m)}" aria-pressed="${m === pick}" title="${esc(m)}">${esc(m.replace(/^gpt-/, ''))}</button>`).join('')}</div>${modelIsFree(ms) ? `<input class="input" data-model-free type="text" spellcheck="false" autocomplete="off" placeholder="or a model id, e.g. provider/model" aria-label="Model id" style="min-width:14ch;flex:1;max-width:26ch">` : ''}`}
        <span class="btnrow">${tray.button()}<button class="btn primary" data-act="run">${icon('play')}Run it</button></span></div></div>`;
      tray.mount(panel, panel.querySelector('[data-zone]'));
      panel.querySelectorAll('[data-model]').forEach(b => b.addEventListener('click', () => panel.querySelectorAll('[data-model]').forEach(x => x.setAttribute('aria-pressed', String(x === b)))));
    }
    body.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { tab = b.dataset.tab; render(); }));
    panel.querySelector('[data-act="save"]')?.addEventListener('click', async () => {
      try { a = await api(`/api/agents/${ws}/${slug}`, { method: 'PUT', body: { markdown: panel.querySelector('textarea').value } }); ctx.toast('Saved. The agent uses it from its next run.'); w.setTitle(nameRole(nm(), a.displayName)); tab = 'overview'; render(); }
      catch (e) { ctx.toast(e.message, 'warn'); }
    });
    panel.querySelectorAll('[data-mcp]').forEach(b => b.addEventListener('click', () => openConnections(a.workspace, { from: b, edit: b.dataset.mcp })));
    panel.querySelector('[data-act="retire"]')?.addEventListener('click', async e => {
      const b = e.currentTarget;
      if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.innerHTML = `${icon('bang')}Click again to retire`; b.classList.add('decide'); return; }
      try { await api(`/api/agents/${ws}/${slug}`, { method: 'DELETE' }); ctx.toast(`${nameRole(nm(), a.displayName)} retired (archived in ${wsName(ws)}/.jos/retired).`); w.close(); }
      catch (err) { ctx.toast(err.message, 'warn'); }
    });
    panel.querySelector('[data-act="run"]')?.addEventListener('click', async e => {
      const ta = panel.querySelector('textarea');
      if (tray.busy()) return ctx.toast('Still saving your files. Run it again in a moment.');
      const files = tray.ready();
      if (!ta.value.trim() && !files.length) return ta.focus();
      const selected = panel.querySelector('[data-model-select]')?.value;
      const typed = panel.querySelector('[data-model-free]')?.value.trim();
      const model = selected || typed || panel.querySelector('[data-model][aria-pressed="true"]')?.dataset.model;
      const btn = e.currentTarget;
      btn.disabled = true;
      try { const run = await api(`/api/agents/${ws}/${slug}/run`, { method: 'POST', body: { instruction: ta.value.trim(), model, files } }); tray.clear(); openRun(run.id); w.close(); }
      catch (err) { ctx.toast(err.message, 'warn'); btn.disabled = false; }
    });
  };
  render();
  if (isNew) hatch(body.querySelector('[data-sprite] svg'));
  return w;
}

// ── Build window (hand an instruction to the Chief) ──
const BUILD_EXAMPLES = {
  any: ['Inbox triage: label new emails by urgency every morning and draft replies to routine ones', 'Weekly digest: summarise this week’s meetings and emails into a short report', 'Research assistant: find and summarise sources on a topic, with links'],
};

export function openBuild(ws, { from, prompt } = {}) {
  const id = `build-${ws}`;
  if (getWindow(id)) return getWindow(id).restore();
  const body = createEl(`<div style="display:grid;gap:var(--s4)">
    <div class="from"><div class="sprite">${spriteFor(ws, 'agent-builder')}</div><div class="t"><b>AI Agent Builder</b><span>Chief of AI Agents · ${esc(wsName(ws))}</span></div></div>
    <div class="field"><label for="b-${ws}">What should the new agent do?</label>
      <textarea class="textarea" id="b-${ws}" placeholder="Describe the job: what triggers it, what it produces, who sees it…" autofocus></textarea>
      <span class="hint">The Chief writes the agent as a Markdown file (name, role, identity, connections, limits). If it isn't sure which connections to use, it'll pop up and ask you.</span></div>
    <div class="examples">${BUILD_EXAMPLES.any.map(x => `<button type="button">${esc(x)}</button>`).join('')}</div>
    <div class="btnrow end"><button class="btn primary" data-act="build">${icon('spark')}Hand it to the Chief</button></div>
  </div>`);
  const w = openWindow({ id, title: `Build an agent · ${wsName(ws)}`, size: 'wide', body, from });
  const ta = body.querySelector('textarea');
  if (prompt) ta.value = prompt;
  body.querySelectorAll('.examples button').forEach(b => b.addEventListener('click', () => { ta.value = b.textContent; ta.focus(); }));
  body.querySelector('[data-act="build"]').addEventListener('click', async e => {
    if (!ta.value.trim()) return ta.focus();
    const btn = e.currentTarget;
    btn.disabled = true;
    try { const run = await api(`/api/agents/${ws}/build`, { method: 'POST', body: { instruction: ta.value.trim() } }); w.close(); openRun(run.id); }
    catch (err) { ctx.toast(err.message, 'warn'); btn.disabled = false; }
  });
  return w;
}
