// Offline checks for run events and activity (activity.mjs, runner.mjs#record): activity states from recorded event
// shapes (Claude Code, Codex, ACP feed names), the redaction pass, safe tool_done briefs, the open-tool tracker,
// text-delta coalescing, Codex's item/completed mapping, and one Claude run through the real runner in a disposable
// copy (a fake `claude` replays a stream-json transcript: n, toolUseId, tool_done, activity on run.event and run.updated).
// No model calls, no network. Run: node orchestrator/scripts/test-activity.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../lib/env.mjs';
import { activityFor, baseActivity, nextActivity, forgetRun, redact, redactEvent, briefFor, textBuffer, appName } from '../lib/activity.mjs';
import { codexCompleted } from '../lib/codex.mjs';

const ok = name => console.log(`ok - ${name}`);
const st = (e, run = {}) => activityFor(e, run)?.state ?? null;

// ── 1. event shapes → states ──
const T = (tool, input, summary = '') => ({ kind: 'tool', tool, input, summary });
const claude = [
  [T('Read', { file_path: '/work/acme/notes/brief.md' }, 'Reading brief.md'), 'reading-files'],
  [T('Glob', { pattern: 'site/src/**/*' }, 'Searching files for site/src/**/*'), 'reading-files'],
  [T('Grep', { pattern: '\\d', output_mode: 'content' }, 'Searching files for \\d'), 'reading-files'],
  [T('Write', { file_path: '/work/acme/Tasks/2026-10-16-launch-notes/notes.md', content: '# Notes' }, 'Writing notes.md'), 'creating-document'],
  [T('Write', { file_path: 'C:\\work\\acme\\site\\home\\index.html', content: '<!DOCTYPE html>' }, 'Writing index.html'), 'creating-document'],
  [T('Edit', { file_path: '/work/acme/scripts/push.py', old_string: 'a', new_string: 'b' }, 'Editing push.py'), 'writing-code'],
  [T('WebSearch', { query: 'large vacation rental great room 8+ guests' }, 'Searching the web: large vacation rental'), 'searching-web'],
  [T('WebFetch', { url: 'https://docs.example.com/scheduling', prompt: 'How are times handled?' }, 'Reading docs.example.com'), 'reading-sources'],
  [T('Bash', { command: 'cd /work/acme && one --agent actions execute notion conn_mod_def::AAA::BBB live::notion::default::abc123 --path-vars \'{"page_id":"3f87"}\'' }, 'Running Retrieve a Page as Markdown on notion'), 'using-app'],
  [T('Bash', { command: 'cd "/work/acme"; for q in "motion trends"; do one --agent actions execute firecrawl conn_mod_def::X live::firecrawl::default::y -d "{}"; done' }, 'Running Search and Optionally Scrape Results on firecrawl'), 'searching-web'],
  [T('Bash', { command: 'cd "/work/northwind" && one --agent actions execute tavily conn_mod_def::C live::tavily::default::b041' }, 'Running Execute a Tavily Search Query on tavily'), 'searching-web'],
  [T('Bash', { command: 'echo \'{"urls":["https://example.com/meetings"]}\' | one --agent actions execute tavily conn_mod_def::A live::tavily::default::b' }, 'Running Extract Raw Web Content on tavily'), 'reading-sources'],
  [T('Bash', { command: 'mkdir -p scrape && one --agent actions execute firecrawl conn_mod_def::B live::firecrawl::default::c' }, 'Running Scrape and Extract From a URL on firecrawl'), 'reading-sources'],
  [T('Bash', { command: 'one --agent actions execute exa conn_mod_def::D live::exa::default::c788 -d \'{"query":"Head of"}\'' }, 'Running Search on exa'), 'searching-web'],
  [T('Bash', { command: 'node -e \'1\' && one --agent actions execute elevenlabs conn_mod_def::E live::elevenlabs::default::f' }, 'Running Convert Text to Speech with a Voice on elevenlabs'), 'using-app'],
  [T('Bash', { command: 'one --agent actions find notion "list comments on a page" --task "read the comments" 2>&1 | head -c 3000' }, 'Looking up notion actions'), 'looking-up-actions'],
  [T('Bash', { command: 'one --agent list 2>&1 | head -60' }, 'Checking connections'), 'looking-up-actions'],
  [T('Bash', { command: 'for t in policy routing; do node orchestrator/scripts/test-$t.mjs >/dev/null; done' }, 'Running `for t in'), 'running-tests'],
  [T('Bash', { command: 'cd studio/remotion && npx remotion render promo-16x9 out/promo.mp4 --codec=h264' }, 'Running `cd studio'), 'rendering-video'],
  // ffmpeg making a QA strip is a command, never a video render (no inference)
  [T('Bash', { command: 'ffmpeg -loglevel error -y -i frames/00001.png -i frames/00980.png -filter_complex "[0][1]vstack=2" qa/l.png' }, 'Running `ffmpeg'), 'running-command'],
  [T('Bash', { command: 'ls "/work/acme/Tasks/" 2>&1' }, 'Running `ls'), 'running-command'],
  [T('Bash', { command: 'node --check orchestrator/lib/runner.mjs' }, 'Running `node --check'), 'running-command'],
  [T('mcp__jitter-mcp__list_files', { limit: 20 }, 'Using jitter-mcp › list_files'), 'using-app'],
  [T('mcp__openrouter-mcp__search-docs', { query: 'usage accounting', max_results: 3 }, 'Using openrouter-mcp › search-docs'), 'using-app'], // searching an app's docs isn't web search
  [T('mcp__buffer-mcp__create_post', { channelId: '6acd', text: 'Hello' }, 'Using buffer-mcp › create_post'), 'using-app'],
  [T('mcp__jos__delegate', { agent: 'creative-producer', task: 'Build the promo now.' }, 'Handing work to creative-producer'), 'handing-off'],
  [T('mcp__jos__huddle', { agent: 'agent-builder', topic: 'channels changed' }, 'Huddling with agent-builder'), 'huddle'],
  [T('mcp__jos__report_done', { status: 'completed', summary: 'Refreshed the playbook' }, 'Reporting back to Orchy'), 'reporting'],
  [T('mcp__jos__ask_user', { question: 'Which emails do you mean?' }, 'Asking the owner a question'), 'waiting'],
  [T('mcp__jos__jev_pick_tools', {}, 'Asking Jev which tools to use'), 'looking-up-actions'],
  [T('mcp__jos__note', { text: 'Halfway' }, 'Halfway'), null], // over in a moment: no state change
  [T('mcp__jos__call_owner', { reason: 'Done' }, 'Ringing the owner'), null],
  [T('Agent', { description: 'Distil principles', subagent_type: 'general-purpose' }, 'Delegating: Distil principles'), 'working'],
  [T('Skill', { skill: 'motion-design' }, 'Using Skill'), 'working'],
  [T('TodoWrite', { todos: [] }, 'Planning the steps'), 'planning'],
  [{ kind: 'plan', text: 'Jev planned Update a Page, Search by Title (2.1s)' }, 'planning'],
  [{ kind: 'text', text: 'Reading the plan first.' }, null],
  [{ kind: 'tool_error', text: 'You only have read access.' }, null],
];
const codex = [
  [T('Edit', { file_path: 'C:\\work\\acme\\studio\\audio.mjs' }, 'Editing audio.mjs'), 'writing-code'],
  [T('Bash', { command: 'git status -sb' }, 'Running `git status -sb`'), 'running-command'],
  [T('Bash', { command: 'one --agent actions find logo-dev "retrieve a logo by domain" --task "logo retrieval"' }, 'Looking up logo-dev actions'), 'looking-up-actions'],
  [T('Bash', { command: 'one --agent actions execute notion conn_mod_def::G live::notion::default::7afb' }, 'Running Retrieve a Page on notion'), 'using-app'],
  [T('Bash', { command: 'Get-Content -Raw C:/work/skills/one/SKILL.md' }, 'Running `Get-Content'), 'running-command'],
  [T('WebSearch', { query: 'remotion docs' }, 'Searching the web: remotion docs'), 'searching-web'],
];
// ACP (Hermes) maps its tools to the same names (engines/acp.mjs#feedTool)
const acp = [
  [T('Read', { file_path: 'notes/open-loops.md' }, 'read'), 'reading-files'],
  [T('Bash', { command: 'one --agent list' }, 'one --agent list'), 'looking-up-actions'],
  [T('Grep', { pattern: 'todo' }, 'search'), 'reading-files'],
  [T('WebFetch', { url: 'https://example.com' }, 'fetch'), 'reading-sources'],
  [T('Edit', { file_path: 'Tasks/2026-10-15-last-email/last-email.md' }, 'write_file: last-email.md'), 'creating-document'],
  [T('tool_describe: Reading tool details', { kind: 'other' }, 'tool_describe'), 'working'],
  [T('generate_image', { prompt: 'a cat' }, 'generate_image'), 'generating-image'],
];
for (const [group, rows] of [['Claude', claude], ['Codex', codex], ['ACP', acp]]) {
  for (const [e, want] of rows) assert.equal(st(e), want, `${group}: ${e.tool || e.kind} ${e.summary || ''} → ${want}`);
  ok(`${group}: ${rows.length} event shapes → states`);
}
// a huddle call names one agent (`agent`) or several (`agents`)
assert.equal(activityFor(T('mcp__jos__huddle', { agents: ['analyst', 'designer', 'agent-builder'], topic: 'x' }, 'Huddling'))?.label, 'Huddling with analyst, designer and agent-builder');
assert.equal(activityFor(T('mcp__jos__huddle', { agent: 'analyst' }, 'Huddling'))?.label, 'Huddling with analyst');
assert.equal(activityFor(T('mcp__jos__huddle', {}, 'Huddling'))?.label, 'Huddling with a colleague');
assert.ok(activityFor(T('mcp__jos__huddle', { agents: ['a-very-long-agent-slug', 'another-very-long-agent-slug'] }, 'Huddling')).label.length <= 'Huddling with '.length + 40);
ok('huddle label: one, several or nobody named, kept short');

