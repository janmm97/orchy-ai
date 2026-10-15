// Shared ACP client (Agent Client Protocol, https://agentclientprotocol.com): JSON-RPC 2.0 over stdio, one JSON
// message per line, between Orchy (the client) and a coding-agent subprocess (`hermes acp`, `dsh --profile acp`…).
// Used by the Hermes and DeepSeek adapters. Status: implemented against the protocol docs, tested only against a
// fake ACP agent (scripts/test-engine-acp.mjs); not run against a real harness (docs/HARNESSES.md).
//
// Protocol (client → agent): initialize, session/new | session/load, session/prompt (returns a stopReason),
// session/cancel (notification). Agent → client: session/update (notification: message chunks, tool_call,
// tool_call_update, plan, usage_update…) and REQUESTS, chiefly session/request_permission.
//
// Safety model, all fail-closed:
//  - Orchy gives the agent no extra powers: initialize declares NO fs and NO terminal client capability, and any
//    fs/* or terminal/* request that arrives anyway is answered "method not found".
//  - Every session/request_permission goes to the Orchy gate (hooks.gate) with the tool mapped to the names
//    policy.mjs understands. The answer is the agent's own `allow_once` or `reject_once` option, never an `*_always`
//    option; if the wanted option isn't offered, or the gate throws, times out, or the request is malformed, the
//    answer is the `cancelled` outcome (a refusal).
//  - Safety net (`strict`, the default): a tool call of a kind other than read/search/think that reaches
//    in_progress/completed without a permission request having been made for it aborts the run ("agent acted
//    without asking"). `strict: false` (only for engines the owner opted into with allowUngated) keeps the run going
//    and records the fact on the feed instead.
//  - Process exit, a broken pipe or a protocol error mid-run fails the run.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { killTree } from './shared.mjs';

export const PROTOCOL_VERSION = 1;
/** What Orchy tells the agent it can do for it: nothing. No fs reads/writes, no terminals. */
export const CLIENT_CAPABILITIES = Object.freeze({ fs: Object.freeze({ readTextFile: false, writeTextFile: false }), terminal: false });
const SAFE_KINDS = new Set(['read', 'search', 'think']);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Pure helpers ──

/** Orchy's bridge ({ command, args, env: {K: v} }) + the workspace's allowed stdio MCP servers → ACP `mcpServers`. */
export function toAcpMcp(servers, names, bridge) {
  const envList = env => Object.entries(env || {}).map(([name, value]) => ({ name, value: String(value) }));
  const out = [];
  if (bridge) out.push({ name: 'jos', command: bridge.command, args: [...(bridge.args || [])], env: envList(bridge.env) });
  for (const [name, s] of Object.entries(servers || {})) {
    if (!s.enabled || name === 'jos' || s.type !== 'stdio') continue; // remote servers aren't passed (ACP http/sse support is optional)
    if (names && !names.includes(name)) continue;
    out.push({ name, command: s.command, args: [...(s.args || [])], env: envList(s.env) });
  }
  return out;
}

/** The option to answer with: the `*_once` allow/reject. Never `*_always`. null = not offered (answer `cancelled`). */
export function pickOption(options, allow) {
  const kind = allow ? 'allow_once' : 'reject_once';
  const o = (Array.isArray(options) ? options : []).find(x => x && x.kind === kind && typeof x.optionId === 'string' && x.optionId);
  return o ? o.optionId : null;
}

const asText = v => (typeof v === 'string' ? v : Array.isArray(v) ? v.join(' ') : v == null ? '' : String(v));

/** Paths a tool call touches: locations, diff content, rawInput. */
function pathsOf(tc, cwd) {
  const raw = tc.rawInput && typeof tc.rawInput === 'object' ? tc.rawInput : {};
  const list = [
    ...(Array.isArray(tc.locations) ? tc.locations.map(l => l?.path) : []),
    ...(Array.isArray(tc.content) ? tc.content.filter(c => c?.type === 'diff').map(c => c.path) : []),
    raw.path, raw.file_path, raw.filePath, raw.filepath, raw.target_file, raw.source, raw.destination, raw.old_path, raw.new_path, raw.from, raw.to,
  ].filter(p => typeof p === 'string' && p);
  return [...new Set(list.map(p => path.resolve(cwd, p)))];
}

