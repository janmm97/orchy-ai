// Client panes: when work lands in a workspace, its pane opens beside Orchy and shows the run
// Orchy is watching (who, the task, the stage strip, a live feed of what the agent is doing),
// anything else running there, and the client's team of agents.
import { icon } from './pixel.mjs';
import { esc, api, md, wsName, wsClass, agentName, runName, timeShort, dur, stripHTML, timezone, clientOwn } from './util.mjs';
import { spriteFor } from './sheets.mjs';

let ctx = null; // { state, LIVE, toast }
export function initPanes(c) { ctx = c; }

const EV_ICON = { system: 'bolt', text: 'chat', tool: 'term', tool_error: 'bang', error: 'bang', note: 'doc', report: 'check', denied: 'x', plan: 'spark' };
const feeds = new Map(); // runId -> events[]
const FEED_MAX = 14;

function evRow(e) {
  const txt = e.summary || e.text || '';
  return `<div class="ev ${esc(e.kind)}">${icon(EV_ICON[e.kind] || 'term')}<span>${e.kind === 'text' ? md(txt) : esc(txt)}</span><time>${timeShort(e.t)}</time></div>`;
}

const isLive = r => ctx.LIVE.has(r.status);
const todayET = iso => new Intl.DateTimeFormat('en-CA', { timeZone: timezone() }).format(new Date(iso));

/**
 * Which run (or routing card) a client's pane is about right now: the session on screen first
 * (its live run, else its latest), then anything else live, then whatever finished since the split opened.
 */
export function focusFor(wsId, since, session) {
  const { state } = ctx;
  const cards = [...state.proposals.values()].filter(p => p.status === 'proposed' && p.choice?.workspace === wsId);
  const proposal = cards.filter(p => p.session === session).at(-1) || cards.at(-1);
  const runs = [...state.runs.values()].filter(r => r.workspace === wsId && !clientOwn(r)).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const live = runs.filter(isLive);
  const mine = runs.filter(r => r.session === session);
  const run = mine.find(isLive) || mine[0] || live[0] || runs.find(r => r.endedAt && Date.parse(r.endedAt) >= since - 2000) || null;
  return { proposal, run, live, runs };
}

async function loadFeed(runId) {
  if (feeds.has(runId)) return;
  feeds.set(runId, []);
  if (runId.startsWith('preview-')) return; // sample data (?preview=work)
  try {
    const d = await api(`/api/runs/${runId}`);
    feeds.set(runId, d.events || []);
    const box = document.querySelector(`[data-feed="${CSS.escape(runId)}"]`);
    if (box) { box.innerHTML = feedHTML(runId, ctx.state.runs.get(runId)); box.scrollTop = box.scrollHeight; }
  } catch { /* the feed fills from live events */ }
}

function feedHTML(runId, run) {
  // tool_done only closes a step (it feeds the run's activity), so it gets no row of its own
  const evs = (feeds.get(runId) || []).filter(e => e.kind !== 'tool_done' && (e.kind !== 'system' || /Finished|Started/i.test(e.text || '')));
  return evs.slice(-FEED_MAX).map(evRow).join('') || `<div class="ev placeholder"><span></span><span>${!run || run.status === 'starting' ? 'Starting up…' : run.status === 'waiting' ? 'Paused until you answer.' : 'Working. Each step shows up here as it happens.'}</span><span></span></div>`;
}

/** A live event for a run: if a pane is showing that run's feed, add the row. */
export function paneEvent(runId, event) {
  if (!feeds.has(runId) || event.kind === 'tool_done') return;
  feeds.get(runId).push(event);
  const box = document.querySelector(`[data-feed="${CSS.escape(runId)}"]`);
  if (!box) return;
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  if (event.kind === 'system' && !/Finished|Started/i.test(event.text || '')) return;
  box.querySelector('.placeholder')?.remove();
  box.insertAdjacentHTML('beforeend', evRow(event));
  while (box.children.length > FEED_MAX) box.firstElementChild.remove();
  if (near) box.scrollTop = box.scrollHeight;
}

