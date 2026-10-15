// Windows for runs, agents and building agents.
import { openWindow, getWindow } from './windows.mjs';
import { icon, agentSVG, createEl, hatch } from './pixel.mjs';
import { fileTray } from './attach.mjs';
import { startCall } from './call.mjs';
import { mountLeadHuddle } from './huddles.mjs';
import { openConnections } from './panels.mjs';
import { esc, api, md, wsName, wsClass, wsModels, modelChoices, modelIsFree, agentName, runName, nameRole, timeShort, dateTime, dur, stripHTML, voiceOf } from './util.mjs';

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
  const txt = e.summary || e.text || '';
  return `<div class="ev ${esc(e.kind)}">${icon(EV_ICON[e.kind] || 'term')}<span>${e.kind === 'text' ? md(txt) : esc(txt)}</span><time>${timeShort(e.t)}</time></div>`;
}
/** Where a follow-up picks up in the same window: what the owner asked. */
const followRow = run => `<div class="ev you">${icon('user')}<span><b>You:</b> ${esc(run.instruction)}</span><time>${timeShort(run.startedAt)}</time></div>`;

// ── Run window ──
export async function openRun(runId, { from } = {}) {
  if (getWindow(`run-${runId}`)) return getWindow(`run-${runId}`).restore();
  let data;
  try { data = await api(`/api/runs/${runId}`); } catch (e) { return ctx.toast(e.message, 'warn'); }
  const r = data.run;
  const body = createEl(`<div style="display:grid;gap:var(--s4)"></div>`);
  const w = openWindow({ id: `run-${runId}`, title: `${runName(r)} · run`, size: 'wide', body, from, dockLabel: runName(r) });
  w.events = data.events;
  w.earlier = []; // runs this window showed before the owner followed up in it: [{ run, events }]
  // a task folder's files (a client's task, a generalist's): what was attached and what the agent made
  w.files = [];
  w.loadFiles = () => { const cur = w.run || r; return cur.taskDir && api(`/api/runs/${cur.id}/files`).then(f => { if ((w.run || r).id === cur.id) { w.files = f; w.render(w.run || r); } }).catch(() => {}); };
  const tray = fileTray(ctx.toast); // files for a follow-up, kept across re-renders
  w.render = run => {
    w.run = run;
    const live = ['starting', 'working', 'waiting', 'stopping'].includes(run.status);
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
        ${w.files?.length ? `<dt>Files</dt><dd class="list">${w.files.map(f => `<div><a href="/api/runs/${encodeURIComponent(run.id)}/file?path=${encodeURIComponent(f.path)}" target="_blank" rel="noopener">${esc(f.path)}</a> <span class="hint">${f.uploaded ? 'attached' : 'made'}</span></div>`).join('')}</dd>` : ''}
        ${run.routing ? `<dt>Routed</dt><dd>${run.routing.source === 'schedule' ? 'on its schedule' : run.routing.source === 'heuristic' ? 'best guess (Jev was offline)' : `by Jev, ${Math.round((run.routing.confidence || 0) * 100)}% sure`}${run.routing.overridden ? ' · adjusted by you' : ''}</dd>` : ''}
        ${run.plan ? `<dt>Jev's plan</dt><dd>${planHTML(run.plan)}</dd>` : ''}
        ${run.parentRunId && !first ? `<dt>Follows</dt><dd><button class="linkish" data-run="${esc(run.parentRunId)}">earlier run</button></dd>` : ''}
        ${run.delegatedBy ? `<dt>Handed over by</dt><dd><button class="linkish" data-run="${esc(run.delegatedBy)}">${esc(run.delegatedByName || 'its head')}</button></dd>` : ''}
        ${run.subRuns?.length ? `<dt>Handed to</dt><dd>${run.subRuns.map((sid, i) => `<button class="linkish" data-run="${esc(sid)}">team run ${i + 1}</button>`).join(', ')}</dd>` : ''}
        ${run.createdAgents?.length ? `<dt>Agents</dt><dd>${run.createdAgents.map(a => `<button class="linkish" data-agent="${esc(a.slug)}" data-ws="${esc(run.workspace)}">${esc(a.slug)}</button>${a.isNew ? ' (new)' : ' (updated)'}`).join(', ')}</dd>` : ''}
      </dl>
      ${rep ? `<div class="field"><span class="label">Report to Orchy</span><div class="md">${md(rep.summary)}</div>
        ${rep.actions_taken?.length ? `<span class="label">Actions taken</span><div class="list">${rep.actions_taken.map(a => `<div>${esc(a)}</div>`).join('')}</div>` : ''}
        ${rep.outputs?.length ? `<span class="label">Outputs</span><div class="list">${rep.outputs.map(a => `<div class="md">${md(a)}</div>`).join('')}</div>` : ''}
        ${rep.follow_ups?.length ? `<span class="label">Follow-ups</span><div class="list">${rep.follow_ups.map(a => `<div>${esc(a)}</div>`).join('')}</div>` : ''}</div>` : ''}
      ${run.error ? `<pre class="cmd">${esc(run.error)}</pre>` : ''}
      <div class="field"><span class="label">What happened</span><div class="timeline" data-tl>${w.earlier.map((seg, i) => (i ? followRow(seg.run) : '') + seg.events.map(evRow).join('')).join('')}${w.earlier.length ? followRow(run) : ''}${w.events.map(evRow).join('') || '<div class="ev"><span></span><span>Starting up…</span></div>'}</div></div>
      ${live
        ? `<div class="btnrow end"><button class="btn" data-act="stop">${icon('stop')}Stop this run</button></div>`
        : `<div class="field" data-fu><label for="fu-${run.id}">Follow up with ${esc(runName(run))}</label><textarea class="textarea" id="fu-${run.id}" style="min-height:64px" placeholder="It remembers this conversation. Ask for changes, next steps…"></textarea>${tray.chips()}
           <div class="btnrow end">${callee ? `<button class="btn" type="button" data-act="call" data-call="${esc(callee.key)}" aria-pressed="false" title="Talk it through with ${esc(callee.name)} on a call">${icon('phone')}Call ${esc(callee.name)}</button>` : ''}${tray.button()}<button class="btn primary" data-act="reply">${icon('send')}Send follow-up</button></div></div>`}`;
    if (!live) tray.mount(body.querySelector('[data-fu]'), body.querySelector('[data-fu]'));
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
      ta.value = ''; tray.clear();
      // the follow-up carries on in this window: the earlier run stays above it
      w.earlier.push({ run, events: w.events });
      w.events = []; w.files = [];
      w.rekey(`run-${nr.id}`);
      w.render(nr);
      // steps it took before the window was refiled under the new run (later ones stream in as usual)
      try { const d = await api(`/api/runs/${nr.id}`); const last = d.events.at(-1)?.t || ''; w.events = [...d.events, ...w.events.filter(e => (e.t || '') > last)]; w.render(d.run); } catch {}
      w.body.querySelector('[data-tl]')?.lastElementChild?.scrollIntoView({ block: 'nearest' });
    });
    body.querySelector('[data-act="call"]')?.addEventListener('click', () => startCall(callee.key, callee.name, { runId: run.id }));
    body.querySelectorAll('[data-run]').forEach(b => b.addEventListener('click', () => openRun(b.dataset.run)));
    body.querySelectorAll('[data-agent]').forEach(b => b.addEventListener('click', () => openAgent(b.dataset.ws, b.dataset.agent)));
  };
  w.render(r);
  w.loadFiles();
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
      panel.innerHTML = `<div style="display:grid;gap:var(--s3)"><div class="field" data-zone><label for="task-${id}">What should ${esc(nm())} do?</label><textarea class="textarea" id="task-${id}" placeholder="Describe the task… (drop or paste files here too)" autofocus></textarea>${tray.chips()}</div>
        <div class="btnrow" style="justify-content:space-between"><div class="seg" role="group" aria-label="Model">${(() => { const ms = a.models || wsModels(a.workspace); const pick = ms.includes(a.model) ? a.model : ms[1] || ms[0]; return modelChoices(ms).map(m => `<button type="button" data-model="${esc(m)}" aria-pressed="${m === pick}" title="${esc(m)}">${esc(m.replace(/^gpt-/, ''))}</button>`).join(''); })()}</div>${(() => { const ms = a.models || wsModels(a.workspace); return modelIsFree(ms) ? `<input class="input" data-model-free type="text" spellcheck="false" autocomplete="off" placeholder="or a model id, e.g. provider/model" aria-label="Model id" style="min-width:14ch;flex:1;max-width:26ch">` : ''; })()}
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
      const typed = panel.querySelector('[data-model-free]')?.value.trim();
      const model = typed || panel.querySelector('[data-model][aria-pressed="true"]')?.dataset.model;
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
