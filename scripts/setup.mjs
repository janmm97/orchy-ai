// First-run setup: `npm run setup`. Safe to re-run: a key you don't change stays as it is.
// Node only, no dependencies. Checks Node, installs packages, creates .env, finds the CLIs Orchy drives, asks
// about Voice, Jev and scripts, checks each key once with its service, then starts Orchy (the browser opens).
//   --yes       ask nothing and keep .env as it is (scripts, CI)
//   --no-start  don't start Orchy at the end (the Start Orchy launchers start it themselves)
// It also copies this computer's launcher from launchers/ into the Orchy folder (placeLauncher).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

export const ONE_GUIDE = `Getting started with One:
  Orchy works with One.
  1) Create an account at https://app.withone.ai/sign-in.
  2) Make one organization per business or client (org switcher, top left).
  3) In Orchy: Workspaces → your workspace → Sign in to One.
  4) Orchy → Connections → Add app.
  5) Can't find an app? In the One dashboard click Developers (bottom left) → Embeddable Auth,
     search for the tool and turn on its Visible toggle.
  Full guide: docs/ONE.md`;

const win = process.platform === 'win32';
const mac = process.platform === 'darwin';
const OK = '✓', NO = '✗';
const args = new Set(process.argv.slice(2));
const interactive = !args.has('--yes') && process.stdin.isTTY && process.stdout.isTTY;

/** The One CLI row. The harness rows come from the engine registry (orchestrator/lib/engines/index.mjs#engineTools): every registered engine appears. */
export const ONE_TOOL = { id: 'one', label: 'One CLI', kind: 'one', install: 'npm install -g @withone/cli' };

function sh(cmd, argv, opts = {}) {
  return spawnSync(cmd, argv, { stdio: 'inherit', shell: win, ...opts });
}
const hasOne = () => spawnSync('one', ['--version'], { shell: win, stdio: 'ignore', windowsHide: true }).status === 0;

