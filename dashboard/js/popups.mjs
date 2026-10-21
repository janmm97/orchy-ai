// Decision windows: everything that needs the owner pops up here.
//   question    → "From: <agent name>"  (agent is unsure; the owner replies)
//   connections → "A message from AI Agent Builder" (toggle which connections the new agent gets)
//   approval    → "From: <agent name> · needs your OK" (outward/destructive action)
import { openWindow as rawOpen, getWindow, closeWindow, decisionVisible } from './windows.mjs';
const openWindow = o => rawOpen({ ...o, queued: decisionVisible() });
import { icon, agentSVG, createEl } from './pixel.mjs';
import { esc, api, wsName, itemName, nameRole, timeShort, platformName } from './util.mjs';

let ctx = null; // { toast(msg), openRun(id), settings() }
export function initPopups(c) { ctx = c; }

function fromBlock(item, label) {
  const slug = item.agent?.slug || 'general';
  const chief = item.kind === 'connections' || slug === 'agent-builder';
  return `<div class="from">
    <div class="sprite">${agentSVG(chief ? 'agent-builder' : `${item.workspace}/${slug}`, item.workspace, { chief, label: itemName(item) })}</div>
    <div class="t"><b>${esc(label)}</b><span>${esc(wsName(item.workspace))} · ${timeShort(item.createdAt)} · <button class="linkish" data-run="${esc(item.runId)}">view run</button></span></div>
  </div>`;
}

export function openItem(item, { from } = {}) {
  if (!item || item.status !== 'pending') return;
  if (getWindow(item.id)) return getWindow(item.id).restore();
  if (item.kind === 'question') return openQuestion(item, from);
  if (item.kind === 'approval') return openApproval(item, from);
  if (item.kind === 'connections') return openConnections(item, from);
}

export function closeItem(itemId) { closeWindow(itemId); }

function wireRunLinks(body) {
  body.querySelectorAll('[data-run]').forEach(b => b.addEventListener('click', () => ctx.openRun(b.dataset.run)));
}

async function submit(item, payload, w, btn) {
  btn && (btn.disabled = true);
  try {
    await api(`/api/inbox/${item.id}/answer`, { method: 'POST', body: payload });
    w.close();
  } catch (e) {
    btn && (btn.disabled = false);
    ctx.toast(e.status === 409 || e.status === 404 ? 'That one was already handled.' : e.message, 'warn');
    if (e.status === 409 || e.status === 404) w.close();
  }
}

function openQuestion(item, from) {
  const name = itemName(item);
  const body = createEl(`<div style="display:grid;gap:var(--s4)">
    ${fromBlock(item, name)}
    <p class="ask">${esc(item.message)}</p>
    ${item.context ? `<div class="ctx">${esc(item.context)}</div>` : ''}
    ${item.options?.length ? `<div class="opts" role="group" aria-label="Suggested answers">${item.options.map((o, i) => `<button type="button" data-opt="${i}" aria-pressed="false">${esc(o)}</button>`).join('')}</div>` : ''}
    <div class="wf">
      <div class="field">
        <label for="ans-${item.id}">Your answer</label>
        <textarea class="textarea" id="ans-${item.id}" style="min-height:72px" placeholder="Type your reply to ${esc(name)}…" autofocus></textarea>
      </div>
      <div class="btnrow" style="justify-content:space-between"><span class="hint">Ctrl+Enter sends. ${esc(name)} waits for you.</span><span class="btnrow"><button class="btn" data-act="later">Later</button><button class="btn primary" data-act="send">${icon('send')}Send answer</button></span></div>
    </div>
  </div>`);
  const w = openWindow({ id: item.id, title: `From: ${name}`, kind: 'decision', body, from, dockLabel: `${name} asks` });
  const ta = body.querySelector('textarea');
  body.querySelectorAll('[data-opt]').forEach(b => b.addEventListener('click', () => {
    body.querySelectorAll('[data-opt]').forEach(x => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    ta.value = item.options[Number(b.dataset.opt)];
    ta.focus();
  }));
  const send = () => { if (!ta.value.trim()) { ta.focus(); return ctx.toast('Write an answer first.', 'warn'); } submit(item, { text: ta.value.trim() }, w, body.querySelector('[data-act="send"]')); };
  body.querySelector('[data-act="send"]').addEventListener('click', send);
  body.querySelector('[data-act="later"]').addEventListener('click', () => w.minimize());
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); });
  wireRunLinks(body);
  return w;
}

