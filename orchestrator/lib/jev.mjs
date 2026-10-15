// Jev, TypeSafe's routing model, from one of four providers:
//   typesafe   TYPESAFE_API_KEY    TypeSafe's own structured `systemone` endpoint (id 'direct')
//   vercel     AI_GATEWAY_API_KEY  Vercel AI Gateway's TypeSafe-compatible API: the same request, another address
//   openrouter OPENROUTER_API_KEY  Jev as a chat model (`~typesafe/jev-latest`), question types emulated
//   opencode   OPENCODE_API_KEY    OpenCode Zen, Jev as a chat model (`jev-1.13`; the free tier only answers the OpenCode app)
// JEV_PROVIDER names one (or "off"); without it, the first provider whose key is set: typesafe, openrouter,
// vercel, opencode. No provider: ask() throws an Error with .code = 'NO_JEV' and callers fall back to keywords.
// Question types: choice (pick one of `criteria`), score (a level of a `criteria` list) and noul
// (a yes/no `instructions` question, answered as a 0-1 probability in `answers.<name>.noul`).
//
// CAVEAT: the chat providers EMULATE those question types over chat completions (one structured-output
// request per ask). It approximates the native systemone types, so the calibration of confidences and
// probabilities can differ from the native ones.
import fs from 'node:fs';
import path from 'node:path';
import { env, DATA_DIR } from './env.mjs';

const OPENROUTER_MODEL = '~typesafe/jev-latest';
const CALL_LOG = path.join(DATA_DIR, 'jev-calls.jsonl');

/** The model id sent to OpenRouter: TYPESAFE_MODEL when it is an OpenRouter-style id (has "/" or "~"), else the default. */
export function openrouterModel() {
  const m = env('TYPESAFE_MODEL');
  return m && /[/~]/.test(m) ? m : OPENROUTER_MODEL;
}

export const PROVIDERS = {
  direct: { name: 'typesafe', label: 'TypeSafe', key: 'TYPESAFE_API_KEY', native: 'https://api.typesafe.ai/v1', model: () => env('TYPESAFE_MODEL', 'jev-latest') },
  vercel: { name: 'vercel', label: 'Vercel AI Gateway', key: 'AI_GATEWAY_API_KEY', native: 'https://ai-gateway.vercel.sh/typesafe/v1', model: () => env('VERCEL_JEV_MODEL', 'typesafe-ai/jev') },
  openrouter: { name: 'openrouter', label: 'OpenRouter', key: 'OPENROUTER_API_KEY', chat: 'https://openrouter.ai/api/v1/chat/completions', model: openrouterModel,
    headers: { 'HTTP-Referer': 'https://github.com/janmm97/orchy-ai', 'X-Title': 'Orchy' } },
  opencode: { name: 'opencode', label: 'OpenCode Zen', key: 'OPENCODE_API_KEY', chat: 'https://opencode.ai/zen/v1/chat/completions', model: () => env('OPENCODE_JEV_MODEL', 'jev-1.13') },
};
const ORDER = ['direct', 'openrouter', 'vercel', 'opencode'];
const byName = n => ORDER.find(id => PROVIDERS[id].name === String(n || '').trim().toLowerCase());

/** The provider id in use: 'direct' (TypeSafe) | 'vercel' | 'openrouter' | 'opencode' | 'none' (keyword routing only). */
export function jevMode() {
  const pick = String(env('JEV_PROVIDER') || '').trim().toLowerCase();
  if (pick === 'off' || pick === 'none') return 'none';
  if (pick) { const id = byName(pick); return id && env(PROVIDERS[id].key) ? id : 'none'; }
  return ORDER.find(id => env(PROVIDERS[id].key)) || 'none';
}

/** "TypeSafe (jev-latest)", "OpenRouter (~typesafe/jev-latest)"…, or null when Jev is off. */
export function jevLabel(mode = jevMode()) {
  const p = PROVIDERS[mode];
  return p ? `${p.label} (${p.model()})` : null;
}