// ── asking ──
async function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(q)).trim(); } finally { rl.close(); }
}
async function yesNo(q, yes = true) {
  for (;;) {
    const a = (await ask(`${q} ${yes ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
    if (!a) return yes;
    if (['y', 'yes'].includes(a)) return true;
    if (['n', 'no'].includes(a)) return false;
  }
}
async function choose(q, options) {
  console.log(q);
  options.forEach((o, i) => console.log(`    [${i + 1}] ${o}`));
  for (;;) {
    const n = Number(await ask(`  Pick 1-${options.length}: `));
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
  }
}
/** A key typed or pasted without showing it (one * per character). */
function secret(prompt) {
  const { stdin, stdout } = process;
  stdout.write(prompt);
  return new Promise(resolve => {
    let value = '', esc = false;
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const done = () => { stdin.off('data', onData); stdin.setRawMode(false); stdin.pause(); stdout.write('\n'); resolve(value.trim()); };
    const onData = chunk => {
      for (const ch of chunk) {
        if (esc) { if (/[A-Za-z~]/.test(ch)) esc = false; continue; } // a terminal's escape sequence (bracketed paste)
        if (ch === '\u001b') { esc = true; continue; }
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') { stdin.setRawMode(false); stdout.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') { if (value) { value = value.slice(0, -1); stdout.write('\b \b'); } continue; }
        if (ch < ' ') continue;
        value += ch; stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

// ── checking a key once with its service: 'ok', 'bad' (refused), or why it couldn't be checked ──
async function probe(url, init = {}) {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    return r.ok ? 'ok' : r.status === 401 || r.status === 403 ? 'bad' : `the service answered ${r.status}`;
  } catch (e) { return e.name === 'TimeoutError' ? 'the service didn’t answer' : e.message; }
}
const bearer = k => ({ headers: { Authorization: `Bearer ${k}` } });
export const CHECKS = {
  ELEVENLABS_API_KEY: k => probe('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': k } }),
  DEEPGRAM_API_KEY: k => probe('https://api.deepgram.com/v1/projects', { headers: { Authorization: `Token ${k}` } }),
  TYPESAFE_API_KEY: k => probe('https://api.typesafe.ai/v1/models', bearer(k)),
  OPENROUTER_API_KEY: k => probe('https://openrouter.ai/api/v1/key', bearer(k)),
  AI_GATEWAY_API_KEY: k => probe('https://ai-gateway.vercel.sh/typesafe/v1/models', bearer(k)),
  // Zen's model list is public, so a one-token reply is the check
  OPENCODE_API_KEY: (k, model) => probe('https://opencode.ai/zen/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model || 'jev-1.13', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
  }),
  ANTHROPIC_API_KEY: k => probe('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01' } }),
  OPENAI_API_KEY: (k, baseUrl) => probe(`${(baseUrl && /^https?:\/\//i.test(baseUrl) ? baseUrl : 'https://api.openai.com/v1').replace(/\/+$/, '')}/models`, bearer(k)),
  GEMINI_API_KEY: k => probe(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(k)}`),
  DEEPSEEK_API_KEY: k => probe('https://api.deepseek.com/models', bearer(k)),
  GROQ_API_KEY: k => probe('https://api.groq.com/openai/v1/models', bearer(k)),
};

/** Ask for one key and check it. Returns the key to save, or null (skipped, or kept as it was). */
async function askKey(env, envKey, label, where, extra) {
  if (env(envKey) && !(await yesNo(`  A ${label} key is already set. Replace it?`, false))) return null;
  for (let tries = 0; tries < 3; tries++) {
    const k = await secret(`  Paste your ${label} API key (${where}), or press Enter to skip: `);
    if (!k) return null;
    process.stdout.write('  Checking it… ');
    const r = await CHECKS[envKey](k, extra);
    if (r === 'ok') { console.log(`${OK} it works`); return k; }
    if (r === 'bad') { console.log(`${NO} ${label} refused that key.${envKey === 'ELEVENLABS_API_KEY' ? ' It needs "Text to Speech" and "Voices: Read" switched on.' : ''}`); continue; }
    console.log(`? couldn’t check it (${r}). Saving it anyway.`);
    return k;
  }
  console.log(`  Skipped after three tries. Add it later in Settings.`);
  return null;
}

/** The questions (io is swapped for scripted answers in test-setup.mjs). */
export async function questions(env, setEnv, io = { yesNo, choose, askKey: (...a) => askKey(env, ...a), log: console.log }) {
  const set = (k, v) => setEnv(k, v);
  const { yesNo, choose, askKey, log } = io;
  const answered = env('VOICE_ENABLED') || env('JEV_PROVIDER');
  if (answered && !(await yesNo('\n  Setup has run before. Go through the questions again?', false))) return;
  const later = []; // a feature wanted with its key left for later: the dashboard won't ask again (lib/features.mjs)

  log('\n  Voice');
  if (!(await yesNo('  Do you want to enable the Voice Agent feature (talk to Orchy and your agents)?', true))) {
    set('VOICE_ENABLED', '0');
    log('  Voice is off: Orchy is chat only. Settings → Voice turns it on later.');
  } else {
    set('VOICE_ENABLED', '1');
    const which = await choose('  Which voice service do you have?', ['ElevenLabs (natural voices, and live calls with your agents)', 'Deepgram (Orchy reads its replies aloud)', 'Both']);
    set('VOICE_PROVIDER', ['elevenlabs', 'deepgram', ''][which]);
    let any = false;
    if (which !== 1) { const k = await askKey('ELEVENLABS_API_KEY', 'ElevenLabs', 'elevenlabs.io → Developers → API keys'); if (k) { set('ELEVENLABS_API_KEY', k); any = true; } }
    if (which !== 0) { const k = await askKey('DEEPGRAM_API_KEY', 'Deepgram', 'console.deepgram.com → API keys'); if (k) { set('DEEPGRAM_API_KEY', k); any = true; } }
    if (!any && !env('ELEVENLABS_API_KEY') && !env('DEEPGRAM_API_KEY')) { later.push('voice'); log('  No voice key yet: Orchy uses your browser’s voice until you add one in Settings. It won’t ask again.'); }
  }

  log('\n  Jev (routing)');
  log('  Jev reads each message and picks the workspace, the agent and the model.');
  if (!(await yesNo('  Do you want to use Jev?', true))) {
    set('JEV_PROVIDER', 'off');
    log('  Jev is off: Orchy matches each message to a workspace and agent by its words, and the agent picks its own tools.');
  } else {
    const src = await choose('  How do you reach Jev?', ['A TypeSafe key', 'Another provider']);
    let provider, envKey, label, where, model;
    if (src === 0) [provider, envKey, label, where] = ['typesafe', 'TYPESAFE_API_KEY', 'TypeSafe', 'typesafe.ai'];
    else {
      const p = await choose('  Which provider?', ['OpenRouter', 'OpenCode Zen', 'Vercel AI Gateway']);
      [provider, envKey, label, where] = [
        ['openrouter', 'OPENROUTER_API_KEY', 'OpenRouter', 'openrouter.ai → Keys'],
        ['opencode', 'OPENCODE_API_KEY', 'OpenCode Zen', 'opencode.ai → Zen → API keys'],
        ['vercel', 'AI_GATEWAY_API_KEY', 'Vercel AI Gateway', 'vercel.com → AI Gateway → API keys'],
      ][p];
      // OpenCode's free tier (jev-1.13-free) only answers the OpenCode app itself, so Orchy uses jev-1.13 with a key
      if (provider === 'opencode') model = env('OPENCODE_JEV_MODEL') || 'jev-1.13';
    }
    const k = await askKey(envKey, label, where, model);
    if (k) set(envKey, k);
    if (env(envKey)) { set('JEV_PROVIDER', provider); log(`  ${OK} Jev runs through ${label}.`); }
    else { set('JEV_PROVIDER', ''); later.push('jev'); log('  No key yet, so Jev stays off. Add one later in Settings → Routing. Orchy won’t ask again.'); }
  }

  log('\n  Scripts');
  const s = await choose('  When an agent wants to run a script:', [
    'Stay on: it runs on its own unless it looks like a decision (money, sending, deleting, sharing) (recommended)',
    'Off: ask me before every script',
  ]);
  set('SETUP_SCRIPTS', s === 0 ? 'on' : 'off'); // Orchy applies it once on start; Settings → Scripts changes it later
  if (later.length) set('SETUP_SKIPPED', later.join(',')); // likewise applied once on start
}

/** The One CLI step. Missing, or a failed install, is a warning and never stops setup: Orchy runs without it and
 *  only app connections wait for it. Installed on a Node it refuses (blocked: lib/one.mjs#oneNodeProblem) is said
 *  as that, with the Node fix, and never reinstalled. io is swapped for fakes in test-setup.mjs. Returns whether One runs. */
export async function oneStep({ version, blocked = null, recheck = () => null, interactive, yesNo, install, auto = false, log = console.log }) {
  const sayBlocked = b => {
    log(`  ${NO} ${ONE_TOOL.label.padEnd(28)} installed${b.version ? ` (${b.version})` : ''}, but it can't run on Node ${b.node}`);
    log(`\n  ! ${b.message}${b.fix ? `\n    Update Node with:\n      ${b.fix}` : ''}\n    Orchy still starts; app connections wait until One can run.`);
    return false;
  };
  if (blocked) return sayBlocked(blocked);
  if (version) { log(`  ${OK} ${ONE_TOOL.label.padEnd(28)} ${version}`); return true; }
  log(`  ${NO} ${ONE_TOOL.label.padEnd(28)} not found. It connects your agents to your apps (Gmail, Slack, Notion and more).`);
  let found = false;
  const shouldInstall = auto || (interactive && await yesNo(`  Install it now (${ONE_TOOL.install})?`, true));
  if (shouldInstall) {
    if (auto) log(`  Installing One CLI globally (${ONE_TOOL.install})...`);
    try { found = !!install(); } catch {}
    // it installed, but on a Node it refuses: say that, not "the install didn't finish"
    const b = found ? null : recheck();
    if (b) return sayBlocked(b);
    log(found ? `  ${OK} One CLI installed` : `  ${NO} The install didn't finish. If it did install, open a new terminal so the PATH updates.`);
  }
  if (!found) log(`\n  ! Orchy still starts, but app connections need the One CLI. Install it with:\n      ${ONE_TOOL.install}\n    then open a new terminal and run setup again. Guide: docs/ONE.md`);
  return found;
}

/** The account "Fix Orchy" runs under (Orchy working on his own code): a fresh install has none. This
 *  computer's harness sign-in is offered; Settings → Accounts changes it later. Never asked with --yes.
 *  io is swapped for fakes in test-setup.mjs. Returns the account set, or null. */
export async function backendAccountStep({ config, saveConfig, signedInAs, engineId = 'claude', interactive, yesNo, log = console.log }) {
  let engList = [];
  try {
    const m = await import(pathToFileURL(path.join(ROOT, 'orchestrator/lib/engines/index.mjs')).href);
    engList = m.engines?.() || [];
  } catch {}
  const eng = engList.find(e => e.id === engineId) || { label: 'Claude Code', fields: { account: 'claudeAccount', profile: 'claudeConfigDir' } };
  const label = eng.label || 'Claude Code';
  const acctKey = eng.fields?.account || 'claudeAccount';
  const profKey = eng.fields?.profile || 'claudeConfigDir';
  const set = config.orchy?.[acctKey];
  if (set) { log(`  ${OK} "Fix Orchy" runs as ${set}`); return set; }
  if (!signedInAs) { log(`  - "Fix Orchy" (Orchy working on his own code) needs a ${label} account: sign in with \`claude auth login\` or your harness, then pick it in Settings → Accounts.`); return null; }
  if (!interactive || !(await yesNo(`  "Fix Orchy" lets Orchy work on his own code with ${label}. Use ${signedInAs} for that?`, true))) {
    log('  - "Fix Orchy" account not set: pick it later in Settings → Accounts, or on the Fix Orchy card.');
    return null;
  }
  (config.orchy ||= {})[acctKey] = signedInAs;
  config.orchy[profKey] = null;
  config.orchy.runtime = engineId;
  saveConfig();
  log(`  ${OK} "Fix Orchy" runs as ${signedInAs}`);
  return signedInAs;
}

export const CLI_OPTIONS = [
  'Claude Code (Anthropic’s coding harness)',
  'Codex (OpenAI’s coding harness)',
  'Hermes (Open-source agent for open models and ACP)',
  'Antigravity (Google Gemini coding harness)',
  'Cursor (Cursor editor harness)',
  'Aider (Git-integrated coding agent; works with OpenRouter, Orca, OpenAI, Anthropic, etc.)',
  'OpenCode (OpenCode AI terminal agent with Zen or custom keys)',
  'Custom CLI (Run your own command or agent binary)',
];

export const CLI_IDS = [
  'claude',
  'codex',
  'hermes',
  'antigravity',
  'cursor',
  'aider',
  'opencode',
  'custom',
];

/** The interactive CLI selection step. Guides the user to pick an engine and set up required keys or routers. */
export async function cliStep({
  config = {},
  saveConfig = () => {},
  env = () => '',
  setEnv = () => {},
  interactive = true,
  engines = [],
  found = {},
  io = { yesNo, choose, askKey: (...a) => askKey(env, ...a), ask, log: console.log },
}) {
  const { yesNo, choose, askKey, log = console.log } = io;
  const askFn = io.ask || ask;
  if (!interactive) return null;

  log('\n  Coding CLI');
  log('  Orchy coordinates coding agents. Which CLI harness would you like to use?');
  const picked = await choose('  Pick a CLI:', CLI_OPTIONS);
  const id = CLI_IDS[picked] || 'claude';
  (config.orchy ||= {}).runtime = id;

  if (engines.length && !found[id] && id !== 'custom') {
    const eng = engines.find(e => e.id === id);
    if (eng) {
      log(`  ! ${eng.label} was not found on this machine.`);
      const inst = win ? eng.install?.winCmd : eng.install?.cmd;
      if (inst) log(`    Install command: ${inst}`);
    }
  }

  if (id === 'aider') {
    log('\n  Aider Setup');
    log('  Aider connects to models via API keys or 3rd-party routers.');
    const prov = await choose('  Which provider or router will you use for Aider?', [
      'OpenRouter (access Claude, GPT, DeepSeek through openrouter.ai)',
      'Orca Router (OpenAI-compatible router at api.orcarouter.com)',
      'Custom OpenAI-compatible Router / Gateway',
      'Anthropic (Claude 3.5 Sonnet, 3 Opus, 3.7)',
      'OpenAI (GPT-4o, o1, o3-mini)',
      'Google Gemini (Gemini 2.0 / 1.5 Pro)',
      'DeepSeek (DeepSeek V3 / R1)',
      'Groq (Fast open models)',
      'Ollama (Local models on your own machine)',
    ]);
    if (prov === 0) {
      const k = await askKey('OPENROUTER_API_KEY', 'OpenRouter', 'openrouter.ai → Keys');
      if (k) setEnv('OPENROUTER_API_KEY', k);
      config.orchy.aiderAccount = 'OpenRouter';
      if (await yesNo('  Configure Claude 3 Opus / 3.5 Sonnet as default Aider models in config?', true)) {
        (config.runtimes ||= {}).aider = {
          label: 'Aider',
          models: ['openrouter/anthropic/claude-3.5-haiku', 'openrouter/anthropic/claude-3.5-sonnet', 'openrouter/anthropic/claude-3-opus'],
        };
      }
    } else if (prov === 1) {
      const baseUrl = (await askFn('  Orca Router Base URL [https://api.orcarouter.com/v1]: ')) || 'https://api.orcarouter.com/v1';
      setEnv('OPENAI_API_BASE', baseUrl);
      const k = await askKey('OPENAI_API_KEY', 'Orca Router', 'orcarouter.com', baseUrl);
      if (k) {
        setEnv('OPENAI_API_KEY', k);
        setEnv('ORCA_API_KEY', k);
      }
      config.orchy.aiderAccount = 'Orca Router';
    } else if (prov === 2) {
      const baseUrl = ((await askFn('  Router Base URL (e.g. https://my-gateway.com/v1): ')) || '').trim();
      if (baseUrl) setEnv('OPENAI_API_BASE', baseUrl);
      const k = await askKey('OPENAI_API_KEY', 'Router', 'your gateway dashboard', baseUrl);
      if (k) setEnv('OPENAI_API_KEY', k);
      config.orchy.aiderAccount = 'Router';
    } else if (prov === 3) {
      const k = await askKey('ANTHROPIC_API_KEY', 'Anthropic', 'console.anthropic.com → API keys');
      if (k) setEnv('ANTHROPIC_API_KEY', k);
      config.orchy.aiderAccount = 'Anthropic';
    } else if (prov === 4) {
      const k = await askKey('OPENAI_API_KEY', 'OpenAI', 'platform.openai.com → API keys');
      if (k) setEnv('OPENAI_API_KEY', k);
      config.orchy.aiderAccount = 'OpenAI';
    } else if (prov === 5) {
      const k = await askKey('GEMINI_API_KEY', 'Google Gemini', 'aistudio.google.com → Get API key');
      if (k) setEnv('GEMINI_API_KEY', k);
      config.orchy.aiderAccount = 'Gemini';
    } else if (prov === 6) {
      const k = await askKey('DEEPSEEK_API_KEY', 'DeepSeek', 'platform.deepseek.com → API keys');
      if (k) setEnv('DEEPSEEK_API_KEY', k);
      config.orchy.aiderAccount = 'DeepSeek';
    } else if (prov === 7) {
      const k = await askKey('GROQ_API_KEY', 'Groq', 'console.groq.com → API keys');
      if (k) setEnv('GROQ_API_KEY', k);
      config.orchy.aiderAccount = 'Groq';
    } else if (prov === 8) {
      const url = ((await askFn('  Ollama endpoint URL [http://localhost:11434]: ')) || '').trim() || 'http://localhost:11434';
      setEnv('OLLAMA_API_BASE', url);
      config.orchy.aiderAccount = 'Ollama';
    }
  } else if (id === 'opencode') {
    log('\n  OpenCode Setup');
    log('  OpenCode connects to models via OpenCode Zen, 3rd-party routers, or direct provider keys.');
    const prov = await choose('  How do you reach models with OpenCode?', [
      'OpenCode Zen (opencode.ai Zen API key)',
      'OpenRouter (access Claude, GPT, DeepSeek through openrouter.ai)',
      'Orca Router / Custom OpenAI-compatible Gateway',
      'Anthropic (ANTHROPIC_API_KEY)',
      'OpenAI (OPENAI_API_KEY)',
      'Browser OAuth / terminal login (`opencode auth login`)',
    ]);
    let openCodeModel = null;
    if (prov === 0) {
      const k = await askKey('OPENCODE_API_KEY', 'OpenCode Zen', 'opencode.ai → Zen → API keys');
      if (k) setEnv('OPENCODE_API_KEY', k);
      config.orchy.opencodeAccount = 'Zen';
      const mChoice = await choose('  Which Zen model should OpenCode use?', [
        'Claude 3.5 Sonnet (zen/claude-3-5-sonnet)',
        'GPT-4o (zen/gpt-4o)',
        'DeepSeek V3 (deepseek-ai/DeepSeek-V3)',
        'Gemini 2.0 Flash (zen/gemini-2.0-flash)',
        'Default (OpenCode harness default)',
        'Custom model name',
      ]);
      if (mChoice === 0) openCodeModel = 'zen/claude-3-5-sonnet';
      else if (mChoice === 1) openCodeModel = 'zen/gpt-4o';
      else if (mChoice === 2) openCodeModel = 'deepseek-ai/DeepSeek-V3';
      else if (mChoice === 3) openCodeModel = 'zen/gemini-2.0-flash';
      else if (mChoice === 5) openCodeModel = ((await askFn('  Enter model name: ')) || '').trim();
    } else if (prov === 1) {
      const k = await askKey('OPENROUTER_API_KEY', 'OpenRouter', 'openrouter.ai → Keys');
      if (k) setEnv('OPENROUTER_API_KEY', k);
      config.orchy.opencodeAccount = 'OpenRouter';
      const mChoice = await choose('  Which OpenRouter model should OpenCode use?', [
        'Claude 3.5 Sonnet (openrouter/anthropic/claude-3.5-sonnet)',
        'Claude 3 Opus (openrouter/anthropic/claude-3-opus)',
        'GPT-4o (openrouter/openai/gpt-4o)',
        'DeepSeek V3 (openrouter/deepseek/deepseek-chat)',
        'Custom model name',
      ]);
      if (mChoice === 0) openCodeModel = 'openrouter/anthropic/claude-3.5-sonnet';
      else if (mChoice === 1) openCodeModel = 'openrouter/anthropic/claude-3-opus';
      else if (mChoice === 2) openCodeModel = 'openrouter/openai/gpt-4o';
      else if (mChoice === 3) openCodeModel = 'openrouter/deepseek/deepseek-chat';
      else if (mChoice === 4) openCodeModel = ((await askFn('  Enter model name: ')) || '').trim();
    } else if (prov === 2) {
      const baseUrl = (await askFn('  Router Base URL [https://api.orcarouter.com/v1]: ')) || 'https://api.orcarouter.com/v1';
      setEnv('OPENAI_API_BASE', baseUrl);
      const k = await askKey('OPENAI_API_KEY', 'Router', 'router dashboard', baseUrl);
      if (k) setEnv('OPENAI_API_KEY', k);
      config.orchy.opencodeAccount = 'Router';
      openCodeModel = ((await askFn('  Model name to use with router [gpt-4o]: ')) || 'gpt-4o').trim();
    } else if (prov === 3) {
      const k = await askKey('ANTHROPIC_API_KEY', 'Anthropic', 'console.anthropic.com → API keys');
      if (k) setEnv('ANTHROPIC_API_KEY', k);
      config.orchy.opencodeAccount = 'Anthropic';
      const mChoice = await choose('  Which Anthropic model should OpenCode use?', [
        'Claude 3.5 Sonnet (claude-3-5-sonnet-20241022)',
        'Claude 3 Opus (claude-3-opus-20240229)',
        'Custom model name',
      ]);
      if (mChoice === 0) openCodeModel = 'claude-3-5-sonnet-20241022';
      else if (mChoice === 1) openCodeModel = 'claude-3-opus-20240229';
      else if (mChoice === 2) openCodeModel = ((await askFn('  Enter model name: ')) || '').trim();
    } else if (prov === 4) {
      const k = await askKey('OPENAI_API_KEY', 'OpenAI', 'platform.openai.com → API keys');
      if (k) setEnv('OPENAI_API_KEY', k);
      config.orchy.opencodeAccount = 'OpenAI';
      openCodeModel = ((await askFn('  Which OpenAI model [gpt-4o]: ')) || 'gpt-4o').trim();
    } else if (prov === 5) {
      log('  - Run `opencode auth login` in a terminal to authenticate OpenCode via browser.');
      config.orchy.opencodeAccount = 'Browser OAuth';
    }

    if (openCodeModel) {
      (config.runtimes ||= {}).opencode = {
        label: 'OpenCode',
        models: [openCodeModel, openCodeModel, openCodeModel],
      };
      setEnv('OPENCODE_MODEL', openCodeModel);
      log(`  ${OK} OpenCode model configured: ${openCodeModel}`);
    }
  } else if (id === 'custom') {
    log('\n  Custom CLI Setup');
    const cmd = ((await askFn('  Command to run (e.g. aider, goose, python agent.py): ')) || '').trim();
    if (cmd) config.orchy.customCommand = cmd;
  } else if (id === 'hermes') {
    log('\n  Hermes Setup');
    const prov = await choose('  Which provider for Hermes?', ['OpenRouter', 'Anthropic', 'Local ACP']);
    if (prov === 0) {
      const k = await askKey('OPENROUTER_API_KEY', 'OpenRouter', 'openrouter.ai → Keys');
      if (k) setEnv('OPENROUTER_API_KEY', k);
    } else if (prov === 1) {
      const k = await askKey('ANTHROPIC_API_KEY', 'Anthropic', 'console.anthropic.com');
      if (k) setEnv('ANTHROPIC_API_KEY', k);
    }
    const mChoice = await choose('  Which model should Hermes use?', [
      'Hermes 3 Llama 3.1 70B (nousresearch/hermes-3-llama-3.1-70b)',
      'Hermes 3 Llama 3.1 405B (nousresearch/hermes-3-llama-3.1-405b)',
      'Claude 3.5 Sonnet (anthropic/claude-3.5-sonnet)',
      'Claude 3 Opus (anthropic/claude-3-opus)',
      'Default (Hermes harness default)',
      'Custom model name',
    ]);
    let hermesModel = null;
    if (mChoice === 0) hermesModel = 'nousresearch/hermes-3-llama-3.1-70b';
    else if (mChoice === 1) hermesModel = 'nousresearch/hermes-3-llama-3.1-405b';
    else if (mChoice === 2) hermesModel = 'anthropic/claude-3.5-sonnet';
    else if (mChoice === 3) hermesModel = 'anthropic/claude-3-opus';
    else if (mChoice === 5) hermesModel = ((await askFn('  Enter model name (e.g. provider/model): ')) || '').trim();

    if (hermesModel) {
      (config.runtimes ||= {}).hermes = {
        label: 'Hermes',
        models: [hermesModel, hermesModel, hermesModel],
      };
      setEnv('HERMES_MODEL', hermesModel);
      log(`  ${OK} Hermes model configured: ${hermesModel}`);
    }
  } else if (id === 'antigravity') {
    log('\n  Antigravity Setup');
    const k = await askKey('GEMINI_API_KEY', 'Google Gemini', 'aistudio.google.com → Get API key');
    if (k) setEnv('GEMINI_API_KEY', k);
  } else if (id === 'claude' || id === 'codex' || id === 'cursor') {
    let signedInAs = null;
    try {
      const eng = engines.find(e => e.id === id);
      const a = await eng?.account(null, { force: true });
      signedInAs = a?.loggedIn ? a.email || a.label || null : null;
    } catch {}
    await backendAccountStep({ config, saveConfig, signedInAs, engineId: id, interactive, yesNo, log });
  }

  saveConfig();
  return id;
}

export const LAUNCHERS = { win32: 'Start Orchy.cmd', darwin: 'Start Orchy.command' }; // anything else: Start Orchy.sh

/** Put this computer's launcher (from launchers/) in the Orchy folder, so there's one "Start Orchy" to double-click.
 *  The copy is git-ignored and refreshed when launchers/ changes. Returns 'made' | 'updated' | 'same' | 'missing'. */
export function placeLauncher(root, platform = process.platform) {
  const name = LAUNCHERS[platform] || 'Start Orchy.sh';
  const src = path.join(root, 'launchers', name), dest = path.join(root, name);
  if (!fs.existsSync(src)) return 'missing';
  let text = fs.readFileSync(src, 'utf8');
  if (name.endsWith('.cmd')) text = text.replace(/\r?\n/g, '\r\n'); // cmd.exe reads CRLF best
  const had = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
  if (had !== text) fs.writeFileSync(dest, text);
  if (platform !== 'win32') fs.chmodSync(dest, 0o755);
  return had === null ? 'made' : had === text ? 'same' : 'updated';
}

async function main() {
  console.log('\n  Orchy setup\n');

  // 1. Node
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    console.log(`  ${NO} Node ${process.version} is too old. Orchy needs Node 20 or newer: https://nodejs.org`);
    process.exit(1);
  }
  console.log(`  ${OK} Node ${process.version}`);

  // 2. packages
  // every dependency, not just the folder: an interrupted install or a pull that adds a package leaves it short
  const deps = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies || {});
  if (deps.some(d => !fs.existsSync(path.join(ROOT, 'node_modules', d, 'package.json')))) {
    console.log('\n  Installing packages (once)...');
    const r = sh('npm', ['install', '--no-fund', '--no-audit']);
    if (r.status !== 0) { console.log(`  ${NO} npm install failed. Check your connection and run: npm install`); process.exit(1); }
  }
  console.log(`  ${OK} packages installed`);

  // 3. .env (never overwritten)
  const envFile = path.join(ROOT, '.env'), example = path.join(ROOT, '.env.example');
  if (fs.existsSync(envFile)) console.log(`  ${OK} .env found`);
  else if (fs.existsSync(example)) { fs.copyFileSync(example, envFile); console.log(`  ${OK} .env created from .env.example`); }
  else console.log('  - no .env.example to copy; Orchy still starts without a .env');

  // 3b. the one launcher for this computer, in the Orchy folder
  const launcher = LAUNCHERS[process.platform] || 'Start Orchy.sh';
  try {
    const placed = placeLauncher(ROOT);
    if (placed !== 'missing') console.log(`  ${OK} "${launcher}" ${placed === 'same' ? 'is' : 'is now'} in the Orchy folder: double-click it to start Orchy from now on`);
  } catch (e) { console.log(`  - couldn't put "${launcher}" in the Orchy folder (${e.message}); use launchers/${launcher} instead`); }

  // 4. Tools: every harness the engine registry knows (found / version / install / gated), plus the One CLI.
  //    None is fatal: a tester may have one harness (or none yet) and no One CLI. Orchy starts and says what's missing.
  const { engines, engineTools, brokenMessage, runRefusal } = await import(pathToFileURL(path.join(ROOT, 'orchestrator/lib/engines/index.mjs')).href);
  const { oneVersion, oneNodeProblem } = await import(pathToFileURL(path.join(ROOT, 'orchestrator/lib/one.mjs')).href);
  const { ensureStandardPath } = await import(pathToFileURL(path.join(ROOT, 'orchestrator/lib/claude.mjs')).href);
  const harnesses = engineTools();
  console.log('\n  Tools');
  const found = {};
  for (const t of harnesses) {
    const e = engines().find(x => x.id === t.id);
    let v = null;
    try { v = e?.available() ? e.version() : null; } catch {} // a probe that throws reads as "not found"
    const refusal = v ? runRefusal(e) : null; // there and starts, but a version Orchy won't run (runRefusal)
    found[t.id] = !!v && !refusal;
    const gate = t.gated ? 'approvals: yes' : 'approvals: NO (only runs where you allow it)';
    const label = `${t.label}${t.id === 'claude' ? ' (recommended)' : ''}`;
    if (refusal) console.log(`  ${NO} ${label.padEnd(28)} ${v}: ${refusal}`);
    else if (v) console.log(`  ${OK} ${label.padEnd(28)} ${v}  [${gate}]`);
    else if (e?.available()) console.log(`  ${NO} ${label.padEnd(28)} ${brokenMessage(e)}`); // there but won't start
    else console.log(`  ${NO} ${label.padEnd(28)} not found${t.optional ? ' (optional)' : ''}. ${t.install ? `Install: ${t.install}` : t.note}  [${gate}]`);
  }
  if (!harnesses.some(t => found[t.id])) {
    console.log(`\n  ! No agent harness yet. Orchy starts, but agents can't run until you install one. Claude Code is recommended:\n      ${harnesses[0].install}${mac ? '\n      (then open a new Terminal window so the PATH updates)' : ''}`);
  }
  found.one = await oneStep({
    version: oneVersion(), blocked: oneNodeProblem(), recheck: () => oneNodeProblem(), interactive, yesNo, auto: true,
    install: () => {
      const res = sh('npm', ['install', '-g', '@withone/cli']);
      ensureStandardPath();
      return res.status === 0 && (hasOne() || !!oneVersion());
    },
  });

  const { config, saveConfig, env, setEnv } = await import(pathToFileURL(path.join(ROOT, 'orchestrator/lib/env.mjs')).href);

  // 4b. CLI selection & Setup
  if (interactive) {
    await cliStep({ config, saveConfig, env, setEnv, interactive, engines: engines(), found, io: { yesNo, choose, askKey: (...a) => askKey(env, ...a), ask, log: console.log } });
  } else {
    const harnessId = config.orchy?.runtime || (found.claude ? 'claude' : harnesses.find(t => found[t.id])?.id);
    if (harnessId) {
      let signedInAs = null;
      try { const a = await engines().find(e => e.id === harnessId)?.account(null, { force: true }); signedInAs = a?.loggedIn ? a.email || a.label || null : null; } catch {}
      await backendAccountStep({ config, saveConfig, signedInAs, engineId: harnessId, interactive: false, yesNo });
    }
  }

  // 5. Voice, Jev and scripts
  if (interactive) {
    await questions(env, setEnv);
  } else console.log('\n  (Not asking questions here: run `npm run setup` in a terminal to set up Voice and Jev.)');

  // 6. One guide, then Orchy
  console.log(`\n${ONE_GUIDE.split('\n').map(l => '  ' + l).join('\n')}`);
  if (args.has('--no-start') || !interactive) {
    let port = '8008';
    try { port = fs.readFileSync(envFile, 'utf8').match(/^\s*PORT\s*=\s*"?(\d+)/m)?.[1] || port; } catch {}
    console.log(`\n  Dashboard: http://localhost:${port}\n`);
    process.exit(0);
  }
  console.log('\n  Starting Orchy. Your browser opens on the dashboard; press Ctrl+C here to stop Orchy.\n');
  const child = spawn(process.execPath, [path.join('orchestrator', 'server.mjs')], { stdio: 'inherit' });
  child.on('exit', code => process.exit(code ?? 0));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {}); // Ctrl+C reaches Orchy too; it stops and this exits with it
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
