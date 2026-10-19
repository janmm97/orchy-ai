// What a harness's pre-tool hook sends (Antigravity, Hermes, Cursor) → the calls Orchy's gate judges ({ tool, input } in policy.mjs's words).
// Pure and dependency-free: the hook process (mcp/tool-hook.mjs) loads it on every tool call, and the adapters use it
// for their feeds. Anything not recognised keeps a name policy.mjs doesn't know, which always asks the owner.
import os from 'node:os';
import path from 'node:path';

// agy's tool calls in the names Orchy's feed, policy words and describeTool know
const AGY_NAMES = { run_command: 'Bash', view_file: 'Read', write_to_file: 'Write', replace_file_content: 'Edit', multi_replace_file_content: 'Edit', sed_file: 'Edit', grep_search: 'Grep', find_by_name: 'Glob', list_dir: 'LS', read_url_content: 'WebFetch', search_web: 'WebSearch' };

/** One agy tool ({ name, parameters }, as its stream and its hooks name it) → { tool, input }. */
export function agyTool(info = {}) {
  const p = info.parameters || {};
  if (info.name === 'call_mcp_tool') return { tool: `mcp__${p.ServerName}__${p.ToolName}`, input: p.Arguments || {} };
  const tool = AGY_NAMES[info.name] || `AGY_${info.name || 'tool'}`;
  const input = info.name === 'run_command' ? { command: p.CommandLine, cwd: p.Cwd }
    : p.AbsolutePath || p.TargetFile ? { ...p, file_path: p.AbsolutePath || p.TargetFile }
    : info.name === 'read_url_content' ? { ...p, url: p.Url || p.url } : p;
  return { tool, input };
}

/** agy's PreToolUse payload → { sessionId (its conversation), calls }. */
export function agyHookCalls(payload = {}) {
  const tc = payload.toolCall || {};
  return { sessionId: payload.conversationId || null, calls: [agyTool({ name: tc.name, parameters: tc.args || {} })] };
}

// Hermes's own bookkeeping (its to-do list, its memory, reading its tool and skill docs): nothing leaves the profile
const HERMES_INTERNAL = new Set(['todo', 'tool_describe', 'skills_list', 'skill_view', 'session_search', 'memory', 'clarify']);

/** One Hermes tool call (name, arguments, the folder it runs in) → the gate's calls. */
export function hermesCalls(name, args = {}, cwd = '.') {
  const a = args && typeof args === 'object' ? args : {};
  const file = p => (typeof p === 'string' && p ? path.resolve(cwd, p) : '');
  if (/^mcp__[^_].*__.+/.test(name)) return [{ tool: name, input: a }];
  switch (name) {
    case 'write_file': return [{ tool: 'Write', input: { file_path: file(a.path), content: a.content } }];
    case 'patch': return [{ tool: 'Edit', input: { file_path: file(a.path) } }];
    case 'read_file': return [{ tool: 'Read', input: { file_path: file(a.path) } }];
    case 'search_files': return [{ tool: 'Grep', input: { pattern: a.pattern ?? a.query ?? '', ...(a.path ? { path: file(a.path) } : {}) } }];
    case 'terminal': return [{ tool: 'Bash', input: { command: String(a.command ?? ''), cwd: a.workdir || a.cwd ? file(a.workdir || a.cwd) : path.resolve(cwd) } }];
    // a Python script with Hermes's tools at hand: judged like any script it would run
    case 'execute_code': return [{ tool: 'Bash', input: { command: `python -c ${JSON.stringify(String(a.code ?? ''))}`, cwd: path.resolve(cwd) } }];
    case 'web_extract': {
      const urls = Array.isArray(a.urls) ? a.urls : [a.url].filter(Boolean);
      return (urls.length ? urls : ['']).map(url => ({ tool: 'WebFetch', input: { url: String(url) } }));
    }
    case 'web_search': return [{ tool: 'WebSearch', input: { query: String(a.query ?? '') } }];
    default:
      if (HERMES_INTERNAL.has(name)) return [{ tool: 'TodoWrite', input: {} }];
      return [{ tool: `hermes:${String(name || 'tool').slice(0, 80)}`, input: a }];
  }
}

/** Hermes's pre_tool_call payload → { sessionId (its ACP session), calls }. */
export function hermesHookCalls(payload = {}) {
  return { sessionId: payload.session_id || null, calls: hermesCalls(String(payload.tool_name || ''), payload.tool_input || {}, payload.cwd || '.') };
}

// ── Cursor (engines/cursor.mjs): its preToolUse and beforeMCPExecution hooks ──
/** Orchy's plugin folder for a Cursor run: Cursor names the plugin's MCP servers plugin-<folder>-<server>. */
export const CURSOR_PLUGIN = 'orchy';
export const cursorServer = id => String(id || '').replace(new RegExp(`^plugin-${CURSOR_PLUGIN}-`), '') || 'mcp';
/** Cursor's own folder for a workspace: ~/.cursor/projects/<the workspace path, each run of other characters one dash>. */
export const cursorProjectSlug = dir => path.resolve(String(dir)).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
/** A file Cursor spills a long tool result into (and reads back), in this workspace's own Cursor folder: bookkeeping. */
export function cursorSpill(file, roots = [], home = os.homedir()) {
  if (!file) return false;
  const abs = path.resolve(String(file));
  return roots.some(r => {
    const rel = path.relative(path.join(home, '.cursor', 'projects', cursorProjectSlug(r), 'agent-tools'), abs);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !/[\\/]/.test(rel) && /\.txt$/i.test(rel);
  });
}

