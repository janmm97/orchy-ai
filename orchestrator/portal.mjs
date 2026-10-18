// Client pages: a second, separate web server (CLIENT_PORT, default 8009) where one of the owner's clients works
// with the agents the owner shared with them (Workspace → a workspace → Client access). Everything lives under
// /c/<link secret>/: the page, and an API that only knows that client's agents, runs and questions.
// The owner's own API on 8008 is never reachable from here. Put this port, and only this one, online
// (Cloudflare Tunnel + Access); requests that come through Cloudflare without Access are refused.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, DASHBOARD_DIR, config, ownerName } from './lib/env.mjs';
import { db, id } from './lib/store.mjs';
import { bus } from './lib/bus.mjs';
import { workspace } from './lib/workspaces.mjs';
import { listAgents } from './lib/agents.mjs';
import * as runner from './lib/runner.mjs';
import * as inbox from './lib/inbox.mjs';
import { ensureSession } from './lib/sessions.mjs';
import * as orchy from './lib/orchy.mjs';
import { CLIENT_PORT, clientByToken } from './lib/clients.mjs';
import { stageUpload, taskFiles, taskFile, sendTaskFile, MAX_FILES, clientHome } from './lib/clientspace.mjs';
import * as voiceAgents from './lib/voiceagents.mjs';
import { env } from './lib/env.mjs';
import { accessConfig, verifiedEmail } from './lib/cfaccess.mjs';
import { voiceEnabled } from './lib/voice.mjs';

const MAX_LIVE = 3;        // tasks one client can have running at once
const MAX_TEXT = 8000;     // characters in a task or answer

