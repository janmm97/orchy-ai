// Resources/: every skill, MCP server and CLI a workspace's agents can use, in one place (ORCHY-ORGANIZE-PLAN §3).
//   Resources/Skills/<name>/  the real skill files. Claude Code loads skills from .claude/skills/, Codex and the
//                             `skills` CLI from .agents/skills/: both keep a link per skill pointing here (a junction on
//                             Windows, a folder symlink on macOS and Linux; a marked copy where links can't be made).
//   Resources/MCPs/<name>/    server.json (its .jos/mcp.json entry with every secret blanked) + README.md.
//                             .jos/mcp.json stays the source (the Connections window writes it); sign-in tokens stay
//                             in orchestrator/data/mcp-auth.json and never come here.
//   Resources/CLIs/<name>/    README.md: what it is, how agents call it, which login.
//   Resources/INDEX.md        rewritten from all of the above and the agent files (which agents use what).
//   Resources/Plugins.md      the Claude Code plugins switched on here (they live in Claude's plugin cache).
// Only a workspace that has a Resources/ folder is synced: a new one gets it from scaffold.mjs, an existing one when
// its move is applied. New skills are filed on their own: a real folder in .claude/skills/ or .agents/skills/
// (`npx skills add`, a builder, the owner by hand) moves into Resources/Skills/ and links take its place, but only while
// no run is live in the workspace (`moves: false` otherwise). Nothing is deleted: a skill replaced by a newer copy goes
// to .archive/resources/. Links that lead out of the workspace are left alone, and .clients/ is never touched.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { execFileSync } from 'node:child_process';
import { oneScope } from './workspaces.mjs';
import { ffBins } from './media.mjs';
import { config, saveConfig, ownerName } from './env.mjs';
import { parseAgentMd, homeOf, wsRel, departmentsOf } from './agents.mjs';

export const RESOURCES = 'Resources';
const SKILL_DIRS = [['.claude', 'skills'], ['.agents', 'skills']];
const SAFE = /^[A-Za-z0-9][\w.-]{0,80}$/;
// Windows and macOS compare paths without case by default
const fold = process.platform === 'win32' || process.platform === 'darwin';
const norm = p => (fold ? path.resolve(p).toLowerCase() : path.resolve(p));
const inside = (child, root) => { const c = norm(child), r = norm(root); return c === r || c.startsWith(r + path.sep); };
const lstat = p => { try { return fs.lstatSync(p); } catch { return null; } };
const realOf = p => { try { return fs.realpathSync.native(p); } catch { return null; } };
/** Where a link points (absolute), dangling or not. */
const linkTarget = p => { try { return path.resolve(path.dirname(p), fs.readlinkSync(p)); } catch { return null; } };

export const resourcesDir = ws => path.join(ws.dir, RESOURCES);
export const hasResources = ws => !!ws?.dir && fs.existsSync(resourcesDir(ws));

/** The empty Resources/ for a workspace (scaffold.mjs, and the move that organises an existing one). */
export function ensureResources(ws) {
  for (const d of ['Skills', 'MCPs', 'CLIs']) fs.mkdirSync(path.join(resourcesDir(ws), d), { recursive: true });
  return resourcesDir(ws);
}

function link(at, to) {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  // a junction needs no admin rights on Windows; on macOS and Linux it's a plain folder symlink (Node ignores the type)
  fs.symlinkSync(to, at, process.platform === 'win32' ? 'junction' : 'dir');
}
// Where a link can't be made (a file system without links, a locked-down Windows), the skill is copied instead and the
// copy carries this note, so later syncs know it's Orchy's copy (refreshed from Resources/), not a new skill to file.
export const COPY_NOTE = '.orchy-resources-copy';
const isCopy = p => fs.existsSync(path.join(p, COPY_NOTE));
const mtimeOf = p => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
function copyIn(at, from, name, why) {
  fs.rmSync(at, { recursive: true, force: true });
  fs.cpSync(from, at, { recursive: true, dereference: true });
  fs.writeFileSync(path.join(at, COPY_NOTE), `A copy of Resources/Skills/${name}/, made because a link couldn't be made here (${why}).
Change the skill in Resources/Skills/${name}/: Orchy refreshes this copy from there.
`);
}
function unlink(p) {
  try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); } // a junction to a folder goes with rmdir on some Windows builds
}
const stamp = now => now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
function archive(ws, from, kind, name, now) {
  const dir = path.join(ws.dir, '.archive', 'resources', kind);
  fs.mkdirSync(dir, { recursive: true });
  let to = path.join(dir, `${name}-${stamp(now)}`);
  for (let n = 2; fs.existsSync(to); n++) to = path.join(dir, `${name}-${stamp(now)}-${n}`);
  fs.renameSync(from, to);
  return path.relative(ws.dir, to).split(path.sep).join('/');
}

