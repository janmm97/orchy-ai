// A tiny FAKE ACP agent for tests (scripts/test-engine-acp.mjs): speaks ACP over stdio, runs a scripted scenario.
// Not a harness; never installed or run outside the tests. Config comes from env: FAKE_ACP = JSON { scenario, loadSession },
// FAKE_ACP_LOG = a file every message from the client and every answer to the agent's requests is appended to.
import fs from 'node:fs';

const cfg = JSON.parse(process.env.FAKE_ACP || '{}');
const LOG = process.env.FAKE_ACP_LOG;
const log = (dir, msg) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify({ dir, msg }) + '\n'); };
const send = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let nextId = 1000;
const waiting = new Map();
const ask = (method, params) => new Promise(resolve => { const id = nextId++; waiting.set(id, resolve); send({ id, method, params }); });
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });

const OPTIONS = [
  { optionId: 'ao', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'aa', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'ro', name: 'Reject', kind: 'reject_once' },
  { optionId: 'ra', name: 'Always reject', kind: 'reject_always' },
];

/** tool_call → permission request → answer recorded → completed or failed */
async function tool(sid, id, call, { options = OPTIONS, update_first = true } = {}) {
  update(sid, { sessionUpdate: 'tool_call', toolCallId: id, status: 'pending', ...call });
  const r = await ask('session/request_permission', { sessionId: sid, toolCall: { toolCallId: id }, options });
  const sel = r?.result?.outcome;
  const allowed = sel?.outcome === 'selected' && sel.optionId === 'ao';
  update(sid, { sessionUpdate: 'tool_call_update', toolCallId: id, status: allowed ? 'completed' : 'failed' });
  return sel;
}

async function prompt(sid) {
  const s = cfg.scenario || 'main';
  if (s === 'main') {
    await tool(sid, 'c1', { title: 'Read notes.md', kind: 'read', locations: [{ path: `${process.cwd()}/notes.md` }], rawInput: { path: `${process.cwd()}/notes.md` } });
    await tool(sid, 'c2', { title: 'git push origin main', kind: 'execute', rawInput: { command: 'git push origin main' } });
    await tool(sid, 'c3', { title: 'Deploy the site', kind: 'other', rawInput: { target: 'prod' } });
    await tool(sid, 'c4', { title: 'Edit a.txt', kind: 'edit', locations: [{ path: `${process.cwd()}/a.txt` }], rawInput: { path: `${process.cwd()}/a.txt` } });
    await tool(sid, 'c5', { title: 'jos report_done', kind: 'other', name: 'jos__report_done', rawInput: { summary: 'ok' } });
    await tool(sid, 'c6', { title: 'Only reject offered', kind: 'execute', rawInput: { command: 'ls' } }, { options: [{ optionId: 'ro', name: 'Reject', kind: 'reject_once' }, { optionId: 'aa', name: 'Always', kind: 'allow_always' }] });
    update(sid, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'All ' } });
    update(sid, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'done.' } });
    update(sid, { sessionUpdate: 'usage_update', used: 100, size: 1000, cost: { amount: 0.02, currency: 'USD' } });
    return 'end_turn';
  }
  if (s === 'gatethrow') {
    await tool(sid, 'c1', { title: 'Fetch', kind: 'fetch', rawInput: { url: 'boom://x' } });
    return 'end_turn';
  }
  if (s === 'noask') {
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 'x1', title: 'rm -rf build', kind: 'execute', status: 'in_progress', rawInput: { command: 'rm -rf build' } });
    await sleep(3000);
    return 'end_turn';
  }
  if (s === 'readfree') { // read/search/think need no permission
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'Read', kind: 'read', status: 'in_progress', locations: [{ path: `${process.cwd()}/x` }] });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'r1', status: 'completed' });
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'read it' } });
    return 'end_turn';
  }
  if (s === 'exit') { await sleep(30); process.exit(3); }
  if (s === 'fs') {
    const a = await ask('fs/read_text_file', { sessionId: sid, path: `${process.cwd()}/secret.txt` });
    const b = await ask('terminal/create', { sessionId: sid, command: 'ls' });
    log('fs-answers', { a, b });
    return 'end_turn';
  }
  if (s === 'malformed') {
    const r = await ask('session/request_permission', { sessionId: sid, options: OPTIONS }); // no toolCall
    log('malformed-answer', r);
    return 'end_turn';
  }
  if (s === 'hang') { await new Promise(() => {}); }
  if (s === 'ranAfterReject') {
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 'z1', title: 'git push', kind: 'execute', status: 'pending', rawInput: { command: 'git push origin main' } });
    await ask('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 'z1' }, options: OPTIONS });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'z1', status: 'in_progress' }); // runs it anyway
    await sleep(3000);
    return 'end_turn';
  }
  return 'end_turn';
}

let buf = '';
process.stdin.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});

let cancelled = false;
async function handle(m) {
  log('in', m);
  if (m.method === undefined && m.id !== undefined) { waiting.get(m.id)?.(m); waiting.delete(m.id); return; }
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: !!cfg.loadSession, promptCapabilities: {}, mcpCapabilities: {} }, agentInfo: { name: 'fake-acp', version: '0' }, authMethods: [] } });
  if (m.method === 'session/new') return send({ id: m.id, result: { sessionId: 'sess_1' } });
  if (m.method === 'session/load') return cfg.loadFails ? send({ id: m.id, error: { code: -32602, message: 'unknown session' } }) : send({ id: m.id, result: {} });
  if (m.method === 'session/cancel') { cancelled = true; return; }
  if (m.method === 'session/prompt') {
    const sid = m.params.sessionId;
    const stopP = prompt(sid);
    const stop = await Promise.race([stopP, new Promise(r => { const t = setInterval(() => { if (cancelled) { clearInterval(t); r('cancelled'); } }, 20); })]);
    return send({ id: m.id, result: { stopReason: stop } });
  }
  send({ id: m.id, error: { code: -32601, message: 'no such method' } });
}
