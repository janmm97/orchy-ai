// OpenCode run adapter. Per run: `opencode serve` on a free 127.0.0.1 port (random server password, per-run config
// file, per-workspace profile), the /event SSE stream, one session, the prompt sent with prompt_async. Every permission
// ask OpenCode raises goes to Orchy's gate (hooks.gate) and is answered through the permission endpoint:
// `once` when the gate allows, `reject` when it denies or anything goes wrong. Never `always`, never `--auto`.
//
// Fails closed: if the permission-response route isn't in /doc, if the effective config shows an "allow", if the
// server dies or the event stream drops mid-run, the run fails instead of continuing ungated.
//
// Checked against opencode.ai/docs (server, plugins, permissions, config, mcp-servers): the routes /event, /doc, /config,
// POST /session, /session/:id/prompt_async, /session/:id/abort and /session/:id/permissions/:permissionID (body {response})
// are documented, and the plugin docs list permission.asked / permission.replied, message.part.updated, session.idle,
// session.status and session.error. permission.updated is an older name Orchy still accepts. The fields inside an event
// (id/sessionID/permission|type/patterns|pattern/metadata/callID) and the `system` prompt field are NOT in the docs pages
// and are read defensively. None of it has run against a real binary yet (docs/HARNESSES.md).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { killTree } from './shared.mjs';
import { briefFor } from '../activity.mjs';
import { mapTool, permissionLooksSafe, modelParts, serverNamesOf, guardConfig } from './opencode-config.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PERMISSION_EVENTS = new Set(['permission.asked', 'permission.updated', 'permission.request', 'permission.requested']);

/** The arguments `opencode serve` gets. Fixed: no --auto (it would approve every ask), nothing secret on the command line. */
export function serveArgs(port) {
  return ['serve', '--port', String(port), '--hostname', '127.0.0.1'];
}

/** The body of prompt_async: the prompt, the system text, and a model only when one was picked ("default" omits it). */
export function buildPromptBody({ prompt, system, model }) {
  const m = modelParts(model);
  return { parts: [{ type: 'text', text: prompt }], ...(system ? { system } : {}), ...(m ? { model: m } : {}) };
}

/** Find the POST route that answers a permission ask in OpenCode's OpenAPI doc. null = this build can't be gated. */
export function findPermissionRoute(doc) {
  const paths = doc && typeof doc === 'object' ? doc.paths || {} : {};
  let found = null;
  for (const [p, ops] of Object.entries(paths)) {
    if (!/permission/i.test(p) || !ops?.post) continue;
    const params = (p.match(/\{[^}]+\}/g) || []).length;
    const style = /\/reply\/?$/.test(p) ? 'reply' : /\/session\//.test(p) && params >= 2 ? 'session' : null;
    if (!style) continue;
    // prefer the session-scoped route the docs name
    if (!found || style === 'session') found = { path: p, style };
  }
  return found;
}

const routeUrl = (route, sessionId, permissionId) => {
  const vals = route.style === 'session' ? [sessionId, permissionId] : [permissionId];
  let i = 0;
  return route.path.replace(/\{[^}]+\}/g, () => encodeURIComponent(vals[i++] ?? ''));
};
const routeBody = (route, response) => (route.style === 'reply' ? { reply: response } : { response });

/** Strip trailing glob parts from an ask pattern: `/a/b/*` → `/a/b`. */
const patternPath = pat => String(pat || '').replace(/[\\/]?\*+$/, '') || String(pat || '');

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// credentials come from the workspace's profile only: drop the PC's own provider keys so two workspaces never share one
const SECRETISH = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD|_ACCESS_KEY_ID|_SECRET_ACCESS_KEY)$/i;
export function openCodeEnv(profileEnv, extra = {}, base = process.env) {
  const e = { ...base };
  for (const k of Object.keys(e)) {
    if (k.startsWith('OPENCODE_') || SECRETISH.test(k) || k === 'GOOGLE_APPLICATION_CREDENTIALS' || k === 'AWS_PROFILE' || k === 'CLAUDECODE') delete e[k];
  }
  return { ...e, ...profileEnv, OPENCODE_DISABLE_AUTOUPDATE: '1', ...extra };
}

