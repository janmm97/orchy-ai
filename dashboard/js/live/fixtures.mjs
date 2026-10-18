// ?preview=live: sample runs, a huddle, steps and files for screenshots of the Live view. Nothing here is real and
// nothing is sent; every id starts with "preview-" so the view never asks the server about them. The samples use the
// workspaces and agents of this install (by position, never by name), like ?preview=work.
import { S } from './model.mjs';
import { openLive } from '../live.mjs';
import { agentName } from '../util.mjs';

export function previewLive({ state }) {
  const ago = s => new Date(Date.now() - s * 1000).toISOString();
  const ws = state.workspaces.filter(w => w.enabled !== false).map(w => w.id);
  const [A, B = ws[0], C = ws[0]] = ws;
  // a fresh install has no agents yet: three made-up ones per workspace for the preview (never saved)
  const SAMPLE = [['researcher', 'Head of Research'], ['designer', 'Designer'], ['analyst', 'Analyst']];
  for (const id of ws) {
    if (state.agents.some(a => a.workspace === id && !a.isBuilder)) continue;
    state.agents.push(...SAMPLE.map(([slug, displayName]) => ({ workspace: id, slug, displayName, role: displayName, description: '', model: 'sonnet', connections: [], preview: true })));
  }
  const team = id => state.agents.filter(a => a.workspace === id && !a.isBuilder && !a.error);
  const ag = (id, i) => team(id)[i] || team(id)[0] || null;
  const head = ag(A, 0), maker = ag(A, 1), ops = ag(B, 0), h1 = ag(C, 0), h2 = ag(C, 1) || ag(C, 0);
  const run = (id, w, a, extra) => ({ id, workspace: w, agentSlug: a?.slug || null, agentName: a?.displayName || 'Generalist', isBuilder: false, model: 'sonnet', ...extra });

  const runs = [
    run('preview-head', A, head, { status: 'working', startedAt: ago(42 * 60), model: 'opus', instruction: 'Research the latest on AI agents this week and turn it into a short PDF report for the newsletter', subRuns: ['preview-maker'],
      activity: { state: 'searching-web', label: 'Searching web' }, plan: { actions: [{ title: 'Search the web', platform: 'exa' }, { title: 'Scrape a page', platform: 'firecrawl' }], ms: 1800 } }),
    run('preview-maker', A, maker, { status: 'working', startedAt: ago(10 * 60), instruction: 'Make the PDF from report.md: six pages, our newsletter look, the chart from sources.csv on page 2', delegatedBy: 'preview-head', delegatedByName: agentName(A, head?.slug, head?.displayName || 'Its head'),
      activity: { state: 'running-command', label: 'Running a command' } }),
    run('preview-ops', B, ops, { status: 'waiting', startedAt: ago(3 * 60 + 5), instruction: 'Reconcile this month’s invoices against the payout report and flag anything that doesn’t match', activity: { state: 'waiting', label: 'Waiting on you' } }),
    run('preview-done', A, ag(A, 2) || head, { status: 'done', outcome: 'completed', startedAt: ago(4 * 3600), endedAt: ago(3.6 * 3600), instruction: 'Draft three subject lines for Friday’s newsletter', report: { status: 'completed', result: '1. **Agents that ship:** what changed this week\n2. Five launches worth your 10 minutes\n3. The week AI agents got jobs', summary: 'Three subject lines, ranked.', outputs: ['Tasks/2026-10-17-newsletter/subject-lines.md'], actions_taken: ['Saved the lines to the task folder', 'Emailed them to the team'] },
      validation: { verdict: 'check', at: ago(3.6 * 3600), ms: 3, checks: [{ name: 'Report', ok: true, note: '' }, { name: 'Status', ok: true, note: '' }, { name: 'Files it names', ok: false, level: 'warn', note: "Can't find subject-lines.md" }, { name: 'App actions', ok: false, level: 'warn', note: "Says it emailed, but I don't see an email step" }] } }),
    // the agent just finished; Orchy is checking its report (validate.mjs) before Orchy reports
    run('preview-checking', B, ag(B, 1) || ops, { status: 'done', outcome: 'completed', startedAt: ago(9 * 60), endedAt: ago(2), instruction: 'Pull last week’s support tickets into a summary table and send it to the team channel',
      report: { status: 'completed', summary: 'Summary table saved and posted to the team channel.', outputs: ['Tasks/tickets/summary.csv'] }, activity: { state: 'validating', label: 'Orchy is checking' } }),
  ];
  for (const r of runs) state.runs.set(r.id, r);
  state.inbox.set('preview-live-ask', { id: 'preview-live-ask', kind: 'approval', status: 'pending', createdAt: ago(60), runId: 'preview-ops', workspace: B,
    agent: { slug: ops?.slug, displayName: ops?.displayName }, title: 'Mark 2 invoices as disputed in the billing app', message: 'Two invoices don’t match the payout report.' });
  if (h1) {
    state.huddles.set('preview-huddle', {
      id: 'preview-huddle', workspace: C, status: 'talking', speaking: h1.slug, maxTurns: 8, createdAt: ago(6 * 60),
      topic: 'Should we build our own webhook service for the new lead forms, or use what we already have?',
      agents: [{ slug: h1.slug, name: agentName(C, h1.slug, h1.displayName), role: h1.displayName }, { slug: h2.slug, name: agentName(C, h2.slug, h2.displayName), role: h2.displayName }],
      turns: [
        { by: h1.slug, name: h1.displayName, at: ago(5 * 60), text: 'I’d build a small webhook service: we control retries and can filter spam before it reaches the CRM.' },
        { by: h2.slug, name: h2.displayName, at: ago(3 * 60), text: 'Before we build anything: the relay we already run forwards these events. What would ours do that it can’t?', challenge: 'A new service is one more thing to keep alive. Show the gap first.' },
        // Orchy steps in (huddlecoach.mjs): a challenge: observation, concern, alternative, trade-off, recommendation
        { by: 'orchy', name: 'Orchy', kind: 'coach', mode: 'challenge', about: 'A new webhook service where the relay does', to: h1.slug, at: ago(2 * 60),
          parts: { observation: 'The plan adds a service to receive lead-form webhooks.', concern: 'The relay already forwards these events; a second receiver is one more thing to host, watch and secure.', alternative: 'Add the spam filter and retries as a step on the existing relay.', tradeoff: 'Less control over retry timing, no new code to run.', recommendation: 'Extend the relay first; build a service only if it can’t filter.' },
          text: 'I challenge: A new webhook service where the relay does.' },
      ],
      readyFrom: 2, coach: { count: 1, cost: 0.04, issues: [{ about: 'A new webhook service where the relay does', mode: 'challenge', status: 'open', to: h1.slug, i: 2 }] },
    });
  }

  const T = (s, e) => ({ t: ago(s), ...e });
  S.events.set('preview-maker', [
    T(600, { n: 1, kind: 'system', text: 'Started on sonnet' }),
    T(560, { n: 2, kind: 'tool', tool: 'Read', toolUseId: 'p1', summary: 'Reading report.md' }),
    T(558, { n: 3, kind: 'tool_done', tool: 'Read', toolUseId: 'p1', ok: true, brief: '214 lines' }),
    T(500, { n: 4, kind: 'text', text: 'Six sections, so one per page. Laying it out as HTML first, then printing it to PDF.' }),
    T(380, { n: 5, kind: 'tool', tool: 'Write', toolUseId: 'p2', summary: 'Writing report.html' }),
    T(379, { n: 6, kind: 'tool_done', tool: 'Write', toolUseId: 'p2', ok: true, brief: '18 KB' }),
    T(200, { n: 7, kind: 'tool', tool: 'Read', toolUseId: 'p3', summary: 'Reading sources.csv' }),
    T(199, { n: 8, kind: 'tool_error', tool: 'Read', toolUseId: 'p3', text: 'File not found: data/sources.csv' }),
    T(150, { n: 9, kind: 'text', text: 'The CSV is one folder up. Using that one.' }),
    T(60, { n: 10, kind: 'tool', tool: 'Bash', toolUseId: 'p4', summary: 'Running `node make-pdf.mjs report.html`' }),
  ]);
  S.events.set('preview-head', [
    T(2500, { n: 1, kind: 'system', text: 'Started on opus' }),
    T(2400, { n: 2, kind: 'tool', tool: 'WebSearch', toolUseId: 'h1', summary: 'Searching “AI agent launches October 2026”' }),
    T(2390, { n: 3, kind: 'tool_done', toolUseId: 'h1', ok: true, brief: '10 results' }),
    T(700, { n: 4, kind: 'tool', tool: 'mcp__jos__delegate', toolUseId: 'h2', summary: 'Handing the PDF to the designer' }),
    T(699, { n: 5, kind: 'tool_done', toolUseId: 'h2', ok: true, brief: 'started' }),
    T(30, { n: 6, kind: 'tool', tool: 'WebSearch', toolUseId: 'h3', summary: 'Searching “agent frameworks release notes this week”' }),
  ]);
  S.events.set('preview-ops', [T(180, { n: 1, kind: 'system', text: 'Started on sonnet' }), T(90, { n: 2, kind: 'tool', tool: 'Read', toolUseId: 'o1', summary: 'Reading payouts-oct.csv' }), T(89, { n: 3, kind: 'tool_done', toolUseId: 'o1', ok: true, brief: '412 rows' })]);
  S.events.set('preview-done', []);
  S.lastTool.set('preview-head', 'Searching “agent frameworks release notes this week”');
  S.lastTool.set('preview-maker', 'Running `node make-pdf.mjs report.html`');
  S.lastTool.set('preview-ops', 'Reading payouts-oct.csv');

  const art = (id, name, kind, extra) => ({ id, name, kind, ext: name.split('.').pop(), workspace: A, agentSlug: maker?.slug || null, agentName: maker?.displayName || 'Generalist', runId: 'preview-maker', runIds: ['preview-maker'], rel: `Tasks/preview/${name}`, version: 1, status: 'draft', size: 4200, updatedAt: ago(300), ...extra });
  // deliverables only (notes, data and scripts never reach the Output gallery)
  S.files.set('run:preview-maker', { at: Date.now(), list: [
    art('preview-a1', 'ai-agents-this-week.pdf', 'pdf', { version: 2, size: 412_000, updatedAt: ago(120) }),
    art('preview-a2', 'launch-teaser.mp4', 'video', { size: 8_400_000, updatedAt: ago(200), media: { durationSec: 24 } }),
    art('preview-a3', 'cover-1080x1350.png', 'image', { size: 920_000, updatedAt: ago(260), status: 'final' }),
    art('preview-a4', 'client-letter.docx', 'doc', { size: 38_000, updatedAt: ago(400), status: 'final' }),
    art('preview-a5', 'voiceover.mp3', 'audio', { size: 610_000, updatedAt: ago(500), media: { durationSec: 31 } }),
  ] });
  S.files.set('run:preview-head', { at: Date.now(), list: [] });
  openLive({ sel: { type: 'run', id: 'preview-maker' } });
}
