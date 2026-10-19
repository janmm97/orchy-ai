// Preview mode (open the dashboard with ?preview): shows sample pop-ups, a routing card and
// sample work so you can see Orchy's interruptions and the split view. Nothing here is real and nothing is sent.
//   ?preview        routing card + the three pop-ups
//   ?preview=route  just the routing card
//   ?preview=work   the split view with sample runs in both clients
//   ?preview=live   the Live view with sample runs, a huddle, steps and files (live/fixtures.mjs)
import { openItem } from './popups.mjs';
import { api, setWorkspaces } from './util.mjs';

// Two made-up workspaces so the preview works on a fresh install (nothing here is saved).
const SAMPLE_WS = [
  { id: 'alpha', name: 'Alpha Studio', client: 'Alpha Studio', color: 'cobalt', enabled: true, runtime: 'claude', account: { ok: true, actual: 'you@example.com' }, oneScoped: true, models: ['haiku', 'sonnet', 'opus'] },
  { id: 'beta', name: 'Beta Labs', client: 'Beta Labs', color: 'tomato', enabled: true, runtime: 'claude', account: { ok: true, actual: 'you@example.com' }, oneScoped: true, models: ['haiku', 'sonnet', 'opus'] },
];
function sampleWorkspaces(state, ensurePanes) {
  if (state.workspaces.length) return;
  state.workspaces = SAMPLE_WS.map(w => ({ ...w }));
  setWorkspaces(state.workspaces, state.retired);
  ensurePanes?.();
}

export async function runPreview({ state, view, upsertProposal, toast, mode = '', wake, layout, ensurePanes, renderPanes, paneEvent, setActive }) {
  const now = new Date().toISOString();
  sampleWorkspaces(state, ensurePanes);
  if (mode === 'live') {
    toast('Preview: sample work in the Live view. Nothing is real.', 'warn');
    return (await import('./live/fixtures.mjs')).previewLive({ state });
  }
  toast(mode === 'route' ? 'Preview: a sample routing card. Nothing is sent.' : mode === 'work' ? 'Preview: sample work in two sessions. Nothing is real.' : 'Preview: these are sample pop-ups. Nothing is sent.', 'warn');

  if (mode === 'work') return previewWork({ state, wake, layout, ensurePanes, renderPanes, paneEvent, setActive });

  upsertProposal({
    id: 'preview-route', session: view.active, status: 'proposed', text: 'Find this week’s customer feedback emails and summarise them in a doc',
    createdAt: now, dispatchAt: null, held: true,
    choice: { intent: 'task', workspace: 'beta', agent: null, model: 'sonnet' },
    routing: {
      intent: 'task', workspace: 'beta', model: 'sonnet', confidence: 0.91, source: 'jev', needsChoice: false, autoDispatchSeconds: 5,
      probabilities: { workspace: { alpha: 0.04, beta: 0.91, none: 0.05 }, agent: { 'beta/general': 0.88, 'alpha/general': 0.12 } },
      jev: { ms: 2050 },
    },
  });

  if (mode === 'route') return;
  let pool = [];
  try { const c = await api('/api/workspaces/' + (state.workspaces[0]?.id || 'beta') + '/connections'); pool = [...c.one, ...c.mcp.map(m => ({ ...m, key: `mcp:${m.name}` }))]; } catch {}
  const gmail = pool.find(c => c.platform === 'gmail');
  const docs = pool.find(c => c.platform === 'google-docs');

  openItem({
    id: 'preview-connections', kind: 'connections', status: 'pending', createdAt: now, runId: 'preview', workspace: 'beta',
    agent: { slug: 'agent-builder', displayName: 'AI Agent Builder' },
    title: 'Connections for Feedback Digest',
    message: 'I can log feedback into Google Docs, but should Feedback Digest also draft replies to customers from the Beta Labs gmail? If yes, it needs Full access there.',
    payload: { agentName: 'Feedback Digest', purpose: 'Log new feedback and draft acknowledgements', suggested: [gmail?.key, docs?.key].filter(Boolean), connections: pool },
  });
  openItem({
    id: 'preview-question', kind: 'question', status: 'pending', createdAt: now, runId: 'preview', workspace: 'beta',
    agent: { slug: 'feedback-digest', displayName: 'Feedback Digest' },
    message: 'Two emails came from the same customer with different subjects. Should I log them as one entry or two?',
    context: '“Export is slow” and “Export is slow (still)” from the same sender, two days apart.',
    options: ['Two separate entries', 'One entry, newest version', 'Ask the customer'],
  });
  openItem({
    id: 'preview-approval', kind: 'approval', status: 'pending', createdAt: now, runId: 'preview', workspace: 'alpha',
    agent: { slug: 'support-triage', displayName: 'Support Triage' },
    title: 'Send Email — Alpha Support (gmail)',
    message: 'POST request changes data',
    detail: 'one --agent actions execute gmail conn_mod_def::…::send-email live::gmail::default::a1b2… -d \'{"to":"customer@example.com","subject":"Re: Billing question"}\'',
  });
}

