// The OpenCode adapter against a FAKE opencode server (an in-process HTTP server; no real binary, no network):
//   node orchestrator/scripts/test-engine-opencode.mjs
// Checks, end to end: an approved read is answered `once`; a `git push` is denied by the real policy (no pop-up decision
// is made: the stub gate refuses whatever would need one); a gate that throws is answered `reject` (fail closed);
// a failed answer, a dropped event stream, a dead server, a missing permission route and a loosened config all
// fail the run; and nothing sent carries `--auto`, `always` or `remember`. Nothing is saved or run.
import http from 'node:http';
import { decide } from '../lib/policy.mjs';
import { launchOpenCodeRun, serveArgs, findPermissionRoute, openCodeEnv, buildPromptBody } from '../lib/engines/opencode-run.mjs';
import { buildOpenCodeConfig } from '../lib/engines/opencode-config.mjs';

let fail = 0;
const ok = (cond, label, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : `  ${extra}`}`); if (!cond) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// a made-up workspace folder, spelled as an absolute path on this system
const ROOT_DIR = process.platform === 'win32' ? 'C:/orchy-test' : '/orchy-test';
const CWD = `${ROOT_DIR}/workspaces/Alpha`;
const WS = { id: 'alpha', name: 'Alpha', dir: CWD };
const PW = 'test-password';
const DOC = { paths: { '/session': { post: {} }, '/session/{sessionID}/prompt_async': { post: {} }, '/session/{sessionID}/permissions/{permissionID}': { post: {} }, '/event': { get: {} } } };

/** A fake `opencode serve`. `script(api)` runs after the prompt arrives. */
async function fakeServer({ doc = DOC, config, answerStatus = 200, script }) {
  const st = { requests: [], answers: [], prompts: [], sessionsCreated: 0, sse: null, waiters: new Map(), known: new Set(['ses_old']) };
  const auth = `Basic ${Buffer.from(`opencode:${PW}`).toString('base64')}`;
  const sse = ev => st.sse?.write(`data: ${JSON.stringify(ev)}\n\n`);
  const api = {
    st, sse,
    waitAnswer: pid => (st.answers.find(a => a.pid === pid) ? Promise.resolve() : new Promise(r => st.waiters.set(pid, r))),
    drop: () => st.sse?.destroy(),
    sid: 'ses_1',
  };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', async () => {
      let json = null; try { json = body ? JSON.parse(body) : null; } catch {}
      st.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: json });
      if (req.headers.authorization !== auth) { res.writeHead(401); return res.end('no'); }
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      if (req.method === 'GET' && req.url === '/event') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        st.sse = res;
        sse({ type: 'server.connected', properties: {} });
        return;
      }
      if (req.method === 'POST' && req.url === '/session') { st.sessionsCreated++; st.known.add(api.sid); return send(200, { id: api.sid }); }
      let m;
      if (req.method === 'GET' && (m = req.url.match(/^\/session\/([^/]+)$/))) return st.known.has(m[1]) ? send(200, { id: m[1] }) : send(404, { error: 'nope' });
      if (req.method === 'GET' && req.url === '/doc') return send(200, doc);
      if (req.method === 'GET' && req.url === '/config') return config === undefined ? send(404, {}) : send(200, config);
      if (req.method === 'POST' && (m = req.url.match(/^\/session\/([^/]+)\/prompt_async$/))) {
        st.prompts.push(json);
        send(204);
        api.sid = m[1];
        Promise.resolve().then(() => script?.(api)).catch(e => console.error('fake script', e));
        return;
      }
      if (req.method === 'POST' && (m = req.url.match(/^\/session\/([^/]+)\/permissions\/([^/]+)$/))) {
        st.answers.push({ sid: m[1], pid: m[2], body: json });
        st.waiters.get(m[2])?.();
        return send(answerStatus, true);
      }
      if (req.method === 'POST' && /\/abort$/.test(req.url)) return send(200, true);
      send(404, {});
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  api.url = `http://127.0.0.1:${srv.address().port}`;
  api.close = () => { st.sse?.destroy(); srv.closeAllConnections?.(); srv.close(); };
  return api;
}