/** One Cursor tool call (its hook's tool name and input, the folder it runs in) → the gate's calls. */
export function cursorCalls(name, args = {}, { cwd = '.', roots = [], home = os.homedir() } = {}) {
  const a = args && typeof args === 'object' ? args : {};
  const file = p => (typeof p === 'string' && p ? path.resolve(cwd, p) : '');
  const f = file(a.file_path ?? a.path);
  const here = path.resolve(cwd);
  // a search with no folder covers Cursor's root: in a git repo that is the repo's top (this repo, for a workspace inside it)
  const top = roots[0] ? path.resolve(roots[0]) : here;
  const book = [{ tool: 'TodoWrite', input: {} }];
  // judged in beforeMCPExecution, where Cursor also names the server (its preToolUse names only the tool)
  if (name.startsWith('MCP:')) return book;
  switch (name) {
    case 'Shell': return [{ tool: 'Bash', input: { command: String(a.command ?? ''), cwd: a.cwd ? file(a.cwd) : here } }];
    // typing into a shell it left running: judged like the command it is
    case 'WriteShellStdin': return [{ tool: 'Bash', input: { command: String(a.chars ?? a.input ?? a.text ?? a.data ?? JSON.stringify(a)), cwd: here } }];
    case 'Read': return cursorSpill(f, roots, home) ? book : [{ tool: 'Read', input: { file_path: f } }];
    case 'Write': return cursorSpill(f, roots, home) ? book : [{ tool: 'Write', input: { file_path: f, ...(typeof a.content === 'string' ? { content: a.content } : {}) } }];
    // a delete is judged as the command it would be, so the Deleting decision applies as for any harness
    case 'Delete': return [{ tool: 'Bash', input: { command: `rm -f "${f}"`, cwd: f ? path.dirname(f) : here } }];
    case 'Grep': return [{ tool: 'Grep', input: { pattern: String(a.pattern ?? a.query ?? ''), path: a.path ? file(a.path) : top } }];
    case 'Glob': return [{ tool: 'Glob', input: { pattern: String(a.pattern ?? a.glob_pattern ?? ''), path: a.path || a.target_directory ? file(a.path ?? a.target_directory) : top } }];
    case 'List': case 'LS': return [{ tool: 'LS', input: { path: file(a.path ?? a.target_directory) || top } }];
    case 'ReadLints': return (Array.isArray(a.paths) && a.paths.length ? a.paths : ['.']).map(p => ({ tool: 'Read', input: { file_path: file(String(p)) } }));
    // a subagent: its own tool calls come through these hooks too (checked on the real CLI)
    case 'Task': return [{ tool: 'Task', input: { description: String(a.description ?? ''), prompt: String(a.prompt ?? ''), subagent_type: typeof a.subagent_type === 'string' ? a.subagent_type : '' } }];
    case 'Fetch': return [{ tool: 'WebFetch', input: { url: String(a.url ?? '') } }];
    case 'ListMcpResources': return [{ tool: 'ListMcpResourcesTool', input: a }];
    case 'FetchMcpResource': return [{ tool: `mcp__${cursorServer(a.server)}__read_resource`, input: a }];
    default: return [{ tool: `cursor:${String(name || 'tool').slice(0, 80)}`, input: a }];
  }
}

/** Cursor's hook payload → { sessionId (its chat, = the stream's session_id), calls }. */
export function cursorHookCalls(payload = {}, { home = os.homedir() } = {}) {
  const sessionId = payload.conversation_id || payload.session_id || null;
  const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots.filter(r => typeof r === 'string' && r) : [];
  let input = payload.tool_input;
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { value: input }; } }
  const name = String(payload.tool_name || '');
  if (payload.hook_event_name === 'beforeMCPExecution') {
    return { sessionId, calls: [{ tool: `mcp__${cursorServer(payload.mcp_server_name)}__${name || 'tool'}`, input: input && typeof input === 'object' ? input : {} }] };
  }
  return { sessionId, calls: cursorCalls(name, input, { cwd: payload.cwd || roots[0] || '.', roots, home }) };
}

/** The kind of action a gate call is, so a hook's OK can be matched to the tool the harness then runs. */
export function actionKind(tool) {
  const t = String(tool || '');
  if (t === 'Write' || t === 'Edit' || t === 'MultiEdit' || t === 'NotebookEdit') return 'edit';
  if (t === 'Bash' || t === 'PowerShell') return 'execute';
  if (t === 'WebFetch' || t === 'WebSearch') return 'fetch';
  if (t === 'Read' || t === 'Grep' || t === 'Glob' || t === 'LS') return 'read';
  if (t.startsWith('mcp__')) return t;
  return 'other';
}
