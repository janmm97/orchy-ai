// What a client's page sees of the files their tasks made, and how their videos play.
// portal.mjs calls these after its own client checks (link secret, Cloudflare Access email). The fence:
//   - only artifacts with artifact.client === this client, in this client's workspace, touched by one of this
//     client's own runs, whose file resolves (realpath) inside this client's sandbox <workspace>/.clients/<id>/;
//     everything else (another client's, the owner's runs, workspace or setup files, a link out) is the same 404;
//   - the record is scrubbed: no workspace path (paths are relative to their own folder), no agent internals
//     (source, runIds, huddle, ffmpeg errors), no R2 keys;
//   - video and audio never stream through the tunnel (Cloudflare's terms): they play from R2 through a presigned
//     GET (≤ 15 min) minted per view; with no R2 keys in .env the page says it isn't switched on yet.
import fs from 'node:fs';
import path from 'node:path';
import { db as storeDb } from './store.mjs';
import { bus } from './bus.mjs';
import { ownerName } from './env.mjs';
import { workspace as wsById } from './workspaces.mjs';
import * as A from './artifacts.mjs';
import { mediaFile } from './media.mjs';
import { CLIENTS_DIR, clientHome, MEDIA } from './clientspace.mjs';
import * as r2 from './r2.mjs';

/** What a client sees when their video can't play because R2 isn't set up. */
export const offMessage = () => `Video playback for clients isn’t switched on yet. ${ownerName()} has been told.`;
const STREAMED = new Set(['video', 'audio']); // never through the tunnel
const R2_FRESH_MS = 29 * 86_400_000;           // the bucket's 30-day lifetime rule: upload again before it bites

const deps = { db: storeDb, workspace: wsById, mediaFile, onOff: null };
/** For tests (and portal.mjs: `onOff` tells the owner once that client video is off). */
export function configureClientView(o) { Object.assign(deps, o); }

const nf = () => Object.assign(new Error('That file isn’t here.'), { status: 404 });
const realOf = p => { try { return fs.realpathSync.native(p); } catch { return null; } };
// Windows and macOS folders ignore case; Linux folders don't
const fold = s => (process.platform === 'win32' || process.platform === 'darwin' ? String(s).toLowerCase() : String(s));
const inside = (child, root) => fold(child).startsWith(fold(root).replace(/[\\/]+$/, '') + path.sep);
const homePrefix = c => fold(`${CLIENTS_DIR}/${c.id}/`);

/** Is this registry record one of this client's? (record level only; `guard` also checks the file) */
function ownsRecord(c, a) {
  if (!a || !c?.id || a.client !== c.id || a.workspace !== c.workspace) return false;
  if (!fold(a.rel || '').startsWith(homePrefix(c))) return false;
  const runs = deps.db().runs || {};
  return (a.runIds || []).some(rid => runs[rid]?.client === c.id);
}

/** The client's own artifact and its real file, or a 404. `fresh` re-stats it (version bump, missing). */
export function guard(c, id, { fresh = true } = {}) {
  if (!/^art_[0-9a-f]{16}$/.test(String(id || ''))) throw nf();
  const a0 = A.getArtifact(id);
  if (!ownsRecord(c, a0)) throw nf();
  let ws;
  try { ws = deps.workspace(c.workspace); } catch { throw nf(); }
  let a = a0, file;
  if (fresh) { try { ({ artifact: a, file } = A.openArtifact(id)); } catch { throw nf(); } }
  else file = A.resolveFile(ws, a.rel, c.id);
  // the sandbox, checked here on its own as well (resolveFile already confines a client's artifacts to it)
  const home = realOf(clientHome(ws, c.id));
  if (!file || !home || !inside(file, home) || !ownsRecord(c, a)) throw nf();
  return { a, file, ws };
}

/** What the page gets: no workspace path, no agent internals, no R2 keys. */
export function clientArtifact(c, a) {
  const runs = deps.db().runs || {};
  const rel = String(a.rel).slice(homePrefix(c).length); // relative to their own folder: Tasks/<task>/…
  const m = a.media || null;
  return {
    id: a.id, name: a.name, kind: a.kind, ext: a.ext, size: a.size, version: a.version, status: a.status, updatedAt: a.updatedAt, rel,
    runId: runs[a.runId]?.client === c.id ? a.runId : null, agentName: a.agentName || null,
    media: m ? {
      state: m.state || null, w: m.w ?? null, h: m.h ?? null, durationSec: m.durationSec ?? null, vcodec: m.vcodec || null, acodec: m.acodec || null,
      fps: m.fps ?? null, frames: m.frames ?? null, bytes: m.bytes ?? null, progress: m.progress ?? null,
      poster: !!m.poster, thumb: !!m.thumb, fit: !!m.fit, preview: !!m.preview, play: m.play ? (m.play === 'copy' ? 'copy' : 'original') : null,
    } : null,
    ...(STREAMED.has(a.kind) && { video: videoState(a) }),
  };
}

/** The client's files for one of their runs (the portal has checked run.client already). */
export function listFor(c, run, { ended = false } = {}) {
  if (!run || run.client !== c.id) throw nf();
  A.syncRun(run, { ended }); // client runs: their task folder and sandbox only
  const out = [];
  for (const p of A.listArtifacts({ run, limit: 300 })) {
    const a = A.getArtifact(p.id);
    if (!ownsRecord(c, a) || a.status === 'missing') continue;
    try { guard(c, a.id, { fresh: false }); } catch { continue; }
    out.push(clientArtifact(c, a));
  }
  return { artifacts: out, video: { on: r2.r2Status().on } };
}