/** Skills: real folders into Resources/Skills/, a junction to each in .claude/skills/ and .agents/skills/. */
function syncSkills(ws, out, { moves, now }) {
  const home = path.join(resourcesDir(ws), 'Skills');
  fs.mkdirSync(home, { recursive: true });
  const dirs = SKILL_DIRS.map(d => path.join(ws.dir, ...d));
  const names = new Set();
  for (const d of [...dirs, home]) {
    let list = [];
    try { list = fs.readdirSync(d); } catch {}
    for (const n of list) if (!n.startsWith('.') && !n.endsWith('.orchy-link')) names.add(n);
  }
  for (const name of [...names].sort()) {
    if (!SAFE.test(name)) continue;
    const dest = path.join(home, name);
    const destSt = lstat(dest);
    if (destSt && (destSt.isSymbolicLink() || !destSt.isDirectory())) { out.skipped.push(`${name}: Resources/Skills/${name} isn't a plain folder`); continue; }
    const spots = dirs.map(p => ({ at: path.join(p, name), st: lstat(path.join(p, name)) }));
    // a loose file, or a link that leads out of the workspace (a global skill): not ours to move or relink
    if (spots.some(s => s.st && !s.st.isSymbolicLink() && !s.st.isDirectory())) { out.skipped.push(`${name}: a file, not a skill folder`); continue; }
    for (const s of spots) s.copy = !!s.st && !s.st.isSymbolicLink() && isCopy(s.at);
    if (spots.some(s => s.st?.isSymbolicLink() && !inside(linkTarget(s.at) || '', ws.dir))) { out.skipped.push(`${name}: links outside ${ws.name}`); continue; }
    const reals = spots.filter(s => s.st && !s.st.isSymbolicLink() && !s.copy);
    if (reals.length) {
      if (!moves) { out.waiting.push(name); continue; }
      try {
        // the newest real copy wins; an older one (and an older Resources copy) is archived, never deleted
        const keep = reals.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)[0];
        if (destSt) out.archived.push(archive(ws, dest, 'Skills', name, now));
        for (const s of reals) if (s !== keep) out.archived.push(archive(ws, s.at, 'Skills', name, now));
        fs.renameSync(keep.at, dest);
        out.moved.push(name);
      } catch (e) { out.errors.push(`${name}: ${e.code || e.message}`); continue; }
    }
    if (!fs.existsSync(dest)) continue; // only links to something else in the workspace: left as they are
    const want = realOf(dest);
    for (const s of spots) {
      try {
        const st = lstat(s.at);
        const rel = path.relative(ws.dir, s.at).split(path.sep).join('/');
        if (st && !st.isSymbolicLink() && !isCopy(s.at)) continue; // a real folder that couldn't move this time
        if (st?.isSymbolicLink() && realOf(s.at) === want) continue;
        if (st && !st.isSymbolicLink()) {
          // Orchy's own copy: try a link again; if that still can't be made, keep the copy fresh
          try { const tmp = `${s.at}.orchy-link`; link(tmp, dest); fs.rmSync(s.at, { recursive: true, force: true }); fs.renameSync(tmp, s.at); out.linked.push(rel); }
          catch (e) {
            try { fs.rmSync(`${s.at}.orchy-link`, { force: true, recursive: false }); } catch {}
            if (mtimeOf(path.join(dest, 'SKILL.md')) > mtimeOf(path.join(s.at, COPY_NOTE))) { copyIn(s.at, dest, name, e.code || e.message); out.copied.push(rel); }
          }
          continue;
        }
        if (st) unlink(s.at);
        try { link(s.at, dest); out.linked.push(rel); }
        catch (e) { copyIn(s.at, dest, name, e.code || e.message); out.copied.push(rel); }
      } catch (e) { out.errors.push(`${name}: link ${e.code || e.message}`); }
    }
  }
}

