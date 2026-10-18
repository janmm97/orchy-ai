// Agents are Claude Code subagent Markdown files in <workspace>/.claude/agents/*.md,
// with extra Orchy frontmatter (display_name, role, connections, limitations...).
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { workspaces, workspace, runtimes, runtimeLabel, modelsFor } from './workspaces.mjs';
import { describeSchedule } from './scheduler.mjs';

export const BUILDER_SLUG = 'agent-builder';

function agentsDir(ws) { return path.join(ws.dir, '.claude', 'agents'); }

/** A C-suite agent: a department head (it has a team), a "Chief …" or a CxO. `executive: true|false` in the frontmatter overrides. */
export function isExecutive(role, displayName, team = []) {
  if (team.length) return true;
  return [role, displayName].some(t => /\bchief\b/i.test(String(t || '')) || /\b(CEO|COO|CFO|CTO|CMO|CIO|CISO|CPO|CHRO|CDO|CCO)\b/.test(String(t || '')));
}

export function parseAgentMd(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text, error: 'Missing frontmatter (--- block)' };
  try {
    return { meta: YAML.parse(m[1]) || {}, body: m[2] };
  } catch (e) {
    return { meta: {}, body: m[2], error: 'Frontmatter is not valid YAML: ' + e.message };
  }
}