// image/video never inferred; only when the name says so
assert.equal(st(T('mcp__openrouter__generate_image', {})), 'generating-image');
assert.equal(st(T('mcp__design__export_video', {})), 'rendering-video');
assert.equal(st(T('Write', { file_path: 'renders/hero.png' })), 'working');
assert.equal(st(T('Bash', { command: 'one --agent actions execute openrouter conn_mod_def::Z live::openrouter::default::k' }, 'Running Create a Chat Completion on openrouter')), 'using-app');
assert.equal(st(T('Bash', { command: 'one --agent actions execute openrouter conn_mod_def::Z live::openrouter::default::k' }, 'Running Generate an Image on openrouter')), 'generating-image');
ok('image/video states only from tool or action names');

// labels and apps
assert.deepEqual(activityFor(claude[8][0]), { tool: 'Bash', app: 'notion', state: 'using-app', label: 'Using Notion' });
assert.equal(activityFor(T('mcp__claude_ai_Notion__search', {})).label, 'Using Notion');
assert.equal(activityFor(claude.find(([e]) => e.tool === 'mcp__jos__delegate')[0]).label, 'Handing to creative-producer');
assert.equal(activityFor(T('mcp__jos__ask_user', {}), { client: 'acme', clientName: 'Acme' }).label, 'Waiting on Acme');
assert.equal(appName('google-calendar'), 'Google Calendar'); assert.equal(appName('github'), 'GitHub'); assert.equal(appName('jitter-mcp'), 'Jitter');
ok('labels: Using <App>, Handing to <agent>, Waiting on <client>');