const SECRET_KEY = /key|token|secret|pass|auth|bearer|cookie|session|sig|credential/i;
const HIDDEN = '<kept in .jos/mcp.json>';
/** An MCP server's config with every value that could be a secret blanked. */
export function scrubServer(cfg) {
  const c = JSON.parse(JSON.stringify(cfg || {}));
  for (const k of ['headers', 'env']) if (c[k] && typeof c[k] === 'object') for (const h of Object.keys(c[k])) c[k][h] = HIDDEN;
  if (typeof c.url === 'string') {
    try {
      const u = new URL(c.url);
      if (u.username || u.password) { u.username = ''; u.password = ''; }
      for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, HIDDEN);
      c.url = u.toString().replace(encodeURIComponent(HIDDEN), HIDDEN);
    } catch {}
  }
  if (Array.isArray(c.args)) {
    c.args = c.args.map((a, i) => {
      const s = String(a);
      if (/^--?[\w-]+=/.test(s) && SECRET_KEY.test(s.split('=')[0])) return `${s.split('=')[0]}=${HIDDEN}`;
      if (i > 0 && SECRET_KEY.test(String(c.args[i - 1])) && /^--?/.test(String(c.args[i - 1]))) return HIDDEN;
      if (/^(sk|pk|rk|ghp|gho|xox[abp])[-_]/i.test(s) || /^[A-Za-z0-9_\-]{32,}$/.test(s)) return HIDDEN;
      return a;
    });
  }
  for (const k of Object.keys(c)) if (!['type', 'description', 'enabled', 'url', 'command', 'args', 'headers', 'env', 'cwd', 'transport'].includes(k) && SECRET_KEY.test(k)) c[k] = HIDDEN;
  return c;
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function writeIfChanged(p, text) {
  try { if (fs.readFileSync(p, 'utf8') === text) return false; } catch {}
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return true;
}

/** MCP servers: a copy of each .jos/mcp.json (and .mcp.json) entry without secrets, and a README if it has none. */
function syncMcps(ws, out) {
  const servers = [];
  for (const [file, label] of [[path.join(ws.dir, '.jos', 'mcp.json'), '.jos/mcp.json'], [path.join(ws.dir, '.mcp.json'), '.mcp.json']]) {
    const j = readJson(file);
    const list = j?.servers || j?.mcpServers || {};
    for (const [name, cfg] of Object.entries(list)) if (SAFE.test(name) && !servers.some(s => s.name === name)) servers.push({ name, cfg, source: label });
  }
  for (const s of servers) {
    const dir = path.join(resourcesDir(ws), 'MCPs', s.name);
    if (writeIfChanged(path.join(dir, 'server.json'), JSON.stringify(scrubServer(s.cfg), null, 2) + '\n')) out.mcps.push(s.name);
    const readme = path.join(dir, 'README.md');
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme, `# ${s.name}

${s.cfg.description || 'An MCP server this workspace can use.'}

- **How agents reach it:** as the \`${s.name}\` MCP server (tools named \`mcp__${s.name}__…\`), when their agent file lists it.
- **Where it's set up:** \`${s.source}\` (Orchy's Connections window). \`server.json\` here is a copy without secrets.
- **Sign-in:** kept by Orchy (\`orchestrator/data/mcp-auth.json\`), never in this folder. Sign in from Connections.
`);
    }
  }
  return servers;
}