/** Run the adapter against a fake server. Returns what the hooks saw. */
async function run(fakeOpts, opts = {}, io = {}) {
  const fake = await fakeServer(fakeOpts);
  const out = { records: [], gated: [], started: null, done: null, closed: 0, wouldAsk: [], fake };
  const exited = new Promise(() => {});
  const gateCtx = { run: { workspace: 'alpha', agentSlug: null }, ws: WS, agent: null, connections: [], mode: 'decisions', askFor: {}, oneScoped: false, remembered: () => false, resolveAction: async () => ({ method: null }), wsAgents: [], otherDirs: [], josRoot: ROOT_DIR };
  const hooks = {
    record: e => out.records.push(e),
    started: s => { out.started = s; },
    // the real policy decides; whatever would need the owner's pop-up is refused here (no pop-up is shown in a test)
    gate: async (tool, input) => {
      out.gated.push({ tool, input });
      if (String(input.url || '').startsWith('boom://')) throw new Error('gate down');
      const v = await decide(tool, input, gateCtx);
      if (v.decision === 'allow') return { allow: true };
      out.wouldAsk.push({ tool, decision: v.decision, reason: v.reason });
      return { allow: false, reason: v.reason };
    },
    usage: t => { out.usage = t; },
    cost: c => { out.cost = c; },
    done: d => { out.done = d; out.doneResolve?.(); },
  };
  const finished = new Promise(r => { out.doneResolve = r; });
  const config = buildOpenCodeConfig({ servers: {}, allowed: null, bridge: { command: 'node', args: ['bridge.mjs'], env: { JOS_TOKEN: 'tok' } } });
  launchOpenCodeRun({ cwd: CWD, bin: 'opencode', profileEnv: {}, runDir: '/nowhere', config, model: 'default', prompt: 'Tidy the notes', system: 'You are inside Orchy', title: 'T', ...opts }, hooks, {
    startServer: async () => ({ baseUrl: fake.url, password: PW, pid: 4242, exited, stderr: () => 'boom on stderr', close: () => { out.closed++; } }),
    partWaitMs: 60, connectTimeoutMs: 3000, ...io,
  });
  await Promise.race([finished, sleep(8000).then(() => { throw new Error('the run never finished'); })]);
  fake.close();
  return out;
}

const part = (id, tool, input, status = 'running', sid = 'ses_1') => ({ type: 'message.part.updated', properties: { part: { id: `p_${id}`, callID: id, sessionID: sid, messageID: 'msg_a', type: 'tool', tool, state: { status, input } } } });
const idle = { type: 'session.idle', properties: { sessionID: 'ses_1' } };
const idleOf = sid => ({ type: 'session.idle', properties: { sessionID: sid } });

