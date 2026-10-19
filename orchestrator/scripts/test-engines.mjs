// Engine registry and adapters, with no network and no harness binary: node orchestrator/scripts/test-engines.mjs
// Covers the registry, refusing engines Orchy can't gate, the account check for email engines (Claude Code, Codex) and
// for profile engines (API-key / provider logins), model tiers for engines whose models are "default", and the
// per-engine config conversions. Nothing is saved or started.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../lib/env.mjs';
import { engine, engines, engineIds, registerEngine, ungatedRefusal, engineInstallCmd, runRefusal } from '../lib/engines/index.mjs';
import { accountCheck, accountFor, runtimes, modelFor, modelsFor, loginHint, runtimeAvailability, profileClash, backendWorkspace, setBackendAccount } from '../lib/workspaces.mjs';
import { startRun, accountKey } from '../lib/runner.mjs';
import { toClaudeMcp } from '../lib/engines/claude.mjs';
import { toCodexMcp } from '../lib/engines/codex.mjs';
import { CODEX_ARGS } from '../lib/codex.mjs';

let fail = 0;
const ok = (cond, label, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : `  ${extra}`}`); if (!cond) fail++; };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
const keep = { workspaces: [...config.workspaces] };
process.on('exit', () => { config.workspaces = keep.workspaces; });

// ── the registry ──
ok(JSON.stringify(engineIds()) === JSON.stringify(['claude', 'codex', 'hermes', 'antigravity', 'cursor']), 'registry lists claude, codex, hermes, antigravity, cursor', JSON.stringify(engineIds()));
ok('hermes' in config.runtimes && !!engine('hermes') && engine('hermes').capabilities.gated && engine('antigravity').capabilities.gated, 'hermes / antigravity are engines, gated through their pre-tool hooks');
ok(ungatedRefusal({ name: 'H' }, engine('hermes')) === null && ungatedRefusal({ name: 'A' }, engine('antigravity')) === null, 'hermes / antigravity need no allowUngated');
ok(JSON.stringify(Object.keys(runtimes())) === JSON.stringify(engineIds()), 'runtimes() lists registered engines only', JSON.stringify(Object.keys(runtimes())));
ok(Object.values(runtimes()).every(r => r.capabilities && r.label && r.models.length === 3 && r.accountModel), 'every runtime carries label, models, accountModel and capabilities');
for (const e of engines()) {
  ok(['bin', 'version', 'available', 'account', 'profileEnv', 'loginCommand', 'mcpConfig', 'launch', 'protocolNotes'].every(k => typeof e[k] === 'function'), `${e.id}: implements the interface`);
  ok(typeof e.capabilities.gated === 'boolean' && typeof e.capabilities.mcp === 'boolean' && typeof e.capabilities.resume === 'boolean' && typeof e.capabilities.headless === 'boolean', `${e.id}: capabilities are explicit booleans`);
}
ok(engine('claude').capabilities.clientSafe && engine('claude').capabilities.huddles, 'claude: client-safe, huddles');
ok(!engine('codex').capabilities.clientSafe && !engine('codex').capabilities.huddles && !!engine('codex').capabilities.clientReason, 'codex: not client-safe, no huddles, says why');
ok(engine('hermes').capabilities.gated && !engine('hermes').capabilities.clientSafe && engine('hermes').accountModel === 'profile', 'hermes: gated, not client-safe, profile account model');
ok(Object.keys(runtimeAvailability()).join() === 'claude,codex,hermes,antigravity,cursor', 'runtimeAvailability asks every engine');
let bad = null;
try { registerEngine({ id: 'half', label: 'Half' }); } catch (e) { bad = e; }
ok(!!bad && !engine('half'), 'an incomplete engine is refused');

// ── an engine Orchy can't gate is refused unless the workspace opts in ──
const fake = (id, over = {}) => ({
  id, label: `Fake ${id}`, models: ['default', 'default', 'default'], blurb: '', fields: { account: `${id}Account`, profile: `${id}Profile` },
  accountModel: 'profile', instructionFile: 'AGENTS.md', defaultProfileLabel: '(none)',
  capabilities: { gated: false, mcp: true, resume: false, headless: true, clientSafe: false, huddles: false, notes: '' },
  bin: () => null, version: () => 'fake 1.0', available: () => true,
  account: async () => ({ loggedIn: true, email: null, label: 'acme-provider' }),
  profileEnv: () => ({}), loginCommand: () => 'fake login', loginAlt: () => null, mcpConfig: () => ({}), protocolNotes: () => '', launch() { throw new Error('should never launch'); },
  ...over,
});
{
  const undo = registerEngine(fake('wild', { account: async () => ({ loggedIn: false, label: null }) })); // never logged in: a run that gets past the refusal stops at the account check
  const ws = { id: 'w1', name: 'Wild One', folder: 'workspaces/__engines-test', runtime: 'wild', enabled: true, wildAccount: 'x', wildProfile: '/tmp/orchy-wild-1', color: 'jade' };
  config.workspaces.push(ws);
  ok(!!ungatedRefusal(ws, engine('wild')), 'ungated engine: refused by default');
  ok(ungatedRefusal({ ...ws, allowUngated: true }, engine('wild')) === null, 'ungated engine: allowed once the workspace opts in');
  ok(ungatedRefusal(ws, engine('claude')) === null && ungatedRefusal(ws, engine('hermes')) === null, 'gated engines are never refused');
  const err = await rejects(startRun({ workspace: 'w1', instruction: 'Delete everything' }));
  ok(err?.code === 'UNGATED_ENGINE' && err.status === 409, 'startRun refuses the run before anything starts', err && `${err.code} ${err.message}`);
  ws.allowUngated = true;
  const err2 = await rejects(startRun({ workspace: 'w1', instruction: 'Do it' }));
  ok(err2?.code === 'ONE_SCOPE', 'with allowUngated the refusal is gone (next: an ungated engine needs the workspace’s own One login)', err2 && err2.code);
  ok(!/never launch/.test(String(err2?.message)), 'and the fake engine was not launched', err2?.message);
  config.workspaces.pop();
  undo();
  ok(!engine('wild'), 'a registered test engine can be removed again');
}
{
  const err = await rejects(startRun({ workspace: '__nobody__', instruction: 'x' }));
  ok(err?.status === 404, 'unknown workspace still 404s');
}
// ── an engine that isn't installed: Windows gets a command that installs it where Orchy looks, a run says what to do ──
{
  ok(/install\.ps1/.test(engineInstallCmd(engine('hermes'), { win: true })), 'hermes: a native Windows install command (not bash in WSL)');
  ok(/^curl .*\| bash$/.test(engineInstallCmd(engine('hermes'), { win: false })), 'hermes: the bash installer elsewhere');
  const undo = registerEngine(fake('absent', { capabilities: { ...fake('x').capabilities, gated: true }, available: () => false, install: { cmd: 'get-absent' } }));
  config.workspaces.push({ id: 'w2', name: 'Absent One', folder: 'workspaces/__engines-test', runtime: 'absent', enabled: true, absentProfile: '/tmp/orchy-absent-1', color: 'jade' });
  const err = await rejects(startRun({ workspace: 'w2', instruction: 'Do it' }));
  ok(err?.code === 'ENGINE_MISSING' && err.status === 409 && /get-absent/.test(err.message) && !/never launch/.test(err.message), 'startRun on an engine that isn’t installed: refused with the install command, nothing launched', err && `${err.code} ${err.message}`);
  config.workspaces.pop();
  undo();
}
// ── an engine that is there but won't start (an install that didn't finish): a run says how to finish its install ──
{
  const undo = registerEngine(fake('halfdone', { capabilities: { ...fake('x').capabilities, gated: true }, version: () => null, install: { cmd: 'get-halfdone', winCmd: 'get-halfdone', winRepair: 'finish-halfdone' } }));
  config.workspaces.push({ id: 'w3', name: 'Half Done', folder: 'workspaces/__engines-test', runtime: 'halfdone', enabled: true, halfdoneProfile: '/tmp/orchy-halfdone-1', color: 'jade' });
  const err = await rejects(startRun({ workspace: 'w3', instruction: 'Do it' }));
  ok(err?.code === 'ENGINE_BROKEN' && err.status === 409 && /won't start/.test(err.message) && /(finish|get)-halfdone/.test(err.message) && /start the task again/.test(err.message) && !/never launch/.test(err.message), 'startRun on an engine that won’t start: refused with the fix, nothing launched', err && `${err.code} ${err.message}`);
  const avail = runtimeAvailability().halfdone;
  ok(avail?.available === false && avail.broken === true && /(finish|get)-halfdone/.test(avail.repair), 'the Add window hears it is broken, with the fix');
  config.workspaces.pop();
  undo();
}

// ── accountCheck: email engines keep their exact semantics ──
const withAccount = (id, fn) => registerEngine({ ...engine(id), account: fn });
for (const [id, fields] of [['claude', ['claudeAccount', 'claudeConfigDir']], ['codex', ['codexAccount', 'codexHome']]]) {
  const mk = over => ({ id: `x-${id}`, name: `X ${id}`, runtime: id, [fields[0]]: 'owner@example.com', ...over });
  let undo = withAccount(id, async () => ({ loggedIn: true, email: 'owner@example.com' }));
  let a = await accountCheck(mk(), {});
  ok(a.ok && a.actual === 'owner@example.com' && a.expected === 'owner@example.com' && a.runtime === id, `${id}: right account (case-insensitive) passes`);
  undo();
  undo = withAccount(id, async () => ({ loggedIn: true, email: 'someone@else.com' }));
  a = await accountCheck(mk(), {});
  ok(!a.ok && a.loggedIn && a.actual === 'someone@else.com' && !!a.fix, `${id}: wrong account is blocked and says how to fix it`);
  undo();
  undo = withAccount(id, async () => ({ loggedIn: false, error: 'not logged in' }));
  a = await accountCheck(mk(), {});
  ok(!a.ok && !a.loggedIn, `${id}: not logged in is blocked`);
  undo();
  undo = withAccount(id, async () => ({ loggedIn: true, email: 'owner@example.com' }));
  a = await accountCheck(mk({ [fields[0]]: null }), {});
  ok(!a.ok && /no .* account set/i.test(a.error || ''), `${id}: a workspace with no account set is blocked`, a.error);
  undo();
  a = await accountCheck(mk(), { runtime: 'hermes' });
  ok(a.runtime === 'hermes' && !a.ok, `${id} workspace asked about Hermes: checked for the engine the run uses`);
}
ok(loginHint({ runtime: 'claude', claudeAccount: 'owner@example.com', claudeConfigDir: '/tmp/prof-a' }).includes('CLAUDE_CONFIG_DIR') && /claude auth login --email/.test(loginHint({ runtime: 'claude', claudeAccount: 'owner@example.com' })), 'claude login hint pins the profile');
ok(loginHint({ runtime: 'codex', codexAccount: 'owner@example.com', codexHome: '/tmp/prof-b' }).includes('CODEX_HOME') && / login$/.test(loginHint({ runtime: 'codex', codexAccount: 'owner@example.com' })), 'codex login hint pins the profile');
{
  const a = await accountCheck({ id: 'm', name: 'M', runtime: 'mystery' }, {});
  ok(!a.ok && /adapter/.test(a.error), 'a runtime with no adapter is blocked');
}

// ── an engine whose installed version Orchy won't run (runRefusal) is refused before anything launches ──
{
  const gated = { ...fake('x').capabilities, gated: true };
  const undo = registerEngine(fake('picky', { capabilities: gated, runRefusal: () => 'Picky 9 runs commands Orchy never sees. Install Picky 8.' }));
  const why = runRefusal(engine('picky'));
  ok(/Picky 9/.test(why || ''), 'runRefusal: the engine’s own reason, with the way back', why);
  const w = { id: 'pk1', name: 'Picky One', folder: 'workspaces/__pk1', runtime: 'picky', pickyProfile: path.join(os.tmpdir(), 'orchy-picky-never'), enabled: true, color: 'teal' };
  config.workspaces.push(w);
  const err = await rejects(startRun({ workspace: 'pk1', instruction: 'List the files' }));
  ok(err?.code === 'ENGINE_UNSAFE' && err.status === 409 && /Picky 9/.test(err.message) && !/never launch/.test(err.message), 'startRun refuses it before anything launches', `${err?.code} ${err?.message}`);
  undo();
  const undoOk = registerEngine(fake('picky', { capabilities: gated, runRefusal: () => null }));
  ok(runRefusal(engine('picky')) === null, 'a version it accepts: nothing to refuse');
  undoOk();
  ok(runRefusal(engine('claude')) === null && runRefusal(engine('hermes')) === null, 'engines without the check refuse nothing');
  const undoT = registerEngine(fake('picky', { capabilities: gated, runRefusal() { throw new Error('boom'); } }));
  ok(/couldn't check/.test(runRefusal(engine('picky')) || ''), 'a refusal check that throws refuses (fail closed)');
  const errT = await rejects(startRun({ workspace: 'pk1', instruction: 'List the files' }));
  ok(errT?.code === 'ENGINE_UNSAFE' && /couldn't check/.test(errT.message) && !/never launch/.test(errT.message), 'and startRun refuses it too, nothing launched', `${errT?.code} ${errT?.message}`);
  undoT();
  config.workspaces.splice(config.workspaces.indexOf(w), 1);
  ok(!engine('picky'), 'the test engine is gone again');
}

// ── Orchy fixing himself: a fresh install (config.example.json) has no Claude Code account for it yet ──
// (in memory only: setBackendAccount saves config.json, so only its refusal, which saves nothing, is called here)
{
  const keepOrchy = config.orchy;
  const undo = registerEngine({ ...engine('claude'), available: () => true, version: () => 'fake 1.0', account: async () => ({ loggedIn: true, email: 'owner@example.com' }) });
  config.orchy = { ...keepOrchy, claudeAccount: null, claudeConfigDir: null };
  let a = await accountCheck(backendWorkspace(), {});
  ok(!a.ok && a.expected === null && a.actual === 'owner@example.com' && /Settings → Accounts/.test(a.error || ''), 'backend: no account set is blocked, and says where to pick one', JSON.stringify(a));
  const err = await rejects(startRun({ workspace: 'orchy', kind: 'fix', instruction: 'Fix the logs page' }));
  ok(err?.code === 'ACCOUNT_MISMATCH' && /no Claude Code account set for fixing himself/.test(err.message) && !/run as null/.test(err.message), 'backend: a fix with no account says so plainly (never "must run as null")', err?.message);
  const refused = await rejects(Promise.resolve().then(() => setBackendAccount({ account: 'not-an-email' })));
  ok(refused?.status === 400 && config.orchy.claudeAccount === null, 'backend: an account that isn’t an email is refused, nothing changes', refused?.message);
  config.orchy.claudeAccount = 'Owner@Example.com';
  a = await accountCheck(backendWorkspace(), {});
  ok(a.ok && a.expected === 'Owner@Example.com', 'backend: with the account set, the check passes (case-insensitive)');
  config.orchy.claudeAccount = 'other@example.com';
  a = await accountCheck(backendWorkspace(), {});
  ok(!a.ok && a.loggedIn && a.actual === 'owner@example.com', 'backend: a different sign-in is still blocked');
  undo();
  config.orchy = keepOrchy;
}

// ── accountCheck: engines with no account concept need a profile folder of their own ──
{
  const undo = registerEngine(fake('keyed', { capabilities: { gated: true, mcp: true, resume: true, headless: true, clientSafe: false, huddles: false, notes: '' } }));
  const w1 = { id: 'k1', name: 'Keyed One', folder: 'workspaces/__k1', runtime: 'keyed', keyedAccount: 'acme', keyedProfile: '/tmp/orchy-keyed/shared', color: 'jade' };
  const w2 = { id: 'k2', name: 'Keyed Two', folder: 'workspaces/__k2', runtime: 'keyed', keyedAccount: null, keyedProfile: '/tmp/orchy-keyed/shared/', color: 'violet' };
  config.workspaces.push(w1, w2);
  ok(profileClash(w1)?.id === 'k2', 'profileClash finds the other workspace on the same folder (trailing slash ignored)');
  let a = await accountCheck(w1, {});
  ok(!a.ok && !!a.profileProblem && /same Fake keyed profile/i.test(a.profileProblem), 'same profile folder for two workspaces is refused', a.profileProblem);
  a = await accountCheck(w2, {});
  ok(!a.ok && !!a.profileProblem, 'and refused for the second one too');
  w2.keyedProfile = '/tmp/orchy-keyed/two';
  a = await accountCheck(w1, {});
  ok(a.ok && a.actual === 'acme-provider' && a.accountModel === 'profile', 'distinct profile folders pass and report the provider as `actual`', JSON.stringify(a));
  a = await accountCheck({ ...w2, keyedProfile: null }, {});
  ok(!a.ok && /profile folder of its own/.test(a.profileProblem || ''), 'no profile folder set is blocked');
  const undo2 = registerEngine(fake('keyed', { capabilities: engine('keyed').capabilities, account: async () => ({ loggedIn: false, label: null }) }));
  a = await accountCheck(w1, {});
  ok(!a.ok && !a.loggedIn && !a.profileProblem, 'a profile with no provider logged in is blocked');
  undo2();
  config.workspaces.splice(config.workspaces.indexOf(w1), 1);
  config.workspaces.splice(config.workspaces.indexOf(w2), 1);
  undo();
}
{
  // Hermes OAuth account + tier-dependent model selection
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchy-hm-'));
  const w = { id: 'hm1', name: 'HM One', folder: 'workspaces/__hm1', runtime: 'hermes', hermesAccount: null, hermesProfile: dir, color: 'violet', allowUngated: true };
  config.workspaces.push(w);
  let a = await accountCheck(w, { force: true });
  ok(!a.ok && !a.loggedIn, 'hermes: a fresh profile is not logged in');
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ version: 1, active_provider: 'nous', providers: { nous: { access_token: 'tok', account_tier: 'pro' } } }));
  a = await accountCheck(w, { force: true });
  ok(a.ok && a.loggedIn && a.plan === 'Nous Portal · Pro' && a.tier === 'pro' && a.availableModels === null, 'hermes: Nous Portal OAuth reports its stored tier; with no model cache no model is made up', JSON.stringify(a));
  fs.writeFileSync(path.join(dir, 'provider_models_cache.json'), JSON.stringify({ nous: { models: ['nous/hermes-5', 'nous/hermes-5:free'] }, openrouter: { models: ['x/y'] } }));
  a = await accountCheck(w, { force: true });
  ok(JSON.stringify(a.availableModels) === '["nous/hermes-5","nous/hermes-5:free"]', 'hermes: the models are the active provider’s from Hermes’s own cache', JSON.stringify(a.availableModels));
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ version: 1, active_provider: 'nous', providers: { nous: { access_token: 'tok', account_tier: 'free' } } }));
  a = await accountCheck(w, { force: true });
  ok(a.plan === 'Nous Portal · Free' && JSON.stringify(a.availableModels) === '["nous/hermes-5:free"]', 'hermes: a free tier only offers the free models', JSON.stringify(a));
  const hint = loginHint(w);
  ok(accountFor(w).computerLogin === true && !hint.includes('HERMES_HOME') && /portal$/.test(hint), 'hermes: a workspace on this computer’s sign-in (the default) logs the computer in with `hermes portal` (OAuth)', hint);
  // the owner picked its own sign-in: only the profile's sign-ins count, and its config must stay on them
  w.hermesComputerLogin = false;
  const ownHint = loginHint(w);
  ok(accountFor(w).computerLogin === false && ownHint.includes('HERMES_HOME') && ownHint.includes('HERMES_SHARED_AUTH_DIR') && /portal$/.test(ownHint), 'hermes: on its own sign-in, Log in pins HERMES_HOME and a Nous token store of its own', ownHint);
  a = await accountCheck(w, { force: true });
  ok(!a.ok && a.loggedIn && /own Hermes sign-in.*names no provider/.test(a.profileProblem || ''), 'hermes: its own sign-in with no provider in its config is refused (Hermes could pick the computer’s)', a.profileProblem);
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'model:\n  default: nous/hermes-5:free\n  provider: nous\nfallback_providers:\n  - provider: deepseek\n    model: deepseek-chat\n');
  a = await accountCheck(w, { force: true });
  ok(!a.ok && /deepseek/i.test(a.profileProblem || ''), 'hermes: … and so is a fallback provider it isn’t signed in to itself', a.profileProblem);
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'model:\n  default: nous/hermes-5:free\n  provider: nous\nauxiliary:\n  vision:\n    provider: auto\n');
  a = await accountCheck(w, { force: true });
  ok(a.ok && a.computerLogin === false && !a.profileProblem, 'hermes: its own sign-in, with its config on its own provider, runs', a.error);
  const pc = { ...w, id: 'hm2', hermesProfile: `${dir}-2`, hermesComputerLogin: true };
  ok(accountKey(pc) === 'hermes:computer' && accountKey({ ...pc, id: 'hm3', hermesProfile: `${dir}-3` }) === 'hermes:computer' && accountKey(w) !== 'hermes:computer', 'hermes: workspaces on the computer’s sign-in share one account queue; one on its own sign-in has its own');
  config.workspaces.splice(config.workspaces.indexOf(w), 1);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}

// ── models: engines whose tiers are all "default" ──
{
  const ws = { id: 'm1', name: 'M', runtime: 'hermes' };
  ok(modelsFor(ws).every(m => m === 'default'), 'hermes: every tier is "default"');
  ok(modelFor(ws, 'sonnet') === 'default' && modelFor(ws, 'haiku') === 'default' && modelFor(ws, undefined) === 'default' && modelFor(ws, 'gpt-6-astra') === 'default', 'modelFor maps any tier name to "default" for hermes');
  ok(modelFor(ws, 'anthropic/claude-sonnet-4') === 'anthropic/claude-sonnet-4', 'a typed provider/model is kept');
  ok(modelFor(ws, 'hermes-5') === 'hermes-5', 'a plain model id is kept on an engine that takes any model id (openModels)');
  ok(modelFor({ runtime: 'claude' }, 'gpt-6.1-sol') === 'sonnet' && modelFor({ runtime: 'codex' }, 'opus') === 'gpt-6-astra' && modelFor({ runtime: 'claude' }, undefined) === 'sonnet', 'claude/codex tier mapping is unchanged');
  ok(modelFor({ runtime: 'claude' }, 'default', 'claude') === 'sonnet' && modelFor({ runtime: 'codex' }, 'default') === 'gpt-6.1-sol', '"default" (the harness picks) on claude/codex is the middle tier, never the cheapest');
  ok(modelFor(ws, 'inherit') === 'default' && modelFor({ runtime: 'claude' }, 'inherit') === 'sonnet' && modelFor({ runtime: 'antigravity' }, 'inherit') !== 'inherit',
    '"inherit" (an agent file’s "the workspace’s model") is never sent to a harness as a model id');
}

// ── MCP conversions ──
{
  const bridge = { command: 'node', args: ['bridge.mjs'], env: { JOS_TOKEN: 't' } };
  const servers = { notion: { type: 'stdio', command: 'npx', args: ['n'], env: { A: '1' }, enabled: true }, web: { type: 'http', url: 'https://x.test/mcp', headers: { H: '1' }, enabled: true }, off: { type: 'stdio', command: 'x', enabled: false }, legacy: { type: 'sse', url: 'https://y.test', enabled: true } };
  const c = engine('claude').mcpConfig({ servers, allowed: null, bridge });
  ok(c.mcpServers.jos.type === 'stdio' && c.mcpServers.jos.timeout === 86_400_000 && c.mcpServers.notion.command === 'npx' && !c.mcpServers.off, 'claude: mcp config has the bridge with a long timeout and the enabled servers');
  const x = engine('codex').mcpConfig({ servers, allowed: null, bridge });
  ok(x.jos.tool_timeout_sec === 86400 && x.notion.tool_timeout_sec === 600 && x.web.http_headers.H === '1' && !x.legacy && !x.off, 'codex: mcp_servers has the bridge, no sse servers');
  ok(Object.keys(toClaudeMcp({}, null)).length === 0 && Object.keys(toCodexMcp({}, null)).length === 0, 'empty registries convert to nothing');
}

// ── protocol notes ──
ok(engine('codex').protocolNotes({ ownerName: 'Sam' }).includes('## Working on Codex') && engine('hermes').protocolNotes({ ownerName: 'Sam' }).includes('## Working on Hermes') && engine('claude').protocolNotes({ ownerName: 'Sam' }) === '', 'each engine adds its own protocol notes');

// ── AGENTS.md: Codex reads it only in the run's own folder (workspaces sit inside Orchy's repo, whose AGENTS.md isn't theirs) ──
ok(CODEX_ARGS.join(' ') === '-c project_root_markers=[] app-server', 'codex app-server starts with project_root_markers=[] (no AGENTS.md from the folders above)');

console.log(fail ? `\n${fail} FAILED` : '\nall engine checks passed');
process.exit(fail ? 1 : 0);
