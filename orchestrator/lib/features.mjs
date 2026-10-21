// The optional features (Jev, Voice) and where the owner stands on each, so nothing asks twice.
// Each is 'on' (it has what it needs), 'off' (the owner turned it off), 'skipped' (they chose to add the key
// later: npm run setup's Enter, or Not now in the dashboard) or 'needs-key' (never answered). Only 'needs-key'
// is still a question; the others are answers, and the dashboard doesn't nag about them.

const OFF = /^(0|false|off|no|none)$/i;
export const SKIPPABLE = ['jev', 'voice'];

/**
 * env: name → value (from .env). skipped: { jev, voice } from the server's settings. jevOn: Jev has a working
 * provider (jev.mjs#jevMode() !== 'none'; passed in so this stays pure).
 */
export function featureStates({ env = () => '', skipped = {}, jevOn = false } = {}) {
  const v = k => String(env(k) ?? '').trim();
  const jevPick = v('JEV_PROVIDER').toLowerCase();
  const jev = OFF.test(jevPick) ? 'off' : jevOn ? 'on' : skipped.jev ? 'skipped' : 'needs-key';

  // voice: ElevenLabs, Deepgram, or '' (either, ElevenLabs first). VOICE_ENABLED unset with no key is
  // unanswered, as voice.mjs#voiceEnabled reads it (off until a key)
  const provider = ['elevenlabs', 'deepgram'].includes(v('VOICE_PROVIDER').toLowerCase()) ? v('VOICE_PROVIDER').toLowerCase() : '';
  const eleven = !!v('ELEVENLABS_API_KEY'), deepgram = !!v('DEEPGRAM_API_KEY');
  const keyed = provider === 'elevenlabs' ? eleven : provider === 'deepgram' ? deepgram : eleven || deepgram;
  const asked = v('VOICE_ENABLED');
  const voice = asked && OFF.test(asked) ? 'off' : keyed ? 'on' : skipped.voice ? 'skipped' : 'needs-key';
  // the keys this voice choice takes: only the one picked, both when none is
  const needs = provider === 'elevenlabs' ? ['ELEVENLABS_API_KEY'] : provider === 'deepgram' ? ['DEEPGRAM_API_KEY'] : ['ELEVENLABS_API_KEY', 'DEEPGRAM_API_KEY'];

  return {
    jev: { state: jev, provider: jevPick && !OFF.test(jevPick) ? jevPick : '' },
    voice: { state: voice, provider, needs },
  };
}

/** Every optional feature answered: on, off or skipped. (The setup guide's Keys step is done then.) */
export const allAnswered = states => Object.values(states).every(f => f.state !== 'needs-key');

/** npm run setup's SETUP_SKIPPED ("voice,jev") as { voice: true, jev: true }; anything else is dropped. */
export function parseSkipped(text) {
  return Object.fromEntries(String(text || '').split(',').map(s => s.trim().toLowerCase()).filter(s => SKIPPABLE.includes(s)).map(s => [s, true]));
}