function nowCard(wsId, f) {
  const { proposal, run } = f;
  if (proposal) {
    const ch = proposal.choice || {};
    const needs = proposal.routing?.needsChoice && !proposal.held;
    return `<div class="incoming">
      <span class="stage">${needs ? 'Jev isn’t sure yet' : `Jev picked ${esc(wsName(wsId))}`}</span>
      <p class="task" style="margin:0">“${esc(proposal.text)}”</p>
      <span class="hint">${needs ? 'Pick the client and agent on the routing card next to Orchy.' : `${ch.intent === 'build_agent' ? 'The AI Agent Builder' : ch.agent ? esc(agentName(wsId, ch.agent, ctx.state.agents.find(a => a.workspace === wsId && a.slug === ch.agent)?.displayName)) : `The ${esc(wsName(wsId))} generalist`} gets it on ${esc(ch.model || 'sonnet')} ${proposal.dispatchAt ? 'in a few seconds' : 'when you press Send now'}.`}</span>
    </div>`;
  }
  if (!run) return `<div class="empty"><strong>Quiet here</strong>Nothing running in ${esc(wsName(wsId))} right now. Tell Orchy what ${esc(ctx.state.workspaces.find(w => w.id === wsId)?.client || 'this client')} needs.</div>`;
  const live = isLive(run);
  if (live) loadFeed(run.id);
  const rep = run.report;
  const asks = [...ctx.state.inbox.values()].filter(i => i.runId === run.id && i.status === 'pending');
  const theirs = asks.length ? null : [...ctx.state.clientAsks.values()].find(i => i.runId === run.id && i.status === 'pending');
  return `<div class="now">
    <div class="who-row"><span class="sprite">${spriteFor(wsId, run.isBuilder ? 'agent-builder' : run.agentSlug)}</span>
      <span><b>${esc(runName(run))}</b><span class="sub">${esc(run.model)} · started ${timeShort(run.startedAt)}${run.clientName ? ` by ${esc(run.clientName)}` : ''}</span></span>
      <span class="timer" ${live ? `data-start="${esc(run.startedAt)}"` : ''}>${dur((run.endedAt ? Date.parse(run.endedAt) : Date.now()) - Date.parse(run.startedAt))}</span></div>
    <p class="task">${esc(run.instruction)}</p>
    <div class="stagebar"><span>${stripHTML(run)}</span><span class="btnrow">
      ${run.status === 'queued' || run.status === 'paused-limit' ? `<button class="btn sm primary" data-run-now="${esc(run.id)}">${icon('play')}Run now</button>` : ''}
      ${asks.length ? `<button class="btn sm decide" data-answer="${esc(asks[0].id)}">${icon('bang')}Answer</button>` : ''}<button class="btn sm" data-run="${esc(run.id)}">${icon('eye')}${live ? 'Watch' : 'Full report'}</button>
      ${live ? `<button class="btn sm" data-stop="${esc(run.id)}">${icon('stop')}Stop</button>` : ''}</span></div>
    ${asks.length ? `<div class="asks"><span class="stage">${esc(asks[0].kind === 'approval' ? 'Needs your OK' : asks[0].kind === 'connections' ? 'Pick connections' : 'Asks you')}</span><p>${esc(asks[0].kind === 'approval' ? asks[0].title || asks[0].message : asks[0].message || asks[0].title || '')}</p></div>` : ''}
    ${theirs ? `<div class="asks theirs"><span class="stage">${esc(theirs.kind === 'approval' ? `Waiting on ${theirs.askee}’s OK` : `Asks ${theirs.askee}`)}</span><p>${esc(theirs.kind === 'approval' ? theirs.title || theirs.message : theirs.message || theirs.title || '')}</p></div>` : ''}
    ${live && !(asks.length && !(feeds.get(run.id) || []).length) ? `<div class="feed" data-feed="${esc(run.id)}" aria-label="What ${esc(runName(run))} is doing">${feedHTML(run.id, run)}</div>`
      : rep ? `<div class="report"><span class="label">Reported back</span><div class="md">${md(rep.summary)}</div>${rep.follow_ups?.length ? `<span class="label">Follow-ups</span><div class="list">${rep.follow_ups.map(x => `<div>${esc(x)}</div>`).join('')}</div>` : ''}</div>`
      : run.error ? `<pre class="cmd">${esc(run.error)}</pre>` : ''}
  </div>`;
}

function teamHTML(wsId) {
  const { state } = ctx;
  const liveRuns = [...state.runs.values()].filter(r => r.workspace === wsId && isLive(r));
  const busy = slug => liveRuns.some(r => (r.isBuilder ? 'agent-builder' : r.agentSlug || null) === slug);
  const agents = state.agents.filter(a => a.workspace === wsId && !a.isBuilder);
  const mate = (slug, name, attrs, role) => `<button class="mate${busy(slug) ? ' busy' : ''}" ${attrs} aria-label="${esc(name)}${role ? `, ${esc(role)}` : ''}${busy(slug) ? ', working' : ''}">
      <span class="sprite" data-sprite="${esc(slug || 'general')}">${spriteFor(wsId, slug === null ? 'general' : slug)}</span>
      <span class="nm">${esc(name)}</span>${role ? `<span class="rl">${esc(role)}</span>` : ''}${busy(slug) ? '<span class="st blink">working</span>' : ''}</button>`;
  // the name the owner calls them by, with the role underneath (agents without a name yet show just the role)
  const named = (slug, role, attrs) => { const n = agentName(wsId, slug, role); return mate(slug, n, attrs, n !== role ? role : ''); };
  return `<div class="team">
    ${named('agent-builder', 'AI Agent Builder', `data-agent="agent-builder" data-ws="${wsId}"`)}
    ${mate(null, 'Generalist', `data-agents="${wsId}"`)}
    ${agents.map(a => named(a.slug, a.displayName, `data-agent="${esc(a.slug)}" data-ws="${wsId}"`)).join('')}
    <button class="mate add" data-build="${wsId}">${icon('plus')}<span>New agent</span></button>
  </div>`;
}