/** Start `opencode serve` for one run. Returns { baseUrl, password, pid, exited, stderr(), close() }. */
export async function startOpenCodeServer(opts) {
  const bin = opts.bin;
  if (!bin) throw new Error('OpenCode isn\'t installed on this PC (no opencode binary found). Install it, or set OPENCODE_CLI_PATH in .env.');
  const port = await freePort();
  const password = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(opts.runDir, { recursive: true });
  const configFile = path.join(opts.runDir, 'opencode.json');
  fs.writeFileSync(configFile, JSON.stringify(opts.config, null, 2), { mode: 0o600 });
  const env = openCodeEnv(opts.profileEnv, {
    OPENCODE_CONFIG: configFile,
    // wins over any opencode.json in the workspace folder: nothing there can switch an ask to an allow
    OPENCODE_CONFIG_CONTENT: JSON.stringify(guardConfig()),
    OPENCODE_SERVER_PASSWORD: password,
  });
  const shell = /\.(cmd|bat)$/i.test(bin);
  const args = serveArgs(port);
  const child = spawn(shell ? `"${bin}"` : bin, args, {
    cwd: opts.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell, detached: process.platform !== 'win32',
  });
  let stderr = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
  const exited = new Promise(resolve => {
    child.on('error', e => { stderr += `\n${e.message}`; resolve(-1); });
    child.on('close', code => resolve(code ?? 1));
  });
  return { baseUrl: `http://127.0.0.1:${port}`, password, pid: child.pid, exited, stderr: () => stderr, close: () => killTree(child) };
}

/**
 * Run one OpenCode turn for an Orchy run.
 * opts: { cwd, bin, profileEnv, runDir, config (generated opencode.json), model, prompt, system, resumeSessionId, title, cleanup() }
 * hooks: the same as codex.mjs (record, started({threadId}), gate(tool, input), usage, cost, done) – ask is unused:
 *   OpenCode's question tool is denied in the config; the agent asks through jos_ask_user.
 * io (tests): { startServer(opts), partWaitMs, connectTimeoutMs }
 * Returns { stop(), pid }.
 */