/** `server__tool` / `server_tool` / `mcp__server__tool` for a known MCP server → `mcp__server__tool`, else null. */
export function mcpName(name, serverNames = []) {
  const raw = String(name || '').trim();
  if (/^mcp__[^_]+.*__.+/.test(raw)) return raw;
  for (const s of [...serverNames].sort((a, b) => b.length - a.length)) {
    for (const sep of ['__', '_', '.', ':', '/']) {
      const p = `${s}${sep}`;
      if (raw.startsWith(p) && raw.length > p.length) return `mcp__${s}__${raw.slice(p.length)}`;
    }
  }
  return null;
}

/**
 * An ACP tool call → the gate's calls: [{ tool, input }]. The kind decides (read → Read, search → Grep, execute → Bash,
 * edit/delete/move → Edit with every path, fetch → WebFetch). `other`, `switch_mode`, unknown kinds and a kind that
 * contradicts its payload become an unrecognised tool, which policy.mjs always asks the owner about.
 * `tc` = the permission request's toolCall merged over what session/update already told us.
 */
export function gateCalls(tc, { cwd, serverNames = [] } = {}) {
  const kind = tc.kind || 'other';
  const raw = tc.rawInput && typeof tc.rawInput === 'object' ? tc.rawInput : {};
  const paths = pathsOf(tc, cwd);
  if (kind === 'execute') {
    const command = asText(raw.command ?? raw.cmd ?? raw.script) || asText(tc.title);
    return [{ tool: 'Bash', input: { command, cwd: asText(raw.cwd ?? raw.workdir ?? raw.working_directory) || cwd } }];
  }
  if (kind === 'edit' || kind === 'delete' || kind === 'move') {
    return (paths.length ? paths : ['']).map(file_path => ({ tool: 'Edit', input: { file_path } }));
  }
  if (kind === 'fetch') return [{ tool: 'WebFetch', input: { url: asText(raw.url ?? raw.uri) || asText(tc.title) } }];
  if (kind === 'read') return [{ tool: 'Read', input: paths.length ? { file_path: paths[0] } : {} }].concat(paths.slice(1).map(p => ({ tool: 'Read', input: { file_path: p } })));
  if (kind === 'search') return [{ tool: 'Grep', input: { ...(raw.pattern || raw.query ? { pattern: asText(raw.pattern ?? raw.query) } : {}), ...(paths.length ? { path: paths[0] } : {}) } }];
  if (kind === 'think') return [{ tool: 'TodoWrite', input: {} }];
  // other / switch_mode / anything new: an MCP tool of a server Orchy configured, else an unknown tool = ask
  const mcp = kind === 'other' && (mcpName(tc.name, serverNames) || mcpName(tc.title, serverNames));
  if (mcp) return [{ tool: mcp, input: raw }];
  return [{ tool: `acp:${asText(tc.name || tc.title || kind).slice(0, 80)}`, input: { kind, title: asText(tc.title), ...raw } }];
}

/** Names for the run feed (same vocabulary as the other adapters). */
export function feedTool(tc, ctx) {
  const c = gateCalls(tc, ctx)[0];
  const input = c.tool === 'Bash' ? { command: c.input.command } : c.tool === 'Edit' || c.tool === 'Read' ? { file_path: c.input.file_path || '' } : c.input;
  return { tool: c.tool.startsWith('acp:') ? asText(tc.title || tc.name || c.tool) : c.tool, input };
}

// ── Transport and JSON-RPC connection ──

/** Spawn the agent. Returns a transport: { write(line), pid, exited, stderr(), kill(), onData(cb) }. */
export function spawnTransport({ bin, args = [], cwd, env }) {
  if (!bin) throw new Error('No harness binary to start.');
  const shell = /\.(cmd|bat)$/i.test(bin);
  const child = spawn(shell ? `"${bin}"` : bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell, detached: process.platform !== 'win32' });
  let stderr = '';
  let dataCb = () => {};
  child.stdout.on('data', d => dataCb(d));
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
  child.stdin.on('error', () => {});
  const exited = new Promise(resolve => {
    child.on('error', e => { stderr += `\n${e.message}`; resolve(-1); });
    child.on('close', code => resolve(code ?? 1));
  });
  return {
    pid: child.pid, exited, stderr: () => stderr,
    onData: cb => { dataCb = cb; },
    write: line => { try { child.stdin.write(line); } catch {} },
    kill: () => killTree(child),
  };
}

