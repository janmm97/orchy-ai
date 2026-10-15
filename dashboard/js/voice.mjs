// Orchy's voice: ElevenLabs via the server (key stays server-side), Deepgram Aura as the backup voice;
// falls back to the browser's speech synthesis. the owner talks to Orchy on a live call (call.mjs).
import { ownerHeaders } from './util.mjs';
let cfg = { tts: 'browser', enabled: true };
// Voice switched off (VOICE_ENABLED=0): nothing speaks, and every call control hides (styles: html.voice-off)
export function setVoiceConfig(c) { cfg = { ...cfg, ...c }; document.documentElement.classList.toggle('voice-off', cfg.enabled === false); }
export const voiceOn = () => cfg.enabled !== false;
export function voiceConfig() { return cfg; }

// ── one voice ──
// Every open dashboard tab gets every reply, so with two tabs open (Chrome restores one at
// sign-in and the launcher opens another) Orchy talked over himself. Only the tab the owner used
// last speaks; when it closes, the next open tab takes over.
let hasVoice = !navigator.locks; // no Web Locks API: every tab speaks, as before
let inLine = false;
function holdVoice(opts) {
  navigator.locks.request('jos-voice', opts, () => {
    if (!opts.steal) inLine = false;
    hasVoice = true;
    return new Promise(() => {}); // held until this tab closes or another one takes it
  }).catch(() => { // another tab took it
    if (!opts.steal) inLine = false;
    hasVoice = false;
    stopSpeaking();
    if (!inLine) { inLine = true; holdVoice({}); }
  });
}
function takeVoice() {
  if (hasVoice) return;
  hasVoice = true; // stealing always succeeds, and a click's speak() shouldn't wait for it
  holdVoice({ steal: true });
}
if (navigator.locks) {
  takeVoice();
  addEventListener('pointerdown', takeVoice, true);
  addEventListener('keydown', takeVoice, true);
  addEventListener('focus', takeVoice);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) takeVoice(); });
}

// ── voice ──
const queue = [];
let speaking = false;
let current = null;
let turn = 0; // bumped by stopSpeaking so a line still loading never plays after it
let onSpeakState = () => {};
export function onSpeaking(fn) { onSpeakState = fn; }

export function speak(text) {
  if (!hasVoice || !voiceOn()) return;
  const clean = String(text || '').replace(/[*_`#>|]/g, '').replace(/\[(.*?)\]\(.*?\)/g, '$1').trim();
  if (!clean) return;
  queue.push(clean);
  if (!speaking) next();
}

export function stopSpeaking() {
  turn++;
  queue.length = 0;
  current?.stop();
  if (window.speechSynthesis) speechSynthesis.cancel();
  current = null;
  if (speaking) { speaking = false; onSpeakState(false); }
}

async function next() {
  const mine = turn;
  const text = queue.shift();
  if (!text) { speaking = false; onSpeakState(false); return; }
  speaking = true; // onSpeakState(true) fires when sound actually starts
  try {
    if (cfg.tts !== 'browser') await playEleven(text, mine);
    else await playBrowser(text);
  } catch (e) {
    if (mine !== turn) return;
    console.warn('[voice] falling back to browser speech:', e.message);
    try { await playBrowser(text); } catch {}
  }
  if (mine === turn) next(); // otherwise stopSpeaking ended this chain (and a new one may be talking)
}

// The browser won't play sound before the owner has clicked or typed on the page (e.g. right after
// sign-in). Instead of dropping the line, wait for that first click or key press, then say it.
function firstGesture() {
  if (navigator.userActivation?.hasBeenActive) return Promise.resolve();
  return new Promise(resolve => {
    const go = () => { removeEventListener('pointerdown', go, true); removeEventListener('keydown', go, true); resolve(); };
    addEventListener('pointerdown', go, true);
    addEventListener('keydown', go, true);
  });
}

async function playEleven(text, mine) {
  const res = await fetch('/api/voice/speak', { method: 'POST', headers: { ...ownerHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `TTS ${res.status}`);
  const blob = await res.blob();
  if (mine !== turn) return; // stopped while the audio was loading
  const url = URL.createObjectURL(blob);
  await new Promise((resolve, reject) => {
    const a = new Audio(url);
    const done = () => { URL.revokeObjectURL(url); resolve(); };
    current = { stop: () => { a.pause(); done(); } };
    a.onplaying = () => onSpeakState(true);
    a.onended = done;
    a.onerror = () => { URL.revokeObjectURL(url); reject(new Error('audio playback failed')); };
    a.play().catch(async e => {
      if (e.name !== 'NotAllowedError') return reject(e);
      await firstGesture();
      if (mine !== turn) return done();
      a.play().catch(reject);
    });
  });
}

function playBrowser(text) {
  return new Promise(resolve => {
    if (!window.speechSynthesis) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    u.voice = voices.find(v => /en(-|_)US/i.test(v.lang) && /natural|aria|jenny|samantha|google us/i.test(v.name)) || voices.find(v => /^en/i.test(v.lang)) || null;
    u.rate = 1.04; u.pitch = 1.1;
    u.onstart = () => onSpeakState(true);
    u.onend = resolve; u.onerror = resolve;
    current = { stop: () => { speechSynthesis.cancel(); resolve(); } };
    speechSynthesis.speak(u);
  });
}

// ── 8-bit sounds ──
let ctx = null;
let soundOn = true;
export function setSound(on) { soundOn = !!on; }
function tone(freq, start, len, type = 'square', gain = 0.05) {
  ctx ||= new (window.AudioContext || window.webkitAudioContext)();
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(gain, ctx.currentTime + start);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + len);
  o.connect(g).connect(ctx.destination);
  o.start(ctx.currentTime + start);
  o.stop(ctx.currentTime + start + len + 0.02);
}
/** One ring of an agent's incoming call: an 8-bit double trill. Plays even with sounds off (the owner switched calls on). */
export function ring() {
  try {
    ctx?.state === 'suspended' && ctx.resume();
    for (const at of [0, 0.5]) for (let i = 0; i < 6; i++) tone(i % 2 ? 784 : 988, at + i * 0.06, 0.055, 'square', 0.045);
  } catch {}
}

export function chirp(kind) {
  if (!soundOn) return;
  try {
    if (kind === 'ask') { tone(660, 0, 0.09); tone(990, 0.1, 0.12); }
    else if (kind === 'done') { tone(523, 0, 0.07); tone(659, 0.08, 0.07); tone(784, 0.16, 0.12); }
    else if (kind === 'error') { tone(220, 0, 0.15); tone(165, 0.16, 0.2); }
    else if (kind === 'route') { tone(880, 0, 0.05, 'square', 0.03); }
    else if (kind === 'hatch') { [392, 494, 587, 784].forEach((f, i) => tone(f, i * 0.07, 0.07)); }
  } catch {}
}
