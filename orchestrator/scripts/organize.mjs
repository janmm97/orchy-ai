// Lays an existing workspace out by department, from a map the owner wrote (README → "Departments, agent homes and
// Resources"). A new workspace starts organised; this is for one that grew up flat. Stop Orchy first.
//   node orchestrator/scripts/organize.mjs plan     orchestrator/data/organize/<ws>-<date>.map.json
//       dry run: writes <ws>-<date>.manifest.json (every step, in order) and .manifest.md (to read). Touches nothing.
//   node orchestrator/scripts/organize.mjs apply    orchestrator/data/organize/<ws>-<date>.manifest.json
//       refuses while Orchy answers on its port (it rewrites state.json and config.json). Checks the whole plan first,
//       then runs it step by step, journalling each one (<…>.journal.json). Stops at the first failure.
//   node orchestrator/scripts/organize.mjs rollback orchestrator/data/organize/<ws>-<date>.manifest.json
//       undoes the journal, newest step first (moves back, links removed, config + state restored from backups).
// Nothing is deleted: clutter goes to the hidden .archive/<date>/; every moved folder leaves a hidden link at its old
// name (a junction on Windows, a folder symlink on macOS and Linux), so old paths keep working; state.json is backed
// up first. Never touches .clients/ or another workspace.
//
// The map (JSON):
//   { "workspace": "acme", "date": "2026-10-18",
//     "departments": { "Marketing": ["writer", "designer"], "Operations": ["agent-builder"] },   every agent file, once
//     "generalistHome": "Operations/Generalist",
//     "shared": { "studio": "Marketing/Studio" },          top-level folders that become a department's shared folder
//     "agentFolders": ["writer"],                          old <slug>/ folders (reference/ …) that become the agent's home
//     "rootFiles": { "brand.md": "Marketing/brand.md" },   loose top-level files to move (no link left at the old name)
//     "archive": ["scratch", "tmp"],                       clutter, to .archive/<date>/
//     "taskOverrides": { "<task folder>": "<agent slug>" | "dept:<Department>" | "archive" },
//     "taskFiles": { "<loose file in Tasks/>": "<task folder it belongs to>" },
//     "retiredOwners": { "<retired slug>": "<slug that takes its old tasks>" },
//     "unmatchedTasks": "Operations/Tasks",
//     "hideAtRoot": [".claude", ".agents", ".jos", ".one", ".clients", "CLAUDE.md", "AGENTS.md", "Tasks"] }
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ORGANIZE_TEST=<dir> (a rehearsal on a throwaway copy): the workspaces, config.json and data/ under <dir>, no Orchy check
const TEST = process.env.ORGANIZE_TEST ? path.resolve(process.env.ORGANIZE_TEST) : null;
const ORCH = TEST ? path.join(TEST, 'orchestrator') : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(ORCH, '..');
const DATA = path.join(ORCH, 'data');
const CONFIG = path.join(ORCH, 'config.json');
const STATE = path.join(DATA, 'state.json');
const PORT = Number(process.env.PORT) || 8008;
const WIN = process.platform === 'win32';
// Windows and macOS see "marketing" and "Marketing" as one name; Linux sees two
const FOLD = WIN || process.platform === 'darwin';
const key = p => (FOLD ? String(p).toLowerCase() : String(p));
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
const writeJson = (p, j) => fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
const posix = p => p.split(path.sep).join('/');
const lstat = p => { try { return fs.lstatSync(p); } catch { return null; } };
const die = msg => { console.error(`organize: ${msg}`); process.exit(1); };
const linkDir = (to, at) => fs.symlinkSync(to, at, WIN ? 'junction' : 'dir');

// ── plan ──
function frontmatter(file) {
  const m = fs.readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const get = k => m?.[1].match(new RegExp(`^${k}:[ \\t]*"?([^"\\r\\n]+)"?`, 'm'))?.[1].trim();
  return { call: get('call_name'), name: get('display_name') || get('name') };
}

