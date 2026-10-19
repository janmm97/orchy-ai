// Engine adapter: Cursor's CLI (`agent`, formerly `cursor-agent`), headless: `agent -p --output-format stream-json`, the
// prompt on stdin. Status: gated through hooks in a plugin Orchy writes for each agent, checked against the real CLI
// (2026.10.16, Windows; docs/HARNESSES.md).
//
// Gated (capabilities.gated = true): before every run Orchy writes a plugin into the agent's own Cursor folder and starts
// Cursor with `--plugin-dir`. Its preToolUse hook (every built-in tool: shell, file reads, writes and deletes, search,
// subagents, whose own calls come through it too) and its beforeMCPExecution hook (every MCP call, with its server) run
// mcp/tool-hook.mjs and wait for Orchy's gate, the owner's pop-up included. Both are failClosed: a hook that denies,
// crashes or times out blocks the call. A deny from any other hook source wins too, and none can turn Orchy's into an allow.
// Orchy never passes --force: with it Cursor approves web search and web fetch itself and neither reaches a hook. Without
// it, headless Cursor rejects both, so Cursor runs in Orchy have no web tools. The agent's config folder
// (CURSOR_CONFIG_DIR) pins approvalMode allowlist with shell, files and MCP allowlisted (the hooks are the gate), web
// search not auto-accepted and Cursor's sandbox off; Orchy rewrites it before every run.
// Windows: Cursor runs hooks with PowerShell syntax but uses Git Bash as its shell whenever MSYSTEM is set (a Git Bash
// parent), which breaks every hook (they then block everything): the MSYS variables are dropped from its environment.
// Its sign-in is one per computer (%APPDATA%\Cursor\auth.json on Windows, ~/.config/cursor/auth.json on Linux, the
// keychain on macOS), so every Cursor workspace runs as the same account (`cursorAccount`, checked when one is added or
// changed, and compared with `agent status` before every run).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { env, expandPath, DATA_DIR, ROOT } from '../env.mjs';
import { findBinary } from '../claude.mjs';
import { briefFor, textBuffer } from '../activity.mjs';
import { psq, sq, killTree, scrubbedEnv } from './shared.mjs';
import { CURSOR_PLUGIN, cursorServer } from './hookmap.mjs';

export const CURSOR = 'cursor';
const WIN = process.platform === 'win32';
// hours: an owner may take a while to answer; past this Cursor blocks the call (the hooks fail closed)
const HOOK_TIMEOUT_S = 6 * 3600;

// ── the program: Cursor's installer keeps versions/<YYYY.MM.DD-commit>/ (node + index.js) behind a launcher script ──
const VERSION_DIR = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/;
const versionKey = name => { const m = name.match(VERSION_DIR); return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : -1; };
/** The newest version folder under <root>/versions that holds Cursor's own node and index.js, or null. */
export function newestCursorVersion(root) {
  let names = [];
  try { names = fs.readdirSync(path.join(root, 'versions')).filter(n => VERSION_DIR.test(n)); } catch { return null; }
  names.sort((a, b) => versionKey(b) - versionKey(a) || b.localeCompare(a));
  for (const n of names) {
    const dir = path.join(root, 'versions', n);
    if (fs.existsSync(path.join(dir, 'index.js')) && fs.existsSync(path.join(dir, WIN ? 'node.exe' : 'node'))) return dir;
  }
  return null;
}
const fromVersionDir = dir => ({ cmd: path.join(dir, WIN ? 'node.exe' : 'node'), args: [path.join(dir, 'index.js')], bin: dir });

/**
 * How to start Cursor: { cmd, args, bin } or null. CURSOR_CLI_PATH may name the launcher, a version folder or (tests) a
 * .mjs script. Windows: its node + index.js are started directly, never through the .cmd/.ps1 launchers (their quoting
 * and stdin handling aren't Orchy's to depend on).
 */
