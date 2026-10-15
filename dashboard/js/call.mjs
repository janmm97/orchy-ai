// Live voice calls: the owner talks to Orchy or any agent by name (ElevenLabs Agents, see orchestrator/lib/voiceagents.mjs).
// The server signs each call; the agents' tools come back here and go to /api/voice/tool/:name,
// so a call can only do what the owner can do from the dashboard.
// Agents also ring the owner here (orchestrator/lib/calls.mjs): Answer starts the same call with the agent's
// greeting and reason; hanging up hands the conversation id back so the transcript reaches the run.
import { api, esc } from './util.mjs';
import { icon } from './pixel.mjs';
import * as voice from './voice.mjs';

// a pinned copy served by Orchy (dashboard/vendor/elevenlabs/README.txt), worklets included: no CDN at call time
const SDK = '/vendor/elevenlabs/client-1.25.0.js';
const WORKLETS = {
  workletPaths: { rawAudioProcessor: '/vendor/elevenlabs/rawAudioProcessor.js', audioConcatProcessor: '/vendor/elevenlabs/audioConcatProcessor.js' },
  libsampleratePath: '/vendor/elevenlabs/libsamplerate-2.1.2.worklet.js',
};
const TOOLS = ['send_task', 'check_status', 'get_result', 'answer_item', 'follow_up'];
let conv = null, who = null, mode = 'idle', toast = () => {};
let gen = 0;         // bumped by every start and hang-up: a call still starting when it changes was cancelled
let placed = null;   // the agent's call this conversation answers (callId), so its end is reported
let incoming = null; // a call ringing in this tab
let ringLoop = null, alert = null;

export function initCalls(ctx) { toast = ctx.toast; }
const onCall = () => !!conv || mode === 'starting';

/** callId: answer an agent's call (or call back a missed one); with fallback, a call back that's too old is a plain call.
 *  runId: the owner calls from a run's window, so the agent knows which run it's about (and can follow it up). */
export async function startCall(key, name, { callId = null, fallback = false, runId = null } = {}) {
  if (!voice.voiceOn() && !conv) return toast('Voice is switched off. Settings → Voice turns it back on.', 'warn');
  if (conv || mode === 'starting') { if (who?.key === key && !callId) return endCall(); await endCall(); }
  stopRinging();
  const mine = ++gen;
  mode = 'starting'; who = { key, name }; placed = callId; bar();
  voice.stopSpeaking();
  try {
    // ask for the microphone first, so a "no" is clear before anything else happens
    (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach(t => t.stop());
    if (mine !== gen) return;
    const plain = () => runId ? api(`/api/runs/${encodeURIComponent(runId)}/call`, { method: 'POST' }) : api(`/api/voice/agents/${encodeURIComponent(key)}/session`);
    const session = callId
      ? api(`/api/calls/${encodeURIComponent(callId)}/answer`, { method: 'POST' }).catch(e => { if (!fallback) throw e; if (mine === gen) placed = null; return plain(); })
      : plain();
    const [{ Conversation }, { signedUrl, overrides }] = await Promise.all([import(SDK), session]);
    if (mine !== gen) return;
    const clientTools = Object.fromEntries(TOOLS.map(t => [t, async params => (await api(`/api/voice/tool/${t}`, { method: 'POST', body: params || {} })).text]));
    const c = await Conversation.startSession({
      signedUrl,
      ...WORKLETS,
      ...(overrides ? { overrides } : {}),
      clientTools,
      onConnect: () => { if (mine === gen) { mode = 'listening'; bar(); } },
      onDisconnect: () => { if (mine !== gen) return; gen++; const c = conv; conv = null; mode = 'idle'; reportEnd(c); bar(); },
      onModeChange: m => { if (mine === gen) { mode = m.mode === 'speaking' ? 'speaking' : 'listening'; bar(); } },
      onError: e => { if (mine === gen) toast(`Call: ${e?.message || e}`, 'warn'); },
    });
    if (mine !== gen) { try { await c.endSession(); } catch {} return; } // hung up while it was connecting
    conv = c;
  } catch (e) {
    if (mine !== gen) return;
    conv = null; mode = 'idle'; reportEnd(null); bar();
    toast(e.name === 'NotAllowedError' ? 'Orchy needs the microphone for calls.' : `Couldn't start the call: ${e.message}`, 'warn');
  }
}

async function endCall() {
  gen++;
  const c = conv;
  conv = null; mode = 'idle';
  try { await c?.endSession(); } catch {}
  reportEnd(c);
  bar();
}

// an agent's call is over: the server fetches the transcript for its run (once per call)
function reportEnd(c) {
  if (!placed) return;
  const callId = placed; placed = null;
  let conversationId = null;
  try { conversationId = c?.getId?.() || null; } catch {}
  api(`/api/calls/${encodeURIComponent(callId)}/end`, { method: 'POST', body: { conversationId } }).catch(() => {});
}

// ── incoming: an agent rings ──
export function ringIn(call) {
  if (!call || incoming?.id === call.id) return;
  if (onCall()) { api(`/api/calls/${encodeURIComponent(call.id)}/decline`, { method: 'POST', body: { busy: true } }).catch(() => {}); return; }
  incoming = call;
  bar();
  voice.ring();
  clearInterval(ringLoop);
  ringLoop = setInterval(() => voice.ring(), 2600);
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try {
      alert = new Notification(`${call.name} is calling`, { body: call.reason, icon: '/assets/images/lilorchy.png', tag: `call-${call.id}`, requireInteraction: true });
      alert.onclick = () => { window.focus(); alert?.close(); };
    } catch {}
  }
}