function plan(mapFile) {
  const map = readJson(mapFile);
  const cfg = readJson(CONFIG);
  const wsCfg = cfg.workspaces.find(w => w.id === map.workspace) || die(`no workspace ${map.workspace}`);
  const W = path.join(ROOT, wsCfg.folder);
  const arch = `.archive/${map.date}`;
  map.shared ||= {}; map.archive ||= []; map.hideAtRoot ||= [];
  map.generalistHome ||= 'Operations/Generalist';
  map.unmatchedTasks ||= `${map.generalistHome.split('/')[0]}/Tasks`;
  const ops = [];
  const note = [];
  const exists = rel => !!lstat(path.join(W, rel));
  const mkdir = rel => { if (!ops.some(o => o.op === 'mkdir' && o.path === rel)) ops.push({ op: 'mkdir', path: rel }); };
  const mkdirs = rel => { const parts = rel.split('/'); for (let i = 1; i <= parts.length; i++) if (!exists(parts.slice(0, i).join('/'))) mkdir(parts.slice(0, i).join('/')); };

  // homes
  const home = {}, deptOf = {};
  for (const [dept, slugs] of Object.entries(map.departments || {})) {
    for (const slug of slugs) {
      const f = path.join(W, '.claude', 'agents', `${slug}.md`);
      if (!fs.existsSync(f)) die(`no agent file ${slug}.md`);
      const { call } = frontmatter(f);
      home[slug] = `${dept}/${call || slug}`;
      deptOf[slug] = dept;
    }
  }
  const agentFiles = fs.readdirSync(path.join(W, '.claude', 'agents')).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3));
  const homeless = agentFiles.filter(s => !home[s]);
  if (homeless.length) die(`agents without a department: ${homeless.join(', ')}`);
  const owner = s => map.retiredOwners?.[s] || s;
  const rootOf = s => (s === 'generalist' || !s ? `${map.generalistHome}/Tasks` : home[owner(s)] ? `${home[owner(s)]}/Tasks` : null);
  const deptRootOf = s => (s === 'generalist' || !s ? `${map.generalistHome.split('/')[0]}/Tasks` : deptOf[owner(s)] ? `${deptOf[owner(s)]}/Tasks` : null);

  // 1. departments, homes, Tasks folders, the archive
  for (const dept of Object.keys(map.departments)) {
    if (exists(dept) && !Object.keys(map.shared).some(k => key(k) === key(dept))) die(`${dept} already exists`);
  }
  // A top-level folder whose name differs from a department's only by case ("marketing" / "Marketing") BECOMES the
  // department folder where names fold (Windows, macOS): renamed in place through a temporary name, so a syncing
  // client (OneDrive, Dropbox) sees one folder renamed rather than two folders that clash. Its old entries move into
  // the shared folder in step 3.
  const clash = FOLD ? Object.keys(map.shared).filter(k => Object.keys(map.departments).some(d => key(d) === key(k))) : [];
  const clashKids = {};
  for (const k of clash) {
    const dept = Object.keys(map.departments).find(d => key(d) === key(k));
    clashKids[k] = fs.readdirSync(path.join(W, k), { withFileTypes: true });
    const taken = new Set(['tasks', map.shared[k].split('/').slice(1).join('/').toLowerCase(), ...Object.values(home).filter(h => h.startsWith(`${dept}/`)).map(h => h.split('/')[1].toLowerCase())]);
    const bad = clashKids[k].filter(e => taken.has(e.name.toLowerCase()));
    if (bad.length) die(`${k}/ holds ${bad.map(e => e.name).join(', ')}, a name the ${dept} folder needs`);
    ops.push({ op: 'move', from: k, to: `.organize-case-${k}`, why: `${k} becomes ${dept} (renamed in place)` }, { op: 'move', from: `.organize-case-${k}`, to: dept });
  }
  mkdirs(arch);
  for (const dept of Object.keys(map.departments)) { mkdirs(`${dept}/Tasks`); }
  mkdirs(`${map.generalistHome}/Tasks`);

  // 2. agent folders (reference/ …) become homes; agents without one get an empty home
  for (const slug of Object.keys(home)) {
    if ((map.agentFolders || []).includes(slug) && exists(slug)) {
      ops.push({ op: 'move', from: slug, to: home[slug], why: `${slug}'s folder becomes its home` });
      ops.push({ op: 'junction', at: slug, to: home[slug] }, { op: 'hide', path: slug });
    } else mkdirs(home[slug]);
    mkdirs(`${home[slug]}/Tasks`);
  }

  // 3. shared department folders
  for (const [from, to] of Object.entries(map.shared)) {
    if (!exists(from)) { note.push(`${from} isn't there: skipped`); continue; }
    if (clash.includes(from)) {
      // the old name now is the department folder: each old entry moves into the shared folder, and a link per entry
      // keeps `${from}/<x>` working (a folder link only points at a folder: a file gets a hard link, left visible,
      // because a hidden file refuses ordinary overwrites on Windows and a hard link shares the flag)
      const dept = to.split('/')[0];
      for (const e of clashKids[from]) {
        const at = `${dept}/${e.name}`;
        ops.push({ op: 'move', from: at, to: `${to}/${e.name}`, why: e === clashKids[from][0] ? `${from}/ → ${to}/` : undefined });
        ops.push({ op: e.isDirectory() ? 'junction' : 'hardlink', at, to: `${to}/${e.name}` }, ...(e.isDirectory() ? [{ op: 'hide', path: at }] : []));
      }
    } else {
      ops.push({ op: 'move', from, to, why: `${from}/ → ${to}/` });
      ops.push({ op: 'junction', at: from, to }, { op: 'hide', path: from });
    }
  }

  // 4. root files to a department (no link at the old name: a hidden one would hide the real file too)
  for (const [from, to] of Object.entries(map.rootFiles || {})) {
    if (!exists(from)) continue;
    ops.push({ op: 'move', from, to, why: `${from} → ${to} (old name not kept)` });
  }

  // 5. old Tasks history to whoever ran it
  const st = fs.existsSync(STATE) ? readJson(STATE) : {};
  const runsBy = {};
  for (const r of Object.values(st.runs || {})) if (r.workspace === map.workspace && r.taskDir && !r.client && !r.taskRoot) (runsBy[r.taskDir] ||= []).push(r);
  const hud = Object.fromEntries(Object.values(st.huddles || {}).filter(h => h.workspace === map.workspace && h.taskDir && !h.taskRoot).map(h => [h.taskDir, h]));
  const mis = Object.fromEntries(Object.values(st.missions || {}).filter(m => m.workspace === map.workspace && m.taskDir && !m.taskRoot).map(m => [m.taskDir, m]));
  const taskMoves = {};
  const tasks = [];
  if (exists('Tasks')) {
    for (const e of fs.readdirSync(path.join(W, 'Tasks'), { withFileTypes: true })) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      const d = e.name, o = map.taskOverrides?.[d];
      let dest, why;
      if (o === 'archive') { dest = `${arch}/Tasks`; why = 'scratch'; }
      else if (o?.startsWith('dept:')) { dest = `${o.slice(5)}/Tasks`; why = 'by hand'; }
      else if (o) { dest = rootOf(o); why = `by hand: ${o}`; }
      else if (hud[d]) { dest = deptRootOf(hud[d].agents?.[0]?.slug); why = `huddle led by ${hud[d].agents?.[0]?.name || hud[d].agents?.[0]?.slug}`; }
      else if (mis[d]) { dest = deptRootOf(mis[d].steps?.[0]?.agent); why = `mission, first step ${mis[d].steps?.[0]?.agent}`; }
      else if (runsBy[d]) { const first = runsBy[d].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))[0]; dest = rootOf(first.agentSlug || 'generalist'); why = `run by ${first.agentName}`; }
      dest ||= map.unmatchedTasks; why ||= 'no record of who ran it';
      tasks.push({ dir: d, dest, why });
      ops.push({ op: 'move', from: `Tasks/${d}`, to: `${dest}/${d}` }, { op: 'junction', at: `Tasks/${d}`, to: `${dest}/${d}` });
      if (!dest.startsWith('.archive')) taskMoves[d] = dest;
    }
    for (const [f, d] of Object.entries(map.taskFiles || {})) if (exists(`Tasks/${f}`) && taskMoves[d]) ops.push({ op: 'move', from: `Tasks/${f}`, to: `${taskMoves[d]}/${d}/${f}` });
  }
  for (const t of tasks) if (!t.dest.startsWith('.archive')) mkdirs(t.dest);

  // 6. clutter
  for (const a of map.archive) {
    if (!exists(a)) { note.push(`${a} isn't there: skipped`); continue; }
    const dir = lstat(path.join(W, a)).isDirectory();
    ops.push({ op: 'move', from: a, to: `${arch}/${a}`, why: 'clutter' });
    if (dir) ops.push({ op: 'junction', at: a, to: `${arch}/${a}` }, { op: 'hide', path: a });
  }

  // 7. Resources: every real skill folder into Resources/Skills, links in .claude/skills and .agents/skills
  mkdirs('Resources/Skills'); mkdirs('Resources/MCPs'); mkdirs('Resources/CLIs');
  const skillDirs = ['.claude/skills', '.agents/skills'];
  const names = new Set();
  for (const d of skillDirs) if (exists(d)) for (const n of fs.readdirSync(path.join(W, d))) if (!n.startsWith('.')) names.add(n);
  const skills = [];
  for (const n of [...names].sort()) {
    const spots = skillDirs.map(d => ({ rel: `${d}/${n}`, st: lstat(path.join(W, d, n)) }));
    if (spots.some(s => s.st && !s.st.isSymbolicLink() && !s.st.isDirectory())) { note.push(`skill ${n}: a file, left alone`); continue; }
    const reals = spots.filter(s => s.st && !s.st.isSymbolicLink()).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    const links = spots.filter(s => s.st?.isSymbolicLink());
    const target = s => path.resolve(path.dirname(path.join(W, s.rel)), fs.readlinkSync(path.join(W, s.rel)));
    if (links.some(s => !key(target(s)).startsWith(key(W) + path.sep))) { note.push(`skill ${n}: links outside the workspace, left alone`); continue; }
    if (!reals.length) { note.push(`skill ${n}: only links, left alone`); continue; }
    for (const s of links) ops.push({ op: 'unlink', path: s.rel, target: posix(path.relative(W, target(s))) });
    ops.push({ op: 'move', from: reals[0].rel, to: `Resources/Skills/${n}` });
    for (const s of reals.slice(1)) ops.push({ op: 'move', from: s.rel, to: `${arch}/skills-duplicates/${s.rel.split('/')[0]}-${n}` });
    for (const s of spots) ops.push({ op: 'junction', at: s.rel, to: `Resources/Skills/${n}` });
    skills.push(n);
  }
  ops.push({ op: 'resources' });

  // 8. hidden at the top, then config and Orchy's records
  // (a folder the steps above create on the way, like .agents/ for the skill links, counts too)
  const madeHere = h => ops.some(o => [o.path, o.at, o.to].some(p => p && (p === h || p.startsWith(`${h}/`))));
  // folders and the instruction files only: tools rewrite package*.json, skills-lock.json, .mcp.json, and a hidden file refuses that on Windows
  const hideOk = h => /^(CLAUDE|AGENTS|GEMINI).md$/i.test(h) || !exists(h) || lstat(path.join(W, h)).isDirectory() || lstat(path.join(W, h)).isSymbolicLink();
  for (const h of map.hideAtRoot) if ((exists(h) || madeHere(h)) && hideOk(h)) ops.push({ op: 'hide', path: h });
  if (!map.hideAtRoot.includes('.archive')) ops.push({ op: 'hide', path: '.archive' });
  const prefixes = [];
  for (const slug of map.agentFolders || []) if (home[slug]) prefixes.push([`${slug}/`, `${home[slug]}/`]);
  for (const [from, to] of Object.entries(map.shared)) prefixes.push([`${from}/`, `${to}/`]);
  for (const [from, to] of Object.entries(map.rootFiles || {})) prefixes.push([from, to]);
  for (const [d, dest] of Object.entries(taskMoves)) prefixes.push([`Tasks/${d}/`, `${dest}/${d}/`]);
  for (const [f, d] of Object.entries(map.taskFiles || {})) if (taskMoves[d]) prefixes.push([`Tasks/${f}`, `${taskMoves[d]}/${d}/${f}`]);
  ops.push({ op: 'config', set: { departments: Object.keys(map.departments), generalistHome: map.generalistHome } });
  ops.push({ op: 'state', taskRoots: taskMoves, prefixes });

  const manifest = { workspace: map.workspace, name: wsCfg.name, dir: W, date: map.date, createdAt: new Date().toISOString(), map: path.basename(mapFile), home, tasks, skills: skills.length, notes: note, ops };
  const base = mapFile.replace(/\.map\.json$/, '');
  writeJson(`${base}.manifest.json`, manifest);
  fs.writeFileSync(`${base}.manifest.md`, manifestMd(manifest, map));
  console.log(`plan: ${ops.length} steps → ${base}.manifest.json / .md`);
  return manifest;
}

