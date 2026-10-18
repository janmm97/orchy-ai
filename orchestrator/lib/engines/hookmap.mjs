// What a harness's pre-tool hook sends → the calls Orchy's gate judges ({ tool, input } in policy.mjs's words).
// Pure and dependency-free: the hook process (mcp/tool-hook.mjs) loads it on every tool call, and the adapters use it
// for their feeds. Anything not recognised keeps a name policy.mjs doesn't know, which always asks the owner.
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
