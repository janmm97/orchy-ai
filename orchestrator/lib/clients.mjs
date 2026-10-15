// Client access: a private link that lets one of the owner's clients (e.g. Alex at Beta Labs) work with chosen agents
// of one workspace from their own page, served by portal.mjs on its own port. config.json `clients[]` is
// the list; only a hash of each link's secret is kept, so a lost link is replaced, never looked up.
import crypto from 'node:crypto';
import path from 'node:path';
import { config, saveConfig, env, ownerName } from './env.mjs';
import { workspace, engineFor } from './workspaces.mjs';
import { engine } from './engines/index.mjs';
import { listAgents } from './agents.mjs';

export const CLIENT_PORT = () => Number(env('CLIENT_PORT', '8009'));
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const hash = token => crypto.createHash('sha256').update(String(token)).digest('hex');

const list = () => (config.clients ||= []);
export const clients = () => list().map(publicClient);
export const clientById = id => list().find(c => c.id === id) || null;

export function publicClient({ tokenHash, ...c }) {
  return { ...c, hasLink: !!tokenHash };
}

/** Where the client's link points: the public address (Cloudflare) once the owner set one, else this PC. */
export function clientBase() {
  return (env('CLIENT_URL') || `http://localhost:${CLIENT_PORT()}`).replace(/\/+$/, '');
}

/** The client a link's secret belongs to, if it is switched on. */
export function clientByToken(token) {
  if (!token || token.length < 20 || token.length > 100) return null;
  const want = Buffer.from(hash(token), 'hex');
  const c = list().find(x => x.tokenHash && crypto.timingSafeEqual(Buffer.from(x.tokenHash, 'hex'), want));
  return c && c.enabled !== false ? c : null;
}

function checkAgents(wsId, slugs) {
  const ws = workspace(wsId);
  const have = new Map(listAgents(wsId).filter(a => !a.isBuilder).map(a => [a.slug, a]));
  const picked = [...new Set((Array.isArray(slugs) ? slugs : []).map(String))];
  if (!picked.length) throw bad('Pick at least one agent');
  const unknown = picked.filter(s => !have.has(s));
  if (unknown.length) throw bad(`Not an agent in ${ws.name}: ${unknown.join(', ')}`);
  // an engine Orchy can't keep inside a client's folder (Codex reads files without asking anyone) can't be shared (yet)
  const unsafe = picked.filter(s => !engine(engineFor(ws, have.get(s)))?.capabilities.clientSafe);
  if (unsafe.length) {
    const eng = engine(engineFor(ws, have.get(unsafe[0])));
    throw bad(`${unsafe.map(s => have.get(s).displayName).join(', ')} run${unsafe.length > 1 ? '' : 's'} on ${eng?.label || 'an engine Orchy can’t check'}, which can't be shared with a client yet: ${eng?.capabilities.clientReason || 'Orchy can’t keep it inside the client’s folder.'}`);
  }
  return picked;
}

const cleanBrief = b => String(b ?? '').replace(/\r\n/g, '\n').trim().slice(0, 6000);

const cleanEmail = e => {
  const s = String(e || '').trim().toLowerCase();
  if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw bad('That email doesn’t look right');
  return s || null;
};

/** A new link: the secret goes out once, in the returned URL. */
function newLink(c) {
  const token = crypto.randomBytes(24).toString('base64url');
  c.tokenHash = hash(token);
  c.linkAt = new Date().toISOString();
  return `${clientBase()}/c/${token}`;
}

export function addClient({ name, email, workspace: wsId, agents }) {
  const n = String(name || '').trim();
  if (!n) throw bad('Give the client a name');
  const ws = workspace(wsId);
  const base = n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'client';
  let cid = `${ws.id}-${base}`;
  for (let i = 2; clientById(cid); i++) cid = `${ws.id}-${base}-${i}`;
  const c = { id: cid, name: n, email: cleanEmail(email), workspace: ws.id, agents: checkAgents(ws.id, agents), enabled: true, createdAt: new Date().toISOString() };
  const link = newLink(c);
  list().push(c);
  saveConfig();
  return { client: publicClient(c), link };
}