// ── pure bits ──
{
  const args = serveArgs(4321);
  ok(args.join(' ') === 'serve --port 4321 --hostname 127.0.0.1' && !args.some(a => /auto|password/i.test(a)), 'opencode serve gets a fixed port/host and no --auto or secret');
  const env = openCodeEnv({ XDG_DATA_HOME: '/p/data' }, { OPENCODE_SERVER_PASSWORD: 'x' }, { PATH: '/bin', OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k2', GITHUB_TOKEN: 't', OPENCODE_CONFIG_CONTENT: '{"permission":{"*":"allow"}}', FOO: '1' });
  ok(env.PATH === '/bin' && env.FOO === '1' && env.XDG_DATA_HOME === '/p/data' && !env.OPENAI_API_KEY && !env.ANTHROPIC_API_KEY && !env.GITHUB_TOKEN && env.OPENCODE_CONFIG_CONTENT === undefined && env.OPENCODE_SERVER_PASSWORD === 'x', 'the PC\'s provider keys and any inherited OpenCode config are dropped from the child env');
  ok(findPermissionRoute(DOC)?.style === 'session' && findPermissionRoute({ paths: { '/permission/{requestID}/reply': { post: {} } } })?.style === 'reply' && findPermissionRoute({ paths: { '/session': { post: {} } } }) === null && findPermissionRoute(null) === null, 'the permission route is found in /doc (either shape), or not');
  ok(!('model' in buildPromptBody({ prompt: 'x', model: 'default' })), 'the default model sends no model');
}

// ── 1. the main path: read once, push denied, gate throws → reject, edit inside the folder once, bridge once ──
{
  const o = await run({
    config: { permission: { '*': 'ask', bash: 'ask' } },
    script: async api => {
      api.sse({ type: 'message.updated', properties: { info: { id: 'msg_u', sessionID: 'ses_1', role: 'user' } } });
      api.sse({ type: 'message.part.updated', properties: { part: { id: 'p_user', messageID: 'msg_u', sessionID: 'ses_1', type: 'text', text: 'Tidy the notes', time: { end: 1 } } } });
      api.sse({ type: 'message.updated', properties: { info: { id: 'msg_a', sessionID: 'ses_1', role: 'assistant' } } });
      // 1: a read inside the folder
      api.sse(part('c1', 'read', { filePath: `${CWD}/notes.md` }));
      api.sse({ type: 'permission.asked', properties: { id: 'per_1', sessionID: 'ses_1', permission: 'read', patterns: [`${CWD}/notes.md`], metadata: {}, always: ['*'], tool: { messageID: 'msg_a', callID: 'c1' } } });
      api.sse({ type: 'permission.asked', properties: { id: 'per_1', sessionID: 'ses_1', permission: 'read', patterns: [`${CWD}/notes.md`], tool: { callID: 'c1' } } }); // the same ask twice
      await api.waitAnswer('per_1');
      // 2: git push (older event name and field shapes)
      api.sse(part('c2', 'bash', { command: 'git push origin main', description: 'push' }));
      api.sse({ type: 'permission.updated', properties: { id: 'per_2', sessionID: 'ses_1', type: 'bash', pattern: 'git push *', callID: 'c2', title: 'git push', metadata: {} } });
      await api.waitAnswer('per_2');
      // 3: the gate throws
      api.sse(part('c3', 'webfetch', { url: 'boom://x' }));
      api.sse({ type: 'permission.asked', properties: { id: 'per_3', sessionID: 'ses_1', permission: 'webfetch', patterns: ['boom://x'], tool: { callID: 'c3' } } });
      await api.waitAnswer('per_3');
      // 4: an edit inside the folder (the part arrives AFTER the ask: the adapter waits briefly for it)
      api.sse({ type: 'permission.asked', properties: { id: 'per_4', sessionID: 'ses_1', permission: 'edit', patterns: ['a.txt'], tool: { callID: 'c4' } } });
      await sleep(15);
      api.sse(part('c4', 'edit', { filePath: `${CWD}/a.txt`, oldString: 'a', newString: 'b' }));
      await api.waitAnswer('per_4');
      // 5: the Orchy bridge
      api.sse({ type: 'permission.asked', properties: { id: 'per_5', sessionID: 'ses_1', permission: 'jos_report_done', patterns: ['*'], tool: { callID: 'c5' } } });
      await api.waitAnswer('per_5');
      api.sse({ type: 'message.part.updated', properties: { part: { id: 'p_text', messageID: 'msg_a', sessionID: 'ses_1', type: 'text', text: 'Tidied the notes.', time: { start: 1, end: 2 } } } });
      api.sse({ type: 'message.part.updated', properties: { part: { id: 'p_step', messageID: 'msg_a', sessionID: 'ses_1', type: 'step-finish', cost: 0.01, tokens: { input: 100, output: 20, reasoning: 0 } } } });
      api.sse({ type: 'message.updated', properties: { info: { id: 'msg_a', sessionID: 'ses_1', role: 'assistant', cost: 0.02, tokens: {} } } });
      api.sse(idle);
    },
  });
  const a = Object.fromEntries(o.fake.st.answers.map(x => [x.pid, x]));
  ok(o.fake.st.answers.length === 5, 'every ask is answered exactly once (the repeated ask too)', String(o.fake.st.answers.length));
  ok(a.per_1?.body?.response === 'once' && a.per_1.sid === 'ses_1', 'a read inside the folder is answered once');
  ok(o.gated[0].tool === 'Read' && o.gated[0].input.file_path.replace(/\\/g, '/').endsWith('/notes.md'), 'the ask reaches the gate as Read with the file path', JSON.stringify(o.gated[0]));
  ok(o.gated[1].tool === 'Bash' && o.gated[1].input.command === 'git push origin main', 'the gate sees the real command from the tool part, not just the pattern', JSON.stringify(o.gated[1]));
  ok(a.per_2?.body?.response === 'reject' && o.wouldAsk.some(w => w.tool === 'Bash' && w.decision === 'ask'), 'git push is refused by the real policy (it would need the owner; no pop-up decision was made)');
  ok(a.per_3?.body?.response === 'reject' && o.records.some(r => r.kind === 'denied' && /gate|check/i.test(r.text)), 'a gate that throws is answered reject (fail closed)');
  ok(o.gated[3].tool === 'Edit' && a.per_4?.body?.response === 'once', 'an edit inside the folder is allowed (its part arrived after the ask)', JSON.stringify(o.gated[3]));
  ok(o.gated[4].tool === 'mcp__jos__report_done' && a.per_5?.body?.response === 'once', 'the Orchy bridge tools map to mcp__jos__*');
  ok(o.fake.st.requests.every(r => r.auth), 'every request carried the server password');
  ok(JSON.stringify(o.fake.st.answers).indexOf('always') < 0 && JSON.stringify(o.fake.st.requests).indexOf('remember') < 0 && JSON.stringify(o.fake.st.requests).indexOf('--auto') < 0, 'nothing sent says always, remember or --auto');
  ok(Object.keys(a.per_1.body).join() === 'response', 'the answer body is only { response }');
  const p = o.fake.st.prompts[0];
  ok(o.fake.st.prompts.length === 1 && p.parts[0].text === 'Tidy the notes' && p.system === 'You are inside Orchy' && !('model' in p), 'the prompt goes once with the system text and no model');
  ok(o.fake.st.sessionsCreated === 1 && o.started?.threadId === 'ses_1', 'a session is created and its id is the run\'s resume key');
  ok(o.done?.code === 0 && o.done.resultText === 'Tidied the notes.', 'the run ends done with the last text as its result', JSON.stringify(o.done));
  ok(o.records.filter(r => r.kind === 'text').length === 1 && o.records.filter(r => r.kind === 'text')[0].text === 'Tidied the notes.', 'only the assistant\'s text reaches the feed (not the echoed prompt)');
  const tools = o.records.filter(r => r.kind === 'tool');
  ok(tools.length === 5 || tools.length === 4, 'tool steps reach the feed once each', String(tools.length));
  ok(tools.some(t => t.tool === 'Bash' && t.input.command === 'git push origin main'), 'a bash step appears as Bash with its command');
  ok(o.usage?.totalTokens === 120 && Math.abs(o.cost - 0.02) < 1e-9, 'tokens and cost are reported', JSON.stringify([o.usage, o.cost]));
  ok(o.closed >= 1, 'the server is stopped when the run ends');
}

// ── 2. the answer endpoint fails → the run fails (not carried on unchecked) ──
{
  const o = await run({ answerStatus: 500, script: api => { api.sse(part('c1', 'read', { filePath: `${CWD}/n.md` })); api.sse({ type: 'permission.asked', properties: { id: 'per_9', sessionID: 'ses_1', permission: 'read', patterns: [`${CWD}/n.md`], tool: { callID: 'c1' } } }); } });
  ok(o.done?.code === 1 && /answer|permission/i.test(o.done.error) && o.closed >= 1, 'if Orchy can\'t answer an ask the run fails and the server is stopped', JSON.stringify(o.done));
}
// ── 3. SSE drops mid-run ──
{
  const o = await run({ script: async api => { api.sse(part('c1', 'read', { filePath: `${CWD}/n.md` })); await sleep(30); api.drop(); } });
  ok(o.done?.code === 1 && /event stream/i.test(o.done.error) && o.closed >= 1, 'a dropped event stream fails the run', JSON.stringify(o.done));
}
// ── 4. the server process dies ──
{
  const fake = await fakeServer({ script: async api => { api.sse(part('c1', 'read', { filePath: `${CWD}/n.md` })); await sleep(40); exitNow(9); } });
  let exitNow; const exited = new Promise(r => { exitNow = r; });
  let done; const finished = new Promise(r => { done = r; });
  const result = {};
  launchOpenCodeRun({ cwd: CWD, bin: 'opencode', profileEnv: {}, runDir: '/nowhere', config: buildOpenCodeConfig({}), model: 'default', prompt: 'p' }, {
    record() {}, started() {}, gate: async () => ({ allow: true }), done: d => { result.d = d; done(); },
  }, { startServer: async () => ({ baseUrl: fake.url, password: PW, pid: 1, exited, stderr: () => 'it crashed', close() { result.closed = true; } }), partWaitMs: 20, connectTimeoutMs: 3000 });
  await Promise.race([finished, sleep(5000)]);
  fake.close();
  ok(result.d?.code === 1 && /stopped \(exit 9\)/.test(result.d.error) && result.closed, 'the server dying mid-run fails the run', JSON.stringify(result.d));
}
// ── 5. startup self-check: no permission route in /doc ──
{
  const o = await run({ doc: { paths: { '/session': { post: {} } } }, script: () => {} });
  ok(o.done?.code === 1 && /permission/i.test(o.done.error) && o.fake.st.prompts.length === 0, 'no permission-response route in /doc: the run fails and the prompt is never sent', JSON.stringify(o.done));
}
// ── 6. the effective config was loosened ──
{
  const o = await run({ config: { permission: { '*': 'ask', bash: 'allow' } }, script: () => {} });
  ok(o.done?.code === 1 && /not all "ask"|permissions/i.test(o.done.error) && o.fake.st.prompts.length === 0, 'an effective config with an allow stops the run before the prompt', JSON.stringify(o.done));
}
// ── 7. OpenCode reports an error ──
{
  const o = await run({ script: api => { api.sse(part('c1', 'read', { filePath: `${CWD}/n.md` })); api.sse({ type: 'session.error', properties: { sessionID: 'ses_1', error: { name: 'ProviderAuthError', data: { message: 'No provider is logged in' } } } }); } });
  ok(o.done?.code === 1 && /No provider is logged in/.test(o.done.error), 'a session.error fails the run with OpenCode\'s message', JSON.stringify(o.done));
}
// ── 8. resume uses the stored session; a missing one starts fresh ──
{
  const o = await run({ script: api => { api.sse(part('c1', 'read', { filePath: `${CWD}/n.md` }, 'running', 'ses_old')); api.sse(idleOf('ses_old')); } }, { resumeSessionId: 'ses_old' });
  ok(o.fake.st.sessionsCreated === 0 && o.started?.threadId === 'ses_old' && o.done?.code === 0, 'a stored session id is resumed (no new session)', JSON.stringify([o.fake.st.sessionsCreated, o.started]));
  const o2 = await run({ script: api => { api.sse(part('c1', 'read', { filePath: `${CWD}/n.md` })); api.sse(idle); } }, { resumeSessionId: 'ses_gone' });
  ok(o2.fake.st.sessionsCreated === 1 && o2.started?.threadId === 'ses_1' && o2.records.some(r => r.kind === 'system'), 'a session that is gone starts a fresh one and says so');
}
// ── 9. a model is passed only when one was chosen ──
{
  const o = await run({ script: api => { api.sse(part('c1', 'read', { filePath: `${CWD}/n.md` })); api.sse(idle); } }, { model: 'anthropic/claude-sonnet-4' });
  ok(JSON.stringify(o.fake.st.prompts[0].model) === JSON.stringify({ providerID: 'anthropic', modelID: 'claude-sonnet-4' }), 'provider/model is split into providerID and modelID');
}
// ── 10. a config in the workspace can't loosen the run: the guard config is passed and every tool is ask/deny ──
{
  const cfg = buildOpenCodeConfig({});
  ok(!JSON.stringify(cfg.permission).includes('allow') && cfg.share === 'disabled', 'the generated config has no allow and switches session sharing off');
}

console.log(fail ? `\n${fail} FAILED` : '\nall OpenCode adapter checks passed');
process.exit(fail ? 1 : 0);