export function resolveCursor() {
  const explicit = env('CURSOR_CLI_PATH');
  if (explicit) {
    const p = expandPath(explicit);
    if (!fs.existsSync(p)) return null;
    if (fs.statSync(p).isDirectory()) return fs.existsSync(path.join(p, 'index.js')) ? fromVersionDir(p) : null;
    if (/\.m?js$/i.test(p)) return { cmd: process.execPath, args: [p], bin: p };
    if (WIN && /\.(cmd|ps1|bat)$/i.test(p)) { const v = newestCursorVersion(path.dirname(p)); return v ? fromVersionDir(v) : { cmd: p, args: [], bin: p }; }
    return { cmd: p, args: [], bin: p };
  }
  if (WIN) {
    const v = process.env.LOCALAPPDATA && newestCursorVersion(path.join(process.env.LOCALAPPDATA, 'cursor-agent'));
    if (v) return fromVersionDir(v);
  }
  // `cursor-agent` first: `agent` alone is a common name for other programs
  const b = findBinary('cursor-agent', [path.join(os.homedir(), '.local', 'bin')]) || (() => {
    const p = path.join(os.homedir(), '.local', 'bin', WIN ? 'agent.cmd' : 'agent');
    return fs.existsSync(p) ? p : null;
  })();
  if (!b) return null;
  if (WIN && /\.(cmd|ps1|bat)$/i.test(b)) { const v = newestCursorVersion(path.dirname(b)); if (v) return fromVersionDir(v); }
  return { cmd: b, args: [], bin: b };
}
let launchCache = null;
const launch = () => { if (!launchCache || !fs.existsSync(launchCache.cmd)) launchCache = resolveCursor(); return launchCache; };
/** Tests point the adapter at a fake Cursor (a .mjs script). */
export function setCursorForTests(p) { launchCache = p ? { cmd: process.execPath, args: [p], bin: p } : null; }

// a .cmd/.bat (a launcher Orchy couldn't see past) only starts through the shell; quote every argument for it
function start(l, args, opts) {
  const o = { ...opts, detached: !WIN }; // its own process group, so killTree stops everything it started
  if (!/\.(cmd|bat)$/i.test(l.cmd)) return spawn(l.cmd, [...l.args, ...args], o);
  const q = a => `"${String(a).replace(/"/g, '""')}"`;
  return spawn([l.cmd, ...l.args, ...args].map(q).join(' '), [], { ...o, shell: true });
}