function manifestMd(m, map) {
  const by = {};
  for (const t of m.tasks) (by[t.dest] ||= []).push(t);
  const moves = m.ops.filter(o => o.op === 'move' && !o.from.startsWith('Tasks/') && !/^\.(claude|agents)\/skills\//.test(o.from) && !o.to.includes('.organize-case-'));
  return `# ${m.name || m.workspace} organize manifest · ${m.date}

Dry run: nothing has moved. ${m.ops.length} steps. Every moved folder leaves a hidden link at its old name, so old
paths keep working. Nothing is deleted: clutter goes to the hidden \`.archive/${m.date}/\`.

## Top level after the move
Visible: ${Object.keys(map.departments).map(d => `\`${d}/\``).join(', ')}, \`Resources/\`, \`Uploads/\`.
Hidden: ${map.hideAtRoot.map(h => `\`${h}\``).join(', ') || '(nothing listed)'}, and the old names below.

## Agent homes
| Department | Agent | Home |
|---|---|---|
${Object.entries(map.departments).flatMap(([d, slugs]) => slugs.map(s => `| ${d} | ${s} | \`${m.home[s]}/\`${(map.agentFolders || []).includes(s) ? ` (from \`${s}/\`)` : ''} |`)).join('\n')}
| ${map.generalistHome.split('/')[0]} | generalist | \`${map.generalistHome}/\` |

## Folders
| From | To |
|---|---|
${moves.map(o => `| \`${o.from}\` | \`${o.to}\`${o.why === 'clutter' ? ' (archive)' : ''} |`).join('\n')}

## Old task folders (${m.tasks.length})
${Object.entries(by).sort().map(([dest, ts]) => `### \`${dest}/\` (${ts.length})\n${ts.map(t => `- ${t.dir} · ${t.why}`).join('\n')}`).join('\n\n')}

## Resources
${m.skills} skill folders move into \`Resources/Skills/\`, with links in \`.claude/skills/\` and \`.agents/skills/\`.
Then Orchy writes the MCP copies (no secrets), CLI notes, \`INDEX.md\` and \`Plugins.md\`.

## Orchy's records
config.json gets \`departments\` and \`generalistHome\`; state.json (backed up first) gets \`taskRoot\` on the old
runs, huddles and missions whose folders moved, and the file registry follows the moves.
${m.notes.length ? `\n## Notes\n${m.notes.map(n => `- ${n}`).join('\n')}\n` : ''}`;
}

