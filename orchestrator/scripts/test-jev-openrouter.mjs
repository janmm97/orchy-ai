// Jev over OpenRouter (lib/jev.mjs): choice / score / noul emulation, bad model output, HTTP errors, and the
// no-key path. fetch is faked: no network, no key needed. Run: node orchestrator/scripts/test-jev-openrouter.mjs
// A .env value wins over process.env, so the owner's own Jev keys are set aside here (in memory; .env is untouched).
const { reloadEnv } = await import('../lib/env.mjs');
const fileEnv = reloadEnv();
for (const k of ['JEV_PROVIDER', 'TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'TYPESAFE_MODEL', 'AI_GATEWAY_API_KEY', 'OPENCODE_API_KEY']) delete fileEnv[k];
process.env.JEV_PROVIDER = '';
process.env.TYPESAFE_API_KEY = '';
process.env.OPENROUTER_API_KEY = 'sk-or-test';
process.env.TYPESAFE_MODEL = '';
const jev = await import('../lib/jev.mjs');

let fail = 0;
const ok = (cond, label, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : `  ${extra}`}`); if (!cond) fail++; };

const questions = {
  intent: { type: 'choice', instructions: 'What?', criteria: { task: 'do work', chat: 'talk' } },
  effort: { type: 'score', instructions: 'How hard?', criteria: ['easy', 'normal', 'hard'] },
  c0: { type: 'noul', instructions: 'Use Gmail?' },
};

const realFetch = globalThis.fetch;
let seen = null;
const reply = (status, body) => async (url, init) => {
  seen = { url, init, body: init?.body ? JSON.parse(init.body) : null };
  return { ok: status < 400, status, json: async () => body };
};
const completion = content => ({ model: '~typesafe/jev-latest', usage: { total_tokens: 42 }, choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] });

ok(jev.jevMode() === 'openrouter', 'mode is openrouter with only OPENROUTER_API_KEY');
ok((await jev.models()).models[0].name === '~typesafe/jev-latest', 'models() lists the default model');

// ── the happy path ──
globalThis.fetch = reply(200, completion({ intent: { choice: 'task', confidence: 0.8 }, effort: { score: 1.4 }, c0: { probability: 0.9 } }));
{
  const r = await jev.ask({ text: 'hi' }, questions, { purpose: 'test' });
  ok(r.via === 'openrouter' && r.usage?.total_tokens === 42 && typeof r.ms === 'number', 'ask returns model/usage/ms/via');
  ok(r.answers.intent.choice === 'task' && r.answers.intent.confidence === 0.8 && r.answers.intent.probabilities.task === 0.8, 'choice → {choice, confidence, probabilities}');
  ok(r.answers.effort.score === 1.4, 'score → {score}');
  ok(r.answers.c0.noul === 0.9, 'noul → {noul}');
  ok(seen.url === 'https://openrouter.ai/api/v1/chat/completions', 'posts to OpenRouter');
  ok(seen.init.headers.Authorization === 'Bearer sk-or-test' && seen.init.headers['X-Title'] === 'Orchy' && seen.init.headers['HTTP-Referer'].includes('orchy-ai'), 'auth + attribution headers');
  ok(seen.body.model === '~typesafe/jev-latest' && seen.body.temperature === 0, 'model and temperature 0');
  const rf = seen.body.response_format;
  ok(rf.type === 'json_schema' && rf.json_schema.strict === true && rf.json_schema.schema.properties.intent.properties.choice.enum.join() === 'task,chat', 'strict json_schema built from the questions');
  ok(JSON.parse(seen.body.messages[1].content).state.text === 'hi', 'state and questions ride in the user message');
}

// ── scores are clamped, probabilities too ──
globalThis.fetch = reply(200, completion({ intent: { choice: 'chat', confidence: 4 }, effort: { score: 9 }, c0: { probability: -1 } }));
{
  const r = await jev.ask({}, questions);
  ok(r.answers.intent.confidence === 1 && r.answers.effort.score === 2 && r.answers.c0.noul === 0, 'out-of-range numbers are clamped');
}

// ── bad model output throws cleanly ──
for (const [label, content] of [['not JSON', 'sure! here you go'], ['a choice outside the criteria', { intent: { choice: 'dance', confidence: 1 }, effort: { score: 1 }, c0: { probability: 1 } }], ['a missing answer', { intent: { choice: 'task', confidence: 1 } }], ['empty content', null]]) {
  globalThis.fetch = reply(200, completion(content === null ? '' : content));
  let err = null;
  try { await jev.ask({}, questions); } catch (e) { err = e; }
  ok(err instanceof Error && err.code !== 'NO_JEV', `malformed output (${label}) throws a plain error`, String(err));
}
globalThis.fetch = reply(200, { choices: [] });
{ let err; try { await jev.ask({}, questions); } catch (e) { err = e; } ok(err instanceof Error, 'no choices throws'); }

// ── HTTP errors ──
globalThis.fetch = reply(401, { error: { message: 'No auth credentials found' } });
{ let err; try { await jev.ask({}, questions); } catch (e) { err = e; } ok(/401/.test(err?.message) && /OPENROUTER_API_KEY/.test(err.message), '401 names the key', err?.message); }
globalThis.fetch = reply(429, { error: { message: 'slow down' } });
{ let err; try { await jev.ask({}, questions); } catch (e) { err = e; } ok(/429/.test(err?.message) && /rate/i.test(err.message), '429 says rate limit', err?.message); }

// ── no key ──
process.env.OPENROUTER_API_KEY = '';
globalThis.fetch = async () => { throw new Error('no network call expected'); };
ok(jev.jevMode() === 'none', 'mode is none without keys');
{ let err; try { await jev.ask({}, questions); } catch (e) { err = e; } ok(err?.code === 'NO_JEV', 'NO_JEV without a key', String(err)); }
ok((await jev.models()).models.length === 0, 'models() is empty when off');

globalThis.fetch = realFetch;
console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);
