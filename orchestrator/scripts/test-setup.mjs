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
ok(r.store.VOICE_ENABLED === '1' && r.store.ELEVENLABS_API_KEY === 'el' && !('DEEPGRAM_API_KEY' in r.store), 'Voice, ElevenLabs: only its key is asked and saved');
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

console.log(fail ? `\n${fail} failed` : '\nall setup checks passed');
process.exit(fail ? 1 : 0);