// run-level states
const R = (status, extra = {}) => baseActivity({ id: 'r', status, ...extra }).state;
assert.deepEqual(['queued', 'starting', 'paused-limit', 'working', 'waiting', 'stopping'].map(s => R(s)), ['queued', 'queued', 'paused', 'working', 'waiting', 'stopping']);
assert.equal(R('working', { huddleTalk: true }), 'huddle');
assert.equal(baseActivity({ status: 'done', endedAt: 'x', outcome: 'completed' }).label, 'Completed');
assert.equal(baseActivity({ status: 'done', endedAt: 'x', outcome: 'partial' }).label, 'Finished (partial)');
assert.equal(R('failed', { endedAt: 'x', outcome: 'failed' }), 'failed');
assert.equal(R('stopped', { endedAt: 'x', outcome: 'stopped' }), 'stopped');
ok('run-level states: queued/starting/paused/working/huddle/waiting/stopping/completed/failed/stopped');

// ── 2. the tracker: tools open and close by toolUseId ──
{
  const run = { id: 'track', status: 'working' };
  const step = e => (run.activity = nextActivity(run, { t: new Date().toISOString(), ...e }));
  step({ kind: 'tool', tool: 'Read', toolUseId: 'a', input: { file_path: 'x.md' } });
  step({ kind: 'tool', tool: 'WebSearch', toolUseId: 'b', input: { query: 'q' } });
  assert.equal(run.activity.state, 'searching-web'); assert.equal(run.activity.toolUseId, 'b');
  const since = run.activity.since;
  step({ kind: 'text', text: 'hm' });
  assert.equal(run.activity.since, since); // unchanged activity keeps its since
  step({ kind: 'tool_done', toolUseId: 'a', ok: true, brief: '3 lines' });
  assert.equal(run.activity.state, 'searching-web'); // the other one is still running
  step({ kind: 'tool_done', toolUseId: 'b', ok: true });
  assert.equal(run.activity.state, 'working');
  step({ kind: 'tool', tool: 'Bash', toolUseId: 'c', input: { command: 'npm test' } });
  run.status = 'waiting'; run.activity = nextActivity(run, null, { statusChanged: true });
  assert.equal(run.activity.state, 'waiting'); assert.equal(run.activity.toolUseId, 'c');
  run.status = 'working'; run.activity = nextActivity(run, null, { statusChanged: true });
  assert.equal(run.activity.state, 'running-tests'); // back to the tool the owner just let through
  step({ kind: 'tool_error', toolUseId: 'c', text: 'Exit 1' });
  assert.equal(run.activity.state, 'working');
  step({ kind: 'tool', tool: 'mcp__jos__report_done', toolUseId: 'd', input: {} });
  step({ kind: 'report', text: 'Done' });
  step({ kind: 'tool_done', toolUseId: 'd', ok: true });
  assert.equal(run.activity.state, 'reporting');
  run.status = 'done'; run.endedAt = 'x'; run.outcome = 'completed';
  step({ kind: 'system', text: 'Finished: completed' });
  assert.equal(run.activity.state, 'completed');
  forgetRun('track');
  ok('tracker: parallel tools, waiting and back, tool_error, report, end');
}
{
  const run = { id: 'track2', status: 'starting' };
  run.activity = nextActivity(run, { t: 't1', kind: 'plan', text: 'Jev planned X' });
  assert.equal(run.activity.state, 'planning');
  run.status = 'working'; run.activity = nextActivity(run, null, { statusChanged: true });
  assert.equal(run.activity.state, 'working'); // the plan was before the agent started
  run.activity = nextActivity(run, { t: 't2', kind: 'tool', tool: 'Bash', input: { command: 'ls' } }); // no toolUseId
  run.activity = nextActivity(run, { t: 't3', kind: 'tool_error', text: 'x' });
  assert.equal(run.activity.state, 'working');
  run.status = 'queued'; run.activity = nextActivity(run, null, { statusChanged: true });
  assert.equal(run.activity.label, 'Queued');
  run.status = 'paused-limit'; run.activity = nextActivity(run, null, { statusChanged: true });
  assert.equal(run.activity.state, 'paused');
  forgetRun('track2');
  ok('tracker: plan hint, tools without ids, queued, paused');
}

