// npm run setup's questions (scripts/setup.mjs), with scripted answers: no terminal, no network, .env untouched.
// Run: node orchestrator/scripts/test-setup.mjs
import { questions } from '../../scripts/setup.mjs';

let fail = 0;
const ok = (cond, label, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : `  ${extra}`}`); if (!cond) fail++; };

/** Run the questions against an in-memory .env. answers: what yesNo / choose return, in order; keys: envKey → pasted key (or null). */
async function run({ answers, keys = {}, start = {} }) {
  const store = { ...start };
  const asked = [];
  const queue = [...answers];
  const next = q => { asked.push(q); if (!queue.length) throw new Error(`no scripted answer for: ${q}`); return queue.shift(); };
  const io = {
    yesNo: async q => next(q),
    choose: async q => next(q),
    askKey: async (envKey, label, where, extra) => { asked.push(`key:${envKey}${extra ? `:${extra}` : ''}`); return keys[envKey] ?? null; },
    log: () => {},
  };
  await questions(k => store[k] || '', (k, v) => { store[k] = v; }, io);
  return { store, asked, left: queue.length };
}

// voice off, Jev off, scripts stay on
let r = await run({ answers: [false, false, 0] });
ok(r.store.VOICE_ENABLED === '0' && r.store.JEV_PROVIDER === 'off' && r.store.SETUP_SCRIPTS === 'on' && !r.left, 'n, n: chat only, Jev off, scripts stay on');
ok(!r.asked.some(a => a.startsWith('key:')), 'no key is asked for when both answers are no');

// voice with ElevenLabs, Jev with TypeSafe
r = await run({ answers: [true, 0, true, 0, 1], keys: { ELEVENLABS_API_KEY: 'el', TYPESAFE_API_KEY: 'ts' } });
ok(r.store.VOICE_ENABLED === '1' && r.store.VOICE_PROVIDER === 'elevenlabs' && r.store.ELEVENLABS_API_KEY === 'el' && !('DEEPGRAM_API_KEY' in r.store), 'Voice, ElevenLabs: only its key is asked and saved, and it is the voice');
ok(r.store.TYPESAFE_API_KEY === 'ts' && r.store.JEV_PROVIDER === 'typesafe', 'Jev, [1] TypeSafe: key saved, provider set');
ok(r.store.SETUP_SCRIPTS === 'off', 'scripts: Off');

// Deepgram only, then both
r = await run({ answers: [true, 1, false, 0], keys: { DEEPGRAM_API_KEY: 'dg' } });
ok(r.store.DEEPGRAM_API_KEY === 'dg' && !r.asked.includes('key:ELEVENLABS_API_KEY'), 'Voice, Deepgram: only the Deepgram key');
r = await run({ answers: [true, 2, false, 0], keys: { ELEVENLABS_API_KEY: 'el', DEEPGRAM_API_KEY: 'dg' } });
ok(r.store.ELEVENLABS_API_KEY === 'el' && r.store.DEEPGRAM_API_KEY === 'dg', 'Voice, Both: both keys');

// other providers
r = await run({ answers: [false, true, 1, 0, 0], keys: { OPENROUTER_API_KEY: 'or' } });
ok(r.store.JEV_PROVIDER === 'openrouter' && r.store.OPENROUTER_API_KEY === 'or', 'Jev, [2] Other → OpenRouter');
r = await run({ answers: [false, true, 1, 1, 0], keys: { OPENCODE_API_KEY: 'oc' } });
ok(r.store.JEV_PROVIDER === 'opencode' && r.asked.includes('key:OPENCODE_API_KEY:jev-1.13'), 'Jev → OpenCode Zen: the key is checked against jev-1.13 (the free tier only answers the OpenCode app)');
r = await run({ answers: [false, true, 1, 1, 0], keys: { OPENCODE_API_KEY: 'oc' }, start: { OPENCODE_JEV_MODEL: 'jev-2' } });
ok(r.asked.includes('key:OPENCODE_API_KEY:jev-2'), 'OpenCode Zen: an OPENCODE_JEV_MODEL already set is the one checked');
r = await run({ answers: [false, true, 1, 2, 0], keys: { AI_GATEWAY_API_KEY: 'vg' } });
ok(r.store.JEV_PROVIDER === 'vercel' && r.store.AI_GATEWAY_API_KEY === 'vg', 'Jev → Vercel AI Gateway');

// a skipped key: Jev stays off, and nothing is half set
r = await run({ answers: [false, true, 0, 0] });
ok(r.store.JEV_PROVIDER === '' && !('TYPESAFE_API_KEY' in r.store), 'Jev with the key skipped: provider left automatic (off until a key)');
// a key that was already there and kept
r = await run({ answers: [true, false, true, 0, 0], start: { TYPESAFE_API_KEY: 'old', VOICE_ENABLED: '1' } });
ok(r.store.JEV_PROVIDER === 'typesafe' && r.store.TYPESAFE_API_KEY === 'old', 'run again, key kept: the provider still points at it');

// run again, and say no to going through it again
r = await run({ answers: [false], start: { VOICE_ENABLED: '1', JEV_PROVIDER: 'typesafe' } });
ok(r.asked.length === 1 && /run before/.test(r.asked[0]) && Object.keys(r.store).length === 2, 'setup run before: one question, nothing changes');

// the One CLI step: missing, or a failed install, only warns (setup goes on and the launchers start Orchy)
const { oneStep } = await import('../../scripts/setup.mjs');
async function one({ version = null, interactive = false, yes = true, installs = false, throws = false }) {
  const lines = [], asked = [];
  let installed = 0;
  const found = await oneStep({
    version, interactive, log: l => lines.push(l),
    yesNo: async q => { asked.push(q); return yes; },
    install: () => { installed++; if (throws) throw new Error('npm missing'); return installs; },
  });
  return { found, out: lines.join('\n'), asked, installed };
}
let o = await one({ version: '1.2.3' });
ok(o.found && /1\.2\.3/.test(o.out) && !o.asked.length && !/docs\/ONE\.md/.test(o.out), 'One found: its version, nothing asked, no warning');
o = await one({});
ok(!o.found && !o.asked.length && !o.installed, 'One missing, no terminal: nothing asked, nothing installed');
ok(/Orchy still starts/.test(o.out) && o.out.includes('npm install -g @withone/cli') && o.out.includes('docs/ONE.md'), 'One missing: a warning with the install command and docs/ONE.md');
o = await one({ interactive: true, yes: false });
ok(!o.found && o.asked.length === 1 && !o.installed && /docs\/ONE\.md/.test(o.out), 'One missing, install declined: warning, no install');
o = await one({ interactive: true, installs: false });
ok(!o.found && o.installed === 1 && /didn't finish/.test(o.out) && /Orchy still starts/.test(o.out), 'One install fails: warning, setup goes on');
o = await one({ interactive: true, throws: true });
ok(!o.found && o.installed === 1 && /Orchy still starts/.test(o.out), 'One install throws: warning, setup goes on');
o = await one({ interactive: true, installs: true });
ok(o.found && /installed/.test(o.out) && !/Orchy still starts/.test(o.out), 'One installed by setup: no warning');

// "Fix Orchy": the Claude Code account Orchy works on his own code under. A fresh config.json has none.
const { backendAccountStep } = await import('../../scripts/setup.mjs');
async function fixAcct({ set = null, signedInAs = null, interactive = true, yes = true }) {
  const config = { orchy: { claudeAccount: set, claudeConfigDir: set ? '~/.claude-x' : null } };
  const lines = [], asked = [];
  let saved = 0;
  const got = await backendAccountStep({ config, saveConfig: () => saved++, signedInAs, interactive, log: l => lines.push(l), yesNo: async q => { asked.push(q); return yes; } });
  return { got, config, saved, asked, out: lines.join('\n') };
}
let b = await fixAcct({ signedInAs: 'owner@example.com' });
ok(b.got === 'owner@example.com' && b.config.orchy.claudeAccount === 'owner@example.com' && b.config.orchy.claudeConfigDir === null && b.saved === 1 && b.asked.length === 1,
  'Fix Orchy: this computer’s Claude Code sign-in is offered, and saved (default profile) when the owner says yes');
b = await fixAcct({ signedInAs: 'owner@example.com', yes: false });
ok(b.got === null && b.config.orchy.claudeAccount === null && !b.saved && /Settings → Accounts/.test(b.out), 'Fix Orchy: declined, nothing saved, and it says where to set it later');
b = await fixAcct({ signedInAs: 'owner@example.com', interactive: false });
ok(b.got === null && !b.asked.length && !b.saved, 'Fix Orchy: --yes / no terminal asks nothing and saves nothing');
b = await fixAcct({ signedInAs: null });
ok(b.got === null && !b.asked.length && !b.saved && /claude auth login/.test(b.out), 'Fix Orchy: Claude Code not signed in, it says how, nothing asked');
b = await fixAcct({ set: 'kept@example.com', signedInAs: 'owner@example.com' });
ok(b.got === 'kept@example.com' && b.config.orchy.claudeAccount === 'kept@example.com' && b.config.orchy.claudeConfigDir === '~/.claude-x' && !b.asked.length && !b.saved,
  'Fix Orchy: an account already set is kept as it is, with its profile');

// each key is checked once with its own service: the right address and header, and what the answer means
const seen = [];
let status = 200;
globalThis.fetch = async (url, init = {}) => { seen.push({ url: String(url), init }); if (status === 0) throw new Error('offline'); return { ok: status < 300, status }; };
const expect = {
  ELEVENLABS_API_KEY: ['https://api.elevenlabs.io/v1/voices', i => i.headers['xi-api-key'] === 'K'],
  DEEPGRAM_API_KEY: ['https://api.deepgram.com/v1/projects', i => i.headers.Authorization === 'Token K'],
  TYPESAFE_API_KEY: ['https://api.typesafe.ai/v1/models', i => i.headers.Authorization === 'Bearer K'],
  OPENROUTER_API_KEY: ['https://openrouter.ai/api/v1/key', i => i.headers.Authorization === 'Bearer K'],
  AI_GATEWAY_API_KEY: ['https://ai-gateway.vercel.sh/typesafe/v1/models', i => i.headers.Authorization === 'Bearer K'],
  OPENCODE_API_KEY: ['https://opencode.ai/zen/v1/chat/completions', i => i.headers.Authorization === 'Bearer K' && JSON.parse(i.body).model === 'jev-1.13' && JSON.parse(i.body).max_tokens === 1],
  ANTHROPIC_API_KEY: ['https://api.anthropic.com/v1/models', i => i.headers['x-api-key'] === 'K' && i.headers['anthropic-version'] === '2023-06-01'],
  OPENAI_API_KEY: ['https://api.openai.com/v1/models', i => i.headers.Authorization === 'Bearer K'],
  GEMINI_API_KEY: ['https://generativelanguage.googleapis.com/v1beta/models?key=K', () => true],
  DEEPSEEK_API_KEY: ['https://api.deepseek.com/models', i => i.headers.Authorization === 'Bearer K'],
  GROQ_API_KEY: ['https://api.groq.com/openai/v1/models', i => i.headers.Authorization === 'Bearer K'],
};
const { CHECKS } = await import('../../scripts/setup.mjs');
for (const [key, [url, good]] of Object.entries(expect)) {
  seen.length = 0;
  const r = await CHECKS[key]('K', 'jev-1.13');
  ok(r === 'ok' && seen[0].url === url && good(seen[0].init), `${key}: checked at ${new URL(url).host}`);
}
status = 401; ok(await CHECKS.TYPESAFE_API_KEY('K') === 'bad', '401: the key is refused');
status = 403; ok(await CHECKS.OPENROUTER_API_KEY('K') === 'bad', '403: the key is refused');
status = 500; ok(/answered 500/.test(await CHECKS.DEEPGRAM_API_KEY('K')), 'a server error: couldn’t check (saved anyway)');
status = 0; ok(/offline/.test(await CHECKS.ELEVENLABS_API_KEY('K')), 'no connection: couldn’t check (saved anyway)');

// OpenAI key with router Base URL
seen.length = 0; status = 200;
await CHECKS.OPENAI_API_KEY('K', 'https://api.orcarouter.com/v1');
ok(seen[0]?.url === 'https://api.orcarouter.com/v1/models', 'OPENAI_API_KEY with custom router baseUrl');

// ── cliStep tests ──
const { cliStep } = await import('../../scripts/setup.mjs');

async function testCli({ answers = [], keys = {}, startConfig = {}, envStore = {}, engines = [], found = {} }) {
  const config = { orchy: { ...startConfig } };
  const envMap = { ...envStore };
  const asked = [];
  const queue = [...answers];
  const next = q => { asked.push(q); if (!queue.length) throw new Error(`no scripted answer for: ${q}`); return queue.shift(); };
  const io = {
    yesNo: async q => next(q),
    choose: async q => next(q),
    askKey: async (envKey, label, where, extra) => { asked.push(`key:${envKey}${extra ? `:${extra}` : ''}`); return keys[envKey] ?? null; },
    ask: async q => next(q),
    log: () => {},
  };
  await cliStep({
    config,
    saveConfig: () => {},
    env: k => envMap[k] || '',
    setEnv: (k, v) => { envMap[k] = v; },
    interactive: true,
    engines,
    found,
    io,
  });
  return { config, envMap, asked };
}

// 1. Pick Aider with OpenRouter
let c = await testCli({
  answers: [5, 0, true], // 5=Aider, 0=OpenRouter, true=set opus/sonnet tier models
  keys: { OPENROUTER_API_KEY: 'sk-or-test' },
});
ok(c.config.orchy.runtime === 'aider' && c.config.orchy.aiderAccount === 'OpenRouter', 'cliStep: Aider with OpenRouter runtime and account set');
ok(c.envMap.OPENROUTER_API_KEY === 'sk-or-test', 'cliStep: OPENROUTER_API_KEY saved to env');
ok(c.config.runtimes?.aider?.models?.includes('openrouter/anthropic/claude-3-opus'), 'cliStep: default Aider OpenRouter models configured');

// 2. Pick Aider with Orca Router
c = await testCli({
  answers: [5, 1, 'https://api.orcarouter.com/v1'], // 5=Aider, 1=Orca, custom url
  keys: { OPENAI_API_KEY: 'sk-orca-test' },
});
ok(c.config.orchy.runtime === 'aider' && c.config.orchy.aiderAccount === 'Orca Router', 'cliStep: Aider with Orca Router runtime and account set');
ok(c.envMap.OPENAI_API_BASE === 'https://api.orcarouter.com/v1', 'cliStep: Orca Router OPENAI_API_BASE saved');
ok(c.envMap.OPENAI_API_KEY === 'sk-orca-test' && c.envMap.ORCA_API_KEY === 'sk-orca-test', 'cliStep: Orca API key saved');

// 3. Pick OpenCode with Zen and Claude 3.5 Sonnet model
c = await testCli({
  answers: [6, 0, 0], // 6=OpenCode, 0=Zen provider, 0=Claude 3.5 Sonnet model
  keys: { OPENCODE_API_KEY: 'sk-zen-test' },
});
ok(c.config.orchy.runtime === 'opencode' && c.config.orchy.opencodeAccount === 'Zen', 'cliStep: OpenCode runtime and account set');
ok(c.config.runtimes?.opencode?.models?.includes('zen/claude-3-5-sonnet'), 'cliStep: OpenCode model configured in runtimes');
ok(c.envMap.OPENCODE_API_KEY === 'sk-zen-test' && c.envMap.OPENCODE_MODEL === 'zen/claude-3-5-sonnet', 'cliStep: OPENCODE_API_KEY and OPENCODE_MODEL saved');

// 3a. Pick OpenCode with OpenRouter
c = await testCli({
  answers: [6, 1, 0], // 6=OpenCode, 1=OpenRouter provider, 0=Claude 3.5 Sonnet model
  keys: { OPENROUTER_API_KEY: 'sk-or-oc' },
});
ok(c.config.orchy.runtime === 'opencode' && c.config.orchy.opencodeAccount === 'OpenRouter', 'cliStep: OpenCode with OpenRouter account set');
ok(c.config.runtimes?.opencode?.models?.includes('openrouter/anthropic/claude-3.5-sonnet'), 'cliStep: OpenCode OpenRouter model configured in runtimes');
ok(c.envMap.OPENROUTER_API_KEY === 'sk-or-oc' && c.envMap.OPENCODE_MODEL === 'openrouter/anthropic/claude-3.5-sonnet', 'cliStep: OpenCode OpenRouter key and model saved');

// 3b. Pick Hermes with Hermes 3 70B model
c = await testCli({
  answers: [2, 0, 0], // 2=Hermes, 0=OpenRouter, 0=Hermes 70B
  keys: { OPENROUTER_API_KEY: 'sk-hermes-or' },
});
ok(c.config.orchy.runtime === 'hermes', 'cliStep: Hermes runtime set');
ok(c.config.runtimes?.hermes?.models?.includes('nousresearch/hermes-3-llama-3.1-70b'), 'cliStep: Hermes model configured in runtimes');
ok(c.envMap.OPENROUTER_API_KEY === 'sk-hermes-or' && c.envMap.HERMES_MODEL === 'nousresearch/hermes-3-llama-3.1-70b', 'cliStep: Hermes key and HERMES_MODEL saved');

// 4. Pick Custom CLI
c = await testCli({
  answers: [7, 'python my_agent.py'], // 7=Custom CLI, command
});
ok(c.config.orchy.runtime === 'custom' && c.config.orchy.customCommand === 'python my_agent.py', 'cliStep: Custom CLI command and runtime saved');

// 5. Pick Claude Code with existing signed in account
c = await testCli({
  answers: [0, true], // 0=Claude Code, yes to use account
  engines: [{ id: 'claude', label: 'Claude Code', account: async () => ({ loggedIn: true, email: 'user@example.com' }) }],
  found: { claude: true },
});
ok(c.config.orchy.runtime === 'claude' && c.config.orchy.claudeAccount === 'user@example.com', 'cliStep: Claude Code with signed in account');

// the launcher: this computer's one is copied from launchers/ into the Orchy folder, the others aren't
{
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { placeLauncher } = await import('../../scripts/setup.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchy-launch-'));
  fs.mkdirSync(path.join(root, 'launchers'));
  for (const n of ['Start Orchy.cmd', 'Start Orchy.command', 'Start Orchy.sh']) fs.writeFileSync(path.join(root, 'launchers', n), `${n}\nline 2\n`);
  ok(placeLauncher(root, 'win32') === 'made' && fs.readFileSync(path.join(root, 'Start Orchy.cmd'), 'utf8') === 'Start Orchy.cmd\r\nline 2\r\n', 'Windows: Start Orchy.cmd copied to the Orchy folder, with CRLF');
  ok(!fs.existsSync(path.join(root, 'Start Orchy.command')) && !fs.existsSync(path.join(root, 'Start Orchy.sh')), 'Windows: only its own launcher is copied');
  ok(placeLauncher(root, 'win32') === 'same', 'run again: left as it is');
  fs.appendFileSync(path.join(root, 'launchers', 'Start Orchy.cmd'), 'line 3\n');
  ok(placeLauncher(root, 'win32') === 'updated', 'launchers/ changed (a pull): the copy is refreshed');
  ok(placeLauncher(root, 'darwin') === 'made' && fs.readFileSync(path.join(root, 'Start Orchy.command'), 'utf8') === 'Start Orchy.command\nline 2\n', 'macOS: Start Orchy.command copied as it is');
  ok(placeLauncher(root, 'linux') === 'made' && fs.existsSync(path.join(root, 'Start Orchy.sh')), 'Linux: Start Orchy.sh copied');
  fs.rmSync(path.join(root, 'launchers'), { recursive: true });
  ok(placeLauncher(root, 'linux') === 'missing', 'no launchers folder: nothing to copy');
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} failed` : '\nall setup checks passed');
process.exit(fail ? 1 : 0);
