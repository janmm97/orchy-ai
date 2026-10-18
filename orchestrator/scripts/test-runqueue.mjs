// Offline checks for the run queue and the gate's extras, in a disposable copy of Orchy with a fake engine (no harness,
// no network): per-account concurrency (maxLivePerAccount), the account key per engine, huddle work one after another,
// a head's hand-offs never deadlocked behind it, Run now, the session/usage-limit pause and its automatic restart,
// interrupted runs after a restart, the scheduler's hold while runs are live, where a shell command really runs
// (mcp/cwd-hook.mjs + gate.mjs#shellCwd: `cd .claude` then a relative write is a setup change), and the image-read guard.
// Run: node orchestrator/scripts/test-runqueue.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../lib/env.mjs';

const ok = name => console.log(`ok - ${name}`);
const delay = ms => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchy-queue-test-'));
try {
  const orch = path.join(tmp, 'orchestrator');
  fs.mkdirSync(orch);
  fs.cpSync(path.join(ROOT, 'orchestrator/lib'), path.join(orch, 'lib'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'orchestrator/mcp'), path.join(orch, 'mcp'), { recursive: true });
  if (fs.existsSync(path.join(ROOT, 'node_modules'))) fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(tmp, '.env'), 'JEV_PROVIDER=off\n');
  const W = (id, account, profile, extra = {}) => ({ id, name: `${id[0].toUpperCase()}${id.slice(1)} Workspace`, folder: `workspaces/${id}`, client: id, runtime: 'fakeq', fakeqAccount: account, fakeqProfile: profile ? path.join(tmp, profile) : null, ...extra });
  const wss = [W('acme', 'one@example.com', 'prof-one'), W('northwind', 'ONE@example.com', 'prof-one'), W('studio', 'two@example.com', 'prof-two'), W('keyed', null, null, { runtime: 'fakep', fakeqProfile: null, fakepProfile: path.join(tmp, 'prof-keyed') })];
  for (const w of wss) fs.mkdirSync(path.join(tmp, w.folder), { recursive: true });
  fs.writeFileSync(path.join(orch, 'config.json'), JSON.stringify({
    timezone: 'UTC', owner: { name: 'Sam' }, orchy: {}, workspaces: wss,
    runtimes: { claude: { label: 'Claude Code', models: ['haiku', 'sonnet', 'opus'] } },
  }));
  fs.writeFileSync(path.join(orch, 'voice-agents.json'), '{"agents":[]}');
  const mod = file => import(pathToFileURL(path.join(orch, 'lib', file)).href);
  const { registerEngine } = await mod('engines/index.mjs');
  const { db } = await mod('store.mjs');

  // a fake engine: launch() only records the run; the test ends it through the same hooks a real adapter uses
  const launched = new Map(); // runId -> { run, ws, opts, hooks, n }
  const fake = (id, accountModel) => ({
    id, label: `Fake ${id}`, models: ['lo', 'mid', 'hi'], blurb: '', fields: { account: `${id}Account`, profile: `${id}Profile` },
    accountModel, instructionFile: 'AGENTS.md', defaultProfileLabel: '(none)',
    capabilities: { gated: true, mcp: true, resume: true, headless: true, clientSafe: false, huddles: true, notes: '' },
    bin: () => null, version: () => null, available: () => true,
    // each profile folder is signed in to its own login
    account: async p => (accountModel === 'email' ? { loggedIn: true, email: /prof-two/.test(p || '') ? 'two@example.com' : 'one@example.com' } : { loggedIn: true, label: 'provider' }),
    profileEnv: () => ({}), loginCommand: () => 'fake login', loginAlt: () => null, mcpConfig: () => ({}), protocolNotes: () => '',
    launch(run, ws, opts, rt) {
      const hooks = rt.hooks(run, ws);
      const prev = launched.get(run.id);
      launched.set(run.id, { run, ws, opts, hooks, n: (prev?.n || 0) + 1 });
      rt.live.set(run.id, { fingerprint: opts.fingerprint, stop: () => hooks.done({ code: 1, status: 'interrupted' }) });
      hooks.started({ threadId: `thread-${run.id}` });
    },
  });
  registerEngine(fake('fakeq', 'email'));
  registerEngine(fake('fakep', 'profile'));

  const R = await mod('runner.mjs');
  const limits = [];
  R.onSessionLimit(x => limits.push(x));
  const S = () => db().settings;
  const start = (ws, extra = {}) => R.startRun({ workspace: ws, instruction: 'Do the thing', ...extra });
  const end = (id, code = 0, error = null) => launched.get(id).hooks.done({ code, status: code ? 'failed' : 'completed', error });

  // ── the account key: per engine, email engines by the login (case-insensitive), profile engines by their folder ──
  const { workspace } = await mod('workspaces.mjs');
  assert.equal(R.accountKey(workspace('acme')), R.accountKey(workspace('northwind')));
  assert.equal(R.accountKey(workspace('acme')), 'fakeq:one@example.com');
  assert.notEqual(R.accountKey(workspace('acme')), R.accountKey(workspace('studio')));
  assert.match(R.accountKey(workspace('keyed')), /^fakep:.*prof-keyed$/);
  ok('account key: one login shared by two workspaces is one account; a profile engine keys on its folder');

  // ── concurrency: at most maxLivePerAccount live per account, the rest queue ──
  S().maxLivePerAccount = 2;
  assert.equal(R.maxLivePerAccount(), 2);
  const r1 = await start('acme'), r2 = await start('northwind');
  const r3 = await start('acme');
  const other1 = await start('studio'); // another login: its own slots
  assert.ok(launched.has(r1.id) && launched.has(r2.id) && !launched.has(r3.id) && launched.has(other1.id));
  assert.equal(R.getRun(r3.id).status, 'queued');
  assert.equal(R.getRun(r3.id).activity.state, 'queued');
  assert.ok(R.isLive(r3.id) && R.liveIn('acme'));
  assert.equal(R.liveCount(), 3);
  end(other1.id); await delay(10);
  assert.equal(R.getRun(r3.id).status, 'queued', 'a slot freed on another account starts nothing here');
  ok('two live on one account, the third queues (live for its workspace, not in liveCount); another login has its own slots');

  end(r1.id);
  await delay(20);
  assert.ok(launched.has(r3.id), 'the queued run starts when a slot frees');
  assert.equal(R.getRun(r3.id).status, 'working');
  assert.equal(R.getRun(r1.id).outcome, 'completed');
  ok('a finished run frees its slot: the queued one starts');

  // ── Run now jumps the queue ──
  const r4 = await start('acme');
  assert.equal(R.getRun(r4.id).status, 'queued');
  R.runNow(r4.id);
  assert.ok(launched.has(r4.id));
  assert.equal(R.liveCount(), 3);
  ok('Run now starts a queued run at once, over the limit');

  // ── a queued run that's stopped never starts ──
  const r5 = await start('acme');
  R.stopRun(r5.id);
  await delay(10);
  assert.equal(R.getRun(r5.id).outcome, 'stopped');
  assert.ok(!launched.has(r5.id) && !R.isLive(r5.id));
  ok('stopping a queued run ends it without starting it');
  for (const id of [r2.id, r3.id, r4.id]) end(id);
  await delay(20);
  assert.equal(R.liveCount(), 0);

  // ── a head's hand-offs never wait behind the head itself (limit 1) ──
  S().maxLivePerAccount = 1;
  const head = await start('acme');
  const sub = await R.startRun({ workspace: 'acme', instruction: 'Your part', delegatedBy: head.id });
  assert.ok(launched.has(sub.id), 'the hand-off starts although its head holds the only slot');
  const other = await start('northwind');
  assert.equal(R.getRun(other.id).status, 'queued');
  end(sub.id); await delay(10);
  assert.equal(R.getRun(other.id).status, 'queued', 'the head still holds the slot');
  end(head.id); await delay(10);
  assert.ok(launched.has(other.id));
  end(other.id); await delay(10);
  ok('a head\'s hand-off starts with limit 1 (no deadlock); others still wait for the slot');

  // ── huddle work: one after another, and only on a free account; huddle talk never waits ──
  S().maxLivePerAccount = 3;
  const busy = await start('acme');
  const work = await R.startRun({ workspace: 'acme', instruction: 'Your part of the agreement', fromHuddle: 'h_1' });
  assert.equal(R.getRun(work.id).status, 'queued');
  const talk = await R.startRun({ workspace: 'acme', instruction: 'Your turn', huddle: 'h_2', huddleTalk: true });
  assert.ok(launched.has(talk.id), 'a huddle turn never waits');
  end(talk.id); await delay(10);
  assert.equal(R.getRun(work.id).status, 'queued');
  end(busy.id); await delay(10);
  assert.ok(launched.has(work.id));
  const work2 = await R.startRun({ workspace: 'acme', instruction: 'The other part', fromHuddle: 'h_1' });
  assert.equal(R.getRun(work2.id).status, 'queued');
  end(work.id); await delay(10);
  assert.ok(launched.has(work2.id));
  end(work2.id); await delay(10);
  ok('approved huddle work starts one after another on a free account; huddle talk skips the queue');

  // ── session/usage limit: the run pauses, the account waits, Run now or the reset starts them again ──
  const a = await start('acme');
  launched.get(a.id).hooks.record({ kind: 'tool', tool: 'Bash', toolUseId: 't1', input: { command: 'ls' } }); // it acted
  end(a.id, 1, "You've hit your usage limit. Try again in 5 minutes.");
  await delay(10);
  const pa = R.getRun(a.id);
  assert.equal(pa.status, 'paused-limit'); assert.ok(!pa.endedAt); assert.match(pa.limitError, /usage limit/);
  assert.equal(pa.activity.state, 'paused');
  assert.equal(limits.length, 1); assert.equal(limits[0].ws.id, 'acme');
  const b = await start('northwind'); // same login: it waits too
  assert.equal(R.getRun(b.id).status, 'paused-limit');
  assert.ok(!launched.get(b.id));
  R.runNow(b.id);
  assert.ok(launched.has(b.id), 'Run now lifts the pause for that run');
  end(b.id); await delay(20);
  assert.equal(launched.get(a.id).n, 2, 'the paused run starts again once a slot frees after the pause lifted');
  assert.equal(launched.get(a.id).opts.resume, `thread-${a.id}`, 'in its own conversation, as it had acted');
  end(a.id); await delay(10);
  assert.equal(R.getRun(a.id).outcome, 'completed');
  assert.equal(limits.length, 1, 'said once per limit window');
  assert.equal(R.parseResetWaitMs('resets in 2 hours'), 2 * 3600_000);
  assert.equal(R.parseResetWaitMs('try again in 90 minutes'), 90 * 60_000);
  assert.equal(R.parseResetWaitMs('limit reached'), 30 * 60_000);
  assert.ok(R.SESSION_LIMIT_RE.test('Claude AI usage limit reached') && !R.SESSION_LIMIT_RE.test('Exit code 1: file not found'));
  ok('usage limit: paused (not failed), the account\'s next run waits, Run now, restart in the same conversation, said once');

  // ── interrupted runs: queued and paused ones are cut off too ──
  S().maxLivePerAccount = 1;
  const live1 = await start('acme'), q1 = await start('acme');
  const cut = R.markInterruptedRuns();
  assert.ok(cut.includes(live1.id) && cut.includes(q1.id));
  assert.equal(R.getRun(q1.id).status, 'failed'); assert.equal(R.getRun(q1.id).activity.state, 'failed');
  ok('markInterruptedRuns covers queued runs and returns the ids it failed');

  // ── the scheduler holds its slots while two or more runs are live ──
  const { HOLD_AT_LIVE } = await mod('scheduler.mjs');
  assert.equal(HOLD_AT_LIVE, 2);
  ok('scheduler: slots wait at 2 live');

  // ── where a shell command runs: the hook's report, then the gate ──
  const G = await mod('gate.mjs');
  const I = await mod('inbox.mjs');
  const acme = workspace('acme');
  fs.mkdirSync(path.join(acme.dir, '.claude'), { recursive: true });
  const rr = await start('northwind'); // queued: the gate only needs the run record
  const run = R.getRun(rr.id);
  run.workspace = 'acme';
  const hook = path.join(orch, 'mcp', 'cwd-hook.mjs');
  const feed = (toolUseId, cwd) => spawnSync(process.execPath, [hook, run.id], { input: JSON.stringify({ tool_use_id: toolUseId, cwd, tool_name: 'Bash' }), encoding: 'utf8' });
  const h1 = feed('tu_claude', path.join(acme.dir, '.claude'));
  assert.equal(h1.status, 0); assert.equal(h1.stdout, '');
  feed('tu_home', acme.dir);
  feed('tu_out', tmp); // outside the workspace: ignored
  spawnSync(process.execPath, [hook, '../escape'], { input: JSON.stringify({ tool_use_id: 'x', cwd: acme.dir }) });
  assert.ok(!fs.existsSync(path.join(orch, 'data', 'runs', '..', 'escape.cwd.jsonl')));
  assert.equal(G.shellCwd(run, acme, 'tu_claude'), path.resolve(acme.dir, '.claude'));
  assert.equal(G.shellCwd(run, acme, 'tu_out'), null);
  assert.equal(G.shellCwd(run, acme, 'nope'), null);
  const write = 'echo "theme: dark" > notes.txt';
  const inHome = await G.gate(run.id, 'Bash', { command: write }, { toolUseId: 'tu_home' });
  assert.equal(inHome.decision, 'allow', JSON.stringify(inHome));
  const inSetup = await G.gate(run.id, 'Bash', { command: write }, { toolUseId: 'tu_claude' });
  assert.notEqual(inSetup.decision, 'allow', 'a relative write after `cd .claude` is a setup change');
  const noHook = await G.gate(run.id, 'Bash', { command: write });
  assert.equal(noHook.decision, 'allow');
  ok('cwd hook: each shell call\'s folder is logged; `cd .claude` then a relative write hits the setup fence');

  // ── the image-read guard: after 60 image reads in one run, the next asks; an OK allows 60 more ──
  const img = { file_path: path.join(acme.dir, 'frames', 'f.png') };
  for (let i = 0; i < G.IMAGE_READ_LIMIT; i++) assert.equal((await G.gate(run.id, 'Read', img)).decision, 'allow');
  assert.equal((await G.gate(run.id, 'Read', { file_path: path.join(acme.dir, 'notes.md') })).decision, 'allow', 'other reads never count');
  const over = await G.gate(run.id, 'Read', img);
  assert.equal(over.decision, 'ask');
  assert.equal(I.getItem(over.itemId).ruleKey, 'image-reads:over-limit');
  I.answer(over.itemId, { approve: true });
  assert.equal(R.getRun(run.id).imageReadCap, 2 * G.IMAGE_READ_LIMIT + 1);
  for (let i = 0; i < G.IMAGE_READ_LIMIT; i++) assert.equal((await G.gate(run.id, 'Read', img)).decision, 'allow');
  assert.equal((await G.gate(run.id, 'Read', img)).decision, 'ask');
  assert.ok(G.isImageRead('Read', { file_path: 'a.JPG' }) && !G.isImageRead('Write', { file_path: 'a.png' }) && !G.isImageRead('Read', { file_path: 'a.md' }));
  ok('image guard: the 61st image read asks, an OK raises the cap by 60');

  // the hook command line: quoted for the harness's shell on each platform
  const { shellLine } = await mod('engines/shared.mjs');
  assert.equal(shellLine(['C:\\Program Files\\nodejs\\node.exe', 'C:\\o\\cwd-hook.mjs', 'run_1'], true), '"C:/Program Files/nodejs/node.exe" "C:/o/cwd-hook.mjs" "run_1"');
  assert.equal(shellLine(['/usr/bin/node', "/home/a b/it's/cwd-hook.mjs", 'run_1'], false), `'/usr/bin/node' '/home/a b/it'\\''s/cwd-hook.mjs' 'run_1'`);
  ok('hook command: double quotes and forward slashes on Windows, POSIX single quotes elsewhere');
} finally {
  assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await delay(300);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
}
console.log('test-runqueue: all passed');
process.exit(0);
