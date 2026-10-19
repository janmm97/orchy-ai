// Orchy without Jev or without Claude Code: the harness that stands in (brain.mjs), routing through it when Jev is off,
// the keyword fallback, Orchy's no-model answer, and the install windows (installer.mjs). No harness is started.
// Run: node orchestrator/scripts/test-brain.mjs
import { route as realRoute } from '../lib/router.mjs';
import { askViaHarness, firstJson, brainEngine, HERMES_BRAIN_ARGS } from '../lib/brain.mjs';
import { offlineAnswer } from '../lib/orchy.mjs';
import { installScript, installBinDirs } from '../lib/installer.mjs';
import { engine, engineInstallCmd, engineHealth, engineRepairCmd, brokenMessage, registerEngine } from '../lib/engines/index.mjs';
import { loginRun } from '../lib/workspaces.mjs';

let fail = 0;
const ok = (cond, label, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : `  ${extra}`}`); if (!cond) fail++; };

const ONE = [{ id: 'org1', name: 'Test Org1 Workspace', client: 'Test Org1', blurb: 'Test work.', aliases: [], runtime: 'codex', enabled: true }];
const TWO = [...ONE, { id: 'beta', name: 'Beta Labs', client: 'Beta Labs Inc', blurb: 'Lab notebooks and sample orders.', aliases: [], runtime: 'codex', enabled: true }];
const AGENTS = [
  { workspace: 'org1', slug: 'writer', displayName: 'Wren', description: 'Writes the newsletter' },
  { workspace: 'org1', slug: 'analyst', displayName: 'Ana Lytics', description: 'Reads the sales sheet' },
];
const noJev = async () => { throw Object.assign(new Error('Jev is off'), { code: 'NO_JEV' }); };
const route = (text, opts = {}) => realRoute(text, { workspaces: ONE, agents: AGENTS, budget: null, primer: null, ask: noJev, harness: null, ...opts });

// ── keywords only (no Jev, no harness) ──
{
  const r = await route('what can the two agents do?');
  ok(r.intent === 'chat' && !r.workspace, 'a question with no workspace named is for Orchy, even with one workspace', JSON.stringify(r));
  const t = await route('draft this week’s newsletter');
  ok(t.intent === 'task' && t.workspace === 'org1', 'work with no workspace named goes to the only one there is', JSON.stringify(t));
  const n = await route('ask Wren to draft the newsletter');
  ok(n.workspace === 'org1' && n.agent === 'writer', 'an agent named in the message is picked', JSON.stringify(n));
  const two = await realRoute('draft this week’s newsletter', { workspaces: TWO, agents: AGENTS, budget: null, primer: null, ask: noJev, harness: null });
  ok(!two.workspace || two.needsChoice, 'two workspaces and none named: no guess', JSON.stringify(two));
}

// ── Jev off, a harness stands in ──
{
  let got = null;
  const harness = async (state, questions, opts) => {
    got = { state, questions, opts };
    return { model: 'Codex', ms: 5, via: 'harness:codex', answers: {
      intent: { choice: 'task', confidence: 0.9, probabilities: { task: 0.9 } },
      workspace: { choice: 'org1', confidence: 0.9, probabilities: { org1: 0.9 } },
      agent: { choice: 'org1/analyst', confidence: 0.85, probabilities: { 'org1/analyst': 0.85 } },
      effort: { score: 1 }, status_about: { choice: 'other', confidence: 0.9 },
    } };
  };
  const r = await route('pull the numbers from the sales sheet', { harness });
  ok(!!got && got.opts.timeoutMs >= 60_000 && got.questions.intent && got.questions.agent, 'Jev off: the harness gets Jev’s own questions, with a longer wait', JSON.stringify(got?.opts));
  ok(r.source === 'jev' && r.agent === 'analyst' && r.jev?.via === 'harness:codex', 'and its answer routes like Jev’s (agent picked, via the harness)', JSON.stringify(r));
  got = null;
  const live = await route('pull the numbers from the sales sheet', { harness, purpose: 'live' });
  ok(!got && live.source === 'heuristic', 'reads while the owner types never use the harness', JSON.stringify(live));
  const broken = await route('pull the numbers from the sales sheet', { harness: async () => { throw new Error('codex fell over'); } });
  ok(broken.source === 'heuristic' && broken.workspace === 'org1', 'a harness that fails: keyword routing', JSON.stringify(broken));
  got = null;
  await route('pull the numbers', { ask: async () => { throw new Error('Jev 500'); }, harness });
  ok(!got, 'Jev that is on but failing does not fall to the harness (only Jev off does)');
}

// ── askViaHarness: Jev's chat emulation through a harness ──
{
  const questions = { intent: { type: 'choice', instructions: 'x', criteria: { task: 'do', chat: 'talk' } }, effort: { type: 'score', criteria: ['low', 'high'] } };
  let sent = null;
  const think = async o => { sent = o; return { text: 'Here you go:\n```json\n{"intent":{"choice":"chat","confidence":0.7},"effort":{"score":1}}\n```' }; };
  const r = await askViaHarness({ instruction: 'hi' }, questions, { via: 'hermes', think });
  ok(r.answers.intent.choice === 'chat' && r.answers.effort.score === 1 && r.via === 'harness:hermes', 'a fenced or wrapped JSON answer is mapped like Jev’s', JSON.stringify(r));
  ok(sent.via === 'hermes' && /routing questions/.test(sent.system) && /"questions"/.test(sent.prompt) && /schema/i.test(sent.prompt), 'the harness gets Jev’s system prompt, the state, the questions and the schema');
  let err = null;
  try { await askViaHarness({}, questions, { via: 'hermes', think: async () => ({ text: 'no idea' }) }); } catch (e) { err = e; }
  ok(!!err, 'no JSON: an error (the router then uses keywords)');
  ok(firstJson('{"a":1}').a === 1 && firstJson('x {"a":2} y').a === 2 && firstJson('nope') === null, 'firstJson finds the object');
}

// ── brain pick and Hermes's text-only flags ──
{
  const keep = process.env.ORCHY_BRAIN;
  process.env.ORCHY_BRAIN = 'off';
  ok(brainEngine() === null, 'ORCHY_BRAIN=off: no brain');
  // a harness that is there but won't start is never the brain: picked by name it's none, else the next that runs
  const undo = registerEngine({ ...engine('claude'), available: () => true, version: () => null });
  process.env.ORCHY_BRAIN = 'claude';
  ok(brainEngine() === null, 'ORCHY_BRAIN=claude but it won’t start: no brain');
  delete process.env.ORCHY_BRAIN;
  ok(brainEngine() !== 'claude', 'in order: a harness that won’t start is passed over');
  undo();
  // OpenCode 2 starts, but Orchy can't gate it (its code mode reaches the network without asking): never the brain
  const undo2 = registerEngine({ ...engine('opencode'), available: () => true, version: () => 'opencode v2.0.28' });
  process.env.ORCHY_BRAIN = 'opencode';
  ok(brainEngine() === null, 'ORCHY_BRAIN=opencode on OpenCode 2: no brain');
  delete process.env.ORCHY_BRAIN;
  ok(brainEngine() !== 'opencode', 'in order: OpenCode 2 is passed over');
  undo2();
  if (keep === undefined) delete process.env.ORCHY_BRAIN; else process.env.ORCHY_BRAIN = keep;
  ok(['--safe-mode', '--oneshot', '-Q'].every(f => HERMES_BRAIN_ARGS.includes(f)) && HERMES_BRAIN_ARGS[HERMES_BRAIN_ARGS.indexOf('-t') + 1] === 'todo', 'Hermes as the brain: one-shot, safe mode, only its task-list toolset');
}

// ── Orchy with nothing to think with ──
{
  const a = offlineAnswer('what can the two agents do?', 'no harness', { agents: AGENTS, wss: ONE });
  ok(/Wren \(Writes the newsletter\)/.test(a) && /Ana Lytics/.test(a) && /Test Org1 Workspace/.test(a), 'a question about the agents is answered from the agent list', a);
  ok(offlineAnswer('tell me a joke', 'no harness', { agents: AGENTS, wss: ONE }) === 'no harness', 'anything else says what is missing');
}

// ── installers: the official command for each OS, then the sign-in ──
{
  const want = {
    claude: ['curl -fsSL https://claude.ai/install.sh | bash', 'powershell -ExecutionPolicy ByPass -c "irm https://claude.ai/install.ps1 | iex"', 'claude auth login'],
    codex: ['curl -fsSL https://chatgpt.com/codex/install.sh | sh', 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"', 'codex login'],
    opencode: ['curl -fsSL https://opencode.ai/install | bash', 'npm install -g opencode-ai', 'opencode auth login'],
    hermes: ['curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash', 'powershell -ExecutionPolicy ByPass -c "iex (irm https://hermes-agent.nousresearch.com/install.ps1)"', 'hermes portal'],
  };
  for (const [id, [posix, win, signIn]] of Object.entries(want)) {
    const e = engine(id);
    ok(engineInstallCmd(e, { win: false }) === posix && engineInstallCmd(e, { win: true }) === win && e.install.signIn === signIn, `${id}: macOS/Linux and Windows installers, then ${signIn}`);
    const ps = installScript(e, { win: true, dirs: installBinDirs({ win: true, home: 'C:\\Users\\u', appData: 'C:\\A', localAppData: 'C:\\L' }) });
    ok(ps.includes(`\n${win}\n`) && ps.includes(`Get-Command '${e.install.bin}'`) && ps.includes(`& '${e.install.bin}' --version`) && ps.includes(`  ${signIn}\n`) && /GetEnvironmentVariable\('Path', 'User'\)/.test(ps) && ps.includes("'CLAUDE_CONFIG_DIR'"), `${id}: the PowerShell window installs, refreshes PATH, clears profile variables, signs in`);
    const sh = installScript(e, { win: false });
    ok(sh.includes(`\n${posix}\n`) && sh.includes(`if '${e.install.bin}' --version >/dev/null 2>&1; then`) && sh.includes(`command -v '${e.install.bin}'`) && sh.includes(`  ${signIn}\n`) && /\nunset CLAUDE_CONFIG_DIR CODEX_HOME/.test(sh) && sh.includes('$HOME/.local/bin'), `${id}: the shell window does the same on macOS/Linux`);
  }
  ok(installBinDirs({ win: true, home: 'H', appData: 'A', localAppData: 'L' }).some(d => /Programs[\\/]OpenAI[\\/]Codex[\\/]bin$/.test(d)), 'Windows PATH includes where the Codex installer puts codex');
}

// ── half-done installs: the program is there but won't start (npm's placeholder opencode.exe) ──
{
  const fake = (over = {}) => ({ id: 'fake', label: 'Fake', install: { winCmd: 'npm i -g fake', cmd: 'curl fake | sh', winRepair: 'node fix.mjs', bin: 'fake' }, bin: () => 'C:\\x\\fake.exe', available: () => true, version: () => '1.0', ...over });
  ok(engineHealth(fake()) === 'ok', 'a program that answers --version is ok');
  ok(engineHealth(fake({ version: () => null })) === 'broken', 'one that is there but fails --version is broken');
  ok(engineHealth(fake({ version: () => { throw new Error('boom'); } })) === 'broken', 'a probe that throws reads as broken');
  ok(engineHealth(fake({ available: () => false })) === 'missing', 'one that is not there is missing');
  ok(engineRepairCmd(fake(), { win: true }) === 'node fix.mjs' && engineRepairCmd(fake(), { win: false }) === 'curl fake | sh', 'repair: the Windows fix there, installing again elsewhere');
  ok(/won't start/.test(brokenMessage(fake(), { win: true })) && brokenMessage(fake(), { win: true }).includes('node fix.mjs'), 'the message says it won\'t start and how to finish it');
  ok(/postinstall\.mjs/.test(engineRepairCmd(engine('opencode'), { win: true })), 'OpenCode on Windows: rerun its postinstall');
  const ps = installScript(engine('opencode'), { win: true, dirs: [] });
  ok(/\} elseif \(\$found\) \{/.test(ps) && ps.includes("won''t start") && ps.includes('postinstall.mjs') && ps.indexOf('opencode auth login') < ps.indexOf('elseif ($found)'), 'the install window signs in only when it runs, else shows the repair');
  ok(/if \(\$found -and -not \$runs\) \{[^}]*node postinstall\.mjs[^}]*\$runs = Test-Runs/.test(ps) && ps.indexOf('$runs = Test-Runs') < ps.indexOf('if ($runs) {'), 'a reinstall that still won’t start runs the repair itself and tests again (npm skipping postinstall twice)');
  ok(/\$global:LASTEXITCODE = 0; try \{ & 'opencode' --version \*> \$null; \$ok = \$\? -and \$global:LASTEXITCODE -eq 0 \} catch \{ \}/.test(ps), 'the probe counts a script launcher that returns normally, never a program that can’t start');
  ok(!installScript(engine('claude'), { win: true, dirs: [] }).includes('Test-Runs\n}') && !/-not \$runs/.test(installScript(engine('claude'), { win: true, dirs: [] })), 'an engine without a repair command has no repair step');
  const win = loginRun("& 'x' auth login", { win: true });
  ok(/^\$global:LASTEXITCODE = 0\n& 'x' auth login\nif \(\$\? -and \$global:LASTEXITCODE -eq 0\)/.test(win) && win.includes("didn''t finish") && win.includes('Done.'), 'the login window says Done only when the sign-in succeeded (PowerShell)');
  const sh = loginRun("'x' auth login", { win: false });
  ok(/^'x' auth login\nif \[ \$\? -eq 0 \]; then/.test(sh) && sh.includes('finish'), 'and in the macOS/Linux shell');
}

if (fail) { console.log(`\n${fail} brain check(s) failed`); process.exit(1); }
console.log('\nall brain checks passed');