/** The CLIs agents here use: a README for each one Orchy can tell is there (builders add others by hand). */
function syncClis(ws, out) {
  const pkg = readJson(path.join(ws.dir, 'package.json')) || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const one = oneScope(ws);
  const known = [];
  if (fs.existsSync(path.join(ws.dir, '.one'))) {
    known.push(['one', `# One CLI

Reaches 1000+ apps (Gmail, Slack, Notion, Stripe…) through ${ws.name}'s own One login.

- **Call it:** \`one --agent list\`, \`one --agent actions find <platform> "<intent>"\`, read the docs with \`one --agent actions load\`, then \`one --agent actions execute <platform> <actionId> <connectionKey> -d '{…}'\`.
- **Login:** this folder's own (\`.one/\`)${one.own ? '' : ' (not signed in yet: Orchy blocks `one` here until it is)'}. **Never run \`one\` for another workspace**, and never from another workspace's folder.
- Sending, posting, money, calendar changes and deletions ask ${ownerName()} first.
`]);
  }
  if (ffBins()) known.push(['ffmpeg', `# ffmpeg

Cuts, converts and probes video and audio (\`ffmpeg\`, \`ffprobe\`), installed once on this PC.

- **Call it:** \`ffmpeg -i in.mp4 …\` with paths relative to the workspace; quote paths with spaces.
- No login.
`]);
  if (deps.playwright || fs.existsSync(path.join(ws.dir, '.playwright'))) known.push(['playwright', `# Playwright

Drives a real browser for screenshots and page checks (\`npx playwright …\`, or the motion skills' scripts).

- Installed in this workspace's \`node_modules\` (package.json).
- No login; it never signs in to ${ownerName()}'s accounts.
`]);
  if (deps.hyperframes) known.push(['hyperframes', `# HyperFrames

Renders HTML motion into video frames (\`npx hyperframes …\`), used by the motion skills.

- Installed in this workspace's \`node_modules\` (package.json).
`]);
  if (deps.remotion || deps['@remotion/cli']) known.push(['remotion', `# Remotion

Renders React compositions to video (\`npx remotion render …\`).

- Installed in this workspace's \`node_modules\` (package.json).
`]);
  if (fs.existsSync(path.join(ws.dir, '.venv'))) known.push(['python', `# Python

This workspace's own Python in \`.venv/\` (\`.venv/Scripts/python\` on Windows, \`.venv/bin/python\` on macOS and Linux), with the packages its skills need.
`]);
  for (const [name, text] of known) {
    const p = path.join(resourcesDir(ws), 'CLIs', name, 'README.md');
    if (!fs.existsSync(p)) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); out.clis.push(name); }
  }
}

function frontmatter(file, max = 6000) {
  try {
    const text = fs.readFileSync(file, 'utf8').slice(0, max);
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    return { meta: m ? YAML.parse(m[1]) || {} : {}, text };
  } catch { return { meta: {}, text: '' }; }
}
const oneLine = (s, n = 160) => { const t = String(s || '').replace(/\s+/g, ' ').replace(/\|/g, '/').trim(); return t.length > n ? `${t.slice(0, n - 1).trim()}…` : t; };
const mentions = (text, name) => new RegExp(`(^|[^a-z0-9-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9-]|$)`, 'i').test(text);
const dirsIn = p => { try { return fs.readdirSync(p, { withFileTypes: true }).filter(e => !e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink())).map(e => e.name).sort(); } catch { return []; } };

