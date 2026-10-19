// Offline checks for the Cursor engine (engines/cursor.mjs) in a disposable Orchy copy: a fake `agent` that reads the
// plugin Orchy writes, runs its hook commands the way Cursor does (the payload on stdin) and prints Cursor's stream-json.
// No real Cursor, no sign-in, no model calls, no network.
//   node orchestrator/scripts/test-engine-cursor.mjs
// Checks: the hook payload → gate calls (MCP judged with its server, Cursor's spill files as bookkeeping, deletes as
// commands); stream-json → feed; the forced config and arguments (never --force); gated with no allowUngated; the shared
// account; the plugin's hooks reach the gate through a bridge (allowed, owner-denied, fail closed), the bridge token only
// in the environment; MSYS variables dropped; resume; crashed and stopped runs; no client tasks, no huddles.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { ROOT } from '../lib/env.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orchy-cursor-test-')));
const orch = path.join(tmp, 'orchestrator');
const wsDir = path.join(tmp, 'workspaces', 'Test');
const otherDir = path.join(tmp, 'workspaces', 'Other');
const cursorHomes = path.join(tmp, 'cursor-homes');
const oneHome = path.join(tmp, 'onehome');
fs.mkdirSync(orch); fs.mkdirSync(wsDir, { recursive: true }); fs.mkdirSync(otherDir, { recursive: true });
fs.cpSync(path.join(ROOT, 'orchestrator/lib'), path.join(orch, 'lib'), { recursive: true });
fs.cpSync(path.join(ROOT, 'orchestrator/mcp'), path.join(orch, 'mcp'), { recursive: true });
if (fs.existsSync(path.join(ROOT, 'node_modules'))) fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
fs.writeFileSync(path.join(orch, 'config.json'), JSON.stringify({
  timezone: 'UTC', owner: { name: 'Sam' }, orchy: {},
  workspaces: [
    { id: 'test', name: 'Test Workspace', folder: 'workspaces/Test', client: 'Test', runtime: 'cursor', cursorAccount: 'shared@example.com', cursorHome: path.join(cursorHomes, 'test') },
    { id: 'other', name: 'Other Workspace', folder: 'workspaces/Other', client: 'Other', runtime: 'claude', claudeAccount: 'x@example.com' },
  ],
  runtimes: { claude: { label: 'Claude Code', models: ['haiku', 'sonnet', 'opus'] } },
}));
fs.writeFileSync(path.join(orch, 'voice-agents.json'), '{"agents":[]}');
fs.copyFileSync(path.join(ROOT, '.cursorignore'), path.join(tmp, '.cursorignore')); // Orchy's own instructions stay out of Cursor runs
// the test workspace has its own One login; One looks it up by folder
const oneConfig = path.join(oneHome, '.one', 'projects', path.resolve(wsDir).replace(/[\\/<>:"|?*]/g, '-'), 'config.json');
fs.mkdirSync(path.dirname(oneConfig), { recursive: true }); fs.writeFileSync(oneConfig, '{}');

const who = path.join(tmp, 'who.txt');
const fake = path.join(tmp, 'fake-cursor.mjs');
fs.writeFileSync(fake, `
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import { spawnSync } from 'node:child_process';
const argv = process.argv.slice(2), flag = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const email = fs.existsSync(${JSON.stringify(who)}) ? fs.readFileSync(${JSON.stringify(who)}, 'utf8').trim() : 'shared@example.com';
if (argv.includes('--version')) { console.log('2026.10.16-fake'); process.exit(0); }
if (argv[0] === 'status') { console.log(JSON.stringify({ status: 'authenticated', isAuthenticated: true, hasAccessToken: true, userInfo: { email, userId: 1 } })); process.exit(0); }
if (argv[0] === 'models') { console.log('Available models\\n\\nauto - Auto (default)\\ngpt-5.3-codex - Codex 5.3\\n'); process.exit(0); }
const out = m => process.stdout.write(JSON.stringify(m) + '\\n');
let prompt = '';
process.stdin.on('data', d => prompt += d).on('end', () => {
  const plugin = flag('--plugin-dir'), workspace = flag('--workspace');
  const id = flag('--resume') || (prompt.includes('WAIT') ? 'chat-wait' : 'chat-1');
  if (prompt.includes('HANG')) return setInterval(() => {}, 1000);
  if (prompt.includes('CRASH')) { process.stderr.write('Error: the model connection dropped\\n'); process.exit(3); }
  out({ type: 'system', subtype: 'init', apiKeySource: 'login', cwd: process.cwd(), session_id: id, model: 'Auto', permissionMode: 'default' });
  if (prompt.includes('WAIT')) return setInterval(() => {}, 1000);
  const hooks = JSON.parse(fs.readFileSync(path.join(plugin, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const toks = cmd => (cmd.match(/"[^"]*"|\\S+/g) || []).map(t => t.replace(/^"|"$/g, ''));
  const hook = (event, payload) => { const t = toks(hooks[event][0].command); const r = spawnSync(t[0], t.slice(1), { input: JSON.stringify({ conversation_id: id, session_id: id, hook_event_name: event, workspace_roots: [workspace], cursor_version: 'fake', ...payload }), encoding: 'utf8', env: process.env }); let d = null; try { d = JSON.parse(r.stdout); } catch {} return { permission: d?.permission || null, message: d?.agent_message || '', code: r.status }; };
  const slug = path.resolve(workspace).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const hooked = prompt.includes('HOOKS') ? {
    echo: hook('preToolUse', { tool_name: 'Shell', tool_input: { command: 'echo hi', cwd: '' }, cwd: workspace }),
    mcpPre: hook('preToolUse', { tool_name: 'MCP:note', tool_input: { text: 'x' } }),
    mcp: hook('beforeMCPExecution', { tool_name: 'note', tool_input: JSON.stringify({ text: 'x' }), mcp_server_name: 'plugin-orchy-jos', command: 'node bridge.mjs' }),
    spill: hook('preToolUse', { tool_name: 'Write', tool_input: { file_path: path.join(os.homedir(), '.cursor', 'projects', slug, 'agent-tools', 'big.txt'), content: 'long output' } }),
    computer: hook('preToolUse', { tool_name: 'ComputerUse', tool_input: { action: 'click' } }),
  } : null;
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Working on it.' }] }, session_id: id });
  out({ type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: { shellToolCall: { args: { command: 'echo hi', workingDirectory: '' } } }, session_id: id });
  out({ type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: { shellToolCall: { args: { command: 'echo hi' }, result: { success: { exitCode: 0, stdout: 'hi\\n', stderr: '' } } } }, session_id: id });
  out({ type: 'tool_call', subtype: 'started', call_id: 'c2', tool_call: { mcpToolCall: { args: { name: 'plugin-orchy-jos-note', args: { text: 'x' }, providerIdentifier: 'plugin-orchy-jos', toolName: 'note' } } }, session_id: id });
  out({ type: 'tool_call', subtype: 'completed', call_id: 'c2', tool_call: { mcpToolCall: { args: { providerIdentifier: 'plugin-orchy-jos', toolName: 'note', args: {} }, result: { success: { content: [{ text: { text: 'noted' } }] } } } }, session_id: id });
  out({ type: 'tool_call', subtype: 'started', call_id: 'c3', tool_call: { webSearchToolCall: { args: { searchTerm: 'news' } } }, session_id: id });
  out({ type: 'tool_call', subtype: 'completed', call_id: 'c3', tool_call: { webSearchToolCall: { args: { searchTerm: 'news' }, result: { rejected: { reason: 'User Rejected' } } } }, session_id: id });
  const config = JSON.parse(fs.readFileSync(path.join(process.env.CURSOR_CONFIG_DIR, 'cli-config.json'), 'utf8'));
  const report = { hooked, hooks, args: argv, model: flag('--model'), resumed: !!flag('--resume'), config,
    pluginJson: JSON.parse(fs.readFileSync(path.join(plugin, '.cursor-plugin', 'plugin.json'), 'utf8')), mcp: JSON.parse(fs.readFileSync(path.join(plugin, 'mcp.json'), 'utf8')),
    runId: process.env.JOS_RUN_ID || null, token: !!process.env.JOS_TOKEN, msystem: process.env.MSYSTEM || null, configDir: process.env.CURSOR_CONFIG_DIR, noBrowser: process.env.NO_OPEN_BROWSER,
    promptHasProtocol: prompt.includes('Working on Cursor') && prompt.includes('# Current request') };
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }, session_id: id });
  out({ type: 'result', subtype: 'success', duration_ms: 10, is_error: false, result: JSON.stringify(report), session_id: id, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0 } });
});
`);
fs.writeFileSync(path.join(tmp, '.env'), `JEV_PROVIDER=off\nCURSOR_CLI_PATH=${fake}\nONE_HOME=${oneHome}\n`);
const mod = file => import(pathToFileURL(path.join(orch, 'lib', file)).href);
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 500; i++) { const v = fn(); if (v) return v; await delay(20); } throw new Error('Test timed out'); }
let debugRun = null; // printed when a check fails
process.env.MSYSTEM = 'MINGW64'; // as under Git Bash: it must never reach Cursor (its hooks would all fail)

try {
  const C = await mod('engines/cursor.mjs');
  const H = await mod('engines/hookmap.mjs');
  const E = await mod('engines/index.mjs');
  const W = await mod('workspaces.mjs');
  const R = await mod('runner.mjs');
  const I = await mod('inbox.mjs');
  const ws = () => W.workspace('test');
  const pending = id => I.itemsForRun(id).find(i => i.status === 'pending');

  // ── hook payload → the gate's calls ──
  const home = path.join(tmp, 'home');
  const hc = (payload) => H.cursorHookCalls({ conversation_id: 'c', hook_event_name: 'preToolUse', workspace_roots: [wsDir], ...payload }, { home }).calls;
  assert.equal(H.cursorHookCalls({ conversation_id: 'chat-9', tool_name: 'Read', tool_input: {} }).sessionId, 'chat-9');
  assert.deepEqual(hc({ tool_name: 'Shell', tool_input: { command: 'git status', cwd: '' }, cwd: wsDir }), [{ tool: 'Bash', input: { command: 'git status', cwd: path.resolve(wsDir) } }]);
  assert.equal(hc({ tool_name: 'WriteShellStdin', tool_input: { chars: 'rm -rf x\n' } })[0].tool, 'Bash');
  assert.deepEqual(hc({ tool_name: 'Write', tool_input: { file_path: 'a.txt', content: 'hi' } }), [{ tool: 'Write', input: { file_path: path.join(wsDir, 'a.txt'), content: 'hi' } }]);
  assert.match(hc({ tool_name: 'Delete', tool_input: { file_path: 'old.txt' } })[0].input.command, /^rm -f ".*old\.txt"$/); // judged as the delete it is
  assert.equal(hc({ tool_name: 'MCP:note', tool_input: {} })[0].tool, 'TodoWrite'); // judged in beforeMCPExecution instead
  assert.deepEqual(H.cursorHookCalls({ conversation_id: 'c', hook_event_name: 'beforeMCPExecution', tool_name: 'send_email', tool_input: '{"to":"a@b.c"}', mcp_server_name: 'plugin-orchy-gmail' }).calls, [{ tool: 'mcp__gmail__send_email', input: { to: 'a@b.c' } }]);
  const spill = path.join(home, '.cursor', 'projects', H.cursorProjectSlug(wsDir), 'agent-tools', 'x.txt');
  assert.equal(hc({ tool_name: 'Write', tool_input: { file_path: spill } })[0].tool, 'TodoWrite'); // Cursor's own spill file
  assert.equal(hc({ tool_name: 'Read', tool_input: { file_path: spill } })[0].tool, 'TodoWrite');
  assert.equal(hc({ tool_name: 'Read', tool_input: { file_path: path.join(home, '.cursor', 'projects', 'other-ws', 'agent-tools', 'x.txt') } })[0].tool, 'Read'); // another workspace's: judged
  assert.equal(hc({ tool_name: 'Read', tool_input: { file_path: path.join(home, '.cursor', 'projects', H.cursorProjectSlug(wsDir), 'mcp-auth.json') } })[0].tool, 'Read');
  assert.equal(hc({ tool_name: 'ComputerUse', tool_input: {} })[0].tool, 'cursor:ComputerUse'); // unknown: asks the owner
  assert.equal(hc({ tool_name: 'Task', tool_input: { description: 'd', prompt: 'p' } })[0].tool, 'Task');
  // in a git repo Cursor's root is the repo's top: a search with no folder is judged there; a delete in its file's folder
  const top = path.join(tmp, 'repo-top');
  assert.equal(H.cursorHookCalls({ conversation_id: 'c', hook_event_name: 'preToolUse', tool_name: 'Grep', tool_input: { pattern: 'x' }, workspace_roots: [top], cwd: wsDir }).calls[0].input.path, top);
  assert.equal(H.cursorHookCalls({ conversation_id: 'c', hook_event_name: 'preToolUse', tool_name: 'Delete', tool_input: { file_path: path.join(wsDir, 'a', 'b.txt') }, workspace_roots: [top] }).calls[0].input.cwd, path.join(wsDir, 'a'));

  // the fence: Orchy's root .cursorignore must hide its own instructions from any Cursor run inside its folder
  assert.equal(C.instructionsFenceProblem(wsDir, tmp), null);
  assert.equal(C.instructionsFenceProblem(os.tmpdir(), path.join(tmp, 'nowhere')), null); // outside Orchy's folder: nothing to hide
  const noFence = path.join(tmp, 'no-fence'); fs.mkdirSync(path.join(noFence, 'ws'), { recursive: true });
  assert.match(C.instructionsFenceProblem(path.join(noFence, 'ws'), noFence) || '', /cursorignore is missing \/AGENTS\.md, \/CLAUDE\.md/);

  // ── stream-json → feed ──
  assert.equal(C.parseCursorLine('{"type":"system","subtype":"init","session_id":"s1"}').sessionId, 's1');
  assert.equal(C.parseCursorLine('not json'), null);
  assert.deepEqual(C.parseCursorLine('{"type":"tool_call","subtype":"started","call_id":"k","tool_call":{"shellToolCall":{"args":{"command":"ls"}}}}').tool, { tool: 'Bash', input: { command: 'ls' } });
  assert.equal(C.parseCursorLine('{"type":"tool_call","subtype":"started","call_id":"k","tool_call":{"mcpToolCall":{"args":{"providerIdentifier":"plugin-orchy-notion","toolName":"search","args":{}}}}}').tool.tool, 'mcp__notion__search');
  assert.match(C.parseCursorLine('{"type":"tool_call","subtype":"completed","call_id":"k","tool_call":{"editToolCall":{"args":{"path":"a"},"result":{"rejected":{"reason":"Denied by Orchy\\n\\nAgent note: Do not suggest workarounds."}}}}}').denied.message, /^Denied by Orchy$/);
  assert.equal(C.parseCursorLine('{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"s"}').result.ok, true);
  assert.equal(C.parseCursorLine('{"type":"result","subtype":"error","is_error":true,"result":"","session_id":"s"}').result.ok, false);

  // ── what Orchy hands Cursor ──
  const args = C.cursorArgs({ plugin: 'P', workspace: 'W', model: 'gpt-5.3-codex', resume: 'chat-1' });
  assert.ok(['-p', '--trust', '--plugin-dir', '--workspace', '--resume'].every(a => args.includes(a)));
  assert.ok(!args.some(a => /^--(force|yolo|approve-mcps|auto-review|sandbox)$/.test(a) || a === '-f'), 'never --force, --approve-mcps, --auto-review or --sandbox');
  assert.ok(!C.cursorArgs({ plugin: 'P', workspace: 'W', model: 'default' }).includes('--model'));
  const cfg = C.cursorConfig();
  assert.equal(cfg.approvalMode, 'allowlist'); assert.equal(cfg.autoAcceptWebSearch, false); assert.equal(cfg.sandbox.mode, 'disabled');
  assert.ok(!cfg.permissions.allow.some(p => /web/i.test(p)), 'no web tool is allowlisted');
  const env = C.cursorEnv('CFG', { JOS_TOKEN: 't' }, { PATH: '/bin', MSYSTEM: 'MINGW64', EXEPATH: 'C:/Git', SHELL: '/usr/bin/bash', CURSOR_API_KEY: 'k', CURSOR_AUTH_TOKEN: 'k', CURSOR_API_ENDPOINT: 'https://evil.example', OPENAI_API_KEY: 'k', FOO: '1' });
  assert.ok(env.CURSOR_CONFIG_DIR === 'CFG' && env.JOS_TOKEN === 't' && env.FOO === '1' && env.NO_OPEN_BROWSER === '1');
  for (const k of ['MSYSTEM', 'EXEPATH', 'SHELL', 'CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN', 'CURSOR_API_ENDPOINT', 'OPENAI_API_KEY']) assert.equal(env[k], undefined, `${k} must not reach Cursor`);
  assert.deepEqual(C.parseCursorStatus('{"isAuthenticated":true,"userInfo":{"email":"a@b.c"}}'), { loggedIn: true, email: 'a@b.c' });
  assert.equal(C.parseCursorStatus('{"isAuthenticated":false}').loggedIn, false);
  assert.deepEqual(C.parseCursorModels('Available models\n\nauto - Auto (default)\nclaude-opus-5-thinking-high - Claude Opus 5\n'), ['auto', 'claude-opus-5-thinking-high']);
  // a version folder (what the Windows installer keeps) is started as its own node + index.js
  const vroot = path.join(tmp, 'cursor-agent'), vdir = path.join(vroot, 'versions', '2026.10.16-e3cb207');
  fs.mkdirSync(vdir, { recursive: true }); fs.writeFileSync(path.join(vdir, 'index.js'), ''); fs.writeFileSync(path.join(vdir, process.platform === 'win32' ? 'node.exe' : 'node'), '');
  fs.mkdirSync(path.join(vroot, 'versions', '2026.9.1-aaaaaaa'), { recursive: true });
  assert.equal(C.newestCursorVersion(vroot), vdir);

  const eng = E.engine('cursor');
  assert.equal(eng.capabilities.gated, true); assert.equal(eng.capabilities.clientSafe, false); assert.equal(eng.capabilities.huddles, false);
  assert.equal(E.engineOffered(eng), true); assert.equal(E.ungatedRefusal(ws(), eng), null);
  assert.equal(eng.version(), '2026.10.16-fake');

  // a bridge like server.mjs's: the hook's POST /api/bridge/tool-hook reaches runner.toolHook with the bridge token
  const bridge = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const send = (code, j) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (req.url !== '/api/bridge/tool-hook' || req.headers['x-jos-token'] !== R.BRIDGE_TOKEN) return send(401, { error: 'Bad bridge token' });
    const b = JSON.parse(body);
    send(200, await R.toolHook({ engine: b.engine, sessionId: b.sessionId, calls: b.calls, maxWaitMs: b.maxWaitMs }));
  });
  await new Promise(r => bridge.listen(0, '127.0.0.1', r));
  R.setPort(bridge.address().port);

  // the shared account: the right one runs, anyone else blocks every Cursor workspace
  assert.equal(W.modelFor(ws(), 'opus'), 'auto'); // every tier is Cursor's own pick
  assert.equal(W.modelFor(ws(), 'claude-opus-5-thinking-high'), 'claude-opus-5-thinking-high'); // any Cursor model id passes
  let acct = await W.accountCheck(ws(), { force: true });
  assert.equal(acct.ok, true, acct.error); assert.equal(acct.actual, 'shared@example.com');
  assert.ok((acct.availableModels || []).includes('gpt-5.3-codex'));
  assert.throws(() => W.updateWorkspace('other', { runtime: 'cursor', account: 'someone@else.com' }), /runs as shared@example.com/);
  assert.throws(() => W.updateWorkspace('test', { ownProfile: true, account: 'shared@example.com' }), /one sign-in/);
  fs.writeFileSync(who, 'intruder@example.com');
  acct = await W.accountCheck(ws(), { force: true });
  assert.equal(acct.ok, false); assert.equal(acct.actual, 'intruder@example.com');
  await assert.rejects(R.startRun({ workspace: 'test', instruction: 'Wrong account' }), /must run as shared@example.com/);
  fs.rmSync(who);
  await W.accountCheck(ws(), { force: true });

  // a run: the plugin's hooks, run as Cursor runs them, reach the gate
  const run = await R.startRun({ workspace: 'test', instruction: 'Test run HOOKS', model: 'gpt-5.3-codex' });
  debugRun = () => { const x = R.getRun(run.id); let feedText = ''; try { feedText = fs.readFileSync(path.join(orch, 'data', 'runs', `${run.id}.jsonl`), 'utf8').slice(-3000); } catch {} return { status: x.status, error: x.error, outcome: x.outcome, sessionId: x.sessionId, feedText }; };
  const ask = await until(() => pending(run.id)); // the unknown tool asks; the echo, the bridge note and the spill passed on their own
  assert.match(`${ask.title} ${ask.message} ${ask.detail || ''}`, /ComputerUse/i); assert.equal(ask.kind, 'approval');
  assert.equal(R.getRun(run.id).status, 'waiting');
  I.answer(ask.id, { approve: false, note: 'not today' });
  await until(() => R.getRun(run.id).endedAt);
  const r = R.getRun(run.id);
  assert.equal(r.outcome, 'completed', r.error);
  assert.equal(r.sessionId, 'chat-1');
  const seen = JSON.parse(r.resultText);
  assert.deepEqual([seen.hooked.echo.permission, seen.hooked.echo.code], ['allow', 0], JSON.stringify(seen.hooked.echo));
  assert.equal(seen.hooked.mcpPre.permission, 'allow');
  assert.equal(seen.hooked.mcp.permission, 'allow');
  assert.equal(seen.hooked.spill.permission, 'allow');
  assert.deepEqual([seen.hooked.computer.permission, seen.hooked.computer.code], ['deny', 0]); assert.match(seen.hooked.computer.message, /not today/);
  for (const ev of ['preToolUse', 'beforeMCPExecution']) {
    const h = seen.hooks[ev]?.[0];
    assert.ok(h && h.failClosed === true && h.timeout >= 3600, `${ev}: failClosed, long timeout`);
    assert.match(h.command, /tool-hook\.mjs" "cursor" "/); assert.ok(!h.command.includes(R.BRIDGE_TOKEN)); // the token is only in Orchy's data folder
  }
  assert.equal(seen.pluginJson.name, 'orchy');
  assert.deepEqual(Object.keys(seen.mcp.mcpServers), ['jos']); assert.equal(seen.mcp.mcpServers.jos.env, undefined); // no token in the file
  assert.equal(seen.config.approvalMode, 'allowlist'); assert.equal(seen.config.autoAcceptWebSearch, false);
  assert.ok(!seen.args.some(a => /^--(force|yolo|approve-mcps)$/.test(a)));
  assert.equal(seen.args[seen.args.indexOf('--workspace') + 1], ws().dir);
  assert.equal(seen.model, 'gpt-5.3-codex');
  assert.equal(seen.runId, run.id); assert.equal(seen.token, true); // the bridge's run id + token ride in Cursor's environment
  assert.equal(seen.msystem, null); assert.equal(seen.noBrowser, '1');
  assert.equal(path.resolve(seen.configDir), path.join(cursorHomes, 'test', 'general', 'config'));
  assert.equal(seen.promptHasProtocol, true);
  const feed = fs.readFileSync(path.join(orch, 'data', 'runs', `${run.id}.jsonl`), 'utf8');
  assert.match(feed, /"kind":"denied"/); assert.match(feed, /web search is off in Orchy/); assert.match(feed, /mcp__jos__note/); assert.match(feed, /"kind":"tool"/);
  assert.ok(r.tokens?.output === 5 && r.tokens.input === 110, JSON.stringify(r.tokens));

  // the hook fails closed: no live run for the session, a wrong token, no Orchy, no credentials
  assert.equal((await R.toolHook({ engine: 'cursor', sessionId: 'chat-1', calls: [{ tool: 'Bash', input: { command: 'echo hi' } }] })).allow, false); // that run has ended
  const hookRun = (creds, payload) => new Promise(resolve => {
    const c = spawn(process.execPath, [path.join(orch, 'mcp', 'tool-hook.mjs'), 'cursor', creds]);
    let stdout = '';
    c.stdout.on('data', d => { stdout += d; });
    c.on('close', status => resolve({ stdout, status }));
    c.stdin.end(JSON.stringify(payload));
  });
  const call = { conversation_id: 'chat-1', hook_event_name: 'preToolUse', tool_name: 'Shell', tool_input: { command: 'echo hi' }, workspace_roots: [wsDir] };
  const badCreds = path.join(tmp, 'bad-creds.json');
  fs.writeFileSync(badCreds, JSON.stringify({ url: `http://127.0.0.1:${bridge.address().port}`, token: 'wrong' }));
  let h = await hookRun(badCreds, call);
  assert.equal(JSON.parse(h.stdout).permission, 'deny'); assert.notEqual(h.status, 0);
  fs.writeFileSync(badCreds, JSON.stringify({ url: 'http://127.0.0.1:1', token: R.BRIDGE_TOKEN }));
  h = await hookRun(badCreds, call);
  assert.equal(JSON.parse(h.stdout).permission, 'deny'); assert.notEqual(h.status, 0);
  h = await hookRun(path.join(tmp, 'no-such-file.json'), call);
  assert.equal(JSON.parse(h.stdout).permission, 'deny'); assert.notEqual(h.status, 0);

  // no fence, no run: the run fails before Cursor starts
  fs.renameSync(path.join(tmp, '.cursorignore'), path.join(tmp, '.cursorignore.off'));
  const fenceless = await R.startRun({ workspace: 'test', instruction: 'No fence' });
  await until(() => R.getRun(fenceless.id).endedAt);
  assert.equal(R.getRun(fenceless.id).outcome, 'failed'); assert.match(R.getRun(fenceless.id).error, /cursorignore/);
  fs.renameSync(path.join(tmp, '.cursorignore.off'), path.join(tmp, '.cursorignore'));

  // a follow-up resumes the same Cursor chat
  const follow = await R.startRun({ workspace: 'test', instruction: 'Follow up', parentRunId: run.id, resumeSessionId: r.sessionId });
  await until(() => R.getRun(follow.id).endedAt);
  assert.equal(JSON.parse(R.getRun(follow.id).resultText).resumed, true);
  assert.equal(R.getRun(follow.id).sessionId, 'chat-1');

  // crashed, stopped
  const crash = await R.startRun({ workspace: 'test', instruction: 'CRASH' });
  debugRun = () => { const x = R.getRun(crash.id); let feedText = ''; try { feedText = fs.readFileSync(path.join(orch, 'data', 'runs', `${crash.id}.jsonl`), 'utf8').slice(-2000); } catch {} return { status: x.status, error: x.error, apiError: x.apiError, limitError: x.limitError, pid: x.pid, feedText }; };
  await until(() => R.getRun(crash.id).endedAt);
  assert.equal(R.getRun(crash.id).outcome, 'failed'); assert.match(R.getRun(crash.id).error, /model connection dropped/);
  const hang = await R.startRun({ workspace: 'test', instruction: 'HANG' });
  await until(() => R.getRun(hang.id).pid);
  R.stopRun(hang.id);
  await until(() => R.getRun(hang.id).endedAt);
  assert.equal(R.getRun(hang.id).outcome, 'stopped');

  // fences: no client tasks, no huddles
  await assert.rejects(R.startRun({ workspace: 'test', instruction: 'Client', client: { id: 'client', name: 'Client' } }), /can't work on a client's task/);
  await assert.rejects(R.startRun({ workspace: 'test', instruction: 'Huddle', huddleTalk: true }), /huddles are Claude Code only/);
  bridge.close();
  console.log('Cursor checks passed: hook payloads → gate calls, stream-json → feed, forced config and arguments (never --force), gated through its plugin hooks (allowed, owner-denied, fail closed), shared account, bridge token in the environment only, MSYS variables dropped, the .cursorignore fence, resume, crash/stop and client/huddle fences.');
} catch (e) {
  console.error(e); if (debugRun) console.error('run:', JSON.stringify(debugRun(), null, 1)); process.exitCode = 1;
} finally {
  // only the uniquely created temporary root is removed
  assert.ok(path.resolve(tmp).startsWith(fs.realpathSync(os.tmpdir())));
  await delay(500);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
  process.exit(process.exitCode || 0);
}