function previewWork({ state, wake, layout, ensurePanes, renderPanes, paneEvent, setActive }) {
  sampleWorkspaces(state, ensurePanes);
  const ago = s => new Date(Date.now() - s * 1000).toISOString();
  // two sessions busy at once: the triage one waits on you, the feedback one is on screen
  for (const s of [
    { id: 's_previewtriage', title: 'Run the morning triage on the Alpha Support inbox', createdAt: ago(220), lastAt: ago(205), closed: false },
    { id: 's_previewfeedback', title: 'Find this week’s customer feedback emails…', createdAt: ago(82), lastAt: ago(76), closed: false },
  ]) state.sessions.set(s.id, s);
  const runs = [
    { id: 'preview-beta', session: 's_previewfeedback', workspace: 'beta', agentSlug: null, agentName: 'Beta Labs generalist', isBuilder: false, model: 'sonnet', status: 'working', startedAt: ago(74),
      instruction: 'Find this week’s customer feedback emails and summarise them in a doc' },
    { id: 'preview-alpha', session: 's_previewtriage', workspace: 'alpha', agentSlug: 'support-inbox-triage', agentName: 'Support Triage', isBuilder: false, model: 'sonnet', status: 'waiting', startedAt: ago(212),
      instruction: 'Run the morning triage on the Alpha Support inbox' },
  ];
  for (const r of runs) state.runs.set(r.id, r);
  // Support Triage is waiting on you: its question sits in the inbox (press Answer in its pane to open it)
  state.inbox.set('preview-ask', { id: 'preview-ask', kind: 'question', status: 'pending', createdAt: ago(40), runId: 'preview-alpha', workspace: 'alpha',
    agent: { slug: 'support-inbox-triage', displayName: 'Support Triage' },
    message: 'A customer asks for a refund on an annual plan. Refunds are on my never-draft list: should I label it urgent and leave it for you?',
    options: ['Yes, label urgent and leave it', 'Draft a holding reply, no promises'] });
  const msgs = [
    { id: 'preview-m0', session: 's_previewtriage', role: 'owner', text: 'Run the morning triage on the Alpha Support inbox', at: ago(215), meta: {} },
    { id: 'preview-m01', session: 's_previewtriage', role: 'orchy', text: 'On it. Support Triage in Alpha Studio has it, running on sonnet.', at: ago(212), meta: { runId: 'preview-alpha', workspace: 'alpha', kind: 'dispatch' } },
    { id: 'preview-m1', session: 's_previewfeedback', role: 'owner', text: 'Find this week’s customer feedback emails and summarise them in a doc', at: ago(80), meta: {} },
    { id: 'preview-m2', session: 's_previewfeedback', role: 'orchy', text: 'On it. Jev sent this to **Beta Labs** (91% sure). The generalist is reading the Beta Labs gmail inbox now.', at: ago(76),
      meta: { runId: 'preview-beta', workspace: 'beta', routing: { workspace: 'beta', agentLabel: 'Beta Labs generalist', model: 'sonnet', client: { alpha: 0.04, beta: 0.91 }, ms: 2050 } } },
  ];
  state.chat.push(...msgs);
  wake('beta');
  setActive('s_previewfeedback');
  layout();
  renderPanes();
  const events = [
    { kind: 'system', text: 'Started Beta Labs generalist on sonnet', t: ago(74) },
    { kind: 'tool', summary: 'one actions find gmail “list messages”', t: ago(70) },
    { kind: 'tool', summary: 'gmail · list messages · Beta Labs gmail · query: subject:(feedback) newer_than:7d', t: ago(61) },
    { kind: 'text', text: 'Found **6** feedback emails this week. Reading each one for topic and mood.', t: ago(48) },
    { kind: 'tool', summary: 'gmail · get message · “Feedback: export is slow”', t: ago(31) },
    { kind: 'tool', summary: 'gmail · get message · “Question about pricing”', t: ago(12) },
  ];
  for (const e of events) paneEvent('preview-beta', e);
}