/** INDEX.md and Plugins.md, from what's in Resources/ and who names it in their agent file. */
function writeIndex(ws, servers, out) {
  const root = resourcesDir(ws);
  const agents = [];
  try {
    for (const f of fs.readdirSync(path.join(ws.dir, '.claude', 'agents'))) {
      if (!f.endsWith('.md')) continue;
      const text = fs.readFileSync(path.join(ws.dir, '.claude', 'agents', f), 'utf8');
      const { meta } = frontmatter(path.join(ws.dir, '.claude', 'agents', f), Infinity); // agent frontmatter can run long
      agents.push({ name: String(meta.call_name || meta.display_name || meta.name || f.slice(0, -3)), text, mcp: Array.isArray(meta.mcp_servers) ? meta.mcp_servers.map(String) : [] });
    }
  } catch {}
  agents.sort((a, b) => a.name.localeCompare(b.name));
  const users = (name, extra = () => false) => agents.filter(a => extra(a) || mentions(a.text, name)).map(a => a.name).join(', ') || '—';
  const href = (...parts) => parts.map(encodeURIComponent).join('/');

  const skills = dirsIn(path.join(root, 'Skills')).map(n => {
    const { meta } = frontmatter(path.join(root, 'Skills', n, 'SKILL.md'));
    return `| [${n}](${href('Skills', n, 'SKILL.md')}) | ${oneLine(meta.description) || '—'} | ${users(n)} |`;
  });
  const on = new Map(servers.map(s => [s.name, s]));
  const mcps = dirsIn(path.join(root, 'MCPs')).map(n => {
    const s = on.get(n);
    return `| [${n}](${href('MCPs', n, 'README.md')}) | ${oneLine(s?.cfg?.description) || '—'} | ${s ? (s.cfg.enabled === false ? 'off' : 'on') : 'removed'} | ${users(n, a => a.mcp.includes(n))} |`;
  });
  const clis = dirsIn(path.join(root, 'CLIs')).map(n => {
    let first = '';
    try { first = fs.readFileSync(path.join(root, 'CLIs', n, 'README.md'), 'utf8').split(/\r?\n/).find(l => l.trim() && !l.startsWith('#')) || ''; } catch {}
    const word = n === 'one' ? /\bone --agent\b|\bOne CLI\b/i : null;
    return `| [${n}](${href('CLIs', n, 'README.md')}) | ${oneLine(first) || '—'} | ${users(n, a => !!word && word.test(a.text))} |`;
  });
  const settings = { ...(readJson(path.join(ws.dir, '.claude', 'settings.json'))?.enabledPlugins || {}), ...(readJson(path.join(ws.dir, '.claude', 'settings.local.json'))?.enabledPlugins || {}) };
  const plugins = Object.entries(settings).filter(([, v]) => v === true).map(([k]) => k).sort();
  const pluginsMd = `# Claude Code plugins · ${ws.name}

Switched on in \`.claude/settings.json\`. They live in Claude Code's own plugin folder, so they can't move here: this is the list. Orchy rewrites it.

${plugins.length ? plugins.map(p => `- \`${p}\``).join('\n') : '(none)'}
`;
  if (writeIfChanged(path.join(root, 'Plugins.md'), pluginsMd)) out.index = true;

  const table = (head, rows, empty) => (rows.length ? `${head}\n${rows.join('\n')}` : empty);
  const md = `# Resources · ${ws.name}

Every skill, MCP server and CLI ${ws.name}'s agents can use. Orchy rewrites this file from the folders here and the agent
files (an agent "uses" what its file names), so change those, not this. New skills land here on their own.

## Skills (${skills.length})

${table('| Skill | What it\'s for | Used by |\n|---|---|---|', skills, 'None yet.')}

## MCP servers (${mcps.length})

Set up in Orchy's Connections window; sign-ins stay with Orchy, never here.

${table('| Server | What it\'s for | On | Used by |\n|---|---|---|---|', mcps, 'None yet.')}

## CLIs (${clis.length})

${table('| CLI | What it\'s for | Used by |\n|---|---|---|', clis, 'None yet.')}

## Plugins (${plugins.length})