/** Newline-delimited JSON-RPC 2.0, both directions. */
export class AcpConnection {
  constructor(transport, { onRequest, onNotification, onGarbage, defaultTimeoutMs = 60_000 } = {}) {
    this.t = transport;
    this.nextId = 1;
    this.pending = new Map(); // id → { resolve, reject, timer, method }
    this.onRequest = onRequest;
    this.onNotification = onNotification;
    this.onGarbage = onGarbage;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.closed = false;
    this.buf = '';
    transport.onData(d => this.#data(d));
  }

  #data(chunk) {
    this.buf += String(chunk);
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) this.#line(line);
    }
    if (this.buf.length > 16_000_000) { this.buf = ''; this.onGarbage?.('a message over 16 MB'); }
  }

  #line(line) {
    let m;
    try { m = JSON.parse(line); } catch { return this.onGarbage?.(line.slice(0, 120)); }
    if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') return this.onGarbage?.(line.slice(0, 120));
    const hasId = m.id !== undefined && m.id !== null;
    if (typeof m.method === 'string') {
      if (hasId) { Promise.resolve().then(() => this.onRequest?.(m.method, m.params, m.id)).catch(() => this.respondError(m.id, -32603, 'Internal error')); }
      else { try { this.onNotification?.(m.method, m.params); } catch (e) { this.onGarbage?.(`notification handler: ${e.message}`); } }
      return;
    }
    if (hasId && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(Object.assign(new Error(m.error.message || `${p.method} failed`), { code: m.error.code, data: m.error.data }));
      else p.resolve(m.result);
      return;
    }
    this.onGarbage?.(line.slice(0, 120));
  }

  #send(obj) { if (!this.closed) this.t.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n'); }

  request(method, params, { timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('The connection is closed.'));
      const id = this.nextId++;
      const ms = timeoutMs === undefined ? this.defaultTimeoutMs : timeoutMs;
      const timer = ms > 0 ? setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error(`${method} timed out after ${Math.round(ms / 1000)}s`), { code: 'TIMEOUT' })); }, ms) : null;
      this.pending.set(id, { resolve, reject, timer, method });
      this.#send({ id, method, params });
    });
  }
  notify(method, params) { this.#send({ method, params }); }
  respond(id, result) { this.#send({ id, result }); }
  respondError(id, code, message) { this.#send({ id, error: { code, message } }); }

  /** The process is gone: every waiting request fails. */
  close(reason = 'The agent process ended.') {
    if (this.closed) return;
    this.closed = true;
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(reason)); this.pending.delete(id); }
  }
}

// ── The run ──

/**
 * Run one ACP turn for an Orchy run.
 * opts: { cwd, bin, args, env, label, prompt, system, mcpServers (ACP array), resumeSessionId, strict (default true),
 *         cleanup(), requestedModel? ("default" or none keeps the harness's own pick) }
 * hooks: same as the other server adapters: record, started({threadId}), gate(tool, input), usage, cost, done.
 * io (tests): { transport, requestTimeoutMs, promptTimeoutMs, graceMs, gateTimeoutMs, cancelGraceMs }
 * Returns { stop(), pid, info() } where info() = { permissionRequests, agent, loadSession, gatedEvidence }.
 */