function openApproval(item, from) {
  const name = itemName(item);
  const body = createEl(`<div style="display:grid;gap:var(--s4)">
    ${fromBlock(item, name)}
    <p class="ask">${esc(name)} wants to: <strong>${esc(item.title)}</strong></p>
    <div class="ctx">${esc(item.message ? `Why I'm asking: ${item.message}.` : '')}${item.delegatedBy ? ` ${esc(item.delegatedBy)} handed ${esc(name)} this task.` : ''} Nothing happens until you approve.</div>
    ${item.detail ? `<div class="field"><span class="label">${/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(item.tool || '') ? 'The change' : 'Exactly what will run'}</span><pre class="cmd">${esc(item.detail)}</pre></div>` : ''}
    <div class="wf">
      <div class="field">
        <label for="note-${item.id}">Note to ${esc(name)} (optional)</label>
        <input class="input" id="note-${item.id}" placeholder="e.g. use the support inbox instead" autofocus>
      </div>
      <div class="btnrow" style="justify-content:space-between">
        ${item.noRemember ? '<span class="hint">Asked every time in a handed-over task.</span>' : `<label style="display:flex;gap:var(--s3);align-items:center;font-size:var(--read-sm)"><span class="switch"><input type="checkbox" role="switch" data-remember><span class="track"><span class="knob"></span></span></span>Always allow this</label>`}
        <span class="btnrow"><button class="btn" data-act="deny">${icon('x')}Deny</button><button class="btn primary" data-act="approve">${icon('check')}Approve</button></span>
      </div>
      ${item.noRemember ? '' : `<div class="remember-scope" data-scope hidden>${item.floor
        ? `<span class="hint">For ${esc(name)} only. Sign-ins, other clients’ folders, Orchy’s own files and the harness’s settings are never allowed for every agent at once.</span>`
        : `<div class="seg" role="group" aria-label="Always allow it for">${[['agent', `${esc(name)} only`], ['workspace', `Every agent in ${esc(wsName(item.workspace))}`]].map(([k, l]) => `<button type="button" data-scope-pick="${k}" aria-pressed="${(ctx.settings?.().allowScope || 'agent') === k}">${l}</button>`).join('')}</div>`}</div>`}
    </div>
  </div>`);
  const w = openWindow({ id: item.id, title: `From: ${name} · needs your OK`, kind: 'decision', body, from, dockLabel: `Approve: ${name}` });
  const note = () => body.querySelector('input.input').value.trim();
  // "Always allow" on: who it covers shows (the default from Settings → Approvals), one agent or the whole workspace
  const scopeBox = body.querySelector('[data-scope]');
  body.querySelector('[data-remember]')?.addEventListener('change', e => { if (scopeBox) scopeBox.hidden = !e.target.checked; });
  body.querySelectorAll('[data-scope-pick]').forEach(b => b.addEventListener('click', () => body.querySelectorAll('[data-scope-pick]').forEach(x => x.setAttribute('aria-pressed', String(x === b)))));
  const everyAgent = () => !item.floor && body.querySelector('[data-scope-pick="workspace"]')?.getAttribute('aria-pressed') === 'true';
  body.querySelector('[data-act="approve"]').addEventListener('click', e => submit(item, { approve: true, note: note(), remember: !!body.querySelector('[data-remember]')?.checked, everyAgent: everyAgent() }, w, e.currentTarget));
  body.querySelector('[data-act="deny"]').addEventListener('click', e => submit(item, { approve: false, note: note() }, w, e.currentTarget));
  wireRunLinks(body);
  return w;
}

function platformMark(p) {
  const short = { gmail: 'GM', 'google-calendar': 'CA', 'google-drive': 'DR', 'google-docs': 'DO', slack: 'SL', notion: 'NO', stripe: 'ST', meta: 'ME', lusha: 'LU', exa: 'EX', tavily: 'TA', firecrawl: 'FC', 'hyper-browser': 'HB', 'open-router': 'OR', typesafe: 'JV', 'conversion-tools': 'CT', github: 'GH', 'deep-seek': 'DS', elevenlabs: 'EL', mcp: 'MC' };
  return short[p] || String(p).slice(0, 2).toUpperCase();
}

function openConnections(item, from) {
  const P = item.payload || {};
  const suggested = new Set(P.suggested || []);
  const pool = P.connections || [];
  const groups = {};
  for (const c of pool) (groups[c.source === 'mcp' ? 'External (MCP)' : platformName(c.platform)] ||= []).push(c);
  const state = new Map(pool.map(c => [c.key, { on: suggested.has(c.key), access: P.suggestedAccess?.[c.key] === 'full' ? 'full' : 'read' }]));

  const row = c => {
    const st = state.get(c.key);
    return `<div class="conn${st.on ? ' on' : ''}" data-key="${esc(c.key)}" title="${esc(c.source === 'mcp' ? (c.description || `${c.type} MCP server`) : c.key)}">
      <span class="pl">${esc(platformMark(c.platform))}</span>
      <span class="n"><b>${esc(c.name)}${suggested.has(c.key) ? '<span class="suggest">suggested</span>' : ''}</b>${c.source === 'mcp' && c.description ? `<span>${esc(c.description)}</span>` : ''}</span>
      <span class="seg" role="group" aria-label="Access for ${esc(c.name)}" ${st.on ? '' : 'aria-disabled="true"'}>
        <button type="button" data-access="read" aria-pressed="${st.access === 'read'}">Read</button><button type="button" data-access="full" aria-pressed="${st.access === 'full'}">Full</button>
      </span>
      <label class="switch" title="Give ${esc(c.name)} to the agent"><input type="checkbox" role="switch" aria-label="Use ${esc(c.name)}" ${st.on ? 'checked' : ''}><span class="track"><span class="knob"></span></span></label>
    </div>`;
  };

  const body = createEl(`<div style="display:grid;gap:var(--s4)">
    ${fromBlock(item, nameRole(itemName(item), 'AI Agent Builder'))}
    <p class="ask">${esc(P.message || item.message || 'Which connections should this agent use?')}</p>
    <div class="ctx"><strong>Building:</strong> ${esc(P.agentName || 'a new agent')}${P.purpose ? ` — ${esc(P.purpose)}` : ''}. Switch on what it may use. <strong>Read</strong> lets it look; <strong>Full</strong> lets it change things (still with your approval).</div>
    <div class="btnrow"><input class="input" data-filter placeholder="Filter connections…" style="flex:1;min-width:160px"><span class="plate" data-count>0 on</span></div>
    <div class="conn-groups">${Object.entries(groups).map(([g, cs]) => `<div class="conn-group"><h4>${esc(g)}</h4><div class="conn-list">${cs.map(row).join('')}</div></div>`).join('') || '<div class="empty">This workspace has no connections yet.</div>'}</div>
    <div class="wf">
      <div class="btnrow"><input class="input" id="cn-${item.id}" style="flex:1;min-width:200px" aria-label="Note to the Builder (optional)" placeholder="Note to the Builder (optional), e.g. drafts only">
        <button class="btn" data-act="later">Later</button><button class="btn primary" data-act="give">${icon('check')}Give these to the Builder</button></div>
    </div>
  </div>`);
  const w = openWindow({ id: item.id, title: `A message from ${nameRole(itemName(item), 'AI Agent Builder')}`, kind: 'decision', size: 'wide', body, from, dockLabel: 'Builder: pick connections' });

  const count = () => { body.querySelector('[data-count]').textContent = `${[...state.values()].filter(s => s.on).length} on`; };
  count();
  body.querySelectorAll('.conn').forEach(el => {
    const key = el.dataset.key;
    const st = state.get(key);
    const seg = el.querySelector('.seg');
    el.querySelector('input[type=checkbox]').addEventListener('change', e => {
      st.on = e.target.checked;
      el.classList.toggle('on', st.on);
      seg.toggleAttribute('aria-disabled', !st.on);
      if (!st.on) seg.setAttribute('aria-disabled', 'true'); else seg.removeAttribute('aria-disabled');
      count();
    });
    seg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      st.access = b.dataset.access;
      seg.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    }));
  });
  body.querySelector('[data-filter]').addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    body.querySelectorAll('.conn').forEach(el => { el.hidden = q && !el.textContent.toLowerCase().includes(q); });
  });
  body.querySelector('[data-act="later"]').addEventListener('click', () => w.minimize());
  body.querySelector('[data-act="give"]').addEventListener('click', e => {
    const selected = [...state.entries()].filter(([, s]) => s.on).map(([key, s]) => ({ key, access: s.access }));
    submit(item, { selected, note: body.querySelector(`#cn-${CSS.escape(item.id)}`).value.trim() }, w, e.currentTarget);
  });
  wireRunLinks(body);
  return w;
}