The Claude Code plugins switched on here: [Plugins.md](Plugins.md).
`;
  if (writeIfChanged(path.join(root, 'INDEX.md'), md)) out.index = true;
}

/**
 * Homes, organised from creation: in a workspace laid out by department, every agent's home and its
 * Tasks/, the generalist's, and each department's Tasks/ exist; a department an agent file names that the workspace
 * doesn't list yet joins `config.json` `departments` (so a builder can open a new department just by using it).
 * Only plain folders inside the workspace (agents.mjs#wsRel); nothing is moved or deleted.
 */
export function syncHomes(ws, out = { homes: [], departments: [] }) {
  if (!departmentsOf(ws).length) return out;
  const dir = path.join(ws.dir, '.claude', 'agents');
  const agents = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const { meta } = parseAgentMd(fs.readFileSync(path.join(dir, f), 'utf8'));
      agents.push({ slug: f.slice(0, -3), home: meta.home ? wsRel(meta.home) : null, department: meta.department ? wsRel(meta.department) : null, callName: meta.call_name ? String(meta.call_name).trim() : null });
    }
  } catch {}
  const known = new Set(departmentsOf(ws).map(d => d.toLowerCase()));
  const fresh = [...new Set(agents.map(a => a.department?.split('/')[0]).filter(d => d && !known.has(d.toLowerCase())))];
  if (fresh.length) {
    const entry = config.workspaces.find(w => w.id === ws.id);
    if (entry) { entry.departments = [...(entry.departments || []), ...fresh]; saveConfig(); }
    ws = { ...ws, departments: [...(ws.departments || []), ...fresh] };
    out.departments.push(...fresh);
  }
  const want = [...departmentsOf(ws).map(d => `${d}/Tasks`), ...agents.map(a => homeOf(ws, a)).filter(Boolean).map(h => `${h}/Tasks`)];
  if (ws.generalistHome && wsRel(ws.generalistHome)) want.push(`${wsRel(ws.generalistHome)}/Tasks`);
  for (const rel of [...new Set(want)]) {
    const p = path.join(ws.dir, ...rel.split('/'));
    if (fs.existsSync(p)) continue;
    try { fs.mkdirSync(p, { recursive: true }); out.homes.push(rel); } catch (e) { out.errors?.push(`${rel}: ${e.code || e.message}`); }
  }
  return out;
}

/**
 * Bring a workspace's Resources/ up to date. `moves: false` (a run is live here) only adds missing links and the
 * index; real skill folders wait for the next idle sync. `index: 'auto'` rewrites INDEX.md when something changed
 * or it's missing; true always checks it (it's only written when its text changes).
 */
export function syncResources(ws, { moves = true, index = true, now = new Date() } = {}) {
  const out = { workspace: ws?.id, moved: [], linked: [], copied: [], archived: [], waiting: [], skipped: [], mcps: [], clis: [], homes: [], departments: [], index: false, errors: [] };
  if (!hasResources(ws)) return { ...out, skippedWorkspace: true };
  ensureResources(ws);
  syncHomes(ws, out);
  syncSkills(ws, out, { moves, now });
  const servers = syncMcps(ws, out);
  syncClis(ws, out);
  const changed = out.moved.length || out.linked.length || out.copied.length || out.mcps.length || out.clis.length;
  if (index === true || changed || !fs.existsSync(path.join(resourcesDir(ws), 'INDEX.md'))) writeIndex(ws, servers, out);
  return out;
}

// What a tidy top level hides on Windows in a workspace laid out by department (departments, Resources/, Uploads/
// and the instruction files show; on macOS and Linux the dot folders are hidden already and nothing else is touched).
// Folders only: Windows refuses a plain overwrite of a HIDDEN file (EPERM), so files that editors and tools rewrite
// (CLAUDE.md, AGENTS.md, package*.json, .mcp.json…) stay visible. The 10-minute sync puts a dropped flag back.
const HIDE_AT_ROOT = ['.claude', '.agents', '.codex', '.jos', '.one', '.clients', '.impeccable', '.playwright', '.venv', '.archive', 'node_modules', 'Tasks'];
export function keepHidden(ws) {
  if (process.platform !== 'win32' || !departmentsOf(ws).length) return [];
  const fixed = [];
  for (const n of HIDE_AT_ROOT) {
    const p = path.join(ws.dir, n);
    const st = lstat(p);
    if (!st) continue;
    try {
      const link = st.isSymbolicLink() ? ['/l'] : [];
      // attrib prints the flags in the first columns ("A    H       C:\…"), then the path
      if (/H/.test(execFileSync('attrib', [...link, p], { encoding: 'utf8' }).slice(0, 12))) continue;
      execFileSync('attrib', ['+h', ...link, p], { stdio: 'ignore' });
      fixed.push(n);
    } catch {}
  }
  return fixed;
}

/** Every workspace with a Resources/ folder (boot and every 10 minutes); `busy(ws)` = a run is live there. */
export function syncAllResources(list, { busy = () => false, log = console.log } = {}) {
  const res = [];
  for (const ws of list) {
    if (!hasResources(ws)) continue;
    try {
      const r = syncResources(ws, { moves: !busy(ws) });
      r.hidden = keepHidden(ws);
      if (r.moved.length || r.archived.length || r.errors.length) log(`[resources] ${ws.name}: ${r.moved.length} filed, ${r.linked.length} linked, ${r.archived.length} archived${r.errors.length ? `, errors: ${r.errors.join('; ')}` : ''}`);
      res.push(r);
    } catch (e) { log(`[resources] ${ws.name}: ${e.message}`); }
  }
  return res;
}
