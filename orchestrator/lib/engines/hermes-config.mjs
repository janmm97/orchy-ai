// Hermes: the config Orchy forces into the workspace's profile (HERMES_HOME/config.yaml) before every run. Pure functions.
//
// Two layers. Hermes's own approvals are forced to manual (it asks before "dangerous" terminal commands and, over ACP,
// before file edits), the non-interactive modes are denied and nothing is allowlisted. And Orchy's pre_tool_call hook
// (mcp/tool-hook.mjs) is the profile's ONLY pre_tool_call hook, fail_closed: Hermes runs it before every tool call
// (files, commands, web, MCP, code) and blocks when it denies, fails or times out. Checked against Hermes 0.21 on
// Windows (docs/HARNESSES.md). The owner's other hooks (post_tool_call…) stay; no other pre_tool_call hook may, since
// one could rewrite a call's arguments after Orchy approved it.
import YAML from 'yaml';

/** The approvals block Orchy writes. Never `smart` (an LLM decides) or `off` (= --yolo). */
export const HERMES_APPROVALS = Object.freeze({
  mode: 'manual',
  timeout: 300,
  cron_mode: 'deny',
  single_query_mode: 'deny',
  unattended_mode: 'deny',
  mcp_reload_confirm: true,
  destructive_slash_confirm: true,
});

/** Hermes stops a hook after this many seconds (its maximum); the hook answers "still waiting" a little before. */
export const HERMES_HOOK_TIMEOUT_S = 300;

/** The pre_tool_call entry for Orchy's hook (`command` is the full command line, quoted for Hermes's splitter). */
export const orchyHookEntry = command => ({ command, timeout: HERMES_HOOK_TIMEOUT_S, fail_closed: true });

/**
 * The profile's existing config.yaml text (or '') → the text Orchy writes: its keys kept, the approvals forced and,
 * given `hookCommand`, Orchy's hook as the only pre_tool_call hook. `fallbackModel` ({ model, provider? }, the
 * computer's choice) fills in a profile that has no model of its own; one it has is never replaced.
 */
export function buildHermesConfigYaml(existingText = '', { hookCommand = null, fallbackModel = null } = {}) {
  let cur = {};
  try { const j = YAML.parse(existingText || ''); if (j && typeof j === 'object' && !Array.isArray(j)) cur = j; } catch { cur = {}; }
  const prevDeny = Array.isArray(cur.approvals?.deny) ? cur.approvals.deny.filter(x => typeof x === 'string') : [];
  const out = { ...cur, approvals: { ...HERMES_APPROVALS, ...(prevDeny.length ? { deny: prevDeny } : {}) }, command_allowlist: [] };
  if (cur.model == null && fallbackModel?.model != null) {
    out.model = fallbackModel.model;
    if (fallbackModel.provider != null && cur.provider == null) out.provider = fallbackModel.provider;
  }
  delete out.yolo;
  if (hookCommand) {
    const hooks = cur.hooks && typeof cur.hooks === 'object' && !Array.isArray(cur.hooks) ? { ...cur.hooks } : {};
    hooks.pre_tool_call = [orchyHookEntry(hookCommand)];
    out.hooks = hooks;
    out.hooks_auto_accept = true; // Hermes asks once at a terminal before running a new hook; nobody is at one here
  }
  return `# Written by Orchy before every run: approvals are forced to manual, nothing is allowlisted, and Orchy's\n# pre_tool_call hook checks every tool call. Everything else here (model, provider…) is yours; Orchy keeps it.\n${YAML.stringify(out)}`;
}

/** Is a config.yaml text safe by Orchy's rules? (the check the tests and the launcher both use) */
export function hermesConfigLooksSafe(text, { hookCommand = null } = {}) {
  let j;
  try { j = YAML.parse(text || ''); } catch { return false; }
  const a = j?.approvals;
  if (!a || a.mode !== 'manual' || a.unattended_mode !== 'deny' || a.single_query_mode !== 'deny' || a.cron_mode !== 'deny') return false;
  if (Array.isArray(j.command_allowlist) ? j.command_allowlist.length : j.command_allowlist != null) return false;
  if (hookCommand) {
    const pre = j.hooks?.pre_tool_call;
    if (!Array.isArray(pre) || pre.length !== 1) return false;
    const h = pre[0];
    if (h?.command !== hookCommand || h.fail_closed !== true || h.matcher != null || !(h.timeout >= 60)) return false;
    if (j.hooks_auto_accept !== true) return false;
  }
  return !/yolo/i.test(text.replace(/^#.*$/gm, ''));
}

/** Variables that would switch approvals or hooks off must never reach the child (HERMES_SAFE_MODE skips every hook). */
export const HERMES_DROP = ['HERMES_YOLO_MODE', 'HERMES_ACCEPT_HOOKS', 'HERMES_SAFE_MODE', 'HERMES_HOME', 'HERMES_ACP_SKIP_CONFIGURED_MCP'];

/** `hermes status` text → { providers: [...], model } (defensive: the output format isn't documented). */
export function parseHermesStatus(text) {
  const t = String(text || '');
  const providers = new Set();
  let model = null;
  for (const raw of t.split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
    let m = line.match(/^(?:active\s+)?provider\s*[:=]\s*(.+)$/i);
    if (m && !/^(none|not configured|unset|-)$/i.test(m[1].trim())) providers.add(m[1].trim().split(/\s+/)[0].replace(/[,()]/g, ''));
    m = line.match(/^model\s*[:=]\s*(.+)$/i);
    if (m && !model) model = m[1].trim();
    m = line.match(/^[✓✔*•-]?\s*([A-Za-z0-9._-]+)\s*[:\s]+\s*(?:✓|✔|configured|logged in|authenticated|key set|set)\b/i);
    if (m && !/^(provider|model|gateway|status|messaging|scheduled)$/i.test(m[1])) providers.add(m[1]);
  }
  return { providers: [...providers].filter(Boolean), model };
}