// ── apply / rollback ──
const idFor = (wsId, rel) => `art_${crypto.createHash('sha1').update(`${wsId}\0${String(rel).toLowerCase()}`).digest('hex').slice(0, 16)}`;
async function orchyUp() {
  if (TEST) return false;
  // any answer at all (even a refusal) means it's up; only a refused connection means it's down
  try { await fetch(`http://127.0.0.1:${PORT}/api/state`, { signal: AbortSignal.timeout(3000) }); return true; } catch (e) { return e?.name === 'TimeoutError'; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rename(a, b) {
  fs.mkdirSync(path.dirname(b), { recursive: true });
  for (let i = 0; ; i++) {
    try { fs.renameSync(a, b); return; } catch (e) { if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e; await sleep(1000 * (i + 1)); }
  }
}
/** Hide (or show) a file or folder: the hidden attribute on Windows, Finder's hidden flag on macOS; Linux has none. */
function setHidden(p, on) {
  const link = lstat(p)?.isSymbolicLink();
  if (WIN) execFileSync('attrib', [on ? '+h' : '-h', ...(link ? ['/l'] : []), p], { stdio: 'pipe' });
  else if (process.platform === 'darwin') execFileSync('chflags', [...(link ? ['-h'] : []), on ? 'hidden' : 'nohidden', p], { stdio: 'pipe' });
}
const rewrite = (rel, prefixes) => { const low = key(rel); for (const [a, b] of prefixes) if (low === key(a) || (a.endsWith('/') && low.startsWith(key(a)))) return b + rel.slice(a.length); return rel; };

export function check(m) {
  const W = m.dir;
  // what each path is after the steps so far (folded where the file system folds names). A moved folder keeps what it held.
  const now = new Map(); // folded path -> { made: true, from? } | { gone: true }
  const disk = rel => !!lstat(path.join(W, rel));
  const has = rel => {
    const parts = rel.split('/');
    for (let i = parts.length; i >= 1; i--) {
      const e = now.get(key(parts.slice(0, i).join('/')));
      if (!e) continue;
      if (e.gone) return false;
      if (i === parts.length) return true;
      return e.from ? disk([e.from, ...parts.slice(i)].join('/')) : false;
    }
    return disk(rel);
  };
  const problems = [];
  for (const o of m.ops) {
    // .clients/ is never touched; hiding the folder itself (an attribute, nothing inside changes) is the one exception
    for (const p of [o.path, o.from, o.to, o.at].filter(Boolean)) if (p.split('/').includes('..') || (/^\.clients(\/|$)/i.test(p) && !(o.op === 'hide' && p === '.clients')) || path.isAbsolute(p) || /^[A-Za-z]:/.test(p)) problems.push(`unsafe path ${p}`);
    if (o.op === 'move') {
      if (!has(o.from)) problems.push(`missing ${o.from}`);
      if (has(o.to)) problems.push(`already there: ${o.to}`);
      const from = o.from;
      // what's under the old path is now under the new one: look it up on disk by the original path
      const orig = (() => { const parts = from.split('/'); for (let i = parts.length; i >= 1; i--) { const e = now.get(key(parts.slice(0, i).join('/'))); if (e?.from) return [e.from, ...parts.slice(i)].join('/'); if (e) return null; } return from; })();
      now.set(key(from), { gone: true });
      now.set(key(o.to), { made: true, from: orig });
    }
    if (o.op === 'junction' || o.op === 'hardlink') { if (has(o.at)) problems.push(`already there: ${o.at}`); now.set(key(o.at), { made: true }); }
    if (o.op === 'unlink') { if (!has(o.path)) problems.push(`missing ${o.path}`); now.set(key(o.path), { gone: true }); }
    if (o.op === 'mkdir') { const parts = o.path.split('/'); for (let i = 1; i <= parts.length; i++) { const p = parts.slice(0, i).join('/'); if (!has(p)) now.set(key(p), { made: true }); } }
  }
  return problems;
}

async function apply(manFile) {
  const m = readJson(manFile);
  const W = m.dir;
  if (await orchyUp()) die(`Orchy is running on port ${PORT}: stop it first (and wait until nothing is running)`);
  const problems = check(m);
  if (problems.length) die(`the plan doesn't fit the folder any more:\n  ${problems.slice(0, 20).join('\n  ')}`);
  const jf = manFile.replace(/\.manifest\.json$/, '.journal.json');
  if (fs.existsSync(jf)) die(`${path.basename(jf)} exists: roll back first, or remove it if that run was rolled back`);
  const journal = { startedAt: new Date().toISOString(), done: [] };
  const save = () => writeJson(jf, journal);
  save();
  const abs = rel => path.join(W, ...rel.split('/'));
  try {
    for (const [i, o] of m.ops.entries()) {
      const undo = { i, op: o.op };
      // the folder a move or link lands in is made (and journalled) first, so a rollback removes it again
      const parentOf = o.op === 'move' ? o.to : ['junction', 'hardlink'].includes(o.op) ? o.at : null;
      if (parentOf && parentOf.includes('/')) {
        const parts = parentOf.split('/').slice(0, -1);
        for (let k = 1; k <= parts.length; k++) {
          const p = parts.slice(0, k).join('/');
          if (!lstat(abs(p))) { fs.mkdirSync(abs(p)); journal.done.push({ i, op: 'mkdir', path: p }); }
        }
      }
      if (o.op === 'mkdir') {
        // each folder made gets its own undo, parents too
        const parts = o.path.split('/');
        for (let k = 1; k <= parts.length; k++) {
          const p = parts.slice(0, k).join('/');
          if (lstat(abs(p))) continue;
          fs.mkdirSync(abs(p));
          journal.done.push({ i, op: 'mkdir', path: p });
        }
        continue;
      }
      else if (o.op === 'move') { await rename(abs(o.from), abs(o.to)); Object.assign(undo, { from: o.from, to: o.to }); }
      else if (o.op === 'junction') { linkDir(abs(o.to), abs(o.at)); undo.at = o.at; }
      else if (o.op === 'hardlink') { fs.linkSync(abs(o.to), abs(o.at)); undo.at = o.at; }
      else if (o.op === 'unlink') { fs.unlinkSync(abs(o.path)); Object.assign(undo, { path: o.path, target: o.target }); }
      else if (o.op === 'hide') { setHidden(abs(o.path), true); undo.path = o.path; }
      else if (o.op === 'resources') {
        const { syncResources } = await import('../lib/resources.mjs');
        const r = syncResources({ id: m.workspace, name: m.name || m.workspace, dir: W, builtin: false });
        undo.result = { moved: r.moved, linked: r.linked, copied: r.copied, errors: r.errors, index: r.index };
        if (r.moved.length || r.errors.length) console.warn('resources:', JSON.stringify(undo.result));
      }
      else if (o.op === 'config') {
        const cfg = readJson(CONFIG);
        const w = cfg.workspaces.find(x => x.id === m.workspace);
        undo.before = Object.fromEntries(Object.keys(o.set).map(k => [k, w[k] === undefined ? null : w[k]]));
        Object.assign(w, o.set);
        writeJson(CONFIG, cfg);
      }
      else if (o.op === 'state') {
        if (!fs.existsSync(STATE)) { journal.done.push(undo); continue; }
        fs.mkdirSync(path.join(DATA, 'organize'), { recursive: true });
        const backup = path.join(DATA, 'organize', `${m.workspace}-${m.date}.state.backup.json`);
        fs.copyFileSync(STATE, backup);
        undo.backup = backup;
        const st = readJson(STATE);
        let runs = 0, recs = 0, arts = 0;
        for (const r of Object.values(st.runs || {})) if (r.workspace === m.workspace && !r.client && !r.taskRoot && o.taskRoots[r.taskDir]) { r.taskRoot = o.taskRoots[r.taskDir]; runs++; }
        for (const h of Object.values(st.huddles || {})) if (h.workspace === m.workspace && !h.taskRoot && o.taskRoots[h.taskDir]) { h.taskRoot = o.taskRoots[h.taskDir]; recs++; }
        for (const x of Object.values(st.missions || {})) {
          if (x.workspace !== m.workspace) continue;
          if (!x.taskRoot && o.taskRoots[x.taskDir]) { x.taskRoot = o.taskRoots[x.taskDir]; recs++; }
          if (Array.isArray(x.filePaths)) x.filePaths = x.filePaths.map(p => rewrite(p, o.prefixes));
          for (const s of x.steps || []) if (Array.isArray(s.files)) s.files = s.files.map(p => rewrite(p, o.prefixes));
        }
        const previews = path.join(DATA, 'previews');
        const pv = fs.existsSync(previews) ? fs.readdirSync(previews) : [];
        undo.previews = [];
        for (const [id, a] of Object.entries(st.artifacts || {})) {
          if (a.workspace !== m.workspace || a.client) continue;
          const rel = rewrite(a.rel, o.prefixes);
          if (rel === a.rel) continue;
          const nid = idFor(m.workspace, rel);
          if (st.artifacts[nid]) continue; // already registered at the new path
          delete st.artifacts[id];
          st.artifacts[nid] = { ...a, id: nid, rel };
          for (const f of pv) if (f.startsWith(id)) { try { fs.renameSync(path.join(previews, f), path.join(previews, nid + f.slice(id.length))); undo.previews.push([f, nid + f.slice(id.length)]); } catch {} }
          arts++;
        }
        writeJson(STATE, st);
        undo.counts = { runs, recs, arts };
        console.log(`state: ${runs} runs, ${recs} huddles/missions, ${arts} files re-pointed`);
      }
      journal.done.push(undo);
      if (i % 25 === 0) save();
    }
    journal.finishedAt = new Date().toISOString();
    save();
    console.log(`applied ${journal.done.length} steps. Journal: ${jf}`);
  } catch (e) {
    journal.failed = { at: journal.done.length, error: e.message };
    save();
    die(`stopped after ${journal.done.length} steps: ${e.message}\nRoll back with: node orchestrator/scripts/organize.mjs rollback ${manFile}`);
  }
}

async function rollback(manFile) {
  const m = readJson(manFile);
  const W = m.dir;
  if (await orchyUp()) die(`Orchy is running on port ${PORT}: stop it first`);
  const jf = manFile.replace(/\.manifest\.json$/, '.journal.json');
  const journal = readJson(jf);
  const abs = rel => path.join(W, ...rel.split('/'));
  const errors = [];
  // Resources/ that sync filled (INDEX, MCP copies) can't be "un-made": it goes to the archive so the folder stops syncing
  for (const u of [...journal.done].reverse()) {
    try {
      if (u.op === 'mkdir') {
        const p = abs(u.path);
        if (!lstat(p) || /^Resources\//i.test(u.path)) continue; // Resources/ goes as a whole, below
        if (fs.readdirSync(p).length === 0) fs.rmdirSync(p);
        else if (u.path === 'Resources') await rename(p, abs(`.archive/${m.date}/Resources-rolled-back-${Date.now()}`));
        else errors.push(`${u.path} isn't empty: left it`);
      }
      else if (u.op === 'move') await rename(abs(u.to), abs(u.from));
      else if (u.op === 'junction' || u.op === 'hardlink') fs.unlinkSync(abs(u.at));
      else if (u.op === 'unlink') linkDir(abs(u.target), abs(u.path));
      else if (u.op === 'hide') { if (lstat(abs(u.path))) setHidden(abs(u.path), false); }
      else if (u.op === 'config') {
        const cfg = readJson(CONFIG);
        const w = cfg.workspaces.find(x => x.id === m.workspace);
        for (const [k, v] of Object.entries(u.before)) { if (v === null) delete w[k]; else w[k] = v; }
        writeJson(CONFIG, cfg);
      }
      else if (u.op === 'state' && u.backup) {
        fs.copyFileSync(u.backup, STATE);
        for (const [a, b] of u.previews || []) { try { fs.renameSync(path.join(DATA, 'previews', b), path.join(DATA, 'previews', a)); } catch {} }
      }
    } catch (e) { errors.push(`step ${u.i} (${u.op}): ${e.message}`); }
  }
  fs.renameSync(jf, jf.replace(/\.json$/, `.rolled-back-${Date.now()}.json`));
  console.log(errors.length ? `rolled back with ${errors.length} problem(s):\n  ${errors.join('\n  ')}` : 'rolled back');
}

// run as a script (a test imports `check` without running anything)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, file] = process.argv.slice(2);
  if (!file || !fs.existsSync(file)) die('usage: organize.mjs plan|apply|rollback <file>');
  if (cmd === 'plan') plan(path.resolve(file));
  else if (cmd === 'apply') await apply(path.resolve(file));
  else if (cmd === 'rollback') await rollback(path.resolve(file));
  else die(`unknown command ${cmd}`);
}