/** The server moved the call on (answered in another tab, declined, missed, or the owner answered the item meanwhile). */
export function callUpdated(call) {
  if (incoming?.id === call.id && call.status !== 'ringing') { stopRinging(); bar(); }
}

function stopRinging() {
  clearInterval(ringLoop); ringLoop = null;
  try { alert?.close(); } catch {}
  alert = null; incoming = null;
}

function answer() {
  const c = incoming;
  if (!c) return;
  startCall(c.key, c.name, { callId: c.id });
}

function decline() {
  const c = incoming;
  stopRinging(); bar();
  if (c) api(`/api/calls/${encodeURIComponent(c.id)}/decline`, { method: 'POST', body: {} }).catch(() => {});
}

function bar() {
  let el = document.getElementById('callbar');
  const live = mode !== 'idle';
  document.querySelectorAll('[data-call]').forEach(b => b.setAttribute('aria-pressed', String(live && b.dataset.call === who?.key)));
  if (!live && !incoming) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'callbar';
    el.className = 'callbar';
    document.body.append(el);
  }
  if (!live) {
    el.dataset.mode = 'ringing';
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-label', `${incoming.name} is calling`);
    el.innerHTML = `${icon('phone', 'ico lg')}<span class="t"><b>${esc(incoming.name)} is calling</b><span>${esc(incoming.reason)}</span></span><span class="btnrow"><button class="btn sm" type="button" data-answer>${icon('phone')}Answer</button><button class="btn sm ghost" type="button" data-decline>${icon('x')}Decline</button></span>`;
    el.querySelector('[data-answer]').addEventListener('click', answer);
    el.querySelector('[data-decline]').addEventListener('click', decline);
    return;
  }
  const state = { starting: 'calling…', listening: 'listening', speaking: 'talking' }[mode] || mode;
  el.dataset.mode = mode;
  el.setAttribute('role', 'status');
  el.removeAttribute('aria-label');
  el.innerHTML = `${icon('phone', 'ico lg')}<span class="t"><b>${esc(who.name)}</b><span>${state}</span></span><button class="btn sm" type="button" data-hangup>${icon('x')}Hang up</button>`;
  el.querySelector('[data-hangup]').addEventListener('click', endCall);
}