async function native(p, pathname, body, timeoutMs = 30_000) {
  const res = await fetch(p.native + pathname, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${env(p.key)}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Jev (${p.label}) ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
  return json;
}

/** One line per Jev call in data/jev-calls.jsonl: what it was for, how long it took, what it cost. */
function logCall(entry) {
  try { fs.appendFileSync(CALL_LOG, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n'); } catch {}
}

// -- chat emulation of the question types (OpenRouter, OpenCode Zen) --

const critKeys = c => (Array.isArray(c) ? c.map((_, i) => String(i)) : Object.keys(c || {}));

/** The strict JSON schema for a set of questions: one object per question name. */
export function buildSchema(questions) {
  const properties = {};
  for (const [name, q] of Object.entries(questions)) {
    if (q.type === 'choice') {
      properties[name] = { type: 'object', additionalProperties: false, required: ['choice', 'confidence'],
        properties: { choice: { type: 'string', enum: critKeys(q.criteria) }, confidence: { type: 'number', description: 'probability 0..1 that this choice is right' } } };
    } else if (q.type === 'score') {
      properties[name] = { type: 'object', additionalProperties: false, required: ['score'],
        properties: { score: { type: 'number', description: `0 to ${Math.max(0, critKeys(q.criteria).length - 1)}; fractions allowed between two levels` } } };
    } else if (q.type === 'noul') {
      properties[name] = { type: 'object', additionalProperties: false, required: ['probability'],
        properties: { probability: { type: 'number', description: 'probability 0..1 that the answer is yes' } } };
    } else throw new Error(`Unknown question type "${q.type}" for ${name}`);
  }
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
}

const SYSTEM = `You answer routing questions about a "state" (JSON). The user message holds {"state", "questions"}. Answer EVERY question, keyed by its name, as JSON that matches the response schema:
- type "choice": pick exactly one key of "criteria" (keys are the allowed values, values describe them; for a list the key is the index). Answer {"choice": <key>, "confidence": <0..1 probability that it is right>}.
- type "score": "criteria" is an ordered list of levels, level 0 first. Answer {"score": <number from 0 to the last level; fractions allowed between levels>}.
- type "noul": "instructions" is a yes/no question. Answer {"probability": <0..1 that the answer is yes>}.
Judge only from the state and each question's "instructions". Reply with the JSON object only.`;

function mapAnswers(questions, parsed) {
  const answers = {};
  const clamp = n => Math.min(1, Math.max(0, Number(n)));
  for (const [name, q] of Object.entries(questions)) {
    const a = parsed?.[name];
    if (!a || typeof a !== 'object') throw new Error(`Jev's answer is missing "${name}"`);
    if (q.type === 'choice') {
      if (!critKeys(q.criteria).includes(String(a.choice))) throw new Error(`Jev picked "${a.choice}" for "${name}", which is not one of the choices`);
      const choice = Array.isArray(q.criteria) ? q.criteria[Number(a.choice)] : a.choice;
      const confidence = Number.isFinite(Number(a.confidence)) ? clamp(a.confidence) : 0;
      answers[name] = { choice, confidence, probabilities: { [choice]: confidence } };
    } else if (q.type === 'score') {
      const top = Math.max(0, critKeys(q.criteria).length - 1), s = Number(a.score);
      if (!Number.isFinite(s)) throw new Error(`Jev's score for "${name}" is not a number`);
      answers[name] = { score: Math.min(top, Math.max(0, s)) };
    } else {
      const p = Number(a.probability);
      if (!Number.isFinite(p)) throw new Error(`Jev's probability for "${name}" is not a number`);
      answers[name] = { noul: clamp(p) };
    }
  }
  return answers;
}

const FENCE = /^```(?:json)?\s*|\s*```$/g; // some chat models wrap the JSON in a code fence

async function viaChat(p, state, questions, timeoutMs) {
  const model = p.model();
  const post = responseFormat => fetch(p.chat, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env(p.key)}`, 'Content-Type': 'application/json', ...(p.headers || {}) },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify({ state, questions }) }],
      ...(responseFormat ? { response_format: responseFormat } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let res = await post({ type: 'json_schema', json_schema: { name: 'jev_answers', strict: true, schema: buildSchema(questions) } });
  let json = await res.json().catch(() => ({}));
  // a provider without strict JSON schemas: ask again with the instructions alone
  if ((res.status === 400 || res.status === 422) && /response_format|json_schema|schema/i.test(JSON.stringify(json))) {
    res = await post(null);
    json = await res.json().catch(() => ({}));
  }
  if (!res.ok) {
    const why = res.status === 401 ? `${p.label} refused the key (401): check ${p.key}`
      : res.status === 429 ? `${p.label} is rate-limiting Jev (429): try again shortly`
      : `${p.label} ${res.status}`;
    throw new Error(`${why}: ${JSON.stringify(json?.error?.message || json).slice(0, 300)}`);
  }
  const content = json?.choices?.[0]?.message?.content;
  let parsed;
  try { parsed = typeof content === 'string' ? JSON.parse(content.trim().replace(FENCE, '')) : content; } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object') throw new Error(`Jev (${p.label}) did not return valid JSON`);
  return { model: json.model || model, answers: mapAnswers(questions, parsed), usage: json.usage };
}

/**
 * Ask Jev named questions about a state. Returns {model, answers, usage, ms, via}.
 * opts.purpose labels the call in the log; opts.timeoutMs caps the call. opts.fallback is accepted for
 * old callers and ignored (there is no second route any more). Throws with .code 'NO_JEV' without a provider.
 */
export async function ask(state, questions, { purpose = 'other', timeoutMs = 30_000 } = {}) {
  const via = jevMode();
  if (via === 'none') {
    const e = new Error('Jev is off: add a key for TypeSafe, OpenRouter, Vercel AI Gateway or OpenCode Zen to .env (npm run setup asks)');
    e.code = 'NO_JEV';
    throw e;
  }
  const p = PROVIDERS[via];
  const t0 = Date.now();
  let res;
  try {
    res = p.native
      ? { model: p.model(), ...(await native(p, '/systemone', { model: p.model(), state, questions }, timeoutMs)) }
      : await viaChat(p, state, questions, timeoutMs);
  } catch (e) {
    logCall({ purpose, ok: false, ms: Date.now() - t0, via, questions: Object.keys(questions).length, error: e.message.slice(0, 200) });
    throw e;
  }
  const ms = Date.now() - t0;
  logCall({ purpose, ok: true, ms, via, model: res.model, questions: Object.keys(questions).length, usage: res.usage });
  return { ...res, ms, via };
}

/** The models Jev can use: {models: [{name}]} in every mode. */
export async function models() {
  const p = PROVIDERS[jevMode()];
  if (!p) return { models: [] };
  return p.native ? native(p, '/models') : { models: [{ name: p.model() }] };
}
