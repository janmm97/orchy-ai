// Codex (OpenAI) as an agent runtime. Orchy drives `codex app-server` over JSON-RPC, the protocol
// the VS Code extension uses. Codex keeps its own sandbox and asks before anything it can't do
// safely (every command, file edit and MCP tool call under the "untrusted" policy); Orchy answers
// each ask with its approval policy and, for outward actions, the owner's Approve/Deny pop-up.
// Accounts: the default profile is ~/.codex; a workspace can pin its own CODEX_HOME.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { env, expandPath } from './env.mjs';
import { findBinary } from './claude.mjs';

const verOf = d => (d.match(/-(\d+(?:\.\d+)*)/)?.[1] || '0').split('.').map(Number);
const newer = (a, b) => { const x = verOf(a), y = verOf(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0); return 0; };

function resolveCodex() {
  const explicit = env('CODEX_CLI_PATH');
  if (explicit && fs.existsSync(explicit)) return explicit;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const npm = process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'codex.cmd');
  if (npm && fs.existsSync(npm)) return npm;
  const onPath = findBinary('codex'); // PATH, Homebrew, ~/.local/bin, ~/.npm-global/bin
  if (onPath) return onPath;
  // the ChatGPT/Codex VS Code extension ships its own copy: take the newest
  const extDir = path.join(home, '.vscode', 'extensions');
  try {
    for (const d of fs.readdirSync(extDir).filter(d => /^openai\.chatgpt-/.test(d)).sort(newer)) {
      const bin = path.join(extDir, d, 'bin');
      for (const plat of fs.existsSync(bin) ? fs.readdirSync(bin) : []) {
        const p = path.join(bin, plat, exe);
        if (fs.existsSync(p)) return p;
      }
    }
  } catch {}
  return null;
}
let bin = null;
/** The codex binary, re-found when an extension update moves it. null = not installed. */
export function codexBin() {
  if (!bin || !fs.existsSync(bin)) bin = resolveCodex();
  return bin;
}

/** A clean env for Codex: pin the profile, drop keys that would switch it off ChatGPT login. */
function codexEnv(codexHome) {
  const e = { ...process.env };
  for (const k of ['CODEX_HOME', 'CODEX_API_KEY', 'OPENAI_API_KEY', 'CLAUDECODE']) delete e[k];
  if (codexHome) e.CODEX_HOME = expandPath(codexHome);
  return e;
}

/** Minimal JSON-RPC client for `codex app-server` (stdio, one JSON message per line). */
class AppServer {
  constructor({ codexHome, cwd }) {
    const b = codexBin();
    if (!b) throw new Error('Codex isn\'t installed on this PC (no codex CLI or ChatGPT VS Code extension found). Install it, or set CODEX_CLI_PATH in .env.');
    if (codexHome) fs.mkdirSync(expandPath(codexHome), { recursive: true });
    this.child = spawn(b, ['app-server'], { cwd: cwd || os.homedir(), env: codexEnv(codexHome), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: b.endsWith('.cmd') });
    this.n = 0;
    this.pending = new Map();
    this.stderr = '';
    this.onNotify = () => {};
    this.onRequest = async () => { throw Object.assign(new Error('not handled'), { code: -32601 }); };
    let buf = '';
    this.child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.handle(line);
      }
    });
    this.child.stderr.on('data', d => { this.stderr = (this.stderr + d).slice(-4000); });
    this.exited = new Promise(resolve => {
      this.child.on('error', e => { this.stderr += `\n${e.message}`; resolve(-1); });
      this.child.on('close', code => {
        for (const p of this.pending.values()) p.reject(new Error(`Codex stopped (exit ${code}). ${this.stderr.trim().split('\n').slice(-3).join(' ')}`.trim()));
        this.pending.clear();
        resolve(code);
      });
    });
  }

  handle(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && m.method) { // a request from Codex (approvals, questions)
      Promise.resolve().then(() => this.onRequest(m.method, m.params || {}))
        .then(result => this.write({ id: m.id, result }))
        .catch(e => this.write({ id: m.id, error: { code: e.code || -32603, message: e.message } }));
      return;
    }
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error.message || 'Codex error'));
      else p.resolve(m.result);
      return;
    }
    if (m.method) this.onNotify(m.method, m.params || {});
  }

  write(msg) { try { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'); } catch {} }

  request(method, params, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const id = ++this.n;
      const timer = timeoutMs ? setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex didn't answer ${method} within ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  async init() {
    await this.request('initialize', { clientInfo: { name: 'jos', title: 'Orchy', version: '0.1.0' }, capabilities: { experimentalApi: false, requestAttestation: false } }, 30_000);
    this.write({ method: 'initialized' });
  }

  close() {
    if (this.child.exitCode !== null) return;
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { windowsHide: true });
    else this.child.kill('SIGTERM');
  }
}

