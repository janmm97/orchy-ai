// Voice agents: Orchy and every workspace agent as an ElevenLabs Conversational AI agent the owner can call by name.
// The roster (names, voices, ElevenLabs ids) lives in orchestrator/voice-agents.json.
// Calls run in the dashboard (browser mic ↔ ElevenLabs), started by the owner or rung by an agent (calls.mjs); the agents' tools are client tools the
// dashboard forwards to POST /api/voice/tool/:name, so the real work still goes through Orchy:
// runs, the approval gate and the account checks are untouched.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ORCH_DIR, env, config, ownerName, readJson } from './env.mjs';
import { voiceEnabled } from './voice.mjs';
import { workspaces, workspace } from './workspaces.mjs';
import { getAgent, listAgents } from './agents.mjs';

const ROSTER = path.join(ORCH_DIR, 'voice-agents.json');
const API = 'https://api.elevenlabs.io';

// No voice-agents.json yet (a fresh clone): start from the empty example so voice stays off, not broken.
export function roster() {
  if (!fs.existsSync(ROSTER)) fs.copyFileSync(path.join(ORCH_DIR, 'voice-agents.example.json'), ROSTER);
  return readJson(ROSTER);
}
function saveRoster(r) { fs.writeFileSync(ROSTER, JSON.stringify(r, null, 2) + '\n'); }
export const keyOf = a => (a.workspace ? `${a.workspace}/${a.slug}` : 'orchy');

