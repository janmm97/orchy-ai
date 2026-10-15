// Hermes: the config Orchy forces into the workspace's profile (HERMES_HOME/config.yaml) before every run. Pure functions.
//
// Hermes asks before running a "dangerous" terminal command (approvals.mode manual); Orchy forces that on, denies the
// non-interactive modes, and never allowlists a command. Honest limit (docs/HARNESSES.md): Hermes' ACP mode only
// bridges those terminal approvals to the client. File writes, patches, web and MCP tools do not ask at all, so the
// engine is registered as NOT gated: it runs only in a workspace whose owner set allowUngated.
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

/** The profile's existing config.yaml text (or '') → the text Orchy writes: its keys kept, the approvals forced. */
export function buildHermesConfigYaml(existingText = '') {
  let cur = {};
  try { const j = YAML.parse(existingText || ''); if (j && typeof j === 'object' && !Array.isArray(j)) cur = j; } catch { cur = {}; }
  const prevDeny = Array.isArray(cur.approvals?.deny) ? cur.approvals.deny.filter(x => typeof x === 'string') : [];
  const out = { ...cur, approvals: { ...HERMES_APPROVALS, ...(prevDeny.length ? { deny: prevDeny } : {}) }, command_allowlist: [] };
  delete out.yolo;
  return `# Written by Orchy before every run: approvals are forced to manual, nothing is allowlisted.\n# Everything else here (model, provider…) is yours; Orchy keeps it.\n${YAML.stringify(out)}`;
}

/** Is a config.yaml text safe by Orchy's rules? (the check the tests and the launcher both use) */
export function hermesConfigLooksSafe(text) {
  let j;
  try { j = YAML.parse(text || ''); } catch { return false; }
  const a = j?.approvals;
  if (!a || a.mode !== 'manual' || a.unattended_mode !== 'deny' || a.single_query_mode !== 'deny' || a.cron_mode !== 'deny') return false;
  if (Array.isArray(j.command_allowlist) ? j.command_allowlist.length : j.command_allowlist != null) return false;
  return !/yolo/i.test(text.replace(/^#.*$/gm, ''));
}

/** Variables that would switch approvals off must never reach the child. */
export const HERMES_DROP = ['HERMES_YOLO_MODE', 'HERMES_ACCEPT_HOOKS', 'HERMES_HOME', 'HERMES_ACP_SKIP_CONFIGURED_MCP'];

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
