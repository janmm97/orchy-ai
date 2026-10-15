// Calls on the client page: the client talks to one of the agents the owner shared with them. The portal signs each call
// (portal.mjs → voiceagents.mjs#clientSession: the client's own voice agent, no transfers, nothing overridable),
// and the agent's five tools come back here and go to the portal, which only touches this client's tasks.
import { icon } from './pixel.mjs';
import { esc } from './util.mjs';

// a pinned copy served by Orchy (dashboard/vendor/elevenlabs/README.txt), worklets included: the page's CSP allows no CDN
const SDK = '/vendor/elevenlabs/client-1.25.0.js';
const WORKLETS = {
  workletPaths: { rawAudioProcessor: '/vendor/elevenlabs/rawAudioProcessor.js', audioConcatProcessor: '/vendor/elevenlabs/audioConcatProcessor.js' },
  libsampleratePath: '/vendor/elevenlabs/libsamplerate-2.1.2.worklet.js',
};
const TOOLS = ['start_task', 'task_status', 'task_result', 'answer_item', 'follow_up'];

let base = '', toast = () => {}, changed = () => {};
let conv = null, mode = 'idle', who = null;
let gen = 0;          // bumped by every start and hang-up: a call still starting when it changes was cancelled
let wasLive = false;  // the page redraws its Call buttons only when a call starts or ends

export function initCalls(opts) { ({ base, toast, changed = () => {} } = opts); }
export const callingWith = () => (mode === 'idle' ? null : who?.slug);

async function post(p, body) {
  const res = await fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `That didn’t work (${res.status}).`);
  return data;
}

export async function startCall(slug, name) {
  if (mode !== 'idle') { const same = who?.slug === slug; await endCall(); if (same) return; }
  const mine = ++gen;
  mode = 'starting'; who = { slug, name }; bar();
  try {
    // ask for the microphone first, so a "no" is clear before anything else happens
    (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach(t => t.stop());
    if (mine !== gen) return;
    const [{ Conversation }, { signedUrl }] = await Promise.all([import(SDK), post(`/voice/${encodeURIComponent(slug)}/session`)]);
    if (mine !== gen) return;
    const clientTools = Object.fromEntries(TOOLS.map(t => [t, async params => {
      try { return (await post(`/voice/tool/${t}`, { ...(params || {}), slug })).text; } catch (e) { return `That didn't work: ${e.message}`; }
    }]));
    const c = await Conversation.startSession({
      signedUrl,
      ...WORKLETS,
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
    conv = null; mode = 'idle'; bar();
    toast(e.name === 'NotAllowedError' ? 'Calls need the microphone. Allow it in your browser and try again.' : `Couldn’t start the call: ${e.message}`, 'warn');
  }
}

export async function endCall() {
  gen++;
  const c = conv;
  conv = null; mode = 'idle';
  try { await c?.endSession(); } catch {}
  reportEnd(c);
  bar();
}

// the owner gets a summary of the call in Orchy (the portal checks the call was this client's)
function reportEnd(c) {
  let conversationId = null;
  try { conversationId = c?.getId?.() || null; } catch {}
  if (conversationId) post('/voice/end', { conversationId }).catch(() => {});
}

function bar() {
  if (wasLive !== (mode !== 'idle')) { wasLive = mode !== 'idle'; changed(); }
  let el = document.getElementById('callbar');
  if (mode === 'idle') { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'callbar';
    el.className = 'callbar';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  const state = { starting: 'calling…', listening: 'listening', speaking: 'talking' }[mode] || mode;
  el.dataset.mode = mode;
  el.innerHTML = `${icon('phone', 'ico lg')}<span class="t"><b>${esc(who.name)}</b><span>${state}</span></span><button class="btn sm" type="button" data-hangup>${icon('x')}Hang up</button>`;
  el.querySelector('[data-hangup]').addEventListener('click', endCall);
}