async function eleven(method, p, body) {
  const key = env('ELEVENLABS_API_KEY');
  if (!key) throw Object.assign(new Error('No ELEVENLABS_API_KEY in .env'), { status: 400 });
  // ElevenLabs throws the odd 500/429 mid-sync: try twice more before giving up
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(API + p, {
      method,
      headers: { 'xi-api-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    if (r.ok) return text ? JSON.parse(text) : {};
    if (attempt < 3 && (r.status >= 500 || r.status === 429)) { await new Promise(res => setTimeout(res, attempt * 2000)); continue; }
    throw Object.assign(new Error(`ElevenLabs ${method} ${p}: ${r.status} ${text.slice(0, 400)}`), { status: 502 });
  }
}

// ── what the dashboard shows ──
export function publicRoster() {
  const r = roster();
  const wss = Object.fromEntries(workspaces().map(w => [w.id, w]));
  return {
    orchy: { key: 'orchy', name: r.orchy.name, voice: r.orchy.voice, ready: !!r.orchy.agentId },
    agents: r.agents.map(a => {
      let role = a.slug;
      try { role = getAgent(a.workspace, a.slug).displayName; } catch {}
      return {
        key: keyOf(a), name: a.name, gender: a.gender, voice: a.voice, workspace: a.workspace, slug: a.slug, role,
        workspaceName: wss[a.workspace]?.name || a.workspace, enabled: !!wss[a.workspace]?.enabled, ready: !!a.agentId,
      };
    }),
  };
}

/** The name the owner calls an agent by ("Grant"), or null when it has none yet. */
export function nameOf(ws, slug) {
  try { return roster().agents.find(x => x.workspace === ws && x.slug === slug)?.name || null; } catch { return null; }
}

/** A workspace's named agents other than `slug`: [{ name, slug }]. */
export function teamNames(ws, slug) {
  try { return roster().agents.filter(x => x.workspace === ws && x.slug !== slug).map(x => ({ name: x.name, slug: x.slug })); } catch { return []; }
}

/** "Blake (Ad Creative Producer)" for a run or item, so calls use the names the owner calls agents by. */
export function callName(ws, slug, role) {
  let a = null;
  try { a = roster().agents.find(x => x.workspace === ws && x.slug === (slug || '')); } catch {}
  return a ? `${a.name} (${role || a.slug})` : role || slug || 'an agent';
}

/** A short-lived signed URL for one call (agents require auth, so only Orchy can start calls). */
export async function signedUrl(key) {
  const r = roster();
  const a = key === 'orchy' ? r.orchy : r.agents.find(x => keyOf(x) === key);
  if (!a?.agentId) throw Object.assign(new Error(`No voice agent for "${key}" yet (run node orchestrator/scripts/voice-agents.mjs)`), { status: 404 });
  const { signed_url } = await eleven('GET', `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(a.agentId)}`);
  return { signedUrl: signed_url, name: a.name };
}

/** The voice key that rings the owner for an agent: its own voice agent, or Orchy when it has none (generalists). */
export function voiceKey(ws, slug) {
  try { const a = roster().agents.find(x => x.workspace === ws && x.slug === slug && x.agentId); if (a) return keyOf(a); } catch {}
  return 'orchy';
}

/**
 * A call the agent placed (calls.mjs): the signed URL plus per-call overrides, so the voice agent
 * opens with its own greeting and knows why it rang. Only the first agent gets them; a transfer
 * lands on the other agent as it is.
 */
export async function callSession(key, { firstMessage, context }) {
  const r = roster();
  const a = key === 'orchy' ? r.orchy : r.agents.find(x => keyOf(x) === key);
  const s = await signedUrl(key);
  const base = key === 'orchy' ? orchyPrompt(r) : agentPrompt(r, a);
  if (key === 'orchy') { r.orchy.lastCall = Date.now(); saveRoster(r); }
  return { ...s, overrides: { agent: { ...(firstMessage ? { firstMessage } : {}), prompt: { prompt: `${base}

${context}` } } } };
}

const pick = list => list[crypto.randomInt(list.length)];

// The owner away from Orchy this long → the call opens with a warm welcome back
const AWAY_MS = 3 * 86_400_000;
const welcomeBack = () => [
  'Hey, stranger! It’s been a while. What are we working on?',
  'Look who’s back! I kept things running while you were away.',
  `${ownerName()}! Long time no hear. Want the rundown, or straight to work?`,
];

/** The owner calling Orchy from the dashboard: a warm welcome back after a few days away. */
export async function orchySession() {
  const last = roster().orchy.lastCall || 0;
  if (!last || Date.now() - last < AWAY_MS) return callSession('orchy', { context: '' });
  const days = Math.round((Date.now() - last) / 86_400_000);
  return callSession('orchy', {
    firstMessage: pick(welcomeBack()),
    context: `# Welcome back
${ownerName()} hasn't called you in ${days} days, so you opened with a warm welcome back. Offer a quick rundown of what happened while ${ownerName()} was away (check_status), then get to work.`,
  });
}

/** One finished call: ElevenLabs' transcript and summary (status "done" once it's processed). */
export const conversation = cid => eleven('GET', `/v1/convai/conversations/${encodeURIComponent(cid)}`);

// ── tools (the same five on every voice agent) ──
const str = description => ({ type: 'string', description });
export const TOOLS = [
  {
    name: 'send_task',
    description: `Hand ${ownerName()}'s task to an agent. It starts a real run in Orchy and returns straight away; the work takes minutes. Pass workspace and agent to pick the agent; leave both out to let Orchy route it.`,
    parameters: { type: 'object', properties: { task: str(`The task in ${ownerName()}'s words, complete enough to act on without this call.`), workspace: str('Workspace id, e.g. alpha.'), agent: str('Agent slug, e.g. blog-writer.') }, required: ['task'] },
  },
  {
    name: 'check_status',
    description: `What is running, what just finished and what is waiting on ${ownerName()} (questions and approvals, with their ids). Optionally only one workspace or agent.`,
    parameters: { type: 'object', properties: { workspace: str('Workspace id to filter on.'), agent: str('Agent slug to filter on.') }, required: [] },
  },
  {
    name: 'get_result',
    description: 'The report of one run (what the agent did, or where it is up to).',
    parameters: { type: 'object', properties: { run_id: str('The run id from check_status or send_task.') }, required: ['run_id'] },
  },
  {
    name: 'answer_item',
    description: `Answer something waiting on ${ownerName()}. For a question pass answer. For an approval pass decision "approve" or "deny" (only after ${ownerName()} clearly said so).`,
    parameters: { type: 'object', properties: { item_id: str('The item id from check_status.'), answer: str(`${ownerName()}'s answer to a question.`), decision: str('approve or deny, for approvals.') }, required: ['item_id'] },
  },
  {
    name: 'follow_up',
    description: 'Send a follow-up to a finished run; the same agent picks up where it left off.',
    parameters: { type: 'object', properties: { run_id: str('The run to follow up.'), message: str(`What ${ownerName()} wants next.`) }, required: ['run_id', 'message'] },
  },
];

// ── prompts ──
const STYLE = `# How you talk
- This is a live voice call with ${ownerName()}. Young, upbeat, warm and positive, like a creator talking to a friend, but never fake or over the top.
- Short spoken sentences. One idea at a time. No lists, markdown, links, ids or file paths read out loud unless ${ownerName()} asks.
- Say numbers and times the way people say them ("about five minutes", "ten AM").
- If you are not sure what ${ownerName()} means, ask one quick question.`;

const TOOL_RULES = `# How work happens
- You don't do the work in this call. send_task starts a real run in Orchy (on Claude Code or Codex), which takes minutes. Tell ${ownerName()} it's started and that they'll see the result in Orchy, or can ask you to check.
- Before send_task, say the task back in one sentence and get a yes, unless ${ownerName()} was already clear and said to go ahead.
- Never say something is done unless check_status or get_result says so.
- Approvals and questions from agents show up in check_status with an id. Read the question out plainly. Only approve or deny when ${ownerName()} clearly says so.
- Agents can ring ${ownerName()} back in the Orchy dashboard. If ${ownerName()} wants a call ("call me when you're done", "call me if you get stuck"), say so in the send_task or follow_up text, e.g. "When you're done, ring ${ownerName()} with call_owner and tell ${ownerName()} what you found." The agent doing the run makes the call. Never tell ${ownerName()} that calling isn't possible.
- If a tool returns an error, say what went wrong in plain words.
- Times are in ${config.timezone || 'America/New_York'}.`;

function agentInfo(a) {
  try {
    const g = getAgent(a.workspace, a.slug);
    return { role: g.displayName, description: String(g.description || '').replace(/^Use (for|to)\s+/i, '').slice(0, 900) };
  } catch { return { role: a.slug, description: '' }; }
}

/** Still on the owner's team: the agent file is there and its workspace is on (retired ones keep their ElevenLabs agent, unlisted). */
function onDuty(a) {
  try { return workspace(a.workspace).enabled && !!getAgent(a.workspace, a.slug); } catch { return false; }
}

function wsLine(id) {
  try { const w = workspace(id); return `${w.name} (workspace id "${w.id}"${w.enabled ? '' : `, switched off right now: runs there are refused until ${ownerName()} switches it back on in Workspace`})`; }
  catch { return id; }
}

function orchyPrompt(r) {
  const team = r.agents.filter(onDuty).map(a => `- ${a.name}: ${agentInfo(a).role} in ${wsLine(a.workspace)}, agent "${a.slug}"`).join('\n');
  return `You are Orchy, ${ownerName()}'s AI orchestrator, on a voice call with ${ownerName()}. ${ownerName()} runs client workspaces of AI agents. You route ${ownerName()}'s work to the right agent, keep track of what's running, read out what's waiting on ${ownerName()}, and put ${ownerName()} through to any agent by name.

${STYLE}

# Your attitude
- Playful and a little cheeky, never mean. At most one light joke a call, then get on with the work.
- Never joke about or criticize other AI products or companies, or the people who build or use them. If ${ownerName()} mentions another AI tool, be gracious and stay on task.
- No swearing (the call hangs up on it).

# The team (call them by name)
${team}
Each workspace also has a generalist: send_task with the workspace and no agent.

${TOOL_RULES}
- When ${ownerName()} names an agent ("give this to Paige", "ask Rex"), send_task with that agent's workspace and slug.
- When ${ownerName()} wants to talk to an agent ("put me through to Sophie", "let me talk to Dex"), transfer the call to them.
- When it's unclear who should do it, leave workspace and agent out and Orchy routes it.`;
}

function agentPrompt(r, a) {
  const { role, description } = agentInfo(a);
  return `You are ${a.name}, the ${role} in ${wsLine(a.workspace)}. ${ownerName()} calls you by name. You're one of the AI agents Orchy runs for ${ownerName()}.

# What you do
${description || role}

${STYLE}

${TOOL_RULES}
- Your own work: send_task with workspace "${a.workspace}" and agent "${a.slug}". check_status with the same to see your runs.
- If ${ownerName()} wants Orchy or another agent, transfer the call back to Orchy.`;
}

const firstMessage = (name, orchy) => (orchy ? `Hey ${ownerName()}! Orchy here. What are we working on?` : `Hey ${ownerName()}, it's ${name}! What can I do for you?`);

function system(name, params) {
  return { type: 'system', name, description: '', params: { system_tool_type: name, ...params } };
}

// Every ElevenLabs guardrail on, for every voice agent (a triggered one ends the call).
const ON = { is_enabled: true, threshold: 'medium' };
const GUARDRAILS = {
  version: '1',
  focus: { is_enabled: true },
  prompt_injection: { is_enabled: true },
  synthetic_voice: { is_enabled: true, trigger_action: { type: 'end_call' } },
  content: {
    execution_mode: 'streaming',
    config: Object.fromEntries(['sexual', 'violence', 'harassment', 'self_harm', 'profanity', 'religion_or_politics', 'medical_and_legal_information'].map(k => [k, ON])),
    trigger_action: { type: 'end_call' },
  },
};

function agentBody(r, a, { orchy = false, transfers = [] } = {}) {
  return {
    name: orchy ? 'Orchy' : `${a.name} · ${agentInfo(a).role}`,
    tags: ['orchy', orchy ? 'orchestrator' : a.workspace],
    conversation_config: {
      agent: {
        first_message: firstMessage(a.name, orchy),
        language: 'en',
        prompt: {
          prompt: orchy ? orchyPrompt(r) : agentPrompt(r, a),
          llm: r.llm,
          temperature: 0.4,
          timezone: config.timezone || 'America/New_York',
          tool_ids: Object.values(r.toolIds || {}),
          built_in_tools: {
            end_call: system('end_call', {}),
            transfer_to_agent: transfers.length ? system('transfer_to_agent', { transfers }) : null,
          },
        },
      },
      tts: { voice_id: a.voiceId },
    },
    // overrides: only a call an agent places sets its own greeting and reason (callSession); Orchy signs every call
    platform_settings: { auth: { enable_auth: true }, guardrails: GUARDRAILS, overrides: { conversation_config_override: { agent: { first_message: true, prompt: { prompt: true } } } } },
  };
}

// ── sync: tools, then every agent, then transfers (they need each other's ids) ──
export async function sync({ log = console.log } = {}) {
  const r = roster();
  r.toolIds ||= {};
  for (const t of TOOLS) {
    const tool_config = { type: 'client', ...t, expects_response: true, response_timeout_secs: 30 };
    if (r.toolIds[t.name]) await eleven('PATCH', `/v1/convai/tools/${r.toolIds[t.name]}`, { tool_config });
    else r.toolIds[t.name] = (await eleven('POST', '/v1/convai/tools', { tool_config })).id;
    log(`tool ${t.name} → ${r.toolIds[t.name]}`);
  }
  saveRoster(r);

  for (const a of r.agents) {
    const body = agentBody(r, a);
    if (a.agentId) await eleven('PATCH', `/v1/convai/agents/${a.agentId}`, body);
    else { a.agentId = (await eleven('POST', '/v1/convai/agents/create', body)).agent_id; saveRoster(r); }
    log(`${a.name} (${keyOf(a)}) → ${a.agentId}`);
  }

  // first sync ever: Orchy needs an agent id before the others can transfer back to it
  if (!r.orchy.agentId) { r.orchy.agentId = (await eleven('POST', '/v1/convai/agents/create', agentBody(r, r.orchy, { orchy: true }))).agent_id; saveRoster(r); }
  const backToOrchy = [{ agent_id: r.orchy.agentId, condition: `${ownerName()} wants Orchy, or wants to talk to a different agent.` }];
  for (const a of r.agents) await eleven('PATCH', `/v1/convai/agents/${a.agentId}`, agentBody(r, a, { transfers: backToOrchy }));
  const toTeam = r.agents.filter(onDuty).map(a => ({ agent_id: a.agentId, condition: `${ownerName()} wants to talk to ${a.name} (${agentInfo(a).role}, ${a.workspace}).` }));
  await eleven('PATCH', `/v1/convai/agents/${r.orchy.agentId}`, agentBody(r, r.orchy, { orchy: true, transfers: toTeam }));
  log(`Orchy → ${r.orchy.agentId} (transfers to ${toTeam.length} agents)`);
  saveRoster(r);
  return r;
}

// Only one agent changed: its own voice agent, then Orchy (team list + transfers). Other agents'
// prompts don't name their teammates, so they stay as they are.
async function syncOne(r, a) {
  const backToOrchy = [{ agent_id: r.orchy.agentId, condition: `${ownerName()} wants Orchy, or wants to talk to a different agent.` }];
  const body = agentBody(r, a, { transfers: backToOrchy });
  if (a.agentId) await eleven('PATCH', `/v1/convai/agents/${a.agentId}`, body);
  else { a.agentId = (await eleven('POST', '/v1/convai/agents/create', body)).agent_id; saveRoster(r); }
  const toTeam = r.agents.filter(x => x.agentId && onDuty(x)).map(x => ({ agent_id: x.agentId, condition: `${ownerName()} wants to talk to ${x.name} (${agentInfo(x).role}, ${x.workspace}).` }));
  await eleven('PATCH', `/v1/convai/agents/${r.orchy.agentId}`, agentBody(r, r.orchy, { orchy: true, transfers: toTeam }));
  saveRoster(r);
}

// ── new agents: a name, a voice, then a sync ──
// Voices stay 50/50 female/male, young, American, upbeat "influencer" style.
const NAMES = {
  female: ['Nora', 'Chloe', 'Maya', 'Stella', 'Piper', 'Hazel', 'Jade', 'Willow', 'Sadie', 'Brooke', 'Riley', 'Layla', 'Naomi', 'Daisy', 'Sienna', 'Gemma', 'Kenzie', 'Ava', 'Lila', 'Tessa'],
  male: ['Miles', 'Owen', 'Finn', 'Nate', 'Caleb', 'Jace', 'Wes', 'Logan', 'Ryder', 'Beau', 'Reid', 'Gavin', 'Ethan', 'Jake', 'Ryan', 'Zane', 'Brody', 'Tanner', 'Rhett', 'Troy'],
};
const OK_USE = new Set(['social_media', 'conversational', 'entertainment_tv']);
const NOT_YOUNG_SOUNDING = new Set(['professional', 'formal', 'mature', 'classy', 'rough', 'deep']);
const ODD_VOICE = /kid|child|ditzy|asmr|whisper|character|villain|old|grandp|robot/i;
const shortVoice = n => String(n).split(/\s+[-–—|]\s+/)[0].trim();

function nextGender(r) {
  const n = g => r.agents.filter(a => a.gender === g).length;
  if (n('female') !== n('male')) return n('female') < n('male') ? 'female' : 'male';
  return r.agents.at(-1)?.gender === 'female' ? 'male' : 'female';
}

const takenNames = r => new Set([r.orchy.name, ...r.agents.map(a => a.name)].map(n => n.toLowerCase()));
const goodName = n => /^[A-Z][a-zA-Z'-]{1,19}$/.test(n || '');

function nextName(r, gender) {
  const taken = takenNames(r);
  const name = NAMES[gender].find(n => !taken.has(n.toLowerCase()));
  if (!name) throw new Error(`Out of ${gender} names for voice agents: add more to NAMES in voiceagents.mjs`);
  return name;
}

/** What the AI Agent Builder needs to name new agents: names in use, whose they are, and the next gender. */
export function namingBrief() {
  const r = roster();
  const gender = nextGender(r);
  return {
    taken: [r.orchy.name, ...r.agents.map(a => a.name)],
    byAgent: Object.fromEntries(r.agents.map(a => [keyOf(a), a.name])),
    gender,
    counts: { female: r.agents.filter(a => a.gender === 'female').length, male: r.agents.filter(a => a.gender === 'male').length },
  };
}

/** A young American voice nobody uses yet: one already in the account first, else the top trending one from the shared library (added to the account). */
async function pickVoice(r, gender) {
  const used = new Set([r.orchy.voiceId, ...r.agents.map(a => a.voiceId)]);
  const mine = (await eleven('GET', '/v2/voices?page_size=100')).voices || [];
  const own = mine.find(v => {
    const l = v.labels || {};
    return !used.has(v.voice_id) && l.gender === gender && l.age === 'young' && l.accent === 'american'
      && OK_USE.has(l.use_case) && !NOT_YOUNG_SOUNDING.has(l.descriptive) && !ODD_VOICE.test(v.name);
  });
  if (own) return { voiceId: own.voice_id, voice: shortVoice(own.name) };

  const inAccount = new Set(mine.map(v => v.voice_id));
  const q = new URLSearchParams({ page_size: '50', gender, age: 'young', accent: 'american', language: 'en', use_cases: 'social_media', sort: 'trending' });
  const shared = (await eleven('GET', `/v1/shared-voices?${q}`)).voices || [];
  const pick = shared.find(v => !used.has(v.voice_id) && !inAccount.has(v.voice_id) && v.free_users_allowed !== false
    && !NOT_YOUNG_SOUNDING.has(v.descriptive) && !ODD_VOICE.test(v.name));
  if (!pick) throw new Error(`No unused young American ${gender} voice found in ElevenLabs`);
  const added = await eleven('POST', `/v1/voices/add/${pick.public_owner_id}/${pick.voice_id}`, { new_name: pick.name });
  return { voiceId: added.voice_id || pick.voice_id, voice: shortVoice(pick.name) };
}

/** Roster entries for agent files that don't have a voice agent yet, and renames from call_name (`only`: one "ws/slug"). */
async function addMissing(log, only = null) {
  const r = roster();
  const files = listAgents().filter(g => !g.error && (!only || `${g.workspace}/${g.slug}` === only));
  // the builder renamed an agent (call_name in its file): follow it if the name is free
  let renamed = false;
  for (const a of r.agents) {
    const g = files.find(f => f.workspace === a.workspace && f.slug === a.slug);
    if (g?.callName && g.callName !== a.name && goodName(g.callName) && !takenNames(r).has(g.callName.toLowerCase())) {
      log(`voice agent renamed: ${a.name} → ${g.callName} (${keyOf(a)})`);
      a.name = g.callName; renamed = true;
    }
  }
  if (renamed) saveRoster(r);

  const have = new Set(r.agents.map(keyOf));
  const added = [];
  for (const g of files.filter(g => !have.has(`${g.workspace}/${g.slug}`))) {
    const gender = g.gender || nextGender(r);
    const own = goodName(g.callName) && !takenNames(r).has(g.callName.toLowerCase()) ? g.callName : null;
    if (g.callName && !own) log(`${keyOf(g)}: call_name "${g.callName}" is taken or not a first name, picking another`);
    const a = { workspace: g.workspace, slug: g.slug, name: own || nextName(r, gender), gender, ...(await pickVoice(r, gender)) };
    r.agents.push(a);
    saveRoster(r);
    added.push({ ...a, role: g.displayName });
    log(`new voice agent: ${a.name} (${a.gender}, voice ${a.voice}) for ${keyOf(a)}`);
  }
  return { added, renamed };
}

let queue = Promise.resolve();
let timer = null;
let wanted = null;
/**
 * Bring ElevenLabs in line with the agent files: give new agents a name and voice, then re-sync
 * (Orchy's team list and transfers change too). `full` re-syncs even when nobody is new (an agent's
 * role or description changed). Debounced and queued, so a burst of builder writes is one sync.
 */
export function refresh({ full = false, log = console.log, onDone } = {}) {
  if (!env('ELEVENLABS_API_KEY') || !voiceEnabled()) return;
  wanted = { full: full || wanted?.full, log, onDone: onDone || wanted?.onDone };
  clearTimeout(timer);
  timer = setTimeout(() => {
    const job = wanted; wanted = null;
    queue = queue.then(async () => {
      const { added, renamed } = await addMissing(job.log);
      // an agent whose ElevenLabs create failed earlier still has no agentId: that needs a sync too
      if (!added.length && !renamed && !job.full && roster().agents.every(a => a.agentId)) return;
      await sync({ log: () => {} });
      job.log(`[voice] in sync${added.length ? `, new: ${added.map(a => a.name).join(', ')}` : ''}`);
      job.onDone?.(added);
    }).catch(e => console.error('[voice] sync failed:', e.message));
  }, 3000);
}

/**
 * The AI Agent Builder puts the agent it just wrote on voice, inside its own run: a name and voice
 * if it's new, then a sync so its prompt, Orchy's team list and the transfers match the file.
 * Shares refresh()'s queue, so the two never write the roster at once.
 */
export async function buildVoice(wsId, slug) {
  if (!env('ELEVENLABS_API_KEY')) throw Object.assign(new Error(`No ELEVENLABS_API_KEY in .env, so voice agents are off. ${ownerName()} adds the key in Settings.`), { status: 400 });
  const g = getAgent(wsId, slug);
  if (g.error) throw Object.assign(new Error(`${slug}.md doesn't parse, fix it first: ${g.error}`), { status: 400 });
  const key = `${wsId}/${g.slug}`;
  const job = queue.then(async () => {
    const { added } = await addMissing(() => {}, key);
    const r = roster();
    // first voice agent ever, or tools missing: the full sync sets everything up
    if (!r.orchy.agentId || TOOLS.some(t => !r.toolIds?.[t.name])) await sync({ log: () => {} });
    else await syncOne(r, r.agents.find(x => keyOf(x) === key));
    const a = roster().agents.find(x => keyOf(x) === key);
    if (!a?.agentId) throw new Error(`ElevenLabs gave ${slug} no agent id`);
    return { name: a.name, callName: g.callName, gender: a.gender, voice: a.voice, agentId: a.agentId, isNew: added.length > 0 };
  });
  queue = job.catch(() => {});
  return job;
}

// ── Clients' own voice agents ──
// A client calls the agents the owner shared with them from their own page (portal.mjs). Each gets its own ElevenLabs
// agent per client ("Harper · for Alex"), never the owner's: no transfers (Orchy and the rest of the team stay out of
// reach), nothing the caller can override, a prompt that knows only that agent's role and the owner's brief, and five
// tools the page sends to the portal, which only touches that client's tasks. No audio is kept, transcripts go
// after 30 days, a call lasts at most 15 minutes.
export const CLIENT_TOOLS = [
  {
    name: 'start_task',
    description: 'Start a task with you (this agent). It runs for real and returns straight away; the work takes minutes and shows on the caller’s page.',
    parameters: { type: 'object', properties: { task: str('The task in the caller’s words, complete enough to act on without this call.') }, required: ['task'] },
  },
  {
    name: 'task_status',
    description: 'The caller’s tasks that are running or finished today, and anything waiting on the caller (questions and approvals, with their ids).',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'task_result',
    description: 'What came back from one of the caller’s tasks (or where it is up to).',
    parameters: { type: 'object', properties: { task_id: str('The task id from task_status or start_task.') }, required: ['task_id'] },
  },
  {
    name: 'answer_item',
    description: 'Answer something waiting on the caller. For a question pass answer. For an approval pass decision "approve" or "deny" (only after the caller clearly said so).',
    parameters: { type: 'object', properties: { item_id: str('The item id from task_status.'), answer: str('The caller’s answer to a question.'), decision: str('approve or deny, for approvals.') }, required: ['item_id'] },
  },
  {
    name: 'follow_up',
    description: 'Follow up on one of the caller’s finished tasks; you pick up where you left off.',
    parameters: { type: 'object', properties: { task_id: str('The task to follow up.'), message: str('What the caller wants next.') }, required: ['task_id', 'message'] },
  },
];

function clientPrompt(c, a, ws) {
  let g = {};
  try { g = getAgent(a.workspace, a.slug); } catch {}
  const role = g.role || g.displayName || a.slug;
  const brief = String(c.brief || '').trim();
  return `You are ${a.name}, ${role}, working for ${c.name} at ${ws.client}. ${c.name} is calling you from their own Orchy page.

# What you do
${g.identity || role}
${brief ? `\n# About ${c.name}\n${brief}\n` : ''}
# How you talk
- This is a live voice call with ${c.name}. Warm, upbeat and clear, never fake or over the top.
- Short spoken sentences, one idea at a time. No lists or markdown. Don't read out ids, links or file paths unless asked.
- Say numbers and times the way people say them. If you're not sure what ${c.name} means, ask one quick question.

# How work happens
- You don't do the work in this call. start_task starts a real task, which takes minutes. Say it's started and that it shows on their page, or that they can ask you to check.
- Before start_task, say the task back in one sentence and get a yes.
- Never say something is done unless task_status or task_result says so.
- Questions and approvals waiting on ${c.name} come from task_status with an id. Read them out plainly. Only approve or deny when ${c.name} clearly says so.
- Some steps wait for ${ownerName()} instead (anything on ${ownerName()}'s computer). If asked, say ${ownerName()} has been told.
- You only know ${c.name}'s own tasks with you. You can't reach other agents, other people or anything of ${ownerName()}'s; if asked, say you can only help with ${c.name}'s tasks.
- If a tool returns an error, say what went wrong in plain words.
- When ${c.name} asks what you did, tell it like a person would: what you looked at, what you found or made, what's next, in a sentence or two. No step-by-step, and never commands, scripts, code, file or program names.`;
}

function clientBody(r, c, a, ws) {
  return {
    name: `${a.name} · for ${c.name}`.slice(0, 80),
    tags: ['orchy', 'client', ws.id],
    conversation_config: {
      agent: {
        first_message: `Hi ${c.name}, it's ${a.name}! What can I do for you?`,
        language: 'en',
        prompt: {
          prompt: clientPrompt(c, a, ws),
          llm: r.llm,
          temperature: 0.4,
          timezone: config.timezone || 'America/New_York',
          tool_ids: CLIENT_TOOLS.map(t => r.clientToolIds[t.name]),
          built_in_tools: { end_call: system('end_call', {}), transfer_to_agent: null },
        },
      },
      tts: { voice_id: a.voiceId },
      conversation: { max_duration_seconds: 900, file_input: { enabled: false } },
    },
    platform_settings: {
      auth: { enable_auth: true },
      guardrails: GUARDRAILS,
      // the caller's browser can't change who it is or what it's told
      overrides: { conversation_config_override: { agent: { first_message: false, language: false, prompt: { prompt: false } }, tts: { voice_id: false } } },
      privacy: { record_voice: false, retention_days: 30 },
      call_limits: { agent_concurrency_limit: 2, daily_limit: 50 },
    },
  };
}

const bodyHash = b => crypto.createHash('sha256').update(JSON.stringify(b)).digest('hex').slice(0, 16);

/**
 * A signed URL for a client's call with one shared agent: its voice agent is made (or brought up to date) first.
 * The caller (portal.mjs) has already checked the agent is shared with them.
 */
export async function clientSession(c, slug) {
  if (!env('ELEVENLABS_API_KEY')) throw Object.assign(new Error('Calls aren’t set up yet.'), { status: 503 });
  const ws = workspace(c.workspace);
  const job = queue.then(async () => {
    const r = roster();
    const a = r.agents.find(x => x.workspace === c.workspace && x.slug === slug);
    if (!a?.voiceId) throw Object.assign(new Error(`This agent doesn’t have a voice yet. ${ownerName()} can set it up.`), { status: 409 });
    r.clientToolIds ||= {};
    for (const t of CLIENT_TOOLS) {
      if (r.clientToolIds[t.name]) continue;
      r.clientToolIds[t.name] = (await eleven('POST', '/v1/convai/tools', { tool_config: { type: 'client', ...t, expects_response: true, response_timeout_secs: 30 } })).id;
      saveRoster(r);
    }
    r.clientVoices ||= {};
    const key = `${c.id}/${slug}`;
    const body = clientBody(r, c, a, ws);
    const hash = bodyHash(body);
    const have = r.clientVoices[key];
    if (!have?.agentId) r.clientVoices[key] = { agentId: (await eleven('POST', '/v1/convai/agents/create', body)).agent_id, hash };
    else if (have.hash !== hash) { await eleven('PATCH', `/v1/convai/agents/${have.agentId}`, body); have.hash = hash; }
    saveRoster(r);
    return { agentId: r.clientVoices[key].agentId, name: a.name };
  });
  queue = job.catch(() => {});
  const { agentId, name } = await job;
  const { signed_url } = await eleven('GET', `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`);
  return { signedUrl: signed_url, name, agentId };
}

/** Is this voice agent one of this client's? (A finished call's id is checked before Orchy reads its transcript.) */
export function isClientVoice(c, agentId) {
  try { return Object.entries(roster().clientVoices || {}).some(([k, v]) => k.startsWith(`${c.id}/`) && v.agentId === agentId); } catch { return false; }
}

/** A client removed, or an agent no longer shared with them: their voice agents go too (on the roster's queue). */
export async function removeClientVoices(cid, keep = []) {
  if (!env('ELEVENLABS_API_KEY')) return;
  const job = queue.then(async () => {
    const r = roster();
    for (const [k, v] of Object.entries(r.clientVoices || {})) {
      if (!k.startsWith(`${cid}/`) || keep.includes(k.slice(cid.length + 1))) continue;
      try { await eleven('DELETE', `/v1/convai/agents/${v.agentId}`); } catch (e) { if (!/404/.test(e.message)) throw e; }
      delete r.clientVoices[k];
      saveRoster(r);
    }
  });
  queue = job.catch(() => {});
  return job;
}
