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
import { startRun } from '../lib/runner.mjs';
import { buildPromptBody } from '../lib/engines/opencode-run.mjs';
import { toClaudeMcp } from '../lib/engines/claude.mjs';
import { toCodexMcp } from '../lib/engines/codex.mjs';
import { OPENCODE_PERMISSION, permissionLooksSafe, mapTool, modelParts } from '../lib/engines/opencode-config.mjs';
import { CODEX_ARGS } from '../lib/codex.mjs';
import { setOpenCodeProbeForTests, parseOpenCodeAuthList, openCodeMajor, inspectOpenCodeAccount } from '../lib/engines/tier-catalog.mjs';

let fail = 0;
const ok = (cond, label, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : `  ${extra}`}`); if (!cond) fail++; };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
const keep = { workspaces: [...config.workspaces] };
process.on('exit', () => { config.workspaces = keep.workspaces; });

// ── the registry ──
ok(JSON.stringify(engineIds()) === JSON.stringify(['claude', 'codex', 'opencode', 'hermes', 'antigravity']), 'registry lists claude, codex, opencode, hermes, antigravity', JSON.stringify(engineIds()));
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
ok(engine('opencode').capabilities.gated && !engine('opencode').capabilities.clientSafe && engine('opencode').accountModel === 'profile', 'opencode: gated, not client-safe, profile account model');
ok(Object.keys(runtimeAvailability()).join() === 'claude,codex,opencode,hermes,antigravity', 'runtimeAvailability asks every engine');
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
  ok(ungatedRefusal(ws, engine('claude')) === null && ungatedRefusal(ws, engine('opencode')) === null, 'gated engines are never refused');
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
  ok(engineInstallCmd(engine('opencode'), { win: true }) === 'npm install -g opencode-ai' && /install\.ps1/.test(engineInstallCmd(engine('hermes'), { win: true })), 'opencode / hermes: native Windows install commands (not bash in WSL)');
  ok(/^curl .*\| bash$/.test(engineInstallCmd(engine('opencode'), { win: false })) && /^curl .*\| bash$/.test(engineInstallCmd(engine('hermes'), { win: false })), 'opencode / hermes: the bash installers elsewhere');
  const undo = registerEngine(fake('absent', { capabilities: { ...fake('x').capabilities, gated: true }, available: () => false, install: { cmd: 'get-absent' } }));
  config.workspaces.push({ id: 'w2', name: 'Absent One', folder: 'workspaces/__engines-test', runtime: 'absent', enabled: true, absentProfile: '/tmp/orchy-absent-1', color: 'jade' });
  const err = await rejects(startRun({ workspace: 'w2', instruction: 'Do it' }));
  ok(err?.code === 'ENGINE_MISSING' && err.status === 409 && /get-absent/.test(err.message) && !/never launch/.test(err.message), 'startRun on an engine that isn’t installed: refused with the install command, nothing launched', err && `${err.code} ${err.message}`);
  config.workspaces.pop();
  undo();
}
// ── an engine that is there but won't start (npm's placeholder opencode.exe): a run says how to finish its install ──
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
  a = await accountCheck(mk(), { runtime: 'opencode' });
  ok(a.runtime === 'opencode' && !a.ok, `${id} workspace asked about OpenCode: checked for the engine the run uses`);
}
ok(loginHint({ runtime: 'claude', claudeAccount: 'owner@example.com', claudeConfigDir: '/tmp/prof-a' }).includes('CLAUDE_CONFIG_DIR') && /claude auth login --email/.test(loginHint({ runtime: 'claude', claudeAccount: 'owner@example.com' })), 'claude login hint pins the profile');
ok(loginHint({ runtime: 'codex', codexAccount: 'owner@example.com', codexHome: '/tmp/prof-b' }).includes('CODEX_HOME') && / login$/.test(loginHint({ runtime: 'codex', codexAccount: 'owner@example.com' })), 'codex login hint pins the profile');
{
  const a = await accountCheck({ id: 'm', name: 'M', runtime: 'mystery' }, {});
  ok(!a.ok && /adapter/.test(a.error), 'a runtime with no adapter is blocked');
}

// ── OpenCode 2 is refused (its code mode's execute tool reaches the network without asking); OpenCode 1 runs ──
{
  const undo2 = registerEngine({ ...engine('opencode'), available: () => true, version: () => 'opencode v2.0.28' });
  const why = runRefusal(engine('opencode'));
  ok(/OpenCode 2/.test(why || '') && /npm install -g opencode-ai|opencode\.ai\/install/.test(why || ''), 'opencode 2: refused, with the way back to OpenCode 1', why);
  const w = { id: 'oc2', name: 'OC Two', folder: 'workspaces/__oc2', runtime: 'opencode', opencodeProfile: path.join(os.tmpdir(), 'orchy-oc2-never'), enabled: true, color: 'teal' };
  config.workspaces.push(w);
  const err = await rejects(startRun({ workspace: 'oc2', instruction: 'List the files' }));
  ok(err?.code === 'ENGINE_UNSAFE' && /OpenCode 2/.test(err.message), 'opencode 2: startRun refuses it before anything launches', `${err?.code} ${err?.message}`);
  config.workspaces.splice(config.workspaces.indexOf(w), 1);
  undo2();
  const undo1 = registerEngine({ ...engine('opencode'), version: () => '1.19.3' });
  ok(runRefusal(engine('opencode')) === null, 'opencode 1: nothing to refuse');
  undo1();
  ok(runRefusal(engine('claude')) === null && runRefusal(engine('hermes')) === null, 'engines without the check refuse nothing');
  const undoT = registerEngine({ ...engine('opencode'), runRefusal() { throw new Error('boom'); } });
  ok(/couldn't check/.test(runRefusal(engine('opencode')) || ''), 'a refusal check that throws refuses (fail closed)');
  undoT();
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
  // the real OpenCode engine: providers come from the profile's auth.json (OpenCode 1; the version is pinned so a PC
  // with OpenCode 2 installed tests the same thing)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchy-oc-'));
  const undoV1 = registerEngine({ ...engine('opencode'), version: () => '1.19.3' });
  const oc = engine('opencode');
  const w = { id: 'oc1', name: 'OC One', folder: 'workspaces/__oc1', runtime: 'opencode', opencodeAccount: null, opencodeProfile: dir, color: 'teal' };
  config.workspaces.push(w);
  // no real `opencode` here: the CLI probe answers what the profile's env would show. The probe only runs when an
  // opencode program is found, so a stand-in file is "it" on a PC (or CI runner) without OpenCode
  const keepCli = process.env.OPENCODE_CLI_PATH;
  if (!oc.bin()) { fs.writeFileSync(path.join(dir, 'opencode-stand-in'), ''); process.env.OPENCODE_CLI_PATH = path.join(dir, 'opencode-stand-in'); }
  process.on('exit', () => { if (keepCli === undefined) delete process.env.OPENCODE_CLI_PATH; else process.env.OPENCODE_CLI_PATH = keepCli; });
  let cli = { providers: [], models: [] }, probedEnv = null;
  const undoProbe = setOpenCodeProbeForTests(async (_bin, env) => { probedEnv = env; return cli; });
  let a = await accountCheck(w, { force: true });
  ok(!a.ok && !a.loggedIn && !a.profileProblem, 'opencode: a fresh profile is not logged in (the PC’s own OpenCode login never counts for it)');
  fs.mkdirSync(path.join(dir, 'data', 'opencode'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'opencode', 'auth.json'), JSON.stringify({ anthropic: { type: 'api', key: 'sk-test' }, openrouter: { type: 'api', key: 'k' } }));
  a = await accountCheck(w, { force: true });
  ok(a.ok && a.actual === 'anthropic, openrouter' && a.availableModels === null && a.plan === 'Claude + OpenRouter', 'opencode: providers in auth.json make it logged in; no plan or model is made up', JSON.stringify(a));
  ok(probedEnv?.XDG_DATA_HOME === path.join(dir, 'data'), 'opencode: the CLI is asked under the workspace’s profile', JSON.stringify(probedEnv?.XDG_DATA_HOME));
  cli = { providers: ['OpenCode Console'], models: ['opencode/big-pickle', 'anthropic/claude-sonnet-5-5'] };
  a = await accountCheck(w, { force: true });
  ok(a.ok && a.actual === 'anthropic, openrouter, opencode' && JSON.stringify(a.availableModels) === JSON.stringify(cli.models), 'opencode: a CLI-only sign-in (OpenCode Console) counts, and the models are the ones `opencode models` lists', JSON.stringify(a));
  undoProbe();
  ok(JSON.stringify(parseOpenCodeAuthList('OpenCode Console  Default                     stored\r\n●  Anthropic  oauth\nEnvironment\nOpenAI  OPENAI_API_KEY\n')) === '["OpenCode Console","Anthropic"]', 'opencode: `auth list` parsing (with and without bullets; env keys skipped)');
  ok(JSON.stringify(parseOpenCodeAuthList('●  Anthropic oauth\n●  OpenRouter api\n')) === '["Anthropic","OpenRouter"]', 'opencode 1: one space before the type still parses to the provider alone');
  ok(openCodeMajor('opencode v2.0.28') === 2 && openCodeMajor('1.19.3') === 1 && openCodeMajor(null) === 0, 'opencode: major version read from `--version`');
  // OpenCode 2 lists a profile's sign-ins and models through a private server (--standalone); OpenCode 1 refuses the flag
  {
    const seen = [];
    const undo = setOpenCodeProbeForTests(async (_bin, env, standalone) => { seen.push({ standalone, env }); return { providers: [], models: [] }; });
    const keepKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-computer';
    const v2 = await inspectOpenCodeAccount(dir, { binPath: 'x', profileEnv: oc.profileEnv(dir), v2: true });
    const v1 = await inspectOpenCodeAccount(dir, { binPath: 'x', profileEnv: oc.profileEnv(dir), v2: false });
    await inspectOpenCodeAccount(null, { binPath: 'x', v2: true });
    if (keepKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = keepKey;
    undo();
    ok(seen[0].standalone === true && seen[1].standalone === false && seen[2].standalone === false, 'opencode: a profile on OpenCode 2 is asked with --standalone; OpenCode 1 and the computer’s own login never are', JSON.stringify(seen.map(s => s.standalone)));
    ok(!('ANTHROPIC_API_KEY' in seen[0].env) && seen[0].env.XDG_DATA_HOME === path.join(dir, 'data'), 'opencode: a profile is asked without the computer’s API keys (what its runs get)');
    ok(!v2.loggedIn && v1.loggedIn, 'opencode 2: an auth.json it never reads doesn’t make the profile signed in; on OpenCode 1 it does', JSON.stringify([v2.loggedIn, v1.loggedIn]));
  }
  const env = oc.profileEnv(dir);
  ok(env.XDG_DATA_HOME === path.join(dir, 'data') && env.OPENCODE_CONFIG_DIR === path.join(dir, 'config') && !!env.XDG_STATE_HOME, 'opencode: profileEnv pins data, state and config under the workspace profile');
  const hint = loginHint(w);
  ok(hint.includes('XDG_DATA_HOME') && hint.includes('OPENCODE_CONFIG_DIR') && (openCodeMajor(oc.version()) >= 2 ? /auth login --standalone$/ : /auth login$/).test(hint), 'opencode: login hint pins the profile and runs `auth login` (--standalone on OpenCode 2)', hint);
  const undoV2 = registerEngine({ ...engine('opencode'), version: () => 'opencode v2.0.28' });
  ok(/auth login --standalone$/.test(loginHint(w)), 'opencode 2: a profile signs in through a private server of its own (the background service is the computer’s)', loginHint(w));
  undoV2();
  undoV1();
  config.workspaces.splice(config.workspaces.indexOf(w), 1);
  fs.rmSync(dir, { recursive: true, force: true });
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
  ok(hint.includes('HERMES_HOME') && /portal$/.test(hint), 'hermes: login hint pins HERMES_HOME and runs `hermes portal` (OAuth)', hint);
  config.workspaces.splice(config.workspaces.indexOf(w), 1);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}

// ── models: engines whose tiers are all "default" ──
{
  const ws = { id: 'm1', name: 'M', runtime: 'opencode' };
  ok(modelsFor(ws).every(m => m === 'default'), 'opencode: every tier is "default"');
  ok(modelFor(ws, 'sonnet') === 'default' && modelFor(ws, 'haiku') === 'default' && modelFor(ws, undefined) === 'default' && modelFor(ws, 'gpt-6-astra') === 'default', 'modelFor maps any tier name to "default" for opencode');
  ok(modelFor(ws, 'anthropic/claude-sonnet-4') === 'anthropic/claude-sonnet-4', 'a typed provider/model is kept');
  ok(modelFor({ runtime: 'claude' }, 'gpt-6.1-sol') === 'sonnet' && modelFor({ runtime: 'codex' }, 'opus') === 'gpt-6-astra' && modelFor({ runtime: 'claude' }, undefined) === 'sonnet', 'claude/codex tier mapping is unchanged');
  ok(modelFor({ runtime: 'claude' }, 'default', 'claude') === 'sonnet' && modelFor({ runtime: 'codex' }, 'default') === 'gpt-6.1-sol', '"default" (the harness picks) on claude/codex is the middle tier, never the cheapest');
  ok(modelFor(ws, 'inherit') === 'default' && modelFor({ runtime: 'hermes' }, 'inherit') === 'default' && modelFor({ runtime: 'claude' }, 'inherit') === 'sonnet' && modelFor({ runtime: 'antigravity' }, 'inherit') !== 'inherit',
    '"inherit" (an agent file’s "the workspace’s model") is never sent to a harness as a model id');
  const none = buildPromptBody({ prompt: 'hi', system: 's', model: 'default' });
  ok(!('model' in none) && none.parts[0].text === 'hi' && none.system === 's', 'opencode prompt body omits the model for "default"');
  ok(JSON.stringify(buildPromptBody({ prompt: 'hi', model: 'anthropic/claude-x/y' }).model) === JSON.stringify({ providerID: 'anthropic', modelID: 'claude-x/y' }), 'and passes provider/model split at the first slash');
  ok(modelParts('sonnet') === null, 'a tier name that is not provider/model sends no model');
}

// ── MCP conversions ──
{
  const bridge = { command: 'node', args: ['bridge.mjs'], env: { JOS_TOKEN: 't' } };
  const servers = { notion: { type: 'stdio', command: 'npx', args: ['n'], env: { A: '1' }, enabled: true }, web: { type: 'http', url: 'https://x.test/mcp', headers: { H: '1' }, enabled: true }, off: { type: 'stdio', command: 'x', enabled: false }, legacy: { type: 'sse', url: 'https://y.test', enabled: true } };
  const c = engine('claude').mcpConfig({ servers, allowed: null, bridge });
  ok(c.mcpServers.jos.type === 'stdio' && c.mcpServers.jos.timeout === 86_400_000 && c.mcpServers.notion.command === 'npx' && !c.mcpServers.off, 'claude: mcp config has the bridge with a long timeout and the enabled servers');
  const x = engine('codex').mcpConfig({ servers, allowed: null, bridge });
  ok(x.jos.tool_timeout_sec === 86400 && x.notion.tool_timeout_sec === 600 && x.web.http_headers.H === '1' && !x.legacy && !x.off, 'codex: mcp_servers has the bridge, no sse servers');
  const o = engine('opencode').mcpConfig({ servers, allowed: ['notion'], bridge });
  ok(o.mcp.jos.type === 'local' && o.mcp.jos.command.join(' ') === 'node bridge.mjs' && o.mcp.jos.environment.JOS_TOKEN === 't' && o.mcp.notion.command[0] === 'npx' && !o.mcp.web, 'opencode: mcp has the bridge as a local server and only the allowed servers');
  ok(permissionLooksSafe(o.permission) && o.permission['*'] === 'ask' && o.permission.bash === 'ask' && o.permission.task === 'deny', 'opencode: everything asks, sub-agents and the question box are denied');
  ok(!JSON.stringify(o.permission).includes('allow'), 'opencode: the generated config never says "allow"');
  ok(!permissionLooksSafe({ '*': 'ask', bash: 'allow' }) && !permissionLooksSafe({ bash: 'ask' }) && !permissionLooksSafe(undefined) && !permissionLooksSafe({ '*': 'ask', read: { '*': 'allow' } }), 'an effective config with an allow (or no catch-all) is not safe');
  ok(OPENCODE_PERMISSION.read['*.env'] === 'deny', '.env files stay denied for reads');
  const names = ['jos', 'notion'];
  ok(mapTool('bash', names) === 'Bash' && mapTool('edit', names) === 'Edit' && mapTool('webfetch', names) === 'WebFetch' && mapTool('jos_report_done', names) === 'mcp__jos__report_done' && mapTool('notion_create_page', names) === 'mcp__notion__create_page' && mapTool('mystery', names) === 'mystery', 'opencode tool names map to the names policy.mjs knows');
  ok(Object.keys(toClaudeMcp({}, null)).length === 0 && Object.keys(toCodexMcp({}, null)).length === 0, 'empty registries convert to nothing');
}

// ── protocol notes ──
ok(engine('codex').protocolNotes({ ownerName: 'Sam' }).includes('## Working on Codex') && engine('opencode').protocolNotes({ ownerName: 'Sam' }).includes('## Working on OpenCode') && engine('claude').protocolNotes({ ownerName: 'Sam' }) === '', 'each engine adds its own protocol notes');

// ── AGENTS.md: Codex reads it only in the run's own folder (workspaces sit inside Orchy's repo, whose AGENTS.md isn't theirs) ──
ok(CODEX_ARGS.join(' ') === '-c project_root_markers=[] app-server', 'codex app-server starts with project_root_markers=[] (no AGENTS.md from the folders above)');

console.log(fail ? `\n${fail} FAILED` : '\nall engine checks passed');
process.exit(fail ? 1 : 0);
