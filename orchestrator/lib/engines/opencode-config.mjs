// OpenCode: the per-run opencode.json Orchy generates, and the checks on it. Pure functions, no I/O.
//
// Safety model: OpenCode asks before it acts only where its config says "ask". So every tool is set to "ask" (the
// ones Orchy never wants it to use are "deny"), and each ask goes to Orchy's gate (opencode-run.mjs). "allow" is
// never written here, and the run refuses to start if the effective config shows an "allow" (permissionLooksSafe).

/** Tool name → rule. `*` is the catch-all (it covers every MCP tool, whose names are `<server>_<tool>`). */
export const OPENCODE_PERMISSION = Object.freeze({
  '*': 'ask',
  // reads ask too (the gate lets the workspace's own files through at once); .env files stay denied, as OpenCode defaults
  read: { '*': 'ask', '*.env': 'deny', '*.env.*': 'deny' },
  edit: 'ask',
  glob: 'ask',
  grep: 'ask',
  list: 'ask',
  bash: 'ask',
  webfetch: 'ask',
  websearch: 'ask',
  lsp: 'ask',
  skill: 'ask',
  external_directory: 'ask',
  // no OpenCode sub-agents (Orchy's heads hand work over with jos_delegate), no question box nobody sees (jos_ask_user
  // is the owner's), and a doom-loop stop is a stop
  task: 'deny',
  question: 'deny',
  doom_loop: 'deny',
});

const sanitize = s => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');

/** Orchy's `.jos/mcp.json` registry entries → OpenCode `mcp` entries. `bridge` = { command, args, env }. */
export function toOpenCodeMcp(servers, names, bridge) {
  const out = {};
  if (bridge) out.jos = { type: 'local', command: [bridge.command, ...(bridge.args || [])], environment: { ...(bridge.env || {}) }, enabled: true, timeout: 60_000 };
  for (const [name, s] of Object.entries(servers || {})) {
    if (!s.enabled || name === 'jos') continue;
    if (names && !names.includes(name)) continue;
    out[name] = s.type === 'stdio'
      ? { type: 'local', command: [s.command, ...(s.args || [])], environment: { ...(s.env || {}) }, enabled: true }
      : { type: 'remote', url: s.url, headers: { ...(s.headers || {}) }, enabled: true };
  }
  return out;
}

/** The whole generated config. No `experimental.mcp_timeout`: the docs don't list that key (an owner's slow answer to jos_ask_user may hit OpenCode's own tool timeout; docs/HARNESSES.md). */
export function buildOpenCodeConfig({ servers, allowed, bridge } = {}) {
  const mcp = toOpenCodeMcp(servers, allowed, bridge);
  return {
    permission: JSON.parse(JSON.stringify(OPENCODE_PERMISSION)),
    mcp,
    share: 'disabled',
    autoupdate: false,
  };
}

/** The part of the config that must win over any opencode.json in the workspace folder (OPENCODE_CONFIG_CONTENT). No secrets in it. */
export function guardConfig() {
  return { permission: JSON.parse(JSON.stringify(OPENCODE_PERMISSION)), share: 'disabled', autoupdate: false };
}

/** Names of the MCP servers in a generated config, longest first (to split `<server>_<tool>`). */
export const serverNamesOf = cfg => Object.keys(cfg?.mcp || {}).sort((a, b) => b.length - a.length);

// OpenCode built-in tool → the Claude-style name policy.mjs understands
const BUILTIN = {
  bash: 'Bash', read: 'Read', glob: 'Glob', grep: 'Grep', list: 'LS', ls: 'LS',
  edit: 'Edit', multiedit: 'Edit', patch: 'Edit', apply_patch: 'Edit', write: 'Write',
  webfetch: 'WebFetch', websearch: 'WebSearch', codesearch: 'WebSearch',
  todowrite: 'TodoWrite', todoread: 'TodoWrite', skill: 'Skill', task: 'Task', lsp: 'Read',
  question: 'AskUserQuestion', external_directory: 'Read',
};

/** OpenCode tool/permission name → policy tool name (`mcp__server__tool` for MCP tools; unknown names pass through and ask the owner). */
export function mapTool(name, serverNames = []) {
  const raw = String(name || '');
  const low = raw.toLowerCase();
  if (BUILTIN[low]) return BUILTIN[low];
  if (low.startsWith('mcp__')) return raw;
  for (const s of serverNames) {
    const p = `${sanitize(s)}_`;
    if (raw.startsWith(p) && raw.length > p.length) return `mcp__${s}__${raw.slice(p.length)}`;
  }
  return raw;
}

/** Does an effective config (as OpenCode reports it) keep everything behind an ask/deny? No `allow` anywhere in `permission`. */
export function permissionLooksSafe(permission) {
  if (!permission || typeof permission !== 'object') return false;
  const bad = v => {
    if (typeof v === 'string') return v === 'allow';
    if (v && typeof v === 'object') return Object.values(v).some(bad);
    return false;
  };
  if (Object.values(permission).some(bad)) return false;
  const star = permission['*'];
  return star === 'ask' || star === 'deny';
}

/** The `--model` value (provider/model) as the prompt body's { providerID, modelID }, or null for "default" (OpenCode picks). */
export function modelParts(model) {
  const m = String(model || '').trim();
  if (!m || m === 'default') return null;
  const i = m.indexOf('/');
  return i > 0 ? { providerID: m.slice(0, i), modelID: m.slice(i + 1) } : null;
}
