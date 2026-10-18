// Resources/ and agent homes, on temp folders: a workspace without Resources/ is left alone; real skills in
// .claude/skills and .agents/skills move into Resources/Skills with links in both (reading through them works); links
// out of the workspace, loose files and .clients/ are never touched; a busy workspace only waits; a newer copy archives
// the old one (nothing deleted); where a link can't be made, a marked copy stands in and isn't filed again; MCP copies
// carry no secrets; INDEX.md says who uses what and is only rewritten when it changes. Then the task paths
// (taskRootRel/taskRel/tasksBase/taskRootFor), wsRel, homeOf/departmentOf, syncHomes, the "Agent homes" and "Where it
// saved" checks, and organize.mjs plan → apply → rollback on a rehearsal copy (ORGANIZE_TEST).
// No real workspace is touched. Run: node orchestrator/scripts/test-resources.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { syncResources, ensureResources, scrubServer, hasResources, syncHomes, COPY_NOTE } from '../lib/resources.mjs';
import { checkRun, configure } from '../lib/validate.mjs';
import { taskRootRel, taskRel, tasksBase, taskRoot } from '../lib/clientspace.mjs';
import { wsRel, homeOf, departmentOf, departmentsOf } from '../lib/agents.mjs';
import { workspaceName, handles } from '../lib/workspaces.mjs';

let fail = 0;
const ok = (cond, label, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : `  ${extra}`}`); if (!cond) fail++; };
const put = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const isLink = p => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const real = p => fs.realpathSync.native(p).toLowerCase();
const dirLink = (to, at) => fs.symlinkSync(to, at, process.platform === 'win32' ? 'junction' : 'dir');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchy-res-'));
const W = path.join(tmp, 'ws');
const ws = { id: 'restest', name: 'ResTest Workspace', dir: W, builtin: true };
const skill = (dir, name, desc, body = '') => put(path.join(W, dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n${body}\n`);