// Git Bash's variables: with MSYSTEM set, Cursor runs its hooks (written in PowerShell syntax) through bash, and they fail
const MSYS = ['MSYSTEM', 'MSYSTEM_PREFIX', 'MSYSTEM_CARCH', 'MSYSTEM_CHOST', 'MINGW_PREFIX', 'MINGW_CHOST', 'MINGW_PACKAGE_PREFIX', 'EXEPATH', 'SHELL'];
/** Cursor's environment: the PC's secrets and the other harnesses' profile variables out, its own config folder in. */
export function cursorEnv(configDir, extra = {}, base = process.env) {
  return scrubbedEnv(configDir ? { CURSOR_CONFIG_DIR: configDir } : {}, { NO_OPEN_BROWSER: '1', ...extra },
    { dropNames: [...MSYS, 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HERMES_HOME', 'CURSOR_API_ENDPOINT', 'CURSOR_CONFIG_DIR'] }, base);
}

// ── who it is signed in as (`agent status --format json`), and the models that account lists (`agent models`) ──
function runCursor(args, { timeout = 20_000 } = {}) {
  const l = launch();
  if (!l) return { ok: false, out: '', error: 'Cursor’s CLI isn’t installed on this computer' };
  const dir = path.join(DATA_DIR, 'cursor-check');
  fs.mkdirSync(dir, { recursive: true });
  // its own config folder, so a check never writes the owner's ~/.cursor/cli-config.json
  const r = spawnSync(l.cmd, [...l.args, ...args], { cwd: dir, env: cursorEnv(path.join(dir, 'config')), timeout, windowsHide: true, encoding: 'utf8', shell: /\.(cmd|bat)$/i.test(l.cmd) });
  if (r.error) return { ok: false, out: '', error: r.error.message };
  return { ok: r.status === 0, out: String(r.stdout || ''), error: String(r.stderr || '').trim().split(/\r?\n/).pop() || null };
}
/** `agent status --format json` → { loggedIn, email }. */
export function parseCursorStatus(text) {
  let j = null;
  try { j = JSON.parse(String(text || '').slice(String(text || '').indexOf('{'))); } catch {}
  const email = typeof j?.userInfo?.email === 'string' && j.userInfo.email.includes('@') ? j.userInfo.email.trim() : null;
  return { loggedIn: !!(j?.isAuthenticated && email), email };
}
/** `agent models` → the model ids ("gpt-5.3-codex - Codex 5.3" → "gpt-5.3-codex"). */
export const parseCursorModels = text => [...new Set(String(text || '').split(/\r?\n/).map(l => l.replace(/\x1b\[[0-9;]*m/g, '').trim().match(/^([a-z0-9][\w.:\-[\],=]*)\s+-\s+\S/i)?.[1]).filter(Boolean))];
let acctCache = null;
export async function cursorAccount({ force = false, maxAge = 60_000 } = {}) {
  if (!force && acctCache && Date.now() - acctCache.at < maxAge) return acctCache.value;
  const s = runCursor(['status', '--format', 'json']);
  const st = s.out ? parseCursorStatus(s.out) : { loggedIn: false, email: null };
  const models = st.loggedIn ? parseCursorModels(runCursor(['models']).out) : [];
  const value = st.loggedIn
    ? { loggedIn: true, email: st.email, label: st.email, models }
    : { loggedIn: false, email: null, label: null, error: s.ok || s.out ? 'Cursor isn’t signed in. Press Log in to sign in in your browser.' : s.error || 'Cursor didn’t answer' };
  acctCache = { at: Date.now(), value };
  return value;
}

// ── the agent's own Cursor folder: its config (CURSOR_CONFIG_DIR) and Orchy's plugin, rewritten every run ──
/** Where a workspace keeps its agents' Cursor folders (`cursorHome`, else ~/.cursor-orchy/<id>). */
export const cursorRoot = ws => (ws?.cursorHome ? expandPath(ws.cursorHome) : path.join(os.homedir(), '.cursor-orchy', String(ws?.id || 'workspace')));
export const cursorAgentDir = (ws, slug) => path.join(cursorRoot(ws), String(slug || 'general').replace(/[^\w.-]/g, '_'));

/** The CLI config Orchy forces: allowlist mode with the hooks as the gate, no auto-accepted web search, no sandbox. */
export function cursorConfig() {
  return {
    version: 1,
    approvalMode: 'allowlist',
    permissions: { allow: ['Shell(*)', 'Read(**)', 'Write(**)', 'Mcp(*:*)'], deny: [] },
    autoAcceptWebSearch: false,
    sandbox: { mode: 'disabled' },
    notifications: false, hints: false,
    attribution: { attributeCommitsToAgent: false, attributePRsToAgent: false },
  };
}

/** Orchy's hook command as Cursor runs it: quoted paths (it splits and re-quotes the first token itself). */
export const cursorHookCommand = ({ script, credsFile }, node = process.execPath) => [node, script, CURSOR, credsFile].map(a => `"${a}"`).join(' ');

/** Write the agent's folder for this run: config/cli-config.json and the plugin (hooks + MCP servers). Returns its paths. */
export function prepareCursor(ws, slug, { bridge, servers = {}, allowed = null, hook }) {
  if (!hook) throw new Error('Cursor only runs with Orchy’s approval hooks.');
  const dir = cursorAgentDir(ws, slug);
  const config = path.join(dir, 'config');
  const plugin = path.join(dir, CURSOR_PLUGIN);
  for (const d of [config, path.join(plugin, '.cursor-plugin'), path.join(plugin, 'hooks')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(config, 'cli-config.json'), JSON.stringify(cursorConfig(), null, 2) + '\n', { mode: 0o600 });
  const command = cursorHookCommand(hook);
  const entry = { command, failClosed: true, timeout: HOOK_TIMEOUT_S };
  fs.writeFileSync(path.join(plugin, 'hooks', 'hooks.json'), JSON.stringify({ version: 1, hooks: { preToolUse: [entry], beforeMCPExecution: [entry] } }, null, 2) + '\n');
  fs.writeFileSync(path.join(plugin, '.cursor-plugin', 'plugin.json'), JSON.stringify({ name: CURSOR_PLUGIN, version: '1.0.0', description: 'Orchy: every tool call waits for Orchy’s approvals.', hooks: './hooks/hooks.json', mcpServers: './mcp.json' }, null, 2) + '\n');
  // the other servers never see Orchy's bridge token, which every MCP server would otherwise inherit from Cursor
  const hide = { JOS_TOKEN: '', JOS_RUN_ID: '', JOS_URL: '' };
  const mcpServers = bridge ? { jos: { command: bridge.command, args: bridge.args } } : {};
  for (const [n, s] of Object.entries(servers)) {
    if (n === 'jos' || !s || s.enabled === false || s.type === 'sse' || (allowed && !allowed.includes(n))) continue;
    mcpServers[n] = s.type === 'stdio' || s.command ? { command: s.command, args: s.args || [], env: { ...(s.env || {}), ...hide } } : { url: s.url, headers: s.headers || {} };
  }
  fs.writeFileSync(path.join(plugin, 'mcp.json'), JSON.stringify({ mcpServers }, null, 2) + '\n', { mode: 0o600 });
  return { dir, config, plugin };
}

// Cursor reads every AGENTS.md / CLAUDE.md in the run's folder and each parent up to the drive root (checked on the
// real CLI), and workspaces live inside this repo: Orchy's root .cursorignore hides Orchy's own instructions from it
export const CURSOR_FENCE = ['/AGENTS.md', '/CLAUDE.md', '/CLAUDE.local.md'];
/** Why a run in this folder would read Orchy's own instructions (the root .cursorignore lost its lines), or null. */
export function instructionsFenceProblem(dir, root = ROOT) {
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null; // a workspace outside Orchy's folder: nothing of Orchy's above it
  let lines = [];
  try { lines = fs.readFileSync(path.join(root, '.cursorignore'), 'utf8').split(/\r?\n/).map(l => l.trim()); } catch {}
  const missing = CURSOR_FENCE.filter(l => !lines.includes(l));
  return missing.length ? `Orchy's .cursorignore is missing ${missing.join(', ')}, so Cursor would read Orchy's own instructions in this workspace's runs. Restore it (git checkout .cursorignore), then start the task again.` : null;
}

/** Cursor's arguments for one turn (the prompt goes in on stdin). Never --force, --approve-mcps or --auto-review. */
export function cursorArgs({ plugin, workspace, model, resume }) {
  const a = ['-p', '--output-format', 'stream-json', '--trust', '--workspace', workspace, '--plugin-dir', plugin];
  if (model && model !== 'default') a.push('--model', model);
  if (resume) a.push('--resume', resume);
  return a;
}

// ── its stream-json, as Orchy's feed ──
// what a finished tool gave back, as text for the feed's counts-only brief
const successText = s => (typeof s === 'string' ? s : s?.content ?? s?.markdown ?? [s?.stdout, s?.stderr].filter(Boolean).join('\n')) || (s?.linesAdded != null ? `${s.linesAdded} lines` : '');
const STREAM_NAMES = { shellToolCall: 'Bash', readToolCall: 'Read', editToolCall: 'Write', writeToolCall: 'Write', deleteToolCall: 'Delete', grepToolCall: 'Grep', globToolCall: 'Glob', lsToolCall: 'LS', webSearchToolCall: 'WebSearch', webFetchToolCall: 'WebFetch', taskToolCall: 'Task', updateTodosToolCall: 'TodoWrite', todoToolCall: 'TodoWrite', getMcpToolsToolCall: 'ToolSearch', awaitToolCall: 'Await' };
// its own bookkeeping (looking up a tool, waiting on a command it left running): not shown in the feed
const QUIET = new Set(['ToolSearch', 'Await']);
/** One tool_call event's { <kind>ToolCall: { args, result? } } → { tool, input, result }. */
export function cursorTool(tc = {}) {
  const kind = Object.keys(tc).find(k => k.endsWith('ToolCall')) || '';
  const v = tc[kind] || {};
  const a = v.args || {};
  let tool = STREAM_NAMES[kind] || `Cursor:${kind.replace(/ToolCall$/, '') || 'tool'}`;
  let input = a;
  if (kind === 'mcpToolCall') { tool = `mcp__${cursorServer(a.providerIdentifier || a.serverIdentifier)}__${a.toolName || 'tool'}`; input = a.args || {}; }
  else if (kind === 'shellToolCall') input = { command: a.command, ...(a.workingDirectory ? { cwd: a.workingDirectory } : {}) };
  else if (a.path && /^(read|edit|write|delete)ToolCall$/.test(kind)) input = { file_path: a.path };
  else if (kind === 'webSearchToolCall') input = { query: a.searchTerm };
  else if (kind === 'webFetchToolCall') input = { url: a.url };
  else if (kind === 'taskToolCall') input = { description: a.description, prompt: a.prompt };
  return { tool, input, result: v.result || null };
}

/**
 * One line of Cursor's stream-json → { sessionId?, init?, text?, toolUseId?, tool?, toolDone?, toolError?, denied?, result? }.
 * A refused tool (`rejected` / `permissionDenied`, Orchy's gate or Cursor's own refusal of web tools) is `denied`.
 */
export function parseCursorLine(line) {
  let m;
  try { m = JSON.parse(String(line).replace(/^﻿/, '')); } catch { return null; }
  if (!m || typeof m !== 'object') return null;
  const out = {};
  if (m.session_id) out.sessionId = m.session_id;
  if (m.type === 'system' && m.subtype === 'init') out.init = true;
  if (m.type === 'assistant') {
    const text = (m.message?.content || []).filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('');
    if (text) out.text = text;
  }
  if (m.type === 'tool_call' && m.tool_call) {
    out.toolUseId = String(m.call_id || m.tool_call.toolCallId || '');
    const t = cursorTool(m.tool_call);
    if (m.subtype === 'started') out.tool = { tool: t.tool, input: t.input };
    else if (m.subtype === 'completed') {
      const r = t.result || {};
      if (r.rejected || r.permissionDenied) {
        const why = r.rejected?.reason || r.permissionDenied?.error || '';
        out.denied = { tool: t.tool, message: String(why || `${t.tool} was refused`).replace(/\n\nAgent note:[\s\S]*$/, '').slice(0, 600) };
      } else if (r.error) out.toolError = { tool: t.tool, message: String(r.error.errorMessage || r.error.error || r.error.message || 'Tool failed').slice(0, 600) };
      else out.toolDone = { tool: t.tool, brief: r.success == null ? 'done' : briefFor(t.tool, successText(r.success)) };
    }
  }
  if (m.type === 'result') out.result = { ok: m.subtype === 'success' && !m.is_error, text: typeof m.result === 'string' ? m.result : '', usage: m.usage || null, durationMs: m.duration_ms ?? null };
  return out;
}

const tokensOf = u => (u ? { input: (u.inputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0), output: u.outputTokens || 0, total: (u.inputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0) + (u.outputTokens || 0) } : null);

let probe = null;

export default {
  id: CURSOR,
  label: 'Cursor',
  // "auto" is Cursor's own pick; any model id `agent models` lists can be named (openModels)
  models: ['auto', 'auto', 'auto'],
  blurb: 'Cursor’s CLI (`agent`). Sign in with your Cursor account in the browser; no API key. Every tool call it makes waits for Orchy’s approvals first, through hooks Orchy adds to each run. It has no web search or fetch in Orchy.',
  fields: { account: 'cursorAccount', profile: 'cursorHome' },
  accountModel: 'email',
  // one Cursor sign-in per computer: every Cursor workspace must name the same account (workspaces.mjs)
  sharedLogin: true,
  openModels: true,
  instructionFile: 'AGENTS.md',
  defaultProfileLabel: '(~/.cursor-orchy/<workspace>)',
  // Cursor's installers (cursor.com/docs/cli/installation): %LOCALAPPDATA%\cursor-agent on Windows, ~/.local/bin elsewhere
  install: {
    cmd: 'curl https://cursor.com/install -fsS | bash',
    winCmd: 'powershell -ExecutionPolicy ByPass -c "irm \'https://cursor.com/install?win32=true\' | iex"',
    signIn: 'agent login', bin: 'agent', optional: true,
    note: 'Optional: Cursor’s CLI. Its agents get no web search or web fetch in Orchy.',
  },
  capabilities: {
    gated: true, mcp: true, resume: true, headless: true,
    clientSafe: false,
    clientReason: 'Cursor hasn’t been checked with clients’ sandboxes yet, so it is not offered to clients.',
    huddles: false,
    notes: 'agent -p with stream-json out, the prompt on stdin, never --force. Orchy’s plugin (--plugin-dir) runs its hook before every tool call (preToolUse) and every MCP call (beforeMCPExecution), failClosed; Cursor blocks the call if the hook denies, fails or times out. Web search and fetch are rejected headless.',
  },
  bin: () => launch()?.bin || null,
  version() {
    const l = launch();
    if (!l) return null;
    if (!probe || probe.bin !== l.bin || (!probe.v && Date.now() - probe.at > 5_000)) {
      let v = null;
      try {
        const r = spawnSync(l.cmd, [...l.args, '--version'], { timeout: 20_000, windowsHide: true, encoding: 'utf8', env: cursorEnv(null), shell: /\.(cmd|bat)$/i.test(l.cmd) });
        if (!r.error && r.status === 0) v = String(r.stdout || r.stderr || '').trim().split(/\r?\n/)[0] || 'ok';
      } catch {}
      probe = { bin: l.bin, at: Date.now(), v };
    }
    return probe.v;
  },
  available: () => !!launch(),
  async account(_profileDir, opts = {}) { return cursorAccount(opts); },
  // the sign-in is the computer's; the agent's config folder is passed per run
  profileEnv: () => ({}),
  loginCommand: (a, { win }) => {
    const l = launch();
    const parts = l ? [l.cmd, ...l.args, 'login'] : ['agent', 'login'];
    return win ? `& ${parts.map(psq).join(' ')}` : parts.map(sq).join(' ');
  },
  loginAlt: a => `Cursor has one sign-in for the whole computer, shared by every Cursor workspace. Sign in as ${a?.email || 'the shared account'} (if it's signed in as someone else, run its logout command first: agent logout).`,
  // Cursor gets its MCP servers from Orchy's plugin (prepareCursor), so launch gets the raw pieces
  mcpConfig: ({ servers, allowed, bridge }) => ({ servers, allowed, bridge }),
  protocolNotes: ({ ownerName }) => `
## Working on Cursor
- Every tool call you make goes to Orchy's approvals first: routine work in this folder runs, and decisions (sending, posting, spending, deleting, sharing, calendar changes) wait for ${ownerName}'s OK, so a call may pause. If a call is refused, don't try another way to do the same thing; say so in your report. If Orchy says it is still waiting for ${ownerName}'s OK, wait a minute and make exactly the same call again.
- You have no web search or web fetch here (they are switched off for Cursor in Orchy). Work from the files, the apps connected through MCP tools, and the commands you are allowed.
- The jos tools above are MCP tools (server \`jos\`). Ask questions only with ask_user and finish with report_done: nobody reads your replies until the report.
- Skills in \`.claude/skills/<name>/\` are plain folders: when your instructions name one, read its \`SKILL.md\` and the files it points to, and follow them. Its Claude-only parts (the Skill tool, hooks, Claude subagents) don't run here: do those steps yourself.
`,
  launch(run, ws, opts, rt) {
    const hooks = rt.hooks(run, ws);
    let child = null, stopped = false;
    rt.live.set(run.id, { fingerprint: opts.fingerprint, stop: () => { stopped = true; killTree(child); hooks.done({ code: null, status: 'interrupted' }); } });
    (async () => {
      const l = launch();
      if (!l) throw new Error('Cursor’s CLI isn’t installed on this computer. Install it (Add window, or Set up Orchy → Tools), or set CURSOR_CLI_PATH in .env.');
      const fence = instructionsFenceProblem(ws.dir);
      if (fence) throw new Error(fence);
      const { servers, allowed, bridge } = opts.mcp || {};
      // from here every tool call Cursor makes waits for the gate (mcp/tool-hook.mjs → runner.mjs#toolHook)
      const hook = hooks.useToolHook(CURSOR);
      const { config, plugin } = prepareCursor(ws, run.agentSlug || 'general', { bridge, servers, allowed, hook });
      if (opts.resume) hooks.started({ threadId: opts.resume });
      let text = '', stderr = '', buf = '', result = null;
      const said = textBuffer(t => hooks.record({ kind: 'text', text: t }));
      child = start(l, cursorArgs({ plugin, workspace: ws.dir, model: run.model, resume: opts.resume }), {
        cwd: ws.dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        // the jos MCP server inherits its run id and token from Cursor; the plugin's mcp.json holds none
        env: cursorEnv(config, bridge?.env || {}),
      });
      run.pid = child.pid;
      child.stdin.on('error', () => {});
      child.stdin.end(`${rt.instructions(ws, run, opts.agentMarkdown, opts.planText)}\n\n# Current request\n${opts.prompt}\n`);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', d => {
        buf += d;
        let end;
        while ((end = buf.indexOf('\n')) >= 0) {
          const e = parseCursorLine(buf.slice(0, end)); buf = buf.slice(end + 1);
          if (!e || stopped) continue;
          // the hooks find this run by Cursor's chat id, which its first line (init) carries
          if (e.sessionId && run.sessionId !== e.sessionId) hooks.started({ threadId: e.sessionId });
          if (e.text) { text += e.text; said.add((said.pending ? '\n\n' : '') + e.text); }
          if (e.tool || e.toolError || e.toolDone || e.denied || e.result) said.flush();
          if (e.tool && !QUIET.has(e.tool.tool)) hooks.record({ kind: 'tool', tool: e.tool.tool, toolUseId: e.toolUseId, input: e.tool.input || {} });
          if (e.toolDone && !QUIET.has(e.toolDone.tool)) hooks.record({ kind: 'tool_done', toolUseId: e.toolUseId, tool: e.toolDone.tool, ok: true, brief: e.toolDone.brief });
          if (e.toolError) hooks.record({ kind: 'tool_error', toolUseId: e.toolUseId, tool: e.toolError.tool, text: e.toolError.message });
          if (e.denied) hooks.record({ kind: 'denied', toolUseId: e.toolUseId, text: /^(WebSearch|WebFetch)$/.test(e.denied.tool) ? `Cursor’s ${e.denied.tool === 'WebSearch' ? 'web search' : 'web fetch'} is off in Orchy.` : e.denied.message });
          if (e.result) result = e.result;
        }
      });
      child.on('error', e => { if (!stopped) { stopped = true; hooks.done({ code: 1, status: 'failed', error: e.message }); } });
      child.on('close', code => {
        if (stopped) return;
        stopped = true;
        said.flush();
        if (result) {
          if (result.usage) hooks.usage(tokensOf(result.usage));
          return hooks.done({ code: result.ok ? 0 : (code || 1), status: result.ok ? 'completed' : 'failed', error: result.ok ? null : (stderr.trim().split('\n').pop() || 'Cursor stopped with an error'), resultText: String(result.text || text).trim() });
        }
        hooks.done({ code: code || 1, status: 'failed', error: stderr.trim().split('\n').pop() || 'Cursor ended without a result', resultText: text.trim() });
      });
    })().catch(e => { killTree(child); if (!stopped) { stopped = true; hooks.done({ code: 1, status: 'failed', error: e.message }); } });
  },
};
