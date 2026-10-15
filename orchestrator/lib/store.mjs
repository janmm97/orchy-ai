// Tiny JSON persistence for runs, sessions, chat, inbox and remembered approvals.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, readJson, setAside } from './env.mjs';

const STATE_PATH = path.join(DATA_DIR, 'state.json');

const empty = () => ({
  runs: {},          // runId -> run record (no raw events)
  sessions: {},      // sessionId -> one conversation with Orchy (sessions.mjs)
  chat: [],          // [{id, role:'owner'|'orchy'|'system', text, at, meta, session}]
  inbox: {},         // itemId -> pending/answered interruption
  rules: [],         // remembered "always allow" approvals
  actionCache: {},   // One actionId -> {title, method, path, platform}
  jevDecisions: {},  // actionId or mcp:<tool> -> Jev's decision kind for it (jevdecide.mjs)
  huddles: {},       // huddleId -> two agents talking a task through (huddle.mjs)
  // approvals: 'decisions' = agents run on their own and only money, sending, calendar, deleting and
  // sharing ask the owner (askFor switches each kind); 'all' = every change asks.
  settings: { voiceReplies: false, sound: true, autoDispatch: true, actionPlan: true, liveJev: true, liveStart: true, approvals: 'decisions', askFor: { money: true, send: true, calendar: true, delete: true, share: true } },
});

/**
 * Read a state file. A missing one is a fresh start; one that won't parse is kept aside (state.json.corrupt-<time>)
 * with a warning before starting fresh, so the next save never overwrites the owner's history.
 */
export function loadState(file) {
  if (!fs.existsSync(file)) return empty();
  try {
    const s = readJson(file);
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('not a JSON object');
    return { ...empty(), ...s };
  } catch (e) {
    if (!setAside(file, e.message)) throw new Error(`${file} couldn't be read (${e.message}), and Orchy couldn't move it aside either. Close whatever has it open, or move it yourself, then start Orchy again.`);
    return empty();
  }
}

let state = loadState(STATE_PATH);

let timer = null;
export function save() {
  clearTimeout(timer);
  timer = setTimeout(flush, 150);
}
export function flush() {
  clearTimeout(timer);
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

export function db() { return state; }

export function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function addChat(role, text, meta = {}, session = null) {
  const msg = { id: id('m'), role, text, at: new Date().toISOString(), meta, session };
  state.chat.push(msg);
  if (state.chat.length > 2000) state.chat.splice(0, state.chat.length - 2000);
  save();
  return msg;
}

export function runEventsPath(runId) {
  return path.join(DATA_DIR, 'runs', `${runId}.jsonl`);
}