try {
  // ── a workspace without Resources/ ──
  skill('.agents/skills', 'alpha', 'Alpha does A | with a pipe');
  let r = syncResources(ws);
  ok(r.skippedWorkspace && !hasResources(ws) && !isLink(path.join(W, '.agents/skills/alpha')), 'no Resources/ → nothing synced, nothing moved');

  // ── a typical layout, plus the odd cases ──
  fs.mkdirSync(path.join(W, '.claude/skills'), { recursive: true });
  dirLink(path.join(W, '.agents/skills/alpha'), path.join(W, '.claude/skills/alpha'));
  skill('.claude/skills', 'beta', 'Beta only in .claude');
  const outside = path.join(tmp, 'global', 'gamma');
  put(path.join(outside, 'SKILL.md'), '---\nname: gamma\ndescription: global\n---\n');
  dirLink(outside, path.join(W, '.claude/skills/gamma'));
  put(path.join(W, '.claude/skills/loose.txt'), 'not a skill');
  skill('.clients/c1/.claude/skills', 'delta', 'a client corner skill');
  put(path.join(W, '.jos/mcp.json'), JSON.stringify({ servers: {
    srv: { type: 'http', description: 'Srv does S', enabled: true, url: 'https://x.test/mcp?key=abc123&team=t', headers: { Authorization: 'Bearer sk-SECRET-1' } },
    cmd: { command: 'node', args: ['server.js', '--api-key', 'TOPSECRETVALUE', '--token=zzz', 'ghp_abcdef'], env: { API_KEY: 'shh' }, enabled: false },
    'bad name!': { url: 'https://nope' },
  } }));
  put(path.join(W, '.claude/agents/writer.md'), '---\nname: writer\ndescription: d\ncall_name: Avery\nmcp_servers: [cmd]\n---\nUse the alpha skill, then srv. Run one --agent list.\n');
  put(path.join(W, '.claude/agents/editor.md'), '---\nname: editor\ndescription: d\ncall_name: Rowan\n---\nUse beta. Never alphabet soup.\n');
  put(path.join(W, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'p1@x': true, 'p2@x': false } }));
  fs.mkdirSync(path.join(W, '.one'), { recursive: true });
  ensureResources(ws);

  r = syncResources(ws);
  const RS = path.join(W, 'Resources/Skills');
  ok(r.moved.sort().join() === 'alpha,beta' && !isLink(path.join(RS, 'alpha')) && fs.existsSync(path.join(RS, 'beta/SKILL.md')), 'real skills move into Resources/Skills', JSON.stringify(r));
  ok(['.claude/skills/alpha', '.agents/skills/alpha', '.claude/skills/beta', '.agents/skills/beta'].every(p => isLink(path.join(W, p))), 'both skill folders hold a link for each');
  ok(real(path.join(W, '.claude/skills/alpha/SKILL.md')) === real(path.join(RS, 'alpha/SKILL.md')) && /Alpha does A/.test(fs.readFileSync(path.join(W, '.agents/skills/alpha/SKILL.md'), 'utf8')), 'reading through the links reaches the real files');
  ok(isLink(path.join(W, '.claude/skills/gamma')) && real(path.join(W, '.claude/skills/gamma')) === real(outside) && fs.existsSync(path.join(outside, 'SKILL.md')) && !fs.existsSync(path.join(RS, 'gamma')), 'a link out of the workspace is left alone (never followed, never moved)');
  ok(fs.existsSync(path.join(W, '.claude/skills/loose.txt')) && r.skipped.some(s => s.startsWith('loose.txt')), 'a loose file stays where it is');
  ok(!isLink(path.join(W, '.clients/c1/.claude/skills/delta')) && !fs.existsSync(path.join(RS, 'delta')), '.clients/ is never touched');
  ok(r.errors.length === 0, 'no errors', r.errors.join('; '));

  const srv = fs.readFileSync(path.join(W, 'Resources/MCPs/srv/server.json'), 'utf8');
  const cmd = fs.readFileSync(path.join(W, 'Resources/MCPs/cmd/server.json'), 'utf8');
  ok(!/sk-SECRET|abc123/.test(srv) && /x\.test\/mcp/.test(srv) && !/TOPSECRETVALUE|zzz|ghp_abcdef|shh/.test(cmd) && /server\.js/.test(cmd), 'MCP copies keep the shape, never a secret', srv + cmd);
  ok(!fs.existsSync(path.join(W, 'Resources/MCPs/bad name!')) && fs.existsSync(path.join(W, 'Resources/MCPs/srv/README.md')), 'odd server names skipped; each server gets a README');
  ok(fs.existsSync(path.join(W, 'Resources/CLIs/one/README.md')) && /Never run `one` for another workspace/.test(fs.readFileSync(path.join(W, 'Resources/CLIs/one/README.md'), 'utf8')), 'the One CLI README names the fence');

  const index = fs.readFileSync(path.join(W, 'Resources/INDEX.md'), 'utf8');
  ok(/\| \[alpha\]\(Skills\/alpha\/SKILL\.md\) \| Alpha does A \/ with a pipe \| Avery \|/.test(index), 'INDEX: a skill, what it’s for, who uses it (no "alphabet" false match)', index);
  ok(/\[beta\][^\n]*\| Rowan \|/.test(index) && /\[cmd\][^\n]*\| off \| Avery \|/.test(index) && /\[srv\][^\n]*\| on \| Avery \|/.test(index) && /\[one\][^\n]*\| Avery \|/.test(index), 'INDEX: MCP servers (on/off, frontmatter or mention) and CLIs');
  ok(/p1@x/.test(fs.readFileSync(path.join(W, 'Resources/Plugins.md'), 'utf8')) && !/p2@x/.test(fs.readFileSync(path.join(W, 'Resources/Plugins.md'), 'utf8')), 'Plugins.md lists the switched-on plugins');

  // ── idempotent ──
  const mtime = fs.statSync(path.join(W, 'Resources/INDEX.md')).mtimeMs;
  r = syncResources(ws);
  ok(!r.moved.length && !r.linked.length && !r.copied.length && !r.archived.length && !r.mcps.length && !r.index && fs.statSync(path.join(W, 'Resources/INDEX.md')).mtimeMs === mtime, 'a second sync changes nothing (no sync-client churn)', JSON.stringify(r));

  // ── a new skill while a run is live, then idle ──
  skill('.agents/skills', 'epsilon', 'Epsilon, added by npx skills add');
  r = syncResources(ws, { moves: false });
  ok(r.waiting.includes('epsilon') && !isLink(path.join(W, '.agents/skills/epsilon')) && !fs.existsSync(path.join(RS, 'epsilon')), 'busy workspace: the new skill waits where it is');
  r = syncResources(ws);
  ok(r.moved.includes('epsilon') && isLink(path.join(W, '.agents/skills/epsilon')) && isLink(path.join(W, '.claude/skills/epsilon')) && /\[epsilon\]/.test(fs.readFileSync(path.join(W, 'Resources/INDEX.md'), 'utf8')), 'idle: filed, linked and indexed');

  // ── an update that replaced the link with a real folder ──
  fs.unlinkSync(path.join(W, '.agents/skills/alpha'));
  skill('.agents/skills', 'alpha', 'Alpha v2');
  r = syncResources(ws, { now: new Date('2026-10-18T10:00:00Z') });
  const arch = path.join(W, '.archive/resources/Skills/alpha-2026-10-18-10-00-00');
  ok(r.moved.includes('alpha') && /Alpha v2/.test(fs.readFileSync(path.join(RS, 'alpha/SKILL.md'), 'utf8')) && /Alpha does A/.test(fs.readFileSync(path.join(arch, 'SKILL.md'), 'utf8')) && isLink(path.join(W, '.agents/skills/alpha')), 'a newer copy wins; the old one is archived, not deleted', JSON.stringify(r));

  // ── no links possible here: a marked copy stands in, and isn't filed as a new skill next time ──
  const realSymlink = fs.symlinkSync;
  fs.symlinkSync = () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); };
  try {
    skill('.claude/skills', 'zeta', 'Zeta, on a disk without links');
    r = syncResources(ws);
    const zc = path.join(W, '.claude/skills/zeta'), za = path.join(W, '.agents/skills/zeta');
    ok(r.moved.includes('zeta') && fs.existsSync(path.join(RS, 'zeta/SKILL.md')) && !isLink(zc) && fs.existsSync(path.join(zc, COPY_NOTE)) && fs.existsSync(path.join(za, 'SKILL.md')) && r.copied.length === 2, 'link refused: the skill is filed and a marked copy stands in each skill folder', JSON.stringify(r));
    r = syncResources(ws);
    ok(!r.moved.length && !r.archived.length && fs.existsSync(path.join(RS, 'zeta/SKILL.md')), 'the copies are Orchy’s: not filed again, nothing archived', JSON.stringify(r));
  } finally { fs.symlinkSync = realSymlink; }
  r = syncResources(ws);
  ok(isLink(path.join(W, '.claude/skills/zeta')) && isLink(path.join(W, '.agents/skills/zeta')) && real(path.join(W, '.claude/skills/zeta/SKILL.md')) === real(path.join(RS, 'zeta/SKILL.md')), 'once links work again, the copies become links', JSON.stringify(r));

  // ── scrubServer on its own ──
  const s = scrubServer({ url: 'https://u:p@h.test/x?token=1', headers: { 'X-Api-Key': 'k' }, apiKey: 'raw' });
  ok(!/u:p|token=1|"k"|raw/.test(JSON.stringify(s)), 'scrubServer: userinfo, query, headers and secret-named fields', JSON.stringify(s));

  // ── task paths ──
  const J = { dir: path.join(tmp, 'J'), id: 'j', departments: ['Marketing', 'I.T. Department', '../x', 'A/B'], generalistHome: 'Operations/Generalist' };
  ok(taskRootRel({}) === 'Tasks' && taskRootRel({ taskRoot: 'Marketing/Avery/Tasks' }) === 'Marketing/Avery/Tasks', 'taskRootRel: old records → Tasks; new ones keep their root');
  ok(['../Tasks', 'Marketing/../../x/Tasks', '.clients/c/Tasks', 'Marketing/Avery', 'C:/x/Tasks', 'a\\b/Tasks'].every(t => taskRootRel({ taskRoot: t }) === 'Tasks'), 'taskRootRel: a root that climbs, hides, isn’t a Tasks folder or is absolute falls back to Tasks');
  ok(taskRootRel({ client: 'c1', taskRoot: 'Marketing/Avery/Tasks' }) === 'Tasks' && tasksBase(J, { client: 'c1', taskRoot: 'Marketing/Avery/Tasks' }) === path.join(J.dir, '.clients', 'c1', 'Tasks'), 'a client’s task stays in their corner whatever the record says');
  ok(taskRel({ taskDir: 'x', taskRoot: 'I.T. Department/Sam/Tasks' }) === 'I.T. Department/Sam/Tasks/x' && taskRel({}) === null && taskRoot(J, { taskDir: 'x' }) === path.join(J.dir, 'Tasks', 'x'), 'taskRel / taskRoot');
  ok(wsRel('Marketing\\Avery') === 'Marketing/Avery' && ['../x', '.clients/a', 'C:/x', '/abs', 'Resources/x', 'uploads', 'a/./b', 'x.', 'a?b', ''].every(p => wsRel(p) === null), 'wsRel: only plain folders inside the workspace');
  ok(departmentsOf(J).join() === 'Marketing,I.T. Department' && departmentsOf({}).length === 0, 'departmentsOf: checked, top-level only');
  fs.mkdirSync(path.join(J.dir, 'Marketing', 'Avery'), { recursive: true });
  ok(homeOf(J, { slug: 'x', home: 'Ops/Zed' }) === 'Ops/Zed' && homeOf(J, { slug: 'dev', callName: 'Sam', department: 'I.T. Department' }) === 'I.T. Department/Sam', 'homeOf: frontmatter home, else department + call name');
  ok(homeOf(J, { slug: 'writer', callName: 'Avery' }) === 'Marketing/Avery' && homeOf(J, { slug: 'nobody', callName: 'Nobody' }) === null, 'homeOf: before the agent file names it, the folder an organise made (else the flat layout)');
  ok(homeOf(J, null) === 'Operations/Generalist' && homeOf({ ...J, generalistHome: null }, null) === null && departmentOf(J, null) === 'Operations', 'the generalist’s home and department');
  ok(departmentOf(J, { slug: 'a', department: 'Marketing' }) === 'Marketing' && departmentOf(J, { slug: 'n' }) === null, 'departmentOf');

  // ── names ──
  ok(workspaceName('Acme') === 'Acme Workspace' && workspaceName('Acme Agent') === 'Acme Workspace' && workspaceName(' Acme Workspace ') === 'Acme Workspace', 'workspaceName: "<Name> Workspace", never doubled');
  ok(handles({ id: 'acme', name: 'Acme Workspace', aliases: ['the bakery'] }).join() === 'Acme,acme,the bakery' || handles({ id: 'acme', name: 'Acme Workspace', aliases: ['the bakery'] }).join() === 'Acme,the bakery', 'handles: the name without "Workspace", the id, the aliases');

  // ── organised from creation: homes made on their own, new departments join, the run checks ──
  const O = { id: 'orgtest-not-in-config', name: 'OrgTest Workspace', dir: path.join(tmp, 'O'), departments: ['Marketing'], generalistHome: 'Operations/Generalist' };
  const agentMd = (slug, extra) => put(path.join(O.dir, '.claude/agents', `${slug}.md`), `---\nname: ${slug}\ndescription: d\n${extra}\n---\nBody\n`);
  agentMd('writer', 'call_name: Avery\ndepartment: Marketing');
  agentMd('closer', 'call_name: Zed\ndepartment: Sales\nhome: Sales/Zed');
  agentMd('helper-subagent', 'description2: x');
  const h = syncHomes(O);
  ok(['Marketing/Tasks', 'Marketing/Avery/Tasks', 'Sales/Zed/Tasks', 'Sales/Tasks', 'Operations/Generalist/Tasks'].every(p => fs.existsSync(path.join(O.dir, p))), 'syncHomes: every home, its Tasks, each department’s Tasks, the generalist’s', JSON.stringify(h));
  ok(h.departments.join() === 'Sales' && !fs.existsSync(path.join(O.dir, 'helper-subagent')), 'a department an agent names joins the list; an agent without one gets no folder');
  ok(syncHomes(O).homes.length === 0, 'syncHomes again: nothing new');
  configure({ agents: () => [
    { slug: 'writer', callName: 'Avery', department: 'Marketing', home: 'Marketing/Avery' },
    { slug: 'head-of-marketing', callName: 'Rowan', department: 'Marketing', home: 'Marketing/Rowan' },
    { slug: 'helper-subagent', callName: null, department: null, home: null },
  ] });
  const named = (v, n) => v.checks.find(c => c.name === n);
  let v = checkRun({ id: 'b1', isBuilder: true, report: { status: 'completed' }, createdAgents: [{ slug: 'writer' }, { slug: 'helper-subagent' }] }, { ws: O });
  ok(named(v, 'Agent homes')?.ok === false && named(v, 'Agent homes').level === 'fail' && /helper-subagent/.test(named(v, 'Agent homes').note) && v.verdict === 'failed', 'a build that leaves an agent without department + home fails the check', JSON.stringify(v.checks));
  v = checkRun({ id: 'b2', isBuilder: true, report: { status: 'completed' }, createdAgents: [{ slug: 'writer' }] }, { ws: O });
  ok(named(v, 'Agent homes')?.ok === true, 'an agent with department + home passes');
  const arts = ['Marketing/Avery/Tasks/t/a.md', 'Marketing/Studio/x.mp4', 'Marketing/Rowan/notes.md', 'scratch/y.json'].map(rel => ({ rel, runIds: ['r1'], status: 'final' }));
  v = checkRun({ id: 'r1', agentSlug: 'writer', taskDir: 't', taskRoot: 'Marketing/Avery/Tasks', report: { status: 'completed' } }, { ws: O, arts });
  const w = named(v, 'Where it saved');
  ok(w?.ok === false && w.level === 'warn' && /2 files/.test(w.note) && /Rowan/.test(w.note) && /scratch/.test(w.note) && !/Studio/.test(w.note), 'files outside its home, task and department (a teammate’s home counts as outside) are flagged', JSON.stringify(w));
  v = checkRun({ id: 'r1', agentSlug: 'writer', taskDir: 't', taskRoot: 'Marketing/Avery/Tasks', report: { status: 'completed' } }, { ws: { ...O, departments: [] }, arts });
  ok(!named(v, 'Where it saved') && !named(v, 'Agent homes'), 'a workspace without departments isn’t checked for places');

  // ── organize.mjs: plan → apply → rollback on a rehearsal copy ──
  const T = path.join(tmp, 'rehearsal');
  const TW = path.join(T, 'workspaces', 'Northwind');
  put(path.join(T, 'orchestrator', 'config.json'), JSON.stringify({ workspaces: [{ id: 'northwind', name: 'Northwind Workspace', folder: 'workspaces/Northwind', runtime: 'claude' }] }));
  put(path.join(T, 'orchestrator', 'data', 'state.json'), JSON.stringify({ runs: { r1: { id: 'r1', workspace: 'northwind', taskDir: '2026-10-01-draft-post', agentSlug: 'writer', agentName: 'Writer', startedAt: '2026-10-01T10:00:00Z' } }, huddles: {}, missions: {}, artifacts: {} }));
  put(path.join(TW, '.claude/agents/writer.md'), '---\nname: writer\ndescription: d\ncall_name: Avery\n---\nBody\n');
  put(path.join(TW, '.claude/agents/agent-builder.md'), '---\nname: agent-builder\ndescription: d\n---\nBody\n');
  put(path.join(TW, 'Tasks/2026-10-01-draft-post/post.md'), 'a post');
  put(path.join(TW, 'Tasks/2026-10-02-mystery/x.md'), 'who ran this?');
  put(path.join(TW, 'studio/brand.md'), 'brand');
  put(path.join(TW, 'scratch/y.json'), '{}');
  put(path.join(TW, 'writer/reference/style.md'), 'style');
  put(path.join(TW, '.claude/skills/omega/SKILL.md'), '---\nname: omega\ndescription: Omega\n---\n');
  const map = path.join(T, 'orchestrator', 'data', 'organize', 'northwind-2026-10-18.map.json');
  put(map, JSON.stringify({ workspace: 'northwind', date: '2026-10-18', departments: { Marketing: ['writer'], 'I.T. Department': ['agent-builder'] }, generalistHome: 'Operations/Generalist', shared: { studio: 'Marketing/Studio' }, agentFolders: ['writer'], archive: ['scratch'], unmatchedTasks: 'Operations/Tasks', hideAtRoot: ['.claude', 'Tasks'] }));
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'organize.mjs');
  const org = (...a) => execFileSync(process.execPath, [script, ...a], { env: { ...process.env, ORGANIZE_TEST: T }, encoding: 'utf8', stdio: 'pipe' });
  org('plan', map);
  const manFile = map.replace(/\.map\.json$/, '.manifest.json');
  const man = JSON.parse(fs.readFileSync(manFile, 'utf8'));
  ok(fs.existsSync(path.join(TW, 'studio')) && !fs.existsSync(path.join(TW, 'Marketing')) && man.home.writer === 'Marketing/Avery' && fs.existsSync(manFile.replace(/\.json$/, '.md')), 'plan: a manifest and its .md, nothing moved', JSON.stringify(man.home));
  ok(man.tasks.find(t => t.dir === '2026-10-01-draft-post')?.dest === 'Marketing/Avery/Tasks' && man.tasks.find(t => t.dir === '2026-10-02-mystery')?.dest === 'Operations/Tasks', 'plan: an old task folder goes to the agent that ran it; one with no record to the unmatched folder');
  org('apply', manFile);
  const cfg = JSON.parse(fs.readFileSync(path.join(T, 'orchestrator', 'config.json'), 'utf8'));
  const st = JSON.parse(fs.readFileSync(path.join(T, 'orchestrator', 'data', 'state.json'), 'utf8'));
  ok(fs.existsSync(path.join(TW, 'Marketing/Avery/Tasks/2026-10-01-draft-post/post.md')) && fs.existsSync(path.join(TW, 'Marketing/Avery/reference/style.md')) && fs.existsSync(path.join(TW, 'Marketing/Studio/brand.md')), 'apply: homes, old tasks and shared folders in place');
  ok(fs.existsSync(path.join(TW, 'studio/brand.md')) && isLink(path.join(TW, 'studio')) && fs.existsSync(path.join(TW, 'Tasks/2026-10-01-draft-post/post.md')), 'apply: old paths still work through links');
  ok(fs.existsSync(path.join(TW, '.archive/2026-10-18/scratch/y.json')) && fs.existsSync(path.join(TW, 'Resources/Skills/omega/SKILL.md')) && isLink(path.join(TW, '.claude/skills/omega')), 'apply: clutter archived (not deleted), skills into Resources/');
  ok(cfg.workspaces[0].departments.join() === 'Marketing,I.T. Department' && cfg.workspaces[0].generalistHome === 'Operations/Generalist' && st.runs.r1.taskRoot === 'Marketing/Avery/Tasks', 'apply: config.json departments + generalistHome, the old run gets its taskRoot');
  org('rollback', manFile);
  const cfg2 = JSON.parse(fs.readFileSync(path.join(T, 'orchestrator', 'config.json'), 'utf8'));
  const st2 = JSON.parse(fs.readFileSync(path.join(T, 'orchestrator', 'data', 'state.json'), 'utf8'));
  ok(!isLink(path.join(TW, 'studio')) && fs.existsSync(path.join(TW, 'studio/brand.md')) && fs.existsSync(path.join(TW, 'Tasks/2026-10-01-draft-post/post.md')) && fs.existsSync(path.join(TW, 'scratch/y.json')) && fs.existsSync(path.join(TW, 'writer/reference/style.md')) && fs.existsSync(path.join(TW, '.claude/skills/omega/SKILL.md')), 'rollback: every folder back where it was');
  ok(!cfg2.workspaces[0].departments && !st2.runs.r1.taskRoot, 'rollback: config.json and state.json as before');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} resource check(s) FAILED` : '\nall resource checks passed');
process.exit(fail ? 1 : 0);