export function launchOpenCodeRun(opts, hooks, io = {}) {
  let finished = false, server = null, api = null, route = null, sessionId = null;
  let lastText = '', finalText = '', promptSent = false, sawActivity = false;
  const abort = new AbortController();
  const serverNames = serverNamesOf(opts.config);
  const roles = new Map();       // messageID → role
  const parts = new Map();       // callID|partID → { tool, input }
  const recorded = new Set();    // tool parts already on the feed
  const texted = new Set();      // text parts already on the feed
  const handled = new Set();     // permission ids already answered
  const pendingText = new Map(); // text parts still streaming
  const msgCost = new Map(), stepCost = new Map(), stepTokens = new Map();
  let assistantError = null;
  let connectedResolve; const connected = new Promise(r => { connectedResolve = r; });

  const end = r => {
    if (finished) return;
    finished = true;
    abort.abort();
    try { server?.close(); } catch {}
    try { opts.cleanup?.(); } catch {}
    hooks.done({ resultText: finalText || lastText || '', ...r });
  };
  const fail = msg => end({ code: 1, status: 'failed', error: msg });

  const request = async (method, p, body, { timeoutMs = 30_000 } = {}) => {
    const res = await fetch(server.baseUrl + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(server.password ? { Authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString('base64')}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any ? AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]) : abort.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { ok: res.ok, status: res.status, json, text };
  };

  const flushText = id => {
    const t = pendingText.get(id);
    pendingText.delete(id);
    if (!t || texted.has(id)) return;
    texted.add(id);
    lastText = t;
    hooks.record({ kind: 'text', text: t });
  };
  const usage = () => {
    const toks = [...stepTokens.values()];
    const sum = f => toks.reduce((a, t) => a + (Number(f(t)) || 0), 0);
    const input = sum(t => t.input), output = sum(t => t.output), reasoning = sum(t => t.reasoning);
    hooks.usage?.({ inputTokens: input, outputTokens: output, reasoningOutputTokens: reasoning, totalTokens: input + output + reasoning });
    const cost = msgCost.size ? [...msgCost.values()].reduce((a, b) => a + b, 0) : [...stepCost.values()].reduce((a, b) => a + b, 0);
    if (cost) hooks.cost?.(cost);
  };

  // ── what a permission ask is really about → policy.mjs's tool names and inputs ──
  async function toolPart(p) {
    const id = p.callID || p.tool?.callID || p.toolCallID;
    if (!id) return null;
    const deadline = Date.now() + (io.partWaitMs ?? 400);
    for (;;) {
      if (parts.has(id)) return parts.get(id);
      if (Date.now() >= deadline || finished) return null;
      await sleep(25);
    }
  }
  async function callsFor(p) {
    const name = p.permission || p.type || p.tool?.name || p.title || '';
    const tool = mapTool(name, serverNames);
    const pats = [].concat(p.patterns ?? p.pattern ?? []).filter(x => typeof x === 'string');
    const meta = p.metadata && typeof p.metadata === 'object' ? p.metadata : {};
    const part = await toolPart(p);
    const inp = part?.input && typeof part.input === 'object' ? part.input : {};
    const abs = x => (x ? path.resolve(opts.cwd, String(x)) : '');
    if (tool === 'Bash') return [{ tool, input: { command: String(inp.command || meta.command || pats.join(' && ') || ''), cwd: inp.workdir || meta.cwd || opts.cwd } }];
    if (tool === 'Edit' || tool === 'Write') {
      const files = [inp.filePath, inp.file_path, meta.filepath, meta.filePath, meta.path, ...pats].filter(Boolean);
      const uniq = [...new Set(files.map(abs))];
      return (uniq.length ? uniq : ['']).map(file_path => ({ tool, input: { file_path } }));
    }
    if (tool === 'Read' || tool === 'Glob' || tool === 'Grep' || tool === 'LS') {
      const base = p.permission === 'external_directory' ? patternPath(pats[0]) : (inp.filePath || inp.file_path || inp.path || meta.filepath || meta.path || patternPath(pats[0]));
      const input = { ...(inp.pattern ? { pattern: inp.pattern } : {}), ...(base ? { file_path: abs(base), path: tool === 'Read' ? undefined : abs(base) } : {}) };
      return [{ tool, input }];
    }
    if (tool === 'WebFetch') return [{ tool, input: { url: String(inp.url || meta.url || pats[0] || '') } }];
    if (tool === 'WebSearch') return [{ tool, input: { query: String(inp.query || meta.query || pats[0] || '') } }];
    return [{ tool, input: Object.keys(inp).length ? inp : { ...meta, ...(pats.length ? { patterns: pats } : {}) } }];
  }

  async function respond(sid, pid, response) {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await request('POST', routeUrl(route, sid, pid), routeBody(route, response), { timeoutMs: 15_000 });
        if (r.ok || r.status === 204) return;
        throw new Error(`HTTP ${r.status}`);
      } catch (e) {
        if (finished) return;
        if (attempt >= 1) throw e;
        await sleep(300);
      }
    }
  }

  async function onPermission(p) {
    const pid = p.id || p.permissionID || p.requestID;
    if (!pid) { fail('OpenCode asked for permission without saying which ask it was, so Orchy stopped the run instead of guessing.'); return; }
    if (handled.has(pid)) return;
    handled.add(pid);
    const sid = p.sessionID || sessionId;
    let allow = false;
    try {
      const calls = await callsFor(p);
      allow = true;
      for (const c of calls) {
        const v = await hooks.gate(c.tool, c.input);
        if (!v?.allow) { allow = false; break; }
      }
    } catch (e) {
      allow = false; // fail closed
      hooks.record({ kind: 'denied', text: `Orchy couldn't check an OpenCode request (${String(e.message || e).slice(0, 120)}), so it was refused.` });
    }
    if (finished) return;
    try { await respond(sid, pid, allow ? 'once' : 'reject'); }
    catch (e) { fail(`Orchy couldn't answer OpenCode's permission request (${String(e.message || e).slice(0, 120)}), so it stopped the run rather than leave it unchecked.`); }
  }

  // ── events → the run's feed ──
  const feedTool = (part, state) => {
    const key = part.callID || part.id;
    const name = mapTool(part.tool, serverNames);
    const input = state?.input && typeof state.input === 'object' ? state.input : {};
    const prev = parts.get(key);
    parts.set(key, { tool: name, input: Object.keys(input).length ? input : prev?.input || {} });
    const status = state?.status;
    if (!recorded.has(key) && (status === 'running' || status === 'completed' || Object.keys(input).length)) {
      recorded.add(key);
      sawActivity = true;
      const shown = name === 'Bash' ? { command: input.command || '' }
        : name === 'Edit' || name === 'Write' || name === 'Read' ? { file_path: input.filePath || input.file_path || '' }
          : input;
      hooks.record({ kind: 'tool', tool: name, toolUseId: key, input: shown });
    }
    if (status === 'error' && !texted.has(`err:${key}`)) {
      texted.add(`err:${key}`);
      hooks.record({ kind: 'tool_error', toolUseId: key, tool: name, text: String(state.error || 'The tool failed').slice(0, 600) });
    }
    // a finished tool: a safe brief only (counts), never its output
    if (status === 'completed' && recorded.has(key) && !texted.has(`done:${key}`)) {
      texted.add(`done:${key}`);
      hooks.record({ kind: 'tool_done', toolUseId: key, tool: name, ok: true, brief: briefFor(name, state.output) });
    }
  };

  function onEvent(raw) {
    const e = raw?.payload && raw.payload.type ? raw.payload : raw;
    const type = e?.type;
    const p = e?.properties || e?.data || {};
    if (!type) return;
    if (type === 'server.connected') { connectedResolve(); return; }
    if (PERMISSION_EVENTS.has(type)) { onPermission(p).catch(err => fail(`Permission handling broke: ${err.message}`)); return; }
    const sid = p.sessionID || p.info?.sessionID || p.part?.sessionID;
    if (sid && sessionId && sid !== sessionId) return;
    if (type === 'message.updated') {
      const info = p.info || {};
      if (info.id) roles.set(info.id, info.role);
      if (info.role === 'assistant') {
        sawActivity = true;
        if (typeof info.cost === 'number') msgCost.set(info.id, info.cost);
        if (info.error) assistantError = info.error.data?.message || info.error.message || info.error.name || 'The model returned an error';
        usage();
      }
      return;
    }
    if (type === 'message.part.updated') {
      const part = p.part || {};
      if (part.type === 'tool') return feedTool(part, part.state || {});
      if (part.type === 'text') {
        if (part.synthetic || roles.get(part.messageID) === 'user' || String(part.text || '').trim() === String(opts.prompt || '').trim()) return;
        sawActivity = true;
        if (part.text?.trim()) pendingText.set(part.id, part.text.trim());
        if (part.time?.end) flushText(part.id); // a streaming part is on the feed once it's finished
        return;
      }
      if (part.type === 'step-finish') {
        if (typeof part.cost === 'number') stepCost.set(part.id, part.cost);
        if (part.tokens) stepTokens.set(part.id, { input: part.tokens.input, output: part.tokens.output, reasoning: part.tokens.reasoning });
        usage();
      }
      return;
    }
    if (type === 'session.error') {
      const msg = p.error?.data?.message || p.error?.message || p.error?.name || 'OpenCode reported an error';
      if (/abort/i.test(p.error?.name || '')) return end({ code: 1, status: 'interrupted', error: null });
      hooks.record({ kind: 'error', text: String(msg).slice(0, 600) });
      return fail(String(msg).slice(0, 1500));
    }
    const idle = type === 'session.idle' || (type === 'session.status' && p.status?.type === 'idle');
    if (idle && promptSent && sawActivity) {
      for (const id of [...pendingText.keys()]) flushText(id);
      finalText = lastText;
      if (assistantError) return fail(String(assistantError).slice(0, 1500));
      return end({ code: 0, status: 'completed', error: null });
    }
  }

  async function readEvents(res) {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let m;
        while ((m = /\r?\n\r?\n/.exec(buf))) {
          const block = buf.slice(0, m.index);
          buf = buf.slice(m.index + m[0].length);
          const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
          if (!data) continue;
          let ev;
          try { ev = JSON.parse(data); } catch { continue; }
          try { onEvent(ev); } catch (err) { fail(`Couldn't read an OpenCode event: ${err.message}`); return; }
        }
      }
    } catch (err) {
      if (finished) return;
      return fail(`OpenCode's event stream broke (${String(err.message || err).slice(0, 120)}). Orchy stopped the run rather than carry on without its approvals.`);
    }
    if (!finished) fail('OpenCode\'s event stream closed in the middle of the run. Orchy stopped it rather than carry on without its approvals.');
  }

  async function openEvents() {
    const deadline = Date.now() + (io.connectTimeoutMs ?? 45_000);
    let last;
    while (Date.now() < deadline && !finished) {
      try {
        const res = await fetch(server.baseUrl + '/event', {
          headers: { Accept: 'text/event-stream', ...(server.password ? { Authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString('base64')}` } : {}) },
          signal: abort.signal,
        });
        if (res.ok && res.body) return res;
        last = new Error(`HTTP ${res.status}`);
      } catch (e) { last = e; }
      await sleep(250);
    }
    throw new Error(`OpenCode's server didn't come up (${last?.message || 'no answer'}). ${String(server.stderr?.() || '').trim().split('\n').slice(-3).join(' ')}`.trim());
  }

  (async () => {
    server = await (io.startServer || startOpenCodeServer)(opts);
    server.exited?.then(code => {
      if (!finished) fail(`OpenCode stopped (exit ${code}). ${String(server.stderr?.() || '').trim().split('\n').slice(-4).join(' ')}`.trim());
    });
    const res = await openEvents();
    readEvents(res);
    await Promise.race([connected, sleep(15_000).then(() => { throw new Error('OpenCode\'s event stream never said hello (no server.connected event).'); })]);

    // the session: resume the stored one, or start a new one
    if (opts.resumeSessionId) {
      const r = await request('GET', `/session/${encodeURIComponent(opts.resumeSessionId)}`);
      if (r.ok && r.json?.id) sessionId = r.json.id;
      else hooks.record({ kind: 'system', text: 'The earlier OpenCode conversation isn\'t available under this workspace\'s profile, so this starts a fresh one.' });
    }
    if (!sessionId) {
      const r = await request('POST', '/session', { title: opts.title || 'Orchy run' });
      if (!r.ok || !r.json?.id) throw new Error(`Couldn't create an OpenCode session (HTTP ${r.status}).`);
      sessionId = r.json.id;
    }

    // startup self-check, fails closed: Orchy can only gate OpenCode if this build can take permission answers
    const doc = await request('GET', '/doc');
    route = doc.ok ? findPermissionRoute(doc.json) : null;
    // the docs say /doc is served as an HTML page: when it isn't JSON there is nothing to read, so use the route the server docs name
    if (!route && doc.ok && doc.json === null) {
      route = { path: '/session/{sessionID}/permissions/{permissionID}', style: 'session' };
      hooks.record({ kind: 'system', text: "OpenCode's /doc isn't JSON here, so Orchy uses the permission route from its server docs." });
    }
    if (!route) throw new Error('This OpenCode build doesn\'t list a route for answering permission requests (/doc), so Orchy can\'t put its approvals in front of it. Not running it.');
    const cfg = await request('GET', '/config').catch(() => null);
    if (cfg?.ok && cfg.json && typeof cfg.json === 'object') {
      if (!permissionLooksSafe(cfg.json.permission)) throw new Error('OpenCode\'s effective permissions are not all "ask" (a config in the workspace or profile loosened them), so Orchy is not running it.');
    } else {
      hooks.record({ kind: 'system', text: 'OpenCode would not show its effective config, so Orchy could not double-check its permissions; every ask still goes through the gate.' });
    }

    hooks.started({ threadId: sessionId });
    promptSent = true;
    const body = buildPromptBody({ prompt: opts.prompt, system: opts.system, model: opts.model });
    const r = await request('POST', `/session/${encodeURIComponent(sessionId)}/prompt_async`, body);
    if (!r.ok && r.status !== 204) throw new Error(`OpenCode refused the prompt (HTTP ${r.status}) ${String(r.text || '').slice(0, 200)}`.trim());
  })().catch(e => { if (!finished) fail(String(e.message || e)); });

  return {
    get pid() { return server?.pid ?? null; },
    async stop() {
      if (finished) return;
      if (sessionId && server) { try { await request('POST', `/session/${encodeURIComponent(sessionId)}/abort`, {}, { timeoutMs: 3000 }); } catch {} }
      setTimeout(() => end({ code: 1, status: 'interrupted', error: null }), 1500);
    },
  };
}