// ── 3. redaction ──
const secrets = {
  bearer: ['curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def" https://api.example.com', 'Bearer [redacted]'],
  sk: ['export OPENAI=sk-proj-AbCdEfGhIjKlMnOpQrStUvWx', 'sk-[redacted]'],
  skant: ['key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA used', 'sk-[redacted]'],
  ghp: ['git clone https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/x/y', 'ghp_[redacted]'],
  xox: ['SLACK=xoxb-123456789012-abcdefABCDEF', 'xoxb-[redacted]'],
  query: ['https://api.example.com/v1/search?q=cats&api_key=abc123def456&token=zzz999', 'api_key=[redacted]&token=[redacted]'],
  env: ['ELEVENLABS_API_KEY=el_0123456789abcdef node render.mjs', 'ELEVENLABS_API_KEY=[redacted]'],
  ps: ['$env:TYPESAFE_API_KEY="ts-live-123456"; one --agent list', 'TYPESAFE_API_KEY=[redacted]'],
  json: ['{"api_key": "abcd1234", "query": "x"}', '"api_key": "[redacted]"'],
  aws: ['AWS key AKIAABCDEFGHIJKLMNOP in a log', 'AKIA[redacted]'],
  google: ['maps?key=AIzaSyA1234567890abcdefghijklmnopqrstu', 'key=[redacted]'],
};
for (const [name, [input, want]] of Object.entries(secrets)) {
  const out = redact(input);
  assert.ok(out.includes(want), `${name}: ${out}`);
}
assert.ok(!redact(secrets.query[0]).includes('abc123def456'));
assert.ok(!redact(secrets.ps[0]).includes('ts-live-123456'));
// what must survive: One connection keys and action ids, plain words, PATH-like vars
for (const keep of ['one --agent actions execute notion conn_mod_def::GJ5EntqNvy0::-VzfhSExTEGG live::notion::default::7afbc74a0e4342a2', 'K=live::notion::default::7afb; A=conn_mod_def::X', 'PATH=/usr/bin npm test', 'Searching the web: best skeleton keys', 'max_tokens=4000']) assert.equal(redact(keep), keep);
const ev = redactEvent({ kind: 'tool', tool: 'Bash', summary: 'Running `GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 gh pr list`', input: { command: 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 gh pr list', headers: { Authorization: 'token abc', 'x-api-key': 'k-123' }, nested: [{ password: 'hunter2' }], max_tokens: 5 } });
assert.ok(!JSON.stringify(ev).includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
assert.equal(ev.input.headers.Authorization, '[redacted]'); assert.equal(ev.input.headers['x-api-key'], '[redacted]');
assert.equal(ev.input.nested[0].password, '[redacted]'); assert.equal(ev.input.max_tokens, 5); assert.equal(ev.tool, 'Bash');
ok(`redaction: ${Object.keys(secrets).length} secret shapes blanked, One keys/ids and plain text kept, input keys`);

// ── 4. briefs: counts only ──
assert.equal(briefFor('Read', [{ type: 'text', text: '     1→# Plan\n     2→secret sk-ant-api03-XYZ\n     3→done' }]), '3 lines');
assert.equal(briefFor('Glob', 'a.md\nb.md\nc.md'), '3 files');
assert.equal(briefFor('Glob', 'No files found'), '0 files');
assert.equal(briefFor('Grep', 'Found 3 files\na\nb\nc'), '3 files');
assert.equal(briefFor('Grep', 'No matches found'), '0 matches');
assert.equal(briefFor('WebSearch', 'Web search results for query: "x"\n\nLinks: [{"title":"A","url":"https://a"},{"title":"B","url":"https://b"}]'), '2 results');
assert.equal(briefFor('Edit', 'The file /secret/path.md has been updated.'), 'saved');
assert.equal(briefFor('Bash', ''), 'no output');
assert.equal(briefFor('Bash', 'hello'), '5 chars');
assert.equal(briefFor('mcp__x__shot', [{ type: 'image', source: {} }]), '1 image');
assert.equal(briefFor('WebFetch', 'x'.repeat(3200)), '3.2k chars');
for (const b of ['3 lines', briefFor('Bash', 'TOKEN=abc\nsk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAA')]) assert.match(b, /^\d+(\.\d)?k? (lines?|chars?)$/);
ok('briefs: lines/files/matches/results/images/chars, never the payload');

// ── 5. text coalescing ──
{
  const out = [];
  const b = textBuffer(t => out.push(t));
  for (const d of ['\n\nThe `mcp', '__jos__report_done`', ' tool', ' rejected', ' every', ' call']) b.add(d);
  b.flush(); b.flush();
  assert.deepEqual(out, ['The `mcp__jos__report_done` tool rejected every call']);
  b.add('One', 3); b.add(' two', 3); b.add('Three', 4); b.flush();
  assert.deepEqual(out.slice(1), ['One two', 'Three']);
  ok('text deltas → one text event per message (flush, or a new message key)');
}

// ── 6. Codex item/completed ──
assert.deepEqual(codexCompleted({ id: 'i1', type: 'commandExecution', status: 'completed', exitCode: 0, aggregatedOutput: 'a\nb\n' }), { kind: 'tool_done', toolUseId: 'i1', tool: 'Bash', ok: true, brief: '2 lines' });
assert.equal(codexCompleted({ id: 'i2', type: 'commandExecution', status: 'failed', exitCode: 1, aggregatedOutput: '{"error":"Error: fetch failed"}' }).text, 'Exit 1: {"error":"Error: fetch failed"}');
assert.deepEqual(codexCompleted({ id: 'i3', type: 'commandExecution', status: 'declined' }), { kind: 'tool_done', toolUseId: 'i3', tool: 'Bash', ok: false, brief: 'declined' });
assert.equal(codexCompleted({ id: 'i4', type: 'mcpToolCall', server: 'jos', tool: 'note', status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } }).brief, '2 chars');
assert.equal(codexCompleted({ id: 'i5', type: 'mcpToolCall', server: 's', tool: 't', error: { message: 'boom' } }).kind, 'tool_error');
assert.equal(codexCompleted({ id: 'i6', type: 'fileChange', status: 'completed', changes: [{ path: 'a' }, { path: 'b' }] }).brief, '2 files');
assert.equal(codexCompleted({ id: 'i7', type: 'webSearch', status: 'completed' }).kind, 'tool_done');
assert.equal(codexCompleted({ id: 'i8', type: 'reasoning' }), null);
ok('Codex item/completed → tool_done / tool_error with toolUseId');

// ── 7. one Claude run through the real runner (disposable copy, fake claude) ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchy-activity-test-'));
try {
  const orch = path.join(tmp, 'orchestrator'), wsDir = path.join(tmp, 'workspaces', 'test');
  fs.mkdirSync(orch); fs.mkdirSync(wsDir, { recursive: true });
  fs.cpSync(path.join(ROOT, 'orchestrator/lib'), path.join(orch, 'lib'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'orchestrator/mcp'), path.join(orch, 'mcp'), { recursive: true });
  if (fs.existsSync(path.join(ROOT, 'node_modules'))) fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(orch, 'config.json'), JSON.stringify({
    timezone: 'UTC', owner: { name: 'Sam' }, orchy: {},
    workspaces: [{ id: 'test', name: 'Test Workspace', folder: 'workspaces/test', client: 'Test', runtime: 'claude', claudeAccount: 'x@example.com', claudeConfigDir: path.join(tmp, 'claude-home') }],
    runtimes: { claude: { label: 'Claude Code', models: ['haiku', 'sonnet', 'opus'] } },
  }));
  fs.writeFileSync(path.join(orch, 'voice-agents.json'), '{"agents":[]}');
  const lines = [
    { type: 'system', subtype: 'init', session_id: 's1', mcp_servers: [{ name: 'jos', status: 'connected' }] },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the plan first.' }, { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/x/plan.md' } }, { type: 'tool_use', id: 'toolu_02', name: 'Grep', input: { pattern: 'schedule', output_mode: 'files_with_matches' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: [{ type: 'text', text: '     1→# Plan\n     2→OPENAI_API_KEY=sk-proj-LEAKLEAKLEAKLEAKLEAKLEAK\n     3→done' }] }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_02', content: 'Found 3 files\na.md\nb.md\nc.md' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_03', name: 'Bash', input: { command: 'TAVILY_API_KEY=tvly-SECRETSECRET one --agent actions execute tavily conn_mod_def::X live::tavily::default::abc -d \'{"query":"x"}\'' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_03', is_error: true, content: 'Exit code 1\nfetch failed for Bearer abcdefghijklmnop' }] } },
    { type: 'assistant', message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 }, content: [{ type: 'text', text: 'Done.' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'Done.', num_turns: 3, total_cost_usd: 0.01, session_id: 's1', usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } },
  ];
  const fixture = path.join(tmp, 'fake-claude.cjs');
  fs.writeFileSync(fixture, `
const argv = process.argv.slice(2);
if (argv[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, email: 'x@example.com' })); process.exit(0); }
if (argv[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
if (argv[argv.indexOf('--output-format') + 1] === 'json') { process.stdin.resume(); process.stdin.on('data', () => {}).on('end', () => { console.log(JSON.stringify({ result: 'Hi.', session_id: 'q1', total_cost_usd: 0.0012345, usage: { input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 4 } })); process.exit(0); }); return; }
require('fs').writeFileSync(${JSON.stringify(path.join(tmp, 'argv.json'))}, JSON.stringify(argv));
process.stdin.resume(); process.stdin.on('data', () => {}).on('end', () => {
  const lines = ${JSON.stringify(lines.map(l => JSON.stringify(l)))};
  let i = 0; const next = () => { if (i >= lines.length) return process.exit(0); process.stdout.write(lines[i++] + '\\n'); setTimeout(next, 15); }; next();
});
`);
  const shim = path.join(tmp, process.platform === 'win32' ? 'fake-claude.cmd' : 'fake-claude');
  fs.writeFileSync(shim, process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n` : `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`);
  if (process.platform !== 'win32') fs.chmodSync(shim, 0o755);
  fs.writeFileSync(path.join(tmp, '.env'), `CLAUDE_CLI_PATH=${shim}\n`);
  const mod = file => import(pathToFileURL(path.join(orch, 'lib', file)).href);
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const B = await mod('bus.mjs');
  const Rn = await mod('runner.mjs');
  const seen = [];
  B.bus.on('event', e => { if (e.type === 'run.event' || e.type === 'run.updated') seen.push(e); });
  const run = await Rn.startRun({ workspace: 'test', instruction: 'Read the plan', model: 'haiku' });
  for (let i = 0; i < 400 && !Rn.getRun(run.id).endedAt; i++) await delay(25);
  const r = Rn.getRun(run.id);
  assert.equal(r.outcome, 'completed', r.error);
  const evs = fs.readFileSync(path.join(orch, 'data', 'runs', `${run.id}.jsonl`), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(evs.map(e => e.n), evs.map((_, i) => i + 1));
  assert.equal(r.evN, evs.length);
  const tools = evs.filter(e => e.kind === 'tool');
  assert.deepEqual(tools.map(e => e.toolUseId), ['toolu_01', 'toolu_02', 'toolu_03']);
  const done = evs.filter(e => e.kind === 'tool_done');
  assert.deepEqual(done.map(e => [e.toolUseId, e.tool, e.ok, e.brief]), [['toolu_01', 'Read', true, '3 lines'], ['toolu_02', 'Grep', true, '3 files']]);
  const err = evs.find(e => e.kind === 'tool_error');
  assert.equal(err.toolUseId, 'toolu_03'); assert.equal(err.tool, 'Bash');
  const raw = fs.readFileSync(path.join(orch, 'data', 'runs', `${run.id}.jsonl`), 'utf8');
  for (const leak of ['sk-proj-LEAK', 'tvly-SECRETSECRET', 'abcdefghijklmnop']) assert.ok(!raw.includes(leak), `leaked ${leak}`);
  assert.match(raw, /TAVILY_API_KEY=\[redacted\]/);
  // run.event carries the activity, step by step
  const acts = seen.filter(e => e.type === 'run.event' && e.runId === run.id).map(e => `${e.event.kind}:${e.activity?.state}`);
  assert.deepEqual(acts.filter(a => !a.startsWith('system')), [
    'text:working', 'tool:reading-files', 'tool:reading-files', 'tool_done:reading-files', 'tool_done:working',
    'tool:using-app', 'tool_error:working', 'text:working',
  ]);
  assert.equal(acts.at(-1), 'system:completed');
  const toolAct = seen.find(e => e.type === 'run.event' && e.event.toolUseId === 'toolu_03' && e.event.kind === 'tool').activity;
  assert.deepEqual({ state: toolAct.state, label: toolAct.label, tool: toolAct.tool, app: toolAct.app, toolUseId: toolAct.toolUseId }, { state: 'using-app', label: 'Using Tavily', tool: 'Bash', app: 'tavily', toolUseId: 'toolu_03' });
  assert.ok(toolAct.since);
  assert.ok(seen.some(e => e.type === 'run.updated' && e.run.id === run.id && e.run.activity?.state === 'working'));
  assert.equal(r.activity.state, 'completed');
  assert.deepEqual(r.tokens, { input: 100, output: 5, total: 105, uncachedInput: 10, cacheRead: 90, cacheCreate: 0 });
  assert.equal(r.lastInputTokens, 100);
  ok(`runner: a Claude transcript → n 1..${evs.length}, toolUseId, tool_done briefs, redacted jsonl, activity on run.event + run.updated, tokens`);

  // the settings file a run gets: the root's instructions excluded, image reads gated, the cwd hook on shell calls
  const argv = JSON.parse(fs.readFileSync(path.join(tmp, 'argv.json'), 'utf8'));
  const settings = JSON.parse(fs.readFileSync(argv[argv.indexOf('--settings') + 1], 'utf8'));
  const fwd = p => p.replace(/\\/g, '/');
  // Orchy's root is where its code really is (Node resolves module paths: /var is /private/var on macOS), and runs work
  // under that same real path, so that's the one excluded (fs.realpathSync is how Node resolves them; .native would
  // also spell out Windows short names, which Node keeps)
  const real = fs.realpathSync(tmp);
  assert.ok(settings.claudeMdExcludes.includes(fwd(path.join(real, 'CLAUDE.md'))) && settings.claudeMdExcludes.includes(path.join(real, 'AGENTS.md')), JSON.stringify(settings.claudeMdExcludes));
  assert.ok(settings.permissions.ask.includes('Read(./**/*.png)') && settings.permissions.ask.includes('Edit(./CLAUDE.md)'));
  const hook = settings.hooks.PreToolUse[0];
  assert.equal(hook.matcher, 'Bash|PowerShell');
  assert.ok(hook.hooks[0].command.includes('cwd-hook.mjs') && hook.hooks[0].command.includes(run.id), hook.hooks[0].command);
  assert.ok(!argv.includes('--effort'), 'no --effort without an agent effort');
  // the cost line for the workspace's own agents
  const cost = JSON.parse(fs.readFileSync(path.join(wsDir, '.jos', 'costs.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.equal(cost.runId, run.id); assert.equal(cost.source, 'owner'); assert.equal(cost.costUsd, 0.01); assert.equal(cost.tokens.total, 105);
  ok('run settings: root CLAUDE.md/AGENTS.md excluded, image reads asked, cwd hook on Bash|PowerShell; cost line in .jos/costs.jsonl');

  // Orchy's own model calls: one line each in data/orchy-costs.jsonl, with what they were for
  const C = await mod('claude.mjs');
  const q = await C.quickClaude({ prompt: 'hello', purpose: 'report', workspace: 'test', cwd: tmp });
  assert.equal(q.text, 'Hi.'); assert.equal(q.tokens.total, 54);
  const oc = fs.readFileSync(path.join(orch, 'data', 'orchy-costs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).at(-1);
  assert.deepEqual({ purpose: oc.purpose, workspace: oc.workspace, costUsd: oc.costUsd, model: oc.model, total: oc.tokens.total }, { purpose: 'report', workspace: 'test', costUsd: 0.00123, model: 'haiku', total: 54 });
  ok('quickClaude: Orchy\'s own call is logged with its purpose, workspace, cost and tokens');
} finally {
  assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await new Promise(r => setTimeout(r, 400));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
}
console.log('test-activity: all passed');
process.exit(0);