const acctCache = new Map();

/** Which ChatGPT account a Codex profile is signed in to (and whether its Windows sandbox is set up). Cached 60s (`maxAge` asks for a fresher answer). */
export async function codexAccount(codexHome, { force = false, maxAge = 60_000 } = {}) {
  const key = codexHome || '(default)';
  const hit = acctCache.get(key);
  if (!force && hit && Date.now() - hit.at < maxAge) return hit.data;
  let data;
  let srv = null;
  try {
    srv = new AppServer({ codexHome });
    await srv.init();
    const r = await srv.request('account/read', {}, 20_000);
    const a = r?.account || null;
    let sandbox = null;
    if (process.platform === 'win32') sandbox = (await srv.request('windowsSandbox/readiness', {}, 10_000).catch(() => null))?.status || null;
    data = { loggedIn: !!a, email: a?.type === 'chatgpt' ? a.email || null : null, authType: a?.type || null, plan: a?.planType || null, sandbox };
  } catch (e) {
    data = { loggedIn: false, error: e.message };
  } finally {
    srv?.close();
  }
  acctCache.set(key, { at: Date.now(), data });
  return data;
}

/** Split a POSIX-quoted command line into words ('…' literal, "…" with \-escapes). null if unbalanced. */
export function shellWords(s) {
  const out = [];
  let cur = '', inWord = false, i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return null;
      cur += s.slice(i + 1, j); i = j + 1; inWord = true; continue;
    }
    if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length && '"\\$`\n'.includes(s[i + 1])) { cur += s[i + 1]; i += 2; } else cur += s[i++];
      }
      if (i >= s.length) return null;
      i++; inWord = true; continue;
    }
    if (/\s/.test(c)) { if (inWord) { out.push(cur); cur = ''; inWord = false; } i++; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += s[i + 1]; i += 2; inWord = true; continue; }
    cur += c; i++; inWord = true;
  }
  if (inWord) out.push(cur);
  return out;
}

/** The command a shell approval is really about: the script inside Codex's powershell/bash wrapper. */
export function unwrapShell(cmd) {
  const s = String(cmd || '').trim();
  const w = shellWords(s);
  if (w && w.length >= 3) {
    const exe = w[0].split(/[\\/]/).pop().toLowerCase();
    if (/^(powershell|pwsh)(\.exe)?$/.test(exe)) {
      const i = w.findIndex(x => /^-c(ommand)?$/i.test(x));
      if (i > 0 && i === w.length - 2) return { shell: 'PowerShell', command: w[i + 1] };
    }
    if (/^(bash|sh|zsh)(\.exe)?$/.test(exe) && /^-l?c$/.test(w[1]) && w.length === 3) return { shell: 'Bash', command: w[2] };
  }
  return { shell: 'Bash', command: s }; // unknown wrapper: judge the whole line (fails safe)
}

const toolNameOf = (msg = '') => msg.match(/tool "([^"]+)"/)?.[1] || null;

