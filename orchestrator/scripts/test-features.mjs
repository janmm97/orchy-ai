// Where the owner stands on Jev and Voice (lib/features.mjs): an answer is never asked again.
// Run: node orchestrator/scripts/test-features.mjs
import { featureStates, allAnswered, parseSkipped } from '../lib/features.mjs';

let fail = 0;
const ok = (cond, label, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : `  ${extra}`}`); if (!cond) fail++; };
const states = (envs, { skipped = {}, jevOn = false } = {}) => featureStates({ env: k => envs[k] || '', skipped, jevOn });

// a fresh install that asked nothing: both are still questions
let s = states({});
ok(s.jev.state === 'needs-key' && s.voice.state === 'needs-key' && !allAnswered(s), 'nothing asked yet: both are questions');
ok(s.voice.needs.join() === 'ELEVENLABS_API_KEY,DEEPGRAM_API_KEY', 'no voice service picked: either key will do');

// npm run setup said no to both
s = states({ VOICE_ENABLED: '0', JEV_PROVIDER: 'off' });
ok(s.jev.state === 'off' && s.voice.state === 'off' && allAnswered(s), 'turned off in setup: answered, nothing to ask');

// said yes, pressed Enter at the key: skipped, answered
s = states({ VOICE_ENABLED: '1', VOICE_PROVIDER: 'elevenlabs', JEV_PROVIDER: '' }, { skipped: { voice: true, jev: true } });
ok(s.jev.state === 'skipped' && s.voice.state === 'skipped' && allAnswered(s), 'key left for later: answered, nothing nags');
ok(s.voice.needs.join() === 'ELEVENLABS_API_KEY', 'ElevenLabs picked: only its key is asked for');

// yes with a key
s = states({ VOICE_ENABLED: '1', VOICE_PROVIDER: 'deepgram', DEEPGRAM_API_KEY: 'dg', JEV_PROVIDER: 'typesafe' }, { jevOn: true });
ok(s.jev.state === 'on' && s.jev.provider === 'typesafe' && s.voice.state === 'on' && s.voice.needs.join() === 'DEEPGRAM_API_KEY', 'keys saved: on, with the provider picked');
// a key beats an old "later"
s = states({ VOICE_ENABLED: '1', ELEVENLABS_API_KEY: 'el' }, { skipped: { voice: true }, jevOn: true });
ok(s.voice.state === 'on' && s.jev.state === 'on', 'a key added after "later": on');
// the picked service's key is the one that counts
s = states({ VOICE_ENABLED: '1', VOICE_PROVIDER: 'elevenlabs', DEEPGRAM_API_KEY: 'dg' });
ok(s.voice.state === 'needs-key', 'ElevenLabs picked, only a Deepgram key: ElevenLabs still needs its key');
// off wins over a key that's still in .env
s = states({ VOICE_ENABLED: 'off', ELEVENLABS_API_KEY: 'el', JEV_PROVIDER: 'none', TYPESAFE_API_KEY: 'ts' }, { jevOn: false });
ok(s.voice.state === 'off' && s.jev.state === 'off', 'off with a key still saved: off');
// VOICE_ENABLED unset but a key there: on (voice.mjs reads it the same way)
ok(states({ ELEVENLABS_API_KEY: 'el' }).voice.state === 'on', 'no answer but a voice key: on');

ok(JSON.stringify(parseSkipped(' voice, JEV ,nope,')) === '{"voice":true,"jev":true}' && JSON.stringify(parseSkipped('')) === '{}', 'SETUP_SKIPPED: only voice and jev are read');

console.log(fail ? `\n${fail} feature check(s) failed` : '\nall feature checks passed');
process.exit(fail ? 1 : 0);