export function updateClient(id, patch = {}) {
  const c = clientById(id);
  if (!c) throw bad('No such client', 404);
  if ('name' in patch) { const n = String(patch.name || '').trim(); if (!n) throw bad('Give the client a name'); c.name = n; }
  if ('email' in patch) c.email = cleanEmail(patch.email);
  if ('agents' in patch) c.agents = checkAgents(c.workspace, patch.agents);
  if ('enabled' in patch) c.enabled = !!patch.enabled;
  // what the client's runs are told about them, instead of the workspace's own notes (the owner writes or approves it)
  if ('brief' in patch) { c.brief = cleanBrief(patch.brief); c.briefAt = new Date().toISOString(); }
  // can they call their agents from the page (their own voice agents, voiceagents.mjs#clientSession)
  if ('calls' in patch) c.calls = !!patch.calls;
  saveConfig();
  return publicClient(c);
}

/** Replace the link: the old one stops working at once. */
export function rotateLink(id) {
  const c = clientById(id);
  if (!c) throw bad('No such client', 404);
  const link = newLink(c);
  saveConfig();
  return { client: publicClient(c), link };
}

export function removeClient(id) {
  const i = list().findIndex(c => c.id === id);
  if (i < 0) throw bad('No such client', 404);
  list().splice(i, 1);
  saveConfig();
}

// ── What a client's run may touch ──
// It works on the client's task with the agents shared with them: it never hands work to the workspace's other
// agents (the Builder included), and never edits the workspace's own setup (agents, instructions, connections).
export const SETUP_GLOBS = ['.claude/**', '.codex/**', '.agents/**', '.jos/**', '.one/**', '**/CLAUDE.md', '**/AGENTS.md', '.mcp.json'];

/** The agents shared with the client who started this run (null for the owner's own runs). */
export const clientShared = run => (run?.client ? clientById(run.client)?.agents || [] : null);

// A bare pattern counts from the run's folder, and a client's run works in <ws>/.clients/<id>: the workspace's own
// setup is also named by its absolute path, in Claude Code's form ("//" is the filesystem root; on Windows C:\Users\…
// is matched as /c/Users/…).
const absRule = p => `//${path.resolve(p).replace(/\\/g, '/').replace(/^([A-Za-z]):\//, (_, d) => `${d.toLowerCase()}/`).replace(/^\/+/, '')}`;

/**
 * Claude Code deny rules for a client's run (deny holds in every permission mode; client runs use default mode, so
 * every other edit asks the gate). Claude Code checks every built-in edit (Write, NotebookEdit…) against Edit rules
 * only, and warns at startup about path rules on the other tools, so these are Edit rules.
 */
export function clientDenyRules(run, wsAgentSlugs) {
  const shared = clientShared(run);
  if (!shared) return [];
  const helpers = wsAgentSlugs.filter(s => !shared.includes(s)).flatMap(s => [`Agent(${s})`, `Task(${s})`]);
  let root = null;
  try { root = absRule(workspace(run.workspace).dir); } catch {}
  const globs = root ? [...SETUP_GLOBS, ...SETUP_GLOBS.map(g => `${root}/${g}`)] : SETUP_GLOBS;
  const setup = globs.map(g => `Edit(${g})`);
  return [...helpers, ...setup];
}

// ── Who answers a pop-up from a client's run ──
// The client decides what happens in the workspace's apps (One actions, other connections, MCP tools): it's
// their data. Anything that touches this PC (scripts, files outside the folder, the One CLI's own settings)
// stays the owner's, so a client's OK can never run commands on the owner's machine.
const CLIENT_DECIDES = /^(one|conn|mcp):/;

/** Inbox fields for an item a run raises: who answers it, and the name the agent hears back. */
export function askFields(run, ruleKey = null) {
  if (!run?.client) return { client: null, answerer: 'owner', askee: ownerName() };
  // The owner following up on the client's task answers its questions and decisions; the client sees it waiting on the owner
  if (run.ownerReply) return { client: run.client, answerer: 'owner', askee: ownerName() };
  const theirs = ruleKey === null || CLIENT_DECIDES.test(ruleKey);
  return { client: run.client, answerer: theirs ? 'client' : 'owner', askee: theirs ? run.clientName || 'the client' : ownerName() };
}