/**
 * Run one Codex turn for a Orchy run.
 * opts: { cwd, codexHome, model, effort, prompt, developerInstructions, mcpServers, resumeThreadId }
 * hooks: {
 *   record(evt)                      → a line in the run's live feed
 *   started({ threadId })            → the Codex thread (resume key for follow-ups)
 *   gate(toolName, input)            → Promise<{ allow, reason }> (Orchy policy + the owner's pop-up)
 *   ask(questions)                   → Promise<{ [questionId]: string }> (the owner answers)
 *   usage(tokens)
 *   done({ code, status, error, resultText })
 * }
 * Returns { stop(), pid }.
 */
export function launchCodexRun(opts, hooks) {
  let srv;
  try { srv = new AppServer({ codexHome: opts.codexHome, cwd: opts.cwd }); }
  catch (e) { queueMicrotask(() => hooks.done({ code: 1, status: 'failed', error: e.message })); return { stop() {}, pid: null }; }

  let threadId = null, turnId = null, finished = false, lastText = '', finalText = '';
  const fileChanges = new Map(); // itemId -> [paths], for fileChange approvals
  const lastMcp = new Map();     // server -> tool, for MCP approval prompts that don't name the tool

  const end = (r) => {
    if (finished) return;
    finished = true;
    srv.close();
    hooks.done({ resultText: finalText || lastText || '', ...r });
  };

  srv.onNotify = (method, p) => {
    if (method === 'item/started') {
      const it = p.item || {};
      if (it.type === 'commandExecution') {
        const shown = (it.commandActions || []).map(a => a.command).filter(Boolean).join(' && ') || unwrapShell(it.command).command;
        hooks.record({ kind: 'tool', tool: 'Bash', input: { command: shown }, codex: 'command' });
      } else if (it.type === 'mcpToolCall') {
        lastMcp.set(it.server, it.tool);
        hooks.record({ kind: 'tool', tool: `mcp__${it.server}__${it.tool}`, input: it.arguments || {}, codex: 'mcp' });
      } else if (it.type === 'fileChange') {
        const paths = (it.changes || []).map(c => c.path);
        fileChanges.set(it.id, paths);
        hooks.record({ kind: 'tool', tool: 'Edit', input: { file_path: paths[0] || '' }, codex: 'patch', extra: paths.length > 1 ? paths.length - 1 : 0 });
      } else if (it.type === 'webSearch') {
        hooks.record({ kind: 'tool', tool: 'WebSearch', input: { query: it.query || it.action?.query || '' }, codex: 'search' });
      }
      return;
    }
    if (method === 'item/completed') {
      const it = p.item || {};
      if (it.type === 'agentMessage' && it.text?.trim()) {
        lastText = it.text.trim();
        if (it.phase === 'final_answer') finalText = lastText;
        hooks.record({ kind: 'text', text: lastText });
      } else if (it.type === 'commandExecution' && it.status === 'failed' && it.exitCode) {
        hooks.record({ kind: 'tool_error', text: `Exit ${it.exitCode}: ${String(it.aggregatedOutput || '').trim().slice(-600)}` });
      } else if (it.type === 'mcpToolCall' && it.error?.message) {
        hooks.record({ kind: 'tool_error', text: it.error.message.slice(0, 600) });
      } else if (it.type === 'fileChange' && it.status === 'failed') {
        hooks.record({ kind: 'tool_error', text: 'A file edit failed to apply.' });
      }
      return;
    }
    if (method === 'thread/tokenUsage/updated') { hooks.usage?.(p.tokenUsage?.total || null); return; }
    if (method === 'error' && p.error && !p.willRetry) { hooks.record({ kind: 'error', text: p.error.message }); return; }
    if (method === 'turn/completed' && p.turn) {
      const t = p.turn;
      end({ code: t.status === 'completed' ? 0 : 1, status: t.status, error: t.error ? [t.error.message, t.error.additionalDetails].filter(Boolean).join(' ') : null });
    }
  };

  srv.onRequest = async (method, p) => {
    if (method === 'item/commandExecution/requestApproval') {
      const { shell, command } = unwrapShell(p.command || (p.commandActions || []).map(a => a.command).join(' && '));
      const v = await hooks.gate(shell, { command, cwd: p.cwd });
      return { decision: v.allow ? 'accept' : 'decline' };
    }
    if (method === 'item/fileChange/requestApproval') {
      const paths = fileChanges.get(p.itemId) || [];
      // a change whose files Orchy never saw asks the owner (an empty file_path does, see policy.mjs)
      const edits = paths.length ? paths.map(fp => ({ file_path: path.resolve(opts.cwd, fp) })) : [{ file_path: '', grant_root: p.grantRoot || null }];
      for (const input of edits) {
        const v = await hooks.gate('Edit', input);
        if (!v.allow) return { decision: 'decline' };
      }
      return { decision: 'accept' };
    }
    if (method === 'mcpServer/elicitation/request') {
      const meta = p._meta || {};
      if (meta.codex_approval_kind !== 'mcp_tool_call') {
        hooks.record({ kind: 'denied', text: `${p.serverName} asked for extra input ("${String(p.message || '').slice(0, 120)}"); Orchy doesn't answer those yet.` });
        return { action: 'decline', content: null, _meta: null };
      }
      const tool = toolNameOf(p.message) || lastMcp.get(p.serverName) || 'tool';
      const v = await hooks.gate(`mcp__${p.serverName}__${tool}`, meta.tool_params || {});
      return { action: v.allow ? 'accept' : 'decline', content: v.allow ? {} : null, _meta: null };
    }
    if (method === 'item/tool/requestUserInput') {
      const got = await hooks.ask(p.questions || []);
      return { answers: Object.fromEntries((p.questions || []).map(q => [q.id, { answers: got[q.id] ? [got[q.id]] : [] }])) };
    }
    if (method === 'item/permissions/requestApproval') {
      hooks.record({ kind: 'denied', text: `Asked for extra ${[p.permissions?.network && 'network', p.permissions?.fileSystem && 'file'].filter(Boolean).join(' and ') || ''} permissions; Orchy runs every step through its own approvals instead.` });
      return { permissions: {}, scope: 'turn' };
    }
    throw Object.assign(new Error(`Orchy doesn't handle ${method}`), { code: -32601 });
  };

  srv.exited.then(code => {
    if (!finished) end({ code: code || 1, status: 'failed', error: srv.stderr.trim().split('\n').slice(-6).join('\n') || `Codex exited with code ${code}` });
  });

  (async () => {
    await srv.init();
    const common = {
      cwd: opts.cwd, model: opts.model, approvalPolicy: 'untrusted', sandbox: 'workspace-write',
      developerInstructions: opts.developerInstructions, config: { mcp_servers: opts.mcpServers || {} },
    };
    const r = opts.resumeThreadId
      ? await srv.request('thread/resume', { threadId: opts.resumeThreadId, ...common, excludeTurns: true }, 60_000)
      : await srv.request('thread/start', { ...common, serviceName: 'Orchy' }, 60_000);
    threadId = r.thread.id;
    hooks.started({ threadId, model: r.model });
    // effort: the agent's reasoning effort (low…ultra); without it Codex uses the model's default
    const t = await srv.request('turn/start', { threadId, input: [{ type: 'text', text: opts.prompt, text_elements: [] }], ...(opts.effort ? { effort: opts.effort } : {}) }, 60_000);
    turnId = t.turn?.id || null;
  })().catch(e => end({ code: 1, status: 'failed', error: e.message }));

  return {
    pid: srv.child.pid,
    async stop() {
      if (threadId && turnId) await srv.request('turn/interrupt', { threadId, turnId }, 5000).catch(() => {});
      setTimeout(() => end({ code: 1, status: 'interrupted', error: null }), 4000);
    },
  };
}
