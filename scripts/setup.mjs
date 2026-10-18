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
    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
  }),
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
    if (!any && !env('ELEVENLABS_API_KEY') && !env('DEEPGRAM_API_KEY')) log('  No voice key yet: Orchy uses your browser’s voice until you add one in Settings.');
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
    else { set('JEV_PROVIDER', ''); log('  No key yet, so Jev stays off. Add one later in Settings → Routing.'); }
  }

  log('\n  Scripts');
  const s = await choose('  When an agent wants to run a script:', [
    'Stay on: it runs on its own unless it looks like a decision (money, sending, deleting, sharing) (recommended)',
    'Off: ask me before every script',
  ]);
  set('SETUP_SCRIPTS', s === 0 ? 'on' : 'off'); // Orchy applies it once on start; Settings → Scripts changes it later
}

/** The One CLI step. Missing, or a failed install, is a warning and never stops setup: Orchy runs without it and
 *  only app connections wait for it. io is swapped for fakes in test-setup.mjs. Returns whether One is there. */
export async function oneStep({ version, interactive, yesNo, install, log = console.log }) {
  if (version) { log(`  ${OK} ${ONE_TOOL.label.padEnd(28)} ${version}`); return true; }
  log(`  ${NO} ${ONE_TOOL.label.padEnd(28)} not found. It connects your agents to your apps (Gmail, Slack, Notion and more).`);
  let found = false;
  if (interactive && await yesNo(`  Install it now (${ONE_TOOL.install})?`, true)) {
    try { found = !!install(); } catch {}
    log(found ? `  ${OK} One CLI installed` : `  ${NO} The install didn't finish. If it did install, open a new terminal so the PATH updates.`);
  }
  if (!found) log(`\n  ! Orchy still starts, but app connections need the One CLI. Install it with:\n      ${ONE_TOOL.install}\n    then open a new terminal and run setup again. Guide: docs/ONE.md`);
  return found;
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
  const { engines, engineTools, brokenMessage } = await import(pathToFileURL(path.join(ROOT, 'orchestrator/lib/engines/index.mjs')).href);
  const { oneVersion } = await import(pathToFileURL(path.join(ROOT, 'orchestrator/lib/one.mjs')).href);
  const harnesses = engineTools();
  console.log('\n  Tools');
  const found = {};
  for (const t of harnesses) {
    const e = engines().find(x => x.id === t.id);
    let v = null;
    try { v = e?.available() ? e.version() : null; } catch {} // a probe that throws reads as "not found"
    found[t.id] = !!v;
    const gate = t.gated ? 'approvals: yes' : 'approvals: NO (only runs where you allow it)';
    const label = `${t.label}${t.id === 'claude' ? ' (recommended)' : ''}`;
    if (v) console.log(`  ${OK} ${label.padEnd(28)} ${v}  [${gate}]`);
    else if (e?.available()) console.log(`  ${NO} ${label.padEnd(28)} ${brokenMessage(e)}`); // there but won't start
    else console.log(`  ${NO} ${label.padEnd(28)} not found${t.optional ? ' (optional)' : ''}. Install: ${t.install}  [${gate}]`);
  }
  if (!harnesses.some(t => found[t.id])) {
    console.log(`\n  ! No agent harness yet. Orchy starts, but agents can't run until you install one. Claude Code is recommended:\n      ${harnesses[0].install}${mac ? '\n      (then open a new Terminal window so the PATH updates)' : ''}`);
  }
  found.one = await oneStep({
    version: oneVersion(), interactive, yesNo,
    install: () => sh('npm', ['install', '-g', '@withone/cli']).status === 0 && hasOne(),
  });

  // 5. Voice, Jev and scripts
  if (interactive) {
    const { env, setEnv } = await import(pathToFileURL(path.join(ROOT, 'orchestrator/lib/env.mjs')).href);
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
