// Offline checks for the Antigravity engine (engines/antigravity.mjs) in a disposable Orchy copy: a fake `agy` that
// replays the stream-json event shapes agy prints. No real agy, no sign-in, no model calls, no network.
//   node orchestrator/scripts/test-antigravity.mjs
// Checks: event + tool shapes; off unless ORCHY_ANTIGRAVITY=1; refused without allowUngated; the shared account
// (the right one runs, anyone else blocks, a second workspace can't name another); every run waits for the owner's
// OK (never remembered); agy's folder gets the deny rules and the bridge (its token only in the environment); resume;
// refused, crashed and stopped runs; no client tasks, no huddles, no runs without the workspace's own One login.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../lib/env.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orchy-agy-test-')));
const orch = path.join(tmp, 'orchestrator');
const wsDir = path.join(tmp, 'workspaces', 'Test');
const otherDir = path.join(tmp, 'workspaces', 'Other');
const agyHome = path.join(tmp, 'agy-homes');
const oneHome = path.join(tmp, 'onehome');
fs.mkdirSync(orch); fs.mkdirSync(wsDir, { recursive: true }); fs.mkdirSync(otherDir, { recursive: true });
fs.cpSync(path.join(ROOT, 'orchestrator/lib'), path.join(orch, 'lib'), { recursive: true });
fs.cpSync(path.join(ROOT, 'orchestrator/mcp'), path.join(orch, 'mcp'), { recursive: true });
if (fs.existsSync(path.join(ROOT, 'node_modules'))) fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
const config = (extra = {}) => fs.writeFileSync(path.join(orch, 'config.json'), JSON.stringify({
  timezone: 'UTC', owner: { name: 'Sam' }, orchy: {},
  workspaces: [
    { id: 'test', name: 'Test Workspace', folder: 'workspaces/Test', client: 'Test', runtime: 'antigravity', antigravityAccount: 'shared@example.com', antigravityHome: path.join(agyHome, 'test'), allowUngated: true, ...extra },
    { id: 'other', name: 'Other Workspace', folder: 'workspaces/Other', client: 'Other', runtime: 'claude', claudeAccount: 'x@example.com' },
  ],
  runtimes: { claude: { label: 'Claude Code', models: ['haiku', 'sonnet', 'opus'] } },
}));
config();
fs.writeFileSync(path.join(orch, 'voice-agents.json'), '{"agents":[]}');
// the test workspace has its own One login; One looks it up by folder
const oneConfig = path.join(oneHome, '.one', 'projects', path.resolve(wsDir).replace(/[\\/<>:"|?*]/g, '-'), 'config.json');
fs.mkdirSync(path.dirname(oneConfig), { recursive: true }); fs.writeFileSync(oneConfig, '{}');

const who = path.join(tmp, 'who.txt');
const fixture = path.join(tmp, 'fake-agy.cjs');
fs.writeFileSync(fixture, `
const fs = require('node:fs'), path = require('node:path');
const argv = process.argv.slice(2), flag = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const email = fs.existsSync(${JSON.stringify(who)}) ? fs.readFileSync(${JSON.stringify(who)}, 'utf8').trim() : 'shared@example.com';
if (argv.includes('models')) { fs.writeFileSync(flag('--log-file'), 'I1016 OAuth: authenticated successfully as ' + email + '\\n'); console.log('gemini-4-argon-high\\tGemini 4 Argon (High)'); process.exit(0); }
const out = m => process.stdout.write(JSON.stringify(m) + '\\n');
let input = '';
process.stdin.on('data', d => input += d).on('end', () => {
  const msg = JSON.parse(input.trim());
  const text = msg.message.content[0].text;
  const home = flag('--gemini_dir');
  const settings = JSON.parse(fs.readFileSync(path.join(home, 'antigravity-cli', 'settings.json'), 'utf8'));
  const mcp = JSON.parse(fs.readFileSync(path.join(home, 'config', 'mcp_config.json'), 'utf8'));
  const id = flag('--conversation') || 'conv-1';
  if (text.includes('HANG')) return setInterval(() => {}, 1000);
  if (text.includes('CRASH')) { process.stderr.write('AGY_ERROR: quota exhausted\\n'); process.exit(3); }
  out({ event: 'init', conversation_id: id, init: { cwd: process.cwd(), permission_mode: settings.toolPermission } });
  out({ event: 'step_update', step_update: { conversation_id: id, step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi', Cwd: process.cwd() } } } });
  out({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { name: 'call_mcp_tool', parameters: { ServerName: 'jos', ToolName: 'note', Arguments: { text: 'x' } } } } });
  out({ event: 'step_update', step_update: { conversation_id: id, step_index: 3, state: 'ERROR', step_type: 'tool', tool_name: 'write_to_file', tool_info: { name: 'write_to_file', parameters: { TargetFile: 'x/.claude/a.md' }, error: { type: 'TOOL_ERROR', message: 'permission check failed for write_file: Permission denied (matches user-configured deny rule)' } } } });
  const report = { args: argv, model: flag('--model'), effort: flag('--effort'), resumed: !!flag('--conversation'), runId: process.env.JOS_RUN_ID || null, token: !!process.env.JOS_TOKEN,
    settings, mcp, promptHasProtocol: text.includes('Working on Antigravity') && text.includes('# Current request') };
  out({ event: 'step_update', step_update: { conversation_id: id, step_index: 4, state: 'DONE', step_type: 'agent_response', text_delta: 'Done.', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
  out({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: JSON.stringify(report), num_turns: 1, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, denied_actions: [{ action: 'write_file', display_name: 'WriteFile' }] } });
});
`);
const shim = path.join(tmp, process.platform === 'win32' ? 'fake-agy.cmd' : 'fake-agy');
fs.writeFileSync(shim, process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n` : `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`);
if (process.platform !== 'win32') fs.chmodSync(shim, 0o755);
const envFile = on => fs.writeFileSync(path.join(tmp, '.env'), `JEV_PROVIDER=off\nAGY_CLI_PATH=${shim}\nONE_HOME=${oneHome}\n${on ? 'ORCHY_ANTIGRAVITY=1\n' : ''}`);
envFile(false);
const mod = file => import(pathToFileURL(path.join(orch, 'lib', file)).href);
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 500; i++) { const v = fn(); if (v) return v; await delay(20); } throw new Error('Test timed out'); }

try {
  const AG = await mod('engines/antigravity.mjs');
  const E = await mod('engines/index.mjs');
  const W = await mod('workspaces.mjs');
  const R = await mod('runner.mjs');
  const I = await mod('inbox.mjs');
  const envMod = await mod('env.mjs');
  const ws = () => W.workspace('test');
  const pending = id => I.itemsForRun(id).find(i => i.status === 'pending');
  const reloadEnv = () => envMod.reloadEnv?.();

  // event and tool shapes
  assert.deepEqual(AG.agyTool({ name: 'run_command', parameters: { CommandLine: 'git status', Cwd: 'C:/x' } }), { tool: 'Bash', input: { command: 'git status', cwd: 'C:/x' } });
  assert.equal(AG.agyTool({ name: 'call_mcp_tool', parameters: { ServerName: 'jos', ToolName: 'ask_user', Arguments: {} } }).tool, 'mcp__jos__ask_user');
  assert.equal(AG.agyTool({ name: 'write_to_file', parameters: { TargetFile: 'C:/a.txt' } }).input.file_path, 'C:/a.txt');
  assert.equal(AG.agyTool({ name: 'generate_image', parameters: {} }).tool, 'AGY_generate_image');
  assert.equal(AG.parseAgyLine('\uFEFF{"event":"init","conversation_id":"c","init":{"permission_mode":"always-proceed"}}').conversationId, 'c');
  assert.equal(AG.parseAgyLine('not json'), null);
  assert.deepEqual(AG.agyArgs({ home: 'H', model: 'm', resume: 'c1' }).slice(0, 2), ['--gemini_dir', 'H']);
  assert.ok(!AG.agyArgs({ home: 'H', model: 'default' }).includes('--model') && AG.agyArgs({ home: 'H' }).at(-1) === '-p=');
  const eng = E.engine('antigravity');
  assert.equal(eng.capabilities.gated, false); assert.equal(eng.capabilities.clientSafe, false); assert.equal(eng.capabilities.huddles, false);

  // off by default: not offered, and no run starts on it
  if (envMod.env('ORCHY_ANTIGRAVITY')) throw new Error('ORCHY_ANTIGRAVITY is set in this shell: unset it to run the test');
  assert.equal(E.engineOffered(eng), false);
  assert.ok(!E.engineTools().some(t => t.id === 'antigravity'));
  await assert.rejects(R.startRun({ workspace: 'test', instruction: 'Off' }), /switched off in this Orchy/);
  assert.throws(() => W.addWorkspace({ name: 'Third', runtime: 'antigravity', account: 'shared@example.com' }), /switched off/);
  envFile(true); reloadEnv();
  assert.equal(E.engineOffered(eng), true);

  // ungated: refused unless the workspace opted in
  const entry = envMod.config.workspaces.find(w => w.id === 'test');
  entry.allowUngated = false;
  await assert.rejects(R.startRun({ workspace: 'test', instruction: 'Not allowed' }), /can't hold behind its approval gate/);
  entry.allowUngated = true;

  // the shared account: right one runs, anyone else blocks every Antigravity workspace
  assert.equal(W.modelFor(ws(), 'opus'), 'gemini-4-argon-high'); // tiers map across engines
  assert.equal(W.modelFor(ws(), 'gemini-custom-pro'), 'gemini-custom-pro'); // any agy model id passes
  assert.equal(W.modelFor(ws(), 'bad id; rm'), 'gemini-4-argon-medium');
  let acct = await W.accountCheck(ws(), { force: true });
  assert.equal(acct.ok, true, acct.error); assert.equal(acct.actual, 'shared@example.com');
  assert.throws(() => W.updateWorkspace('other', { runtime: 'antigravity', account: 'someone@else.com' }), /runs as shared@example.com/);
  assert.throws(() => W.updateWorkspace('test', { ownProfile: true, account: 'shared@example.com' }), /one sign-in/);
  fs.writeFileSync(who, 'intruder@example.com');
  acct = await W.accountCheck(ws(), { force: true });
  assert.equal(acct.ok, false); assert.equal(acct.actual, 'intruder@example.com');
  await assert.rejects(R.startRun({ workspace: 'test', instruction: 'Wrong account' }), /must run as shared@example.com/);
  fs.rmSync(who);
  await W.accountCheck(ws(), { force: true });

  // a run: the owner approves it whole, then agy runs in its own folder with Orchy's rules and bridge
  const run = await R.startRun({ workspace: 'test', instruction: 'Test run', model: 'opus' });
  const ok = await until(() => pending(run.id));
  assert.match(ok.title, /on Antigravity\?/); assert.equal(ok.noRemember, true); assert.equal(ok.kind, 'approval');
  I.answer(ok.id, { approve: true });
  await until(() => R.getRun(run.id).endedAt);
  const r = R.getRun(run.id);
  assert.equal(r.outcome, 'completed', r.error);
  assert.equal(r.sessionId, 'conv-1');
  assert.equal(r.permissionDenials, 1);
  const seen = JSON.parse(r.resultText);
  assert.equal(seen.model, 'gemini-4-argon-high');
  assert.equal(seen.runId, run.id); assert.equal(seen.token, true); // the bridge's run id + token ride in agy's environment
  assert.equal(seen.promptHasProtocol, true);
  assert.equal(seen.settings.toolPermission, 'always-proceed');
  assert.ok(seen.settings.permissions.allow.includes('mcp(jos/*)'));
  const deny = seen.settings.permissions.deny.join('\n');
  const fwd = p => path.resolve(p).replace(/\\/g, '/');
  for (const must of [`write_file(${fwd(path.join(wsDir, '.claude'))}/)`, `write_file(${fwd(path.join(wsDir, 'AGENTS.md'))})`, `write_file(${fwd(path.join(wsDir, 'Resources'))}/)`, `read_file(${fwd(otherDir)})`, `read_file(${fwd(orch)})`, `read_file(${fwd(path.join(tmp, '.env'))})`, `read_file(${fwd(path.join(os.homedir(), '.one'))})`]) assert.ok(deny.includes(must), `missing deny rule ${must}`);
  assert.deepEqual(Object.keys(seen.mcp.mcpServers), ['jos']);
  assert.equal(seen.mcp.mcpServers.jos.env, undefined); // no token in the file
  assert.ok(fs.existsSync(path.join(agyHome, 'test', 'general', 'antigravity-cli', 'settings.json'))); // the generalist's own folder
  const feed = fs.readFileSync(path.join(orch, 'data', 'runs', `${run.id}.jsonl`), 'utf8');
  assert.match(feed, /"kind":"denied"/); assert.match(feed, /mcp__jos__note/); assert.match(feed, /"kind":"tool"/);

  // a follow-up resumes the same agy conversation
  const follow = await R.startRun({ workspace: 'test', instruction: 'Follow up', parentRunId: run.id, resumeSessionId: r.sessionId });
  I.answer((await until(() => pending(follow.id))).id, { approve: true });
  await until(() => R.getRun(follow.id).endedAt);
  const f = JSON.parse(R.getRun(follow.id).resultText);
  assert.equal(f.resumed, true);
  assert.equal(R.getRun(follow.id).sessionId, 'conv-1');

  // refused, crashed, stopped
  const no = await R.startRun({ workspace: 'test', instruction: 'Refuse me' });
  I.answer((await until(() => pending(no.id))).id, { approve: false });
  await until(() => R.getRun(no.id).endedAt);
  assert.equal(R.getRun(no.id).outcome, 'failed'); assert.match(R.getRun(no.id).error, /not approved/);
  const crash = await R.startRun({ workspace: 'test', instruction: 'CRASH' });
  I.answer((await until(() => pending(crash.id))).id, { approve: true });
  await until(() => R.getRun(crash.id).endedAt);
  assert.equal(R.getRun(crash.id).outcome, 'failed'); assert.match(R.getRun(crash.id).error, /quota exhausted/);
  const hang = await R.startRun({ workspace: 'test', instruction: 'HANG' });
  I.answer((await until(() => pending(hang.id))).id, { approve: true });
  await until(() => R.getRun(hang.id).pid);
  R.stopRun(hang.id);
  await until(() => R.getRun(hang.id).endedAt);
  assert.equal(R.getRun(hang.id).outcome, 'stopped');

  // fences: no client tasks, no huddles, and no runs without the workspace's own One login
  await assert.rejects(R.startRun({ workspace: 'test', instruction: 'Client', client: { id: 'client', name: 'Client' } }), /can't work on a client's task/);
  await assert.rejects(R.startRun({ workspace: 'test', instruction: 'Huddle', huddleTalk: true }), /huddles are Claude Code only/);
  fs.rmSync(oneConfig);
  await assert.rejects(R.startRun({ workspace: 'test', instruction: 'No One' }), /own One account/);
  console.log('Antigravity checks passed: off by default, ungated opt-in, event + tool shapes, shared account, whole-run approval, agy folder rules + bridge env, resume, refuse/crash/stop and client/huddle/One fences.');
} catch (e) {
  console.error(e); process.exitCode = 1;
} finally {
  // only the uniquely created temporary root is removed
  assert.ok(path.resolve(tmp).startsWith(fs.realpathSync(os.tmpdir())));
  await delay(500);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
  process.exit(process.exitCode || 0);
}
