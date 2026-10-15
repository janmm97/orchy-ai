// Jev's four providers (lib/jev.mjs), with fetch faked: no network, no key. Run: node orchestrator/scripts/test-jev-providers.mjs
// Which provider is picked (JEV_PROVIDER, or the key order), and what each sends: address, key, model, request shape.
const KEYS = ['JEV_PROVIDER', 'TYPESAFE_API_KEY', 'TYPESAFE_MODEL', 'OPENROUTER_API_KEY', 'AI_GATEWAY_API_KEY', 'VERCEL_JEV_MODEL', 'OPENCODE_API_KEY', 'OPENCODE_JEV_MODEL'];
// a .env value wins over process.env, so the owner's own settings are set aside here (in memory; .env is untouched)
const { reloadEnv } = await import('../lib/env.mjs');
const fileEnv = reloadEnv();
for (const k of KEYS) delete fileEnv[k];
const jev = await import('../lib/jev.mjs');

let fail = 0;
const ok = (cond, label, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : `  ${extra}`}`); if (!cond) fail++; };
const setEnv = vars => { for (const k of KEYS) process.env[k] = vars[k] ?? ''; };

const questions = { intent: { type: 'choice', instructions: 'What?', criteria: { task: 'do work', chat: 'talk' } }, c0: { type: 'noul', instructions: 'Gmail?' } };
const nativeReply = { model: 'jev', answers: { intent: { choice: 'task', confidence: 0.9 }, c0: { noul: 0.7 } }, usage: { input_tokens: 10 } };
const chatReply = content => ({ model: 'm', choices: [{ message: { content } }], usage: { total_tokens: 5 } });
const answer = JSON.stringify({ intent: { choice: 'task', confidence: 0.9 }, c0: { probability: 0.7 } });

let calls = [];
const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
let script = [];
globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null }); return script.shift() || reply(200, {}); };
const run = async (vars, replies) => { setEnv(vars); calls = []; script = replies; return jev.ask({ text: 'hi' }, questions, { purpose: 'test' }); };

// ── which provider ──
setEnv({});
ok(jev.jevMode() === 'none' && jev.jevLabel() === null, 'no key: Jev is off');
setEnv({ OPENCODE_API_KEY: 'oc', OPENROUTER_API_KEY: 'or' });
ok(jev.jevMode() === 'openrouter', 'without JEV_PROVIDER: OpenRouter comes before OpenCode in the key order');
setEnv({ AI_GATEWAY_API_KEY: 'v', TYPESAFE_API_KEY: 'ts' });
ok(jev.jevMode() === 'direct', 'without JEV_PROVIDER: TypeSafe first (existing installs keep working)');
setEnv({ JEV_PROVIDER: 'opencode', OPENCODE_API_KEY: 'oc', TYPESAFE_API_KEY: 'ts' });
ok(jev.jevMode() === 'opencode', 'JEV_PROVIDER picks one over the key order');
setEnv({ JEV_PROVIDER: 'vercel', TYPESAFE_API_KEY: 'ts' });
ok(jev.jevMode() === 'none', 'JEV_PROVIDER names one whose key is missing: off, not another provider');
setEnv({ JEV_PROVIDER: 'off', TYPESAFE_API_KEY: 'ts' });
ok(jev.jevMode() === 'none', 'JEV_PROVIDER=off: off even with a key');
setEnv({ JEV_PROVIDER: 'OpenCode', OPENCODE_API_KEY: 'oc', OPENCODE_JEV_MODEL: 'jev-1.13-free' });
ok(jev.jevMode() === 'opencode' && jev.jevLabel() === 'OpenCode Zen (jev-1.13-free)', 'names are case-blind; the label names the model');

// ── what each sends ──
let r = await run({ TYPESAFE_API_KEY: 'ts-key' }, [reply(200, nativeReply)]);
ok(calls[0].url === 'https://api.typesafe.ai/v1/systemone' && calls[0].init.headers.Authorization === 'Bearer ts-key' && calls[0].body.model === 'jev-latest' && calls[0].body.questions && calls[0].body.state, 'TypeSafe: native systemone body to api.typesafe.ai');
ok(r.via === 'direct' && r.answers.c0.noul === 0.7, 'TypeSafe: native answers come back as they are');

r = await run({ JEV_PROVIDER: 'vercel', AI_GATEWAY_API_KEY: 'vg-key' }, [reply(200, nativeReply)]);
ok(calls[0].url === 'https://ai-gateway.vercel.sh/typesafe/v1/systemone' && calls[0].init.headers.Authorization === 'Bearer vg-key' && calls[0].body.model === 'typesafe-ai/jev', 'Vercel: the same native body, at the gateway, model typesafe-ai/jev');
ok(r.via === 'vercel' && r.answers.intent.choice === 'task', 'Vercel: native answers');

r = await run({ OPENROUTER_API_KEY: 'or-key' }, [reply(200, chatReply(answer))]);
ok(calls[0].url === 'https://openrouter.ai/api/v1/chat/completions' && calls[0].body.model === '~typesafe/jev-latest' && calls[0].body.response_format?.type === 'json_schema' && calls[0].init.headers['X-Title'] === 'Orchy', 'OpenRouter: chat body with a strict schema and attribution headers');
ok(r.answers.c0.noul === 0.7 && r.answers.intent.confidence === 0.9, 'OpenRouter: emulated answers mapped to the native shape');

r = await run({ JEV_PROVIDER: 'opencode', OPENCODE_API_KEY: 'oc-key' }, [reply(200, chatReply(answer))]);
ok(calls[0].url === 'https://opencode.ai/zen/v1/chat/completions' && calls[0].init.headers.Authorization === 'Bearer oc-key' && calls[0].body.model === 'jev-1.13' && !calls[0].init.headers['X-Title'], 'OpenCode Zen: chat body, model jev-1.13, no OpenRouter headers');
ok(r.via === 'opencode' && r.answers.intent.choice === 'task', 'OpenCode Zen: emulated answers');

r = await run({ JEV_PROVIDER: 'opencode', OPENCODE_API_KEY: 'oc', OPENCODE_JEV_MODEL: 'jev-1.13-free' }, [reply(200, chatReply('```json\n' + answer + '\n```'))]);
ok(calls[0].body.model === 'jev-1.13-free' && r.answers.c0.noul === 0.7, 'the free model, and JSON wrapped in a code fence still reads');

r = await run({ JEV_PROVIDER: 'opencode', OPENCODE_API_KEY: 'oc' }, [reply(400, { error: { message: 'response_format json_schema is not supported' } }), reply(200, chatReply(answer))]);
ok(calls.length === 2 && calls[0].body.response_format && !calls[1].body.response_format && r.answers.intent.choice === 'task', 'a provider without strict schemas: asked again without response_format');

const err = await run({ JEV_PROVIDER: 'opencode', OPENCODE_API_KEY: 'bad' }, [reply(401, { error: { message: 'nope' } })]).catch(e => e);
ok(err instanceof Error && /OpenCode Zen refused the key \(401\): check OPENCODE_API_KEY/.test(err.message), 'a refused key names the provider and its setting', err?.message);

const off = await run({}, []).catch(e => e);
ok(off?.code === 'NO_JEV' && calls.length === 0, 'no provider: NO_JEV, and nothing is sent');

setEnv({ JEV_PROVIDER: 'opencode', OPENCODE_API_KEY: 'oc' });
ok(JSON.stringify(await jev.models()) === JSON.stringify({ models: [{ name: 'jev-1.13' }] }), 'models() names the chat model');

console.log(fail ? `\n${fail} failed` : '\nall Jev provider checks passed');
process.exit(fail ? 1 : 0);