export function launchAcpRun(opts, hooks, io = {}) {
  const label = opts.label || 'The agent';
  const strict = opts.strict !== false;
  const cwd = path.resolve(opts.cwd);
  const serverNames = (opts.mcpServers || []).map(s => s.name);
  const graceMs = io.graceMs ?? 250;
  const gateTimeoutMs = io.gateTimeoutMs ?? 6 * 3600_000;
  let conn = null, transport = null, finished = false, sessionId = null, stopping = false;
  let agentCaps = {}, agentInfo = null, permissionRequests = 0, lastText = '';
  const tools = new Map();      // toolCallId → merged tool call
  const asked = new Set();      // toolCallIds a permission request was made for
  const denied = new Set();     // ... and answered with a refusal
  const recorded = new Set();
  const pendingPerms = new Set(); // resolvers: answer `cancelled` on stop
  const violationTimers = new Map();
  let textBuf = '', textMsg = null, promptStarted = false;

  const end = r => {
    if (finished) return;
    finished = true;
    for (const t of violationTimers.values()) clearTimeout(t);
    flushText();
    for (const cancel of [...pendingPerms]) cancel();
    conn?.close();
    try { transport?.kill(); } catch {}
    try { opts.cleanup?.(); } catch {}
    hooks.done({ resultText: lastText || '', ...r });
  };
  const fail = msg => end({ code: 1, status: 'failed', error: msg });

  function flushText() {
    const t = textBuf.trim();
    textBuf = ''; textMsg = null;
    if (!t) return;
    lastText = t;
    hooks.record({ kind: 'text', text: t });
  }

  // ── session/update → the feed ──
  function mergeTool(u) {
    const id = u.toolCallId;
    if (!id) return null;
    const prev = tools.get(id) || { toolCallId: id };
    const next = { ...prev };
    for (const k of ['title', 'name', 'kind', 'status', 'locations', 'content']) if (u[k] !== undefined && u[k] !== null) next[k] = u[k];
    if (u.rawInput !== undefined && u.rawInput !== null) next.rawInput = u.rawInput;
    if (u.rawOutput !== undefined && u.rawOutput !== null) next.rawOutput = u.rawOutput;
    tools.set(id, next);
    return next;
  }

  function checkAsked(tc) {
    if (!tc) return;
    if (tc.status !== 'in_progress' && tc.status !== 'completed') return;
    if (denied.has(tc.toolCallId)) {
      hooks.record({ kind: 'denied', text: `${label} ran "${String(tc.title || tc.kind || 'a tool').slice(0, 120)}" after Orchy refused it.` });
      if (strict) return fail(`${label} ran a tool Orchy had refused. Orchy stopped the run.`);
      return;
    }
    if (SAFE_KINDS.has(tc.kind || 'other')) return;
    if (asked.has(tc.toolCallId) || violationTimers.has(tc.toolCallId)) return;
    // a permission request can be in flight right behind the status change
    violationTimers.set(tc.toolCallId, setTimeout(() => {
      violationTimers.delete(tc.toolCallId);
      if (finished || asked.has(tc.toolCallId)) return;
      const what = String(tc.title || tc.kind || 'a tool').slice(0, 120);
      if (strict) {
        hooks.record({ kind: 'denied', text: `${label} ran "${what}" without asking Orchy first.` });
        fail(`${label} acted without asking (${what}). Orchy stopped the run because it can't hold this agent behind its approvals.`);
      } else if (!tc.warned) {
        tc.warned = true;
        hooks.record({ kind: 'system', text: `${label} ran "${what}" without asking Orchy. This workspace is allowed to run it without approvals (allowUngated).` });
      }
    }, graceMs));
  }

  function maybeRecord(tc) {
    if (!tc || recorded.has(tc.toolCallId)) return;
    if (tc.status === 'pending' && tc.rawInput === undefined && !tc.locations) return; // wait for the detail
    recorded.add(tc.toolCallId);
    flushText();
    const f = feedTool(tc, { cwd, serverNames });
    hooks.record({ kind: 'tool', tool: f.tool, input: f.input });
  }

  function onUpdate(params) {
    if (finished || !params || (params.sessionId && sessionId && params.sessionId !== sessionId)) return;
    const u = params.update;
    if (!u || typeof u !== 'object') return;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        if (!promptStarted) return; // history replayed by session/load is not this run's work
        const c = u.content;
        if (c?.type !== 'text' || typeof c.text !== 'string') return;
        if (textMsg && u.messageId && u.messageId !== textMsg) flushText();
        textMsg = u.messageId || textMsg || '_';
        textBuf += c.text;
        return;
      }
      case 'tool_call': case 'tool_call_update': {
        if (!promptStarted) return;
        const tc = mergeTool(u);
        if (!tc) return;
        maybeRecord(tc);
        if (u.status === 'failed') {
          const out = asText(tc.rawOutput?.error ?? tc.rawOutput?.message ?? '') || (Array.isArray(tc.content) ? tc.content.map(c => c?.content?.text).filter(Boolean).join(' ') : '');
          hooks.record({ kind: 'tool_error', text: (out || 'The tool failed').slice(0, 600) });
        }
        checkAsked(tc);
        return;
      }
      case 'plan': {
        if (!promptStarted || !Array.isArray(u.entries)) return;
        hooks.record({ kind: 'system', text: `Plan: ${u.entries.map(e => `${e.status === 'completed' ? '[x]' : '[ ]'} ${asText(e.content)}`).join(' · ')}`.slice(0, 800) });
        return;
      }
      case 'usage_update': {
        if (u.cost && typeof u.cost.amount === 'number' && /^usd$/i.test(u.cost.currency || 'usd')) hooks.cost?.(u.cost.amount);
        return;
      }
      default: return; // thoughts, modes, commands, config: nothing to show
    }
  }

  // ── session/request_permission → the gate ──
  async function onPermission(params, id) {
    const cancelled = () => conn.respond(id, { outcome: { outcome: 'cancelled' } });
    if (!params || typeof params !== 'object' || !params.toolCall || typeof params.toolCall !== 'object' || !Array.isArray(params.options)) return cancelled();
    if (params.sessionId && sessionId && params.sessionId !== sessionId) return cancelled();
    permissionRequests++;
    const tid = params.toolCall.toolCallId;
    if (tid) asked.add(tid);
    if (permissionRequests === 1) hooks.record({ kind: 'system', text: `${label} asks through ACP before it acts; every request goes to Orchy's approvals.` });
    let allow = false;
    let stopped = false;
    const cancelNow = () => { stopped = true; cancelled(); pendingPerms.delete(cancelNow); };
    pendingPerms.add(cancelNow);
    try {
      const tc = tid ? mergeTool(params.toolCall) : params.toolCall;
      const calls = gateCalls(tc || params.toolCall, { cwd, serverNames });
      allow = true;
      for (const c of calls) {
        const verdict = await Promise.race([
          hooks.gate(c.tool, c.input),
          sleep(gateTimeoutMs).then(() => { throw new Error('the approval timed out'); }),
        ]);
        if (!verdict?.allow) { allow = false; break; }
      }
    } catch (e) {
      allow = false; // fail closed
      hooks.record({ kind: 'denied', text: `Orchy couldn't check a request from ${label} (${String(e.message || e).slice(0, 120)}), so it was refused.` });
    }
    pendingPerms.delete(cancelNow);
    if (stopped || finished) return;
    const optionId = pickOption(params.options, allow);
    if (tid && !(allow && optionId)) denied.add(tid);
    if (optionId) conn.respond(id, { outcome: { outcome: 'selected', optionId } });
    else cancelled(); // the wanted `*_once` option isn't offered: never fall back to an `*_always` one
  }

  function onRequest(method, params, id) {
    if (finished) return conn.respondError(id, -32603, 'The run is over.');
    if (method === 'session/request_permission') return onPermission(params, id);
    // fs/* and terminal/* were declined at initialize; anything else is unknown. Either way: no.
    return conn.respondError(id, -32601, `Method not found: ${method} (Orchy offers no client capabilities)`);
  }

  let garbage = 0;
  const onGarbage = what => {
    garbage++;
    if (garbage === 1) hooks.record({ kind: 'system', text: `${label} sent something that isn't ACP (${String(what).slice(0, 80)}); ignoring it.` });
    if (garbage > 50) fail(`${label} is not speaking ACP (too many unreadable lines).`);
  };

  (async () => {
    transport = (io.transport ? await io.transport(opts) : spawnTransport({ bin: opts.bin, args: opts.args, cwd: opts.cwd, env: opts.env }));
    transport.exited.then(code => {
      if (finished) return;
      conn?.close();
      fail(`${label} stopped (exit ${code}). ${String(transport.stderr?.() || '').trim().split('\n').slice(-4).join(' ')}`.trim());
    });
    conn = new AcpConnection(transport, { onRequest, onNotification: (m, p) => { if (m === 'session/update') onUpdate(p); }, onGarbage, defaultTimeoutMs: io.requestTimeoutMs ?? 60_000 });

    const init = await conn.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'orchy', title: 'Orchy', version: '0.1.0' },
    });
    if (!init || typeof init !== 'object' || typeof init.protocolVersion !== 'number') throw new Error(`${label} answered initialize with something that isn't ACP.`);
    if (init.protocolVersion !== PROTOCOL_VERSION) throw new Error(`${label} speaks ACP version ${init.protocolVersion}; Orchy speaks ${PROTOCOL_VERSION}.`);
    agentCaps = init.agentCapabilities && typeof init.agentCapabilities === 'object' ? init.agentCapabilities : {};
    agentInfo = init.agentInfo || null;

    const base = { cwd, mcpServers: opts.mcpServers || [] };
    let session = null; // what session/new or session/load answered (its model options)
    if (opts.resumeSessionId && agentCaps.loadSession === true) {
      try {
        session = await conn.request('session/load', { sessionId: opts.resumeSessionId, ...base }, { timeoutMs: io.requestTimeoutMs ?? 120_000 });
        sessionId = opts.resumeSessionId;
      } catch (e) {
        hooks.record({ kind: 'system', text: `${label} couldn't load the earlier conversation (${String(e.message).slice(0, 100)}), so this starts a fresh one.` });
      }
    } else if (opts.resumeSessionId) {
      hooks.record({ kind: 'system', text: `${label} can't resume an earlier conversation over ACP, so this starts a fresh one.` });
    }
    if (!sessionId) {
      const r = await conn.request('session/new', base);
      if (!r?.sessionId || typeof r.sessionId !== 'string') throw new Error(`${label} didn't return a session id.`);
      sessionId = r.sessionId;
      session = r;
    }
    // the agent's model, when it names one: a model config option if the harness offers one, else session/set_model
    if (opts.requestedModel && opts.requestedModel !== 'default') {
      const option = session?.configOptions?.find?.(o => o.category === 'model');
      try {
        if (option) await conn.request('session/set_config_option', { sessionId, configId: option.id, value: opts.requestedModel });
        else await conn.request('session/set_model', { sessionId, modelId: opts.requestedModel });
      } catch (e) {
        hooks.record({ kind: 'system', text: `${label} couldn't switch to ${opts.requestedModel} (${String(e.message).slice(0, 100)}), so it uses the model it's set to.` });
      }
    }
    hooks.started({ threadId: sessionId });

    // ACP has no system-prompt field: Orchy's instructions lead the prompt
    const text = opts.system ? `${opts.system}\n\n---\n\n${opts.prompt}` : opts.prompt;
    promptStarted = true;
    const res = await conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, { timeoutMs: io.promptTimeoutMs ?? 0 });
    if (finished) return;
    flushText();
    const u = res?.usage;
    if (u && typeof u === 'object') hooks.usage?.({ inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0, reasoningOutputTokens: u.thoughtTokens || 0, totalTokens: u.totalTokens || (u.inputTokens || 0) + (u.outputTokens || 0) });
    const stop = res?.stopReason;
    if (stop === 'end_turn') return end({ code: 0, status: 'completed', error: null });
    if (stop === 'cancelled') return end({ code: 1, status: 'interrupted', error: null });
    if (stop === 'refusal') return fail(`${label} refused to continue.`);
    if (stop === 'max_tokens' || stop === 'max_turn_requests') return fail(`${label} stopped early (${stop}). Send a follow-up to continue.`);
    return fail(`${label} ended the turn with an unknown stop reason (${String(stop).slice(0, 40)}).`);
  })().catch(e => {
    if (finished) return;
    const auth = e?.code === -32000 || /auth/i.test(String(e?.message || '')) && /required|sign|login/i.test(String(e?.message || ''));
    fail(auth ? `${label} isn't signed in (${String(e.message).slice(0, 120)}). Sign in with its own login command, then try again.` : String(e?.message || e));
  });

  return {
    get pid() { return transport?.pid ?? null; },
    info: () => ({ permissionRequests, agent: agentInfo, loadSession: agentCaps.loadSession === true, gatedEvidence: permissionRequests > 0 }),
    async stop() {
      if (finished || stopping) return;
      stopping = true;
      try { if (sessionId) conn?.notify('session/cancel', { sessionId }); } catch {}
      for (const cancel of [...pendingPerms]) cancel(); // the spec: answer every pending permission request `cancelled`
      setTimeout(() => end({ code: 1, status: 'interrupted', error: null }), io.cancelGraceMs ?? 3000);
    },
  };
}