// ── video and audio through R2 ──
function videoState(a) {
  if (!r2.r2Status().on) return { state: 'off' };
  const m = a.media || {}, u = m.r2;
  if (!m.play) return { state: 'preparing' };
  if (u?.version === a.version && u.state === 'ready' && Date.now() - Date.parse(u.at) < R2_FRESH_MS) return { state: 'ready' };
  if (u?.version === a.version && u.state === 'uploading') return { state: 'uploading' };
  if (u?.version === a.version && u.state === 'error') return { state: 'error' };
  return { state: 'waiting' };
}
// what media.mediaFile(id, 'play') is: the original as is, or a copy (H.264/AAC, or the faststart remux) in previews/
const playName = a => (a.media?.play === 'original' ? `original.${String(a.ext).replace(/[^\w]/g, '').slice(0, 8) || 'bin'}` : a.kind === 'audio' ? 'audio.m4a' : 'play.mp4');
const playType = name => MEDIA[path.extname(name).toLowerCase()] || (name.endsWith('.m4a') ? 'audio/mp4' : 'video/mp4');

let chain = Promise.resolve();
const uploading = new Set(); // `${id}:${version}`
function setR2(id, version, patch) {
  const a = A.getArtifact(id);
  if (!a || a.version !== version) return; // a newer version came in meanwhile: its own upload follows
  A.updateMedia(id, { r2: { ...(a.media?.r2?.version === version ? a.media.r2 : {}), version, ...patch } });
}
/** Put the playable file of a client's video in R2 (one upload at a time). Resolves when done. */
export function upload(cid, a) {
  const cfg = r2.r2Config();
  if (!cfg || !a?.media?.play || !STREAMED.has(a.kind) || a.client !== cid) return Promise.resolve(false);
  const tag = `${a.id}:${a.version}`;
  if (uploading.has(tag)) return chain;
  const file = deps.mediaFile(a.id, 'play');
  if (!file) return Promise.resolve(false);
  const version = a.version, name = playName(a), key = r2.keyFor(cid, a.id, version, name);
  uploading.add(tag);
  setR2(a.id, version, { state: 'uploading', key, at: null, error: null });
  chain = chain.then(async () => {
    try {
      await r2.deletePrefix(cfg, r2.clientPrefix(cid, a.id)).catch(() => {}); // the old version's copy
      await r2.putFile(cfg, key, file, playType(name));
      setR2(a.id, version, { state: 'ready', key, name, at: new Date().toISOString(), error: null });
      return true;
    } catch (e) {
      console.error('[client video] upload failed:', e.message);
      setR2(a.id, version, { state: 'error', error: String(e.message).slice(0, 200) });
      return false;
    } finally { uploading.delete(tag); }
  });
  return chain;
}

/**
 * The page asks to play (or download) one of their videos: a presigned GET link (≤ 15 min), or what's in the way:
 * { url, download, expiresAt } | { off: true, message, note } | { state: 'preparing'|'uploading'|'waiting'|'error', message }.
 */
export function playFor(c, id) {
  const { a } = guard(c, id);
  if (!STREAMED.has(a.kind)) throw Object.assign(new Error('Only videos and audio play this way.'), { status: 400 });
  const cfg = r2.r2Config();
  if (!cfg) { deps.onOff?.(c, a); return { off: true, message: offMessage(), note: `${ownerName()} has been told. It plays right here once it is.` }; }
  const v = videoState(a);
  if (v.state === 'ready') {
    const key = a.media.r2.key;
    const play = r2.presignGet(cfg, key, { expires: r2.PLAY_EXPIRES });
    const dl = r2.presignGet(cfg, key, { expires: r2.PLAY_EXPIRES, download: a.media.play === 'original' ? a.name : a.name.replace(/\.[^.]+$/, '') + path.extname(a.media.r2.name || '.mp4') });
    return { url: play.url, download: dl.url, expiresAt: play.expiresAt };
  }
  if (v.state === 'preparing' || v.state === 'uploading') return { state: v.state, message: 'Getting it ready to play…' };
  upload(c.id, a); // waiting (or a failed try): start it now; the page hears artifact.updated when it's ready
  return { state: 'uploading', message: 'Getting it ready to play…' };
}

/** A client was removed: their copies go from the bucket too (the bucket's 30-day rule catches anything missed). */
export const forgetClient = cid => r2.forgetClientCopies(cid);

/** Live events for the page: only this client's artifacts, scrubbed. Returns [type, data] or null. */
export function artifactEvent(c, evt) {
  if (evt.type !== 'artifact.created' && evt.type !== 'artifact.updated') return null;
  const a = evt.artifact?.id && A.getArtifact(evt.artifact.id);
  if (!ownsRecord(c, a)) return null;
  return ['artifact.updated', { artifact: clientArtifact(c, a) }];
}

// ── wiring (portal.mjs calls this once) ──
let started = false;
export function startClientView() {
  if (started) return;
  started = true;
  // a client's video that's final and playable goes up ahead of time, so it plays at once when they open it
  bus.on('event', e => {
    try {
      if (e.type !== 'artifact.updated' || !e.artifact?.client) return;
      const a = A.getArtifact(e.artifact.id);
      if (!a?.client || a.status !== 'final' || !STREAMED.has(a.kind) || a.media?.state !== 'ready' || !a.media.play) return;
      if (videoState(a).state === 'waiting') upload(a.client, a);
    } catch (err) { console.error('[client video]', err.message); }
  });
  // an artifact dropped from the registry takes its R2 copy with it
  A.onDrop(a => {
    const cfg = a?.client && a.media?.r2?.key && r2.r2Config();
    if (cfg) r2.deletePrefix(cfg, r2.clientPrefix(a.client, a.id)).catch(err => console.warn('[client video] not removed:', err.message));
  });
}
