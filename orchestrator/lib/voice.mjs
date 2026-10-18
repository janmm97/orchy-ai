// Orchy's voice (ElevenLabs, with Deepgram Aura as the backup voice). The browser plays speech proxied
// through here, so keys never leave this machine. (Talking to Orchy is a live ElevenLabs call: call.mjs.)
import { env } from './env.mjs';

let ttsIssue = null;     // last ElevenLabs problem, shown in Settings

/**
 * VOICE_ENABLED=0 (npm run setup asks): chat only. Nothing speaks, nothing rings, no voice agents are made.
 * Left unset (an install that asked nothing, e.g. one an AI agent ran): off until a voice key is in .env.
 */
export const voiceEnabled = () => {
  const v = String(env('VOICE_ENABLED') || '').trim();
  if (!v) return !!(env('ELEVENLABS_API_KEY') || env('DEEPGRAM_API_KEY'));
  return !/^(0|false|off|no)$/i.test(v);
};

/** Which service speaks: VOICE_PROVIDER=elevenlabs|deepgram (Settings → Voice), or '' for ElevenLabs first, Deepgram as backup. */
export const VOICE_PROVIDERS = ['', 'elevenlabs', 'deepgram'];
export const voiceProvider = () => { const p = String(env('VOICE_PROVIDER') || '').trim().toLowerCase(); return VOICE_PROVIDERS.includes(p) ? p : ''; };

export function voiceConfig() {
  const provider = voiceProvider();
  const eleven = provider !== 'deepgram' && !!env('ELEVENLABS_API_KEY');
  const deepgram = !!env('DEEPGRAM_API_KEY');
  const enabled = voiceEnabled();
  return {
    enabled,
    provider,
    tts: !enabled ? 'off' : eleven || deepgram ? (eleven && !ttsIssue ? 'elevenlabs' : deepgram ? 'deepgram' : 'elevenlabs') : 'browser',
    voiceId: env('ELEVENLABS_VOICE_ID', '21m00Tcm4TlvDq8ikWAM'),
    auraVoice: env('DEEPGRAM_TTS_MODEL', 'aura-2-thalia-en'),
    ttsIssue,
  };
}

export function clearVoiceIssues() { ttsIssue = null; }

async function pipe(r, res) {
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

async function eleven(text) {
  const key = env('ELEVENLABS_API_KEY');
  const voice = env('ELEVENLABS_VOICE_ID', '21m00Tcm4TlvDq8ikWAM');
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=mp3_44100_128&optimize_streaming_latency=2`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({
      text,
      model_id: env('ELEVENLABS_MODEL', 'eleven_flash_v2_5'),
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.25, use_speaker_boost: true },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) {
    const detail = await r.json().catch(() => ({}));
    const msg = detail?.detail?.message || detail?.detail || `HTTP ${r.status}`;
    throw Object.assign(new Error(`ElevenLabs: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`), { status: r.status });
  }
  return r;
}

async function aura(text) {
  const r = await fetch(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(env('DEEPGRAM_TTS_MODEL', 'aura-2-thalia-en'))}&encoding=mp3`, {
    method: 'POST',
    headers: { Authorization: `Token ${env('DEEPGRAM_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw Object.assign(new Error(`Deepgram Aura ${r.status}: ${(await r.text()).slice(0, 200)}`), { status: 502 });
  return r;
}

/** Stream speech for text into an HTTP response: ElevenLabs first, Deepgram Aura as backup (Deepgram only when it was picked). */
export async function speak(text, res) {
  const clean = String(text || '').slice(0, 2000);
  if (env('ELEVENLABS_API_KEY') && voiceProvider() !== 'deepgram') {
    try {
      const r = await eleven(clean);
      ttsIssue = null;
      return pipe(r, res);
    } catch (e) {
      ttsIssue = e.status === 401 || e.status === 403
        ? `${e.message} Edit the key at elevenlabs.io → Developers → API keys and enable "Text to Speech" (and "Voices: Read"). Using Deepgram's voice meanwhile.`
        : e.message;
      if (!env('DEEPGRAM_API_KEY')) throw Object.assign(new Error(ttsIssue), { status: 502 });
    }
  }
  if (env('DEEPGRAM_API_KEY')) return pipe(await aura(clean), res);
  throw Object.assign(new Error('No voice key in .env (ELEVENLABS_API_KEY or DEEPGRAM_API_KEY)'), { status: 400 });
}

export async function listVoices() {
  const key = env('ELEVENLABS_API_KEY');
  if (!key) return [];
  const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.voices || []).map(v => ({ id: v.voice_id, name: v.name, category: v.category, preview: v.preview_url }));
}
