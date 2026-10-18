// Setting up a new workspace folder the same way every time:
//   CLAUDE.md + AGENTS.md            instructions Claude Code / Codex read in that folder
//   .claude/agents/agent-builder.md  the workspace's Chief of AI Agents (Orchy Agent Spec)
//   .jos/mcp.json, .jos/retired/     external MCP servers and retired agents
//   .one/                            marks the folder as its own One project (signed in separately)
//   Tasks/                           task folders until the agents have homes in departments (tasks.mjs)
//   Resources/, Uploads/             skills/MCPs/CLIs in one place (resources.mjs); files the owner attaches
// The text lives in orchestrator/templates/*.md: edit those to change what new workspaces get.
import fs from 'node:fs';
import path from 'node:path';
import { ORCH_DIR, config, ownerName } from './env.mjs';
import { modelsFor, runtimeLabel, accountFor } from './workspaces.mjs';
import { engine } from './engines/index.mjs';
import { ensureResources, syncResources } from './resources.mjs';

const TEMPLATES = path.join(ORCH_DIR, 'templates');

function fill(name, vars) {
  return fs.readFileSync(path.join(TEMPLATES, name), 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

/** Create and configure ws.dir. Never overwrites anything that's already there. */
export function scaffoldWorkspace(ws) {
  const [quick, mid, top] = modelsFor(ws);
  const plain = s => String(s || '').replace(/"/g, "'").replace(/\s+/g, ' ').trim();
  const vars = {
    OWNER: ownerName(), TIMEZONE: config.timezone || 'America/New_York', NAME: plain(ws.name), CLIENT: plain(ws.client), ID: ws.id, BLURB: plain(ws.blurb),
    RUNTIME: runtimeLabel(ws.runtime), ACCOUNT: accountFor(ws).email || 'its own account',
    TOP_MODEL: top, MID_MODEL: mid, TODAY: new Date().toLocaleDateString('en-CA'),
    MODEL_RULES: `\`${quick}\` (quick, simple), \`${mid}\` (default), or \`${top}\` (complex judgement, long writing)`,
  };
  const made = [];
  const write = (rel, text) => {
    const p = path.join(ws.dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (fs.existsSync(p)) return;
    fs.writeFileSync(p, text);
    made.push(rel);
  };
  fs.mkdirSync(ws.dir, { recursive: true });
  for (const d of ['.one', '.jos/retired', '.claude/agents', 'Tasks', 'Uploads']) fs.mkdirSync(path.join(ws.dir, d), { recursive: true });
  ensureResources(ws);
  const instructions = fill('workspace-instructions.md', vars);
  write('CLAUDE.md', instructions);
  write('AGENTS.md', instructions);
  write('.claude/agents/agent-builder.md', fill('agent-builder.md', vars));
  write('.jos/mcp.json', JSON.stringify({ servers: {} }, null, 2) + '\n');
  // the homes of the departments it starts with (the builder's included, resources.mjs#syncHomes) and INDEX.md
  try { syncResources(ws); } catch (e) { console.warn('[scaffold] resources', e.message); }
  return made;
}

/** A workspace switched to another engine gets that engine's instruction file if it's missing. */
export function ensureInstructions(ws) {
  const file = engine(ws.runtime)?.instructionFile || 'CLAUDE.md';
  const target = path.join(ws.dir, file);
  const other = path.join(ws.dir, file === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md');
  if (fs.existsSync(target) || !fs.existsSync(other)) return false;
  fs.copyFileSync(other, target);
  return true;
}