export function renderPane(wsId, since, session) {
  const col = document.getElementById(`col-${wsId}`);
  const ws = ctx.state.workspaces.find(w => w.id === wsId);
  if (!col || !ws) return;
  const f = focusFor(wsId, since, session);
  const others = f.live.filter(r => r !== f.run);
  const today = todayET(new Date().toISOString());
  const earlier = f.runs.filter(r => !isLive(r) && r !== f.run && r.endedAt && todayET(r.endedAt) === today).slice(0, 4);
  const acct = ws.account || {};
  const keepScroll = col.querySelector('.pane-body')?.scrollTop || 0;
  const feedBox = col.querySelector('[data-feed]');
  const feedScroll = feedBox ? { id: feedBox.dataset.feed, top: feedBox.scrollTop, atEnd: feedBox.scrollHeight - feedBox.scrollTop - feedBox.clientHeight < 80 } : null;

  col.innerHTML = `
    <div class="pane-head">
      <div class="row"><h2 class="px2">${esc(wsName(wsId))}</h2>
        <button class="btn sm icon" data-fold="${wsId}" aria-label="Hide the ${esc(wsName(wsId))} panel" title="Hide this panel">${icon('close')}</button></div>
      <div class="meta"><span class="who">Client <b>${esc(wsName(wsId))}</b> · ${esc(ws.runtimeLabel || 'Claude Code')}</span>
        ${acct.ok ? `<span class="acct" title="${esc(ws.runtimeLabel || 'Claude Code')} account for this workspace">${icon('check')}${esc(acct.actual)}</span>`
          : `<span class="acct bad">${icon('bang')}${acct.loggedIn ? 'Wrong account' : 'Needs login'}</span>`}</div>
    </div>
    <div class="pane-body">
      ${acct.ok ? '' : `<div class="fixbar"><b>${esc(wsName(wsId))} only runs as ${esc(acct.expected || ws.accounts?.[ws.runtime]?.account || '')}.</b>
        <span>${acct.loggedIn ? `Its ${esc(acct.runtimeLabel || '')} profile is logged in as ${esc(acct.actual || 'another account')}, so Orchy won't start anything here.` : acct.hint ? `${esc(acct.hint)} Then re-check:` : `Its ${esc(acct.runtimeLabel || 'Claude Code')} profile isn’t logged in yet. Log in once as that account in the browser, then re-check:`}</span>
        <code>${esc(acct.fix || '')}</code>
        <div class="btnrow"><button class="btn sm" data-login="${esc(wsId)}">Log in</button><button class="btn sm" data-copy="${esc(acct.fix || '')}">Copy command</button><button class="btn sm" data-recheck>${icon('refresh')}Re-check</button></div></div>`}
      <div class="section">
        <div class="section-h"><h3>${f.proposal ? 'Coming in' : f.run && isLive(f.run) ? 'Working on' : f.run ? (Date.now() - Date.parse(f.run.endedAt) < 10 * 60_000 ? 'Just finished' : 'Last run') : 'Now'}</h3>${f.live.length ? `<span class="plate ${wsClass(wsId)} blink">${f.live.length} live</span>` : ''}</div>
        ${nowCard(wsId, f)}
      </div>
      ${others.length ? `<div class="section"><div class="section-h"><h3>Also working <span class="count">${others.length}</span></h3></div>
        <div class="runs">${others.map(runRow).join('')}</div></div>` : ''}
      <div class="section"><div class="section-h"><h3>Team</h3></div>${teamHTML(wsId)}</div>
      ${earlier.length ? `<div class="section"><div class="section-h"><h3>Earlier today</h3></div><div class="runs">${earlier.map(runRow).join('')}</div></div>` : ''}
    </div>`;
  col.querySelector('.pane-body').scrollTop = keepScroll;
  const nb = col.querySelector('[data-feed]');
  if (nb) nb.scrollTop = feedScroll && feedScroll.id === nb.dataset.feed && !feedScroll.atEnd ? feedScroll.top : nb.scrollHeight;
}

function runRow(r) {
  const live = isLive(r);
  return `<button class="runrow" data-run="${esc(r.id)}">
    <span class="l1"><b>${esc(runName(r))}${r.clientName ? ` · ${esc(r.clientName)}` : ''}</b><span class="timer" ${live ? `data-start="${esc(r.startedAt)}"` : ''}>${live ? dur(Date.now() - Date.parse(r.startedAt)) : timeShort(r.startedAt)}</span></span>
    <span class="l2">${esc(r.instruction)}</span>
    <span class="l3">${stripHTML(r)}</span>
  </button>`;
}