function section(body, heading) {
  const re = new RegExp(`^##\\s+${heading}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, 'im');
  return body.match(re)?.[1]?.trim() || '';
}

function summarize(ws, file) {
  const slug = path.basename(file, '.md');
  const text = fs.readFileSync(file, 'utf8');
  const stat = fs.statSync(file);
  const { meta, body, error } = parseAgentMd(text);
  const connections = Array.isArray(meta.connections) ? meta.connections : [];
  // `engine` pins the agent to an engine other than the workspace's (e.g. Codex in a Claude workspace)
  const engine = meta.engine ? String(meta.engine).toLowerCase() : null;
  const engineError = engine && !runtimes()[engine] ? `Unknown engine "${meta.engine}" (use ${Object.keys(runtimes()).join(' or ')})` : null;
  const pinned = engine && !engineError ? engine : null;
  // Claude Code finds a subagent by its `name`, Orchy (--agent, the Agent/Task rules) by the file name
  const nameError = meta.name && String(meta.name).trim() !== slug ? `Frontmatter name "${meta.name}" doesn't match the file name ${slug}.md: rename one so they're the same` : null;
  const team = slug !== BUILDER_SLUG && Array.isArray(meta.team) ? meta.team.map(s => String(s).trim()).filter(Boolean) : [];
  const role = meta.role || (slug === BUILDER_SLUG ? 'Chief of AI Agents' : '');
  return {
    workspace: ws.id,
    slug,
    name: meta.name || slug,
    displayName: meta.display_name || meta.name || slug,
    description: meta.description || '',
    role,
    // the human first name the owner calls it by (its voice agent's name); the builder picks it
    callName: meta.call_name ? String(meta.call_name).trim() : null,
    gender: ['female', 'male'].includes(String(meta.gender).toLowerCase()) ? String(meta.gender).toLowerCase() : null,
    identity: meta.identity || section(body, 'Identity').split('\n')[0] || '',
    model: meta.model || 'inherit',
    engine: pinned,
    engineLabel: runtimeLabel(pinned || ws.runtime),
    effort: meta.effort ? String(meta.effort).toLowerCase() : null,
    models: modelsFor(ws, pinned || ws.runtime),
    connections: connections.map(c => (typeof c === 'string' ? { key: c } : c)),
    mcpServers: Array.isArray(meta.mcp_servers) ? meta.mcp_servers : [],
    limitations: Array.isArray(meta.limitations) ? meta.limitations : [],
    // a department head's team: the agents it may hand work to (delegation.mjs). Builders never delegate.
    team,
    // C-suite: may start a huddle from its own runs (huddle.mjs#partnersFor). Builders build, they don't huddle on their own.
    executive: slug !== BUILDER_SLUG && (typeof meta.executive === 'boolean' ? meta.executive : isExecutive(role, meta.display_name, team)),
    // where it works: its department and its home folder, both relative to the workspace (`Marketing/Writer`)
    department: meta.department ? wsRel(meta.department) : null,
    home: meta.home ? wsRel(meta.home) : null,
    schedule: meta.schedule || null,
    scheduleTask: meta.schedule_task || null,
    scheduleText: meta.schedule ? describeSchedule(meta.schedule) || `unreadable schedule: ${meta.schedule}` : null,
    created: meta.created || stat.birthtime.toISOString().slice(0, 10),
    createdBy: meta.created_by || null,
    version: meta.version || 1,
    isBuilder: slug === BUILDER_SLUG,
    updatedAt: stat.mtime.toISOString(),
    error: error || engineError || nameError || null,
  };
}

/**
 * A folder inside the workspace as `Marketing/Writer` (forward slashes), or null: nothing absolute, no climbing out,
 * no hidden folders (so never `.clients/`, `.claude/`), and never Resources/ or Uploads/.
 */
export function wsRel(p) {
  const raw = String(p || '').trim();
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  if (!parts.length || path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) return null;
  if (parts.some(s => s === '..' || s.startsWith('.') || /[\x00-\x1f<>:"|?*]/.test(s) || /[ .]$/.test(s))) return null;
  if (/^(resources|uploads)$/i.test(parts[0])) return null;
  return parts.join('/');
}

/** The workspace's department folders (`config.json` `workspaces[].departments`), checked. */
export const departmentsOf = ws => (Array.isArray(ws?.departments) ? ws.departments.map(wsRel).filter(d => d && !d.includes('/')) : []);

/**
 * Where an agent keeps its work, relative to the workspace (`Marketing/Writer`), or null for the flat layout
 * (`Tasks/` at the top). Its frontmatter `home`, else `<department>/<call name>`, else a department folder that
 * already holds a folder of its call name or slug (a workspace organised before its agent files name a home).
 * No agent = the generalist (`workspaces[].generalistHome`).
 */
export function homeOf(ws, agent) {
  if (!agent) return ws.generalistHome ? wsRel(ws.generalistHome) : null;
  if (agent.home) return agent.home;
  const names = [...new Set([agent.callName, agent.slug].filter(Boolean))];
  if (agent.department) return wsRel(`${agent.department}/${names[0]}`);
  for (const d of departmentsOf(ws)) {
    for (const n of names) if (wsRel(n) && fs.existsSync(path.join(ws.dir, d, n))) return `${d}/${n}`;
  }
  return null;
}

/** The department an agent sits in (its frontmatter, else its home's first folder), or null. */
export function departmentOf(ws, agent) {
  if (agent?.department) return agent.department.split('/')[0];
  const home = homeOf(ws, agent);
  return home && home.includes('/') ? home.split('/')[0] : null;
}

export function listAgents(wsId) {
  const list = [];
  for (const ws of wsId ? [workspace(wsId)] : workspaces()) {
    const dir = agentsDir(ws);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      try {
        const a = summarize(ws, path.join(dir, f));
        // the department it sits in (frontmatter, else its home folder), for the Workspaces window's groups
        a.dept = departmentsOf(ws).length ? departmentOf(ws, a) : null;
        list.push(a);
      } catch (e) { console.warn('[agents] skip', f, e.message); }
    }
  }
  return list.sort((a, b) => (b.isBuilder - a.isBuilder) || a.displayName.localeCompare(b.displayName));
}

export function getAgent(wsId, slug) {
  const ws = workspace(wsId);
  const file = path.join(agentsDir(ws), `${safeSlug(slug)}.md`);
  if (!fs.existsSync(file)) throw Object.assign(new Error(`No agent "${slug}" in ${ws.name}`), { status: 404 });
  return { ...summarize(ws, file), markdown: fs.readFileSync(file, 'utf8'), path: file };
}

export function saveAgent(wsId, slug, markdown) {
  const ws = workspace(wsId);
  const { error, meta } = parseAgentMd(markdown);
  if (error) throw Object.assign(new Error(error), { status: 400 });
  if (!meta.name || !meta.description) throw Object.assign(new Error('Frontmatter needs at least name and description'), { status: 400 });
  if (meta.engine && !runtimes()[String(meta.engine).toLowerCase()]) throw Object.assign(new Error(`Unknown engine "${meta.engine}" (use ${Object.keys(runtimes()).join(' or ')})`), { status: 400 });
  const file = path.join(agentsDir(ws), `${safeSlug(slug)}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, markdown);
  return getAgent(wsId, slug);
}

export function deleteAgent(wsId, slug) {
  if (slug === BUILDER_SLUG) throw Object.assign(new Error('The Chief of AI Agents cannot be deleted'), { status: 400 });
  const ws = workspace(wsId);
  const file = path.join(agentsDir(ws), `${safeSlug(slug)}.md`);
  const retired = path.join(ws.dir, '.jos', 'retired');
  fs.mkdirSync(retired, { recursive: true });
  if (fs.existsSync(file)) fs.renameSync(file, path.join(retired, `${safeSlug(slug)}-${Date.now()}.md`));
}

export function safeSlug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'agent';
}

/** Snapshot of agent files, used to detect what a builder run created or changed. */
export function agentFingerprint(wsId) {
  const out = {};
  for (const a of listAgents(wsId)) out[a.slug] = a.updatedAt;
  return out;
}