const err = (status, message) => Object.assign(new Error(message), { status });
const clip = (s, n = 140) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// How much one client can do in an hour (a leaked link or a stuck script can't run up the owner's bill or fill the disk)
const LIMITS = { task: 40, upload: 80, call: 12, end: 12, tool: 300 };
const spent = new Map(); // `${clientId}:${kind}` -> [timestamps]
function allow(c, kind) {
  const key = `${c.id}:${kind}`, now = Date.now();
  const recent = (spent.get(key) || []).filter(t => now - t < 3_600_000);
  if (recent.length >= LIMITS[kind]) throw err(429, 'That’s a lot in one hour. Try again a bit later.');
  recent.push(now);
  spent.set(key, recent);
}
// paths on the owner's PC mean nothing to a client and say more than they need to. Orchy's own folders go first (the
// client's corner and the workspace keep what's below them; anything else in the Orchy folder or the owner's home goes whole) in
// every spelling a tool prints: C:\…, C:/…, C:\\… (JSON), /c/…, ~/…, C:Users… (a shell ate the backslashes), and
// the folder slugs Claude and One make of them (C--Users-…); then any other drive or home path
// (a drive path like C:\… or C:/…, folders with spaces in them included, never a URL's "s://")
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SEP = String.raw`(?:\\{1,2}|/)`;
const SEG = String.raw`[^\s'"\`)\]\\/,;]+`;
const REST = String.raw`(?:${SEG}(?: ${SEG}){0,3}${SEP})*[^\s'"\`)\]]*`; // the rest of a path
function spellings(dir, whole = false) {
  const abs = path.resolve(dir), parts = abs.split(/[\\/]+/).filter(Boolean);
  const drive = /^[A-Za-z]:$/.test(parts[0]) ? parts.shift()[0] : null;
  const slug = s => [...s].map(ch => (/[A-Za-z0-9]/.test(ch) ? ch : `(?:${reEsc(ch)}|-)`)).join('');
  const out = [`${drive ? `(?:${drive}:|/(?:mnt/)?${drive})` : ''}${SEP}?${parts.map(reEsc).join(`${SEP}?`)}`, `${drive ? `${drive}-` : ''}-${parts.map(slug).join('-')}`];
  const rel = path.relative(os.homedir(), abs);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) out.push(rel ? `(?<![\\w~])~${SEP}${rel.split(/[\\/]+/).map(reEsc).join(SEP)}` : `(?<![\\w~])~(?=${SEP})`);
  return whole ? out.map(p => `${p}(?:${SEP}${REST}|-[^\\s'"\`)\\]\\\\/]*)?`) : out;
}
const DRIVE_PATH = new RegExp(String.raw`(?<![A-Za-z0-9])[A-Za-z]:(?:\\{1,2}|/(?!/))${REST}`, 'g');
const scrubbers = new Map(); // "workspace/client" -> scrub
function scrubber(wsId = null, cid = null) {
  const key = `${wsId}/${cid}`;
  if (scrubbers.has(key)) return scrubbers.get(key);
  const dirs = [];
  let known = true;
  if (wsId) {
    try { const ws = workspace(wsId); if (cid) dirs.push(clientHome(ws, cid)); dirs.push(ws.dir); } catch { known = false; }
  }
  const mine = new RegExp([...dirs.flatMap(d => spellings(d)), ...spellings(ROOT, true), ...spellings(os.homedir(), true)].join('|'), 'gi');
  const fn = s => String(s ?? '').replace(mine, '…')
    .replace(/(["'`])[A-Za-z]:[\\/][^"'`\n]*\1/g, '$1…$1').replace(DRIVE_PATH, '…')
    .replace(/(?<=^|[\s'"`(=])\/(?:(?:mnt\/)?[A-Za-z]\/)?(?:Users|home)\/[^\s'"`)\]]*/g, '…');
  if (known) scrubbers.set(key, fn);
  return fn;
}
const scrub = scrubber();

// ── what a client sees of runs, their steps and their questions ──
export function clientRun(r) {
  const rep = r.report, s = scrubber(r.workspace, r.client);
  // what they asked (the note about attached files is shown as file chips instead); the owner's follow-ups are scrubbed too
  const asked = String(r.instruction || '').replace(/\n\nFiles (?:[^\n]*) attached \(in this folder; open them with Read\):[\s\S]*$/, '');
  return {
    // a run waiting its turn on the owner's account (queued, or paused on a usage limit) is just "starting" to the client
    id: r.id, agent: r.agentSlug, agentName: r.agentName, status: r.status === 'queued' || r.status === 'paused-limit' ? 'starting' : r.status, outcome: r.outcome || null,
    instruction: r.ownerReply ? s(asked) : asked,
    by: r.ownerReply ? ownerName() : null, files: (r.files || []).map(p => path.posix.basename(p)),
    startedAt: r.startedAt, endedAt: r.endedAt || null, parentRunId: r.parentRunId || null,
    // files on the owner's PC mean nothing to the client: keep links, IDs and the rest
    report: rep ? { status: rep.status, summary: s(rep.summary || ''), outputs: (rep.outputs || []).filter(o => !/^[A-Za-z]:[\\/]/.test(o)).map(s), follow_ups: (rep.follow_ups || []).map(s) } : null,
    // the raw error can quote commands and paths
    error: r.error ? `Something went wrong on this task. ${ownerName()} can see what happened.` : null, stoppedBy: r.stoppedBy || null,
  };
}

/** One step of a run, as its client sees it (`r`: the run, for whose folders to scrub). */
export function clientEvent(e, r = null) {
  const t = e.t, s = scrubber(r?.workspace, r?.client);
  if (e.kind === 'text' || e.kind === 'note' || e.kind === 'report') return { t, kind: e.kind, text: s(e.text || '').slice(0, 4000) };
  // steps never show, not even as a verb: the page just shows it's busy (client.mjs cycles playful words on each tick)
  if (e.kind === 'tool') return e.tool === 'mcp__jos__note' ? null : { t, kind: 'tick' };
  if (e.kind === 'tool_error' || e.kind === 'denied') return { t, kind: 'tick' }; // a step that failed: the agent carries on
  if (e.kind === 'error') return { t, kind: 'error', text: `Something went wrong on this task. ${ownerName()} can see what happened.` };
  if (e.kind === 'system' && /^Dispatched/.test(e.text || '')) return { t, kind: 'system', text: 'Started' };
  if (e.kind === 'system' && /^Finished/.test(e.text || '')) return { t, kind: 'system', text: s(e.text) };
  return null;
}

export function clientItem(i) {
  const base = { id: i.id, kind: i.kind, status: i.status, runId: i.runId, createdAt: i.createdAt, agentName: i.agent?.displayName || 'An agent' };
  // a step that touches the owner's PC: the client only learns that it's waiting on the owner
  if (i.answerer !== 'client') return { ...base, answerer: 'owner', title: `Waiting for ${ownerName()} to OK a step on the computer` };
  const s = scrubber(i.workspace, i.client);
  return {
    ...base, answerer: 'client', title: s(i.title || ''), message: s(i.message || ''), context: s(i.context || ''), options: (i.options || []).map(s),
    detail: i.kind === 'approval' ? s(i.detail || '').slice(0, 3000) : '',
    action: i.action ? { title: i.action.title, connection: i.action.connectionName, platform: i.action.platform } : null,
  };
}

const myRuns = c => Object.values(db().runs).filter(r => r.client === c.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
const starting = new Map(); // client id -> tasks it is starting right now (not live yet), so a burst can't pass MAX_LIVE
const resuming = new Set(); // agent sessions a follow-up is starting from right now
const liveCount = c => myRuns(c).filter(r => runner.isLive(r.id)).length + (starting.get(c.id) || 0);
/** Hold one of the client's MAX_LIVE slots while `fn` starts a run (sync check and hold, before any await). */
async function inSlot(c, fn) {
  if (liveCount(c) >= MAX_LIVE) throw err(429, `${MAX_LIVE} tasks are already running. Wait for one to finish.`);
  allow(c, 'task');
  starting.set(c.id, (starting.get(c.id) || 0) + 1);
  try { return await fn(); } finally { starting.set(c.id, starting.get(c.id) - 1); }
}
function mine(c, rid) {
  const r = db().runs[rid];
  if (!r || r.client !== c.id) throw err(404, 'That task isn’t here.');
  return r;
}

function sharedAgents(c) {
  const voiced = callsOn(c) ? new Set(voiceAgents.roster().agents.filter(v => v.workspace === c.workspace && v.voiceId).map(v => v.slug)) : new Set();
  return listAgents(c.workspace).filter(a => !a.isBuilder && !a.error && c.agents.includes(a.slug))
    .map(a => ({ slug: a.slug, name: a.displayName, role: a.role || '', about: a.identity || '', callName: voiced.has(a.slug) ? voiceAgents.nameOf(c.workspace, a.slug) : null }));
}
/** Can this client call their agents? (the owner's switch per client, and ElevenLabs set up.) */
const callsOn = c => c.calls !== false && !!env('ELEVENLABS_API_KEY') && voiceEnabled();

function stateFor(c) {
  const ws = workspace(c.workspace);
  return {
    client: { name: c.name, workspace: ws.id, workspaceName: ws.name, company: ws.client, open: ws.enabled },
    owner: { name: (config.owner?.name || '').trim() },
    timezone: config.timezone,
    agents: sharedAgents(c),
    runs: myRuns(c).slice(0, 60).map(clientRun),
    inbox: inbox.pending().filter(i => i.client === c.id).map(clientItem),
    maxLive: MAX_LIVE,
    calls: callsOn(c),
  };
}

// ── Calls: the client talks to a shared agent (voiceagents.mjs#clientSession). Its five tools come back from the
// page to here and do only what the page itself can do for this client.
const word = r => (runner.isLive(r.id) ? (r.status === 'waiting' ? 'waiting' : 'working') : r.report?.status || r.outcome || r.status);
async function voiceTool(c, name, p) {
  const slug = String(p.slug || '');
  if (!c.agents.includes(slug)) throw err(403, 'That agent isn’t shared with you.');
  if (name === 'start_task') {
    const r = await startTask(c, { agent: slug, text: p.task });
    return `Started. Task id ${r.id}. It shows on the page now.`;
  }
  if (name === 'task_status') {
    const day = Date.now() - 86_400_000;
    const runs = myRuns(c).filter(r => runner.isLive(r.id) || Date.parse(r.endedAt || r.startedAt) > day).slice(0, 12);
    const items = inbox.pending().filter(i => i.client === c.id);
    const mineToDo = items.filter(i => i.answerer === 'client');
    const ownerAsks = items.length - mineToDo.length;
    return [
      runs.length ? `Tasks today:\n${runs.map(r => `- ${r.id}: ${r.agentName}, ${word(r)}: "${clip(r.instruction, 120)}"`).join('\n')}` : 'No tasks today.',
      mineToDo.length ? `Waiting on the caller:\n${mineToDo.map(i => `- ${i.id}: ${i.kind === 'approval' ? 'approval' : 'question'}: ${clip(i.kind === 'approval' ? i.title : i.message || i.title, 200)}${i.options?.length ? ` (options: ${i.options.join(' / ')})` : ''}`).join('\n')}` : 'Nothing waiting on the caller.',
      ownerAsks ? `${ownerAsks} step${ownerAsks > 1 ? 's' : ''} waiting on ${ownerName()}.` : '',
    ].filter(Boolean).join('\n');
  }
  if (name === 'task_result') {
    const r = mine(c, String(p.task_id || ''));
    const cr = clientRun(r);
    return cr.report ? `${word(r)}. ${clip(cr.report.summary, 1500)}` : cr.error ? `It failed: ${cr.error}` : `Still ${word(r)}.`;
  }
  if (name === 'answer_item') {
    const it = inbox.getItem(String(p.item_id || ''));
    const body = it?.kind === 'approval' ? { approve: /^approve/i.test(String(p.decision || '')), note: 'by voice' } : { text: p.answer };
    if (it?.kind === 'approval' && !/^(approve|deny)/i.test(String(p.decision || ''))) throw err(400, 'Say approve or deny.');
    answer(c, String(p.item_id || ''), body);
    return 'Done. The task carries on.';
  }
  if (name === 'follow_up') {
    const r = await followUp(c, String(p.task_id || ''), { text: p.message });
    return `Sent. Task id ${r.id}.`;
  }
  throw err(404, 'No such tool.');
}

/** Live events, filtered to this client. Returns [type, data] or null. */
function forClient(c, evt) {
  switch (evt.type) {
    case 'run.started': case 'run.updated': case 'run.ended': {
      const r = evt.run && db().runs[evt.run.id];
      return r?.client === c.id ? [evt.type, { run: clientRun({ ...r, ...evt.run }) }] : null;
    }
    case 'run.event': {
      const r = db().runs[evt.runId];
      if (r?.client !== c.id) return null;
      const e = clientEvent(evt.event || {}, r);
      return e ? [evt.type, { runId: evt.runId, event: e }] : null;
    }
    case 'inbox.created': case 'inbox.answered': case 'inbox.expired':
      return evt.item?.client === c.id ? [evt.type, { item: clientItem(evt.item) }] : null;
    case 'clients.changed': case 'workspaces.changed': case 'agent.updated': case 'agent.retired':
      return ['refresh', {}];
    default: return null;
  }
}

function text(v, { max = MAX_TEXT, empty = null } = {}) {
  const s = String(v ?? '').trim();
  if (!s) { if (empty !== null) return empty; throw err(400, 'Write something first.'); }
  if (s.length > max) throw err(413, `That’s too long (${s.length} characters; the limit is ${max}).`);
  return s;
}

// ── actions ──
/** Upload ids from the page (files staged in the client's folder, clientspace.mjs). */
function uploadIds(body) {
  const ids = Array.isArray(body.files) ? body.files.map(String) : [];
  if (ids.length > MAX_FILES) throw err(400, `Up to ${MAX_FILES} files at a time.`);
  return ids;
}

async function startTask(c, body) {
  const uploads = uploadIds(body);
  const instruction = text(body.text, { empty: uploads.length ? '' : null });
  const slug = String(body.agent || '');
  if (!c.agents.includes(slug)) throw err(403, 'That agent isn’t shared with you.');
  const ws = workspace(c.workspace);
  const sid = id('s');
  const run = await inSlot(c, () => runner.startRun({ workspace: ws.id, agentSlug: slug, instruction, uploads, session: sid, client: { id: c.id, name: c.name } })
    .catch(e => { throw cantStart(e, c, ws, slug); }));
  // a client's conversation with their agents stays on their page: no Orchy session, nothing in the owner's chat
  return clientRun(db().runs[run.id]);
}

async function followUp(c, rid, body) {
  const prev = mine(c, rid);
  const uploads = uploadIds(body);
  const instruction = text(body.text, { empty: uploads.length ? '' : null });
  // one follow-up at a time per task: two would resume the same agent session at once
  const thread = prev.sessionId || prev.id;
  if (runner.isLive(prev.id) || resuming.has(thread) || myRuns(c).some(r => runner.isLive(r.id) && (r.parentRunId === prev.id || (prev.sessionId && r.sessionId === prev.sessionId)))) throw err(409, 'Still working on it. Wait for it to finish, then follow up.');
  if (!c.agents.includes(prev.agentSlug)) throw err(403, 'That agent isn’t shared with you any more.');
  const ws = workspace(prev.workspace);
  const sid = prev.session || id('s');
  const run = await inSlot(c, () => {
    resuming.add(thread);
    return runner.startRun({ workspace: ws.id, agentSlug: prev.agentSlug, model: prev.model, instruction, uploads, resumeSessionId: prev.sessionId, parentRunId: prev.id, session: sid, client: { id: c.id, name: c.name } })
      .catch(e => { throw cantStart(e, c, ws, prev.agentSlug); }).finally(() => resuming.delete(thread));
  });
  return clientRun(db().runs[run.id]);
}

/** Setup problems are the owner's to fix: tell the owner the details and the client the gist. */
function cantStart(e, c, ws, slug) {
  if (e.status && e.status < 500 && !['ACCOUNT_MISMATCH', 'WORKSPACE_DISABLED'].includes(e.code)) return e;
  const name = sharedAgents(c).find(a => a.slug === slug)?.name || slug;
  const sid = ensureSession(null, { text: `${c.name} couldn’t start ${name}`, origin: 'client-setup' }).id;
  orchy.say(`${c.name} tried to start ${name} from the client page, but it couldn't run: ${e.message}`, { error: true, workspace: ws.id, session: sid });
  return err(503, `${name} can’t start right now. ${ownerName()} has been told and will sort it out.`);
}

function answer(c, iid, body) {
  const item = inbox.getItem(iid);
  if (!item || item.client !== c.id || item.answerer !== 'client') throw err(404, 'That question is gone.');
  if (item.status !== 'pending') throw err(409, 'Already answered.');
  let ans;
  if (item.kind === 'question') ans = { text: text(body.text, { max: 4000, empty: '(no answer)' }) };
  else if (item.kind === 'approval') ans = { approve: !!body.approve, note: String(body.note || '').slice(0, 1000), remember: false };
  else throw err(400, 'That can’t be answered here.');
  inbox.answer(iid, { ...ans, by: c.name });
  const run = db().runs[item.runId];
  if (run && !inbox.pending().some(i => i.runId === run.id)) runner.setRunStatus(run, 'working');
  return { ok: true };
}

// ── HTTP ──
const SECURITY = {
  'Referrer-Policy': 'no-referrer', // the link's secret is in the path: never hand it to sites the client opens
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow',
  // scripts only from here (the call SDK and its audio worklets are pinned copies, dashboard/vendor/elevenlabs);
  // the network only to here and ElevenLabs' call servers; WebAssembly for the resampler a call may need
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; media-src 'self' blob:; connect-src 'self' https://api.elevenlabs.io wss://api.elevenlabs.io https://livekit.rtc.elevenlabs.io wss://livekit.rtc.elevenlabs.io; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=(), payment=(), usb=()',
};
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
// the only files this server hands out
const d = (...p) => path.join(DASHBOARD_DIR, ...p);
const STATIC = {
  '/styles/tokens.css': d('styles', 'tokens.css'), '/styles/app.css': d('styles', 'app.css'), '/styles/client.css': d('styles', 'client.css'),
  '/js/client.mjs': d('js', 'client.mjs'), '/js/attach.mjs': d('js', 'attach.mjs'), '/js/pixel.mjs': d('js', 'pixel.mjs'), '/js/util.mjs': d('js', 'util.mjs'),
  '/vendor/marked.js': path.join(ROOT, 'node_modules', 'marked', 'lib', 'marked.esm.js'),
  '/js/clientcall.mjs': d('js', 'clientcall.mjs'),
  ...Object.fromEntries(['client-1.25.0.js', 'rawAudioProcessor.js', 'audioConcatProcessor.js', 'libsamplerate-2.1.2.worklet.js'].map(f => [`/vendor/elevenlabs/${f}`, d('vendor', 'elevenlabs', f)])),
  '/fonts/Silkscreen-400.woff2': d('fonts', 'Silkscreen-400.woff2'), '/fonts/AtkinsonHyperlegibleNext.woff2': d('fonts', 'AtkinsonHyperlegibleNext.woff2'),
  '/fonts/AtkinsonHyperlegibleMono.woff2': d('fonts', 'AtkinsonHyperlegibleMono.woff2'),
  '/assets/images/lilorchy_svg.svg': path.join(ROOT, 'assets', 'images', 'lilorchy_svg.svg'),
};

function send(res, status, body, headers = {}) {
  const json = typeof body !== 'string';
  res.writeHead(status, { ...SECURITY, 'Content-Type': json ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(json ? JSON.stringify(body) : body);
}
function serveFile(res, file, cache = 'no-cache') {
  if (!fs.existsSync(file)) return send(res, 404, { error: 'Not found' });
  res.writeHead(200, { ...SECURITY, 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': cache });
  fs.createReadStream(file).pipe(res);
}
const escHTML = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const notice = (res, status, title, message) => send(res, status, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escHTML(title)}</title>
<link rel="stylesheet" href="/styles/tokens.css"><link rel="stylesheet" href="/styles/client.css">
<main class="gone"><h1>${escHTML(title)}</h1><p>${escHTML(message)}</p></main></html>`);
const gone = res => notice(res, 404, 'Link not working', `This link was replaced or switched off. Ask ${ownerName()} for a new one.`);

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 100_000) throw err(413, 'Too much at once.'); }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw err(400, 'That request was garbled. Reload the page.'); }
}

/** The client a request belongs to. Through Cloudflare, Access must have signed them in (as them). */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
async function who(req, token) {
  const c = clientByToken(token);
  if (!c) return null;
  // on this PC the link alone opens it; from anywhere else only through Cloudflare Access, checked (lib/cfaccess.mjs)
  const viaCloudflare = !!(req.headers['cf-ray'] || req.headers['cf-connecting-ip']);
  const remote = viaCloudflare || !LOCAL_HOST.test(String(req.headers.host || '')) || !!(req.headers['x-forwarded-for'] || req.headers.forwarded);
  if (!remote) return c;
  if (!viaCloudflare) throw err(403, `Client pages go online only through a Cloudflare Tunnel with Cloudflare Access, so this page stays closed. ${ownerName()} can find the steps in the README (Client pages).`);
  const cfg = accessConfig();
  if (!cfg) throw err(403, `This page isn’t protected by Cloudflare Access yet, so it stays closed. ${ownerName()} needs to finish the Access setup.`);
  let email;
  try { email = await verifiedEmail(req, cfg); }
  catch (e) { throw err(403, `Cloudflare Access didn’t vouch for this visit (${e.message}), so the page stays closed.`); }
  // online, a link opens only for the person it belongs to: no email on file means nobody
  if (!c.email) throw err(403, `${ownerName()} hasn’t said whose email this link is for yet, so it stays closed. Ask ${ownerName()} to add it.`);
  if (email !== c.email) throw err(403, `This link belongs to ${c.name}, but you’re signed in as ${email}.`);
  return c;
}

function events(req, res, c, token) {
  res.writeHead(200, { ...SECURITY, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  const write = (type, data) => { try { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} };
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20_000); // under Cloudflare's 100s idle cut-off
  const stop = () => { clearInterval(ping); bus.off('event', onEvent); };
  const onEvent = evt => {
    const now = clientByToken(token); // the link was replaced or switched off: close the stream
    if (!now || now.id !== c.id) { write('revoked', {}); stop(); res.end(); return; }
    const out = forClient(now, evt);
    if (out) write(out[0], out[1]);
  };
  bus.on('event', onEvent);
  req.on('close', stop);
}

async function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://x');
  if (req.method === 'GET' && STATIC[pathname]) return serveFile(res, STATIC[pathname], pathname.startsWith('/fonts/') ? 'max-age=86400' : 'no-cache');
  const m = pathname.match(/^\/c\/([A-Za-z0-9_-]{20,100})(\/.*)?$/);
  if (!m) return gone(res);
  const [, token, rest = '/'] = m;
  let c;
  try { c = await who(req, token); }
  catch (e) { if (rest === '/') return notice(res, e.status, 'Not open yet', e.message); throw e; }
  if (!c) return gone(res);
  if (req.method === 'GET' && rest === '/') return serveFile(res, d('client.html'), 'no-store');
  const api = rest.match(/^\/api\/(.+)$/)?.[1];
  if (!api) return gone(res);
  const [a, b, x] = api.split('/');
  if (req.method === 'GET' && api === 'state') return send(res, 200, stateFor(c));
  if (req.method === 'GET' && api === 'events') return events(req, res, c, token);
  if (req.method === 'POST' && api === 'runs') return send(res, 200, await startTask(c, await readBody(req)));
  // a file for the next task or follow-up: the raw body is the file, X-File-Name its name
  if (req.method === 'POST' && api === 'files') {
    allow(c, 'upload');
    const name = decodeURIComponent(String(req.headers['x-file-name'] || ''));
    if (!name.trim()) throw err(400, 'That file has no name.');
    return send(res, 200, await stageUpload(workspace(c.workspace), c.id, req, name));
  }
  if (a === 'runs' && b) {
    if (req.method === 'GET' && !x) {
      const r = mine(c, b);
      return send(res, 200, { run: clientRun(r), events: runner.runEvents(r.id).map(e => clientEvent(e, r)).filter(Boolean), items: inbox.itemsForRun(r.id).map(clientItem), live: runner.isLive(r.id) });
    }
    // the task's folder: what they attached and what the agent made
    if (req.method === 'GET' && x === 'files') {
      const r = mine(c, b);
      return send(res, 200, taskFiles(workspace(r.workspace), r).map(({ path: p, name, size, kind, at, uploaded }) => ({ path: p, name, size, kind, at, uploaded })));
    }
    if (req.method === 'GET' && x === 'file') {
      const r = mine(c, b);
      const file = taskFile(workspace(r.workspace), r, new URL(req.url, 'http://x').searchParams.get('path'));
      if (!file) throw err(404, 'That file isn’t there.');
      return sendTaskFile(res, file, { 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'X-Robots-Tag': 'noindex, nofollow' });
    }
    if (req.method === 'POST' && x === 'reply') return send(res, 200, await followUp(c, b, await readBody(req)));
    if (req.method === 'POST' && x === 'stop') { mine(c, b); return send(res, 200, clientRun(db().runs[runner.stopRun(b, { by: c.name }).id])); }
  }
  if (req.method === 'POST' && a === 'inbox' && b && x === 'answer') return send(res, 200, answer(c, b, await readBody(req)));
  if (a === 'voice' && req.method === 'POST') {
    if (!callsOn(c)) throw err(403, 'Calls aren’t switched on for you.');
    // voice/<slug>/session: a signed link for one call with one of their agents
    if (b && x === 'session') {
      if (!c.agents.includes(b)) throw err(403, 'That agent isn’t shared with you.');
      allow(c, 'call');
      const s = await voiceAgents.clientSession(c, b);
      return send(res, 200, { signedUrl: s.signedUrl, name: s.name });
    }
    if (b === 'tool' && x) { allow(c, 'tool'); return send(res, 200, { text: scrubber(c.workspace, c.id)(await voiceTool(c, x, await readBody(req))) }); }
    // a client's call is theirs: nothing of it reaches the owner's chat (ElevenLabs keeps the transcript 30 days)
    if (b === 'end') { allow(c, 'end'); return send(res, 200, { ok: true }); }
  }
  throw err(404, 'Not found');
}

export function startPortal() {
  const port = CLIENT_PORT();
  const server = http.createServer(async (req, res) => {
    try { await handle(req, res); }
    catch (e) {
      if (!e.status || e.status >= 500) console.error(`[client page] ${req.method} ${req.url.replace(/\/c\/[^/]+/, '/c/…')}`, e);
      if (!res.headersSent) send(res, e.status || 500, { error: e.status && e.status < 500 ? scrub(e.message) : `Something went wrong on ${ownerName()}’s side. Try again in a minute.` });
      else res.end();
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.on('error', e => console.error(e.code === 'EADDRINUSE'
    ? `\n  Client pages: port ${port} is taken, so client links won't open. Free it or set CLIENT_PORT=… in .env.\n`
    : `[client page] ${e.message}`));
  server.listen(port, '127.0.0.1', () => console.log(`  Client pages → http://localhost:${port} (only /c/<link>; put this port behind Cloudflare Access)`));
  return server;
}
