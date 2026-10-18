// The media pipeline: what the viewer needs to show images and play video/audio. ffmpeg is optional: without it
// every file still opens as is (the browser shows png/jpg/gif/webp and plays mp4/webm itself), and media records say
// `no-ffmpeg` instead of offering thumbs, posters and playable copies.
// On register (artifacts.mjs → enqueue): ffprobe → artifact.media {w, h, durationSec, vcodec, acodec, fps, rotation,
// frames}; then, only when the browser can't show the original as is: a thumb (320 px) for galleries and chips,
// a fit view (2560 px) for huge images, a preview.webp for HEIC/TIFF/PSD/DNG, a poster for video, a faststart
// remux for an mp4/mov whose moov sits at the end, a playable H.264/AAC copy (≤1080p) for anything else, and an
// audio.m4a for audio the browser can't play. Progress shown while transcoding is measured (-progress out_time).
//
// Rules: spawn with an args array (never a shell); inputs only from the registry (re-checked by the path guard);
// outputs only in orchestrator/data/previews/<artifactId>/v<version>/ (agents can't reach it), written under a temp
// name and renamed; one job at a time; inputs capped at 4 GB / 3 h; a file still being written waits ("processing").
// Previews of artifacts that drop out of the registry are deleted.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { env } from './env.mjs';
import { standardBinDirs } from './claude.mjs';
import { configure, getArtifact, updateMedia, openArtifact, previewsDir } from './artifacts.mjs';

export const LIMITS = { bytes: 4 * 1024 ** 3, seconds: 3 * 3600, hugeBytes: 8 * 1024 * 1024, hugePx: 4000, fitPx: 2560, thumbPx: 320, posterPx: 1280 };
const NATIVE_IMG = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg']);
const CONVERT_IMG = new Set(['heic', 'heif', 'tif', 'tiff', 'psd', 'dng']);
const PLAY_CONTAINER = new Set(['mp4', 'm4v', 'webm', 'mov']);
const FASTSTART_CONTAINER = new Set(['mp4', 'm4v', 'mov']);
const PLAY_V = new Set(['h264', 'vp8', 'vp9', 'av1']);
const PLAY_A = new Set(['aac', 'mp3', 'opus', 'vorbis']);
const NATIVE_AUDIO = new Set(['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac']);
const STABLE_MS = 2000, RECHECK_MS = 5000, MAX_WAITS = 720; // a file still growing is looked at again for up to an hour

// ── finding ffmpeg ──
// FFMPEG_PATH (the ffmpeg binary or its folder), then PATH and the usual install folders (Homebrew, /usr/local/bin,
// ~/.local/bin), then winget's links and packages on Windows. Only real executables: ffmpeg is spawned without a
// shell, so a .cmd shim can't be used.
const EXE = process.platform === 'win32' ? '.exe' : '';
function findBins() {
  const pair = dir => {
    const f = path.join(dir, `ffmpeg${EXE}`), p = path.join(dir, `ffprobe${EXE}`);
    try { return fs.statSync(f).isFile() && fs.statSync(p).isFile() ? { ffmpeg: f, ffprobe: p } : null; } catch { return null; }
  };
  const explicit = env('FFMPEG_PATH');
  if (explicit) {
    let r = null;
    try { r = fs.statSync(explicit).isFile() ? pair(path.dirname(explicit)) : pair(explicit); } catch {}
    if (r) return r;
  }
  const dirs = [...String(process.env.PATH || '').split(path.delimiter).map(d => d.replace(/^"|"$/g, '')), ...standardBinDirs(), '/opt/local/bin', '/snap/bin'];
  for (const d of dirs) { if (d) { const r = pair(d); if (r) return r; } }
  const local = process.platform === 'win32' && process.env.LOCALAPPDATA;
  if (local) {
    const links = pair(path.join(local, 'Microsoft', 'WinGet', 'Links'));
    if (links) return links;
    const pk = path.join(local, 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const d of fs.readdirSync(pk).filter(d => /ffmpeg/i.test(d))) {
        for (const sub of fs.readdirSync(path.join(pk, d)).sort().reverse()) { const r = pair(path.join(pk, d, sub, 'bin')); if (r) return r; }
      }
    } catch {}
  }
  return null;
}
let bins;
/** { ffmpeg, ffprobe } absolute paths, or null when ffmpeg isn't installed (looked up again if it goes away). */
export function ffBins() { if (bins === undefined || (bins && !fs.existsSync(bins.ffmpeg))) bins = findBins(); return bins; }
/** Forget the lookup (e.g. after FFMPEG_PATH changed). */
export function resetBins() { bins = undefined; }
/** Tests: pretend ffmpeg is installed at `b` ({ ffmpeg, ffprobe }), or isn't (null). */
export function useBins(b) { bins = b; }

/** Run a binary (no shell). Resolves { code, out, err }; `onOut` gets stdout lines as they come. */
function exec(bin, args, { onOut, timeoutMs = 6 * 3600_000 } = {}) {
  return new Promise(resolve => {
    let out = '', err = '', buf = '';
    let child;
    try { child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ code: -1, out: '', err: e.message }); }
    const t = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on('data', d => {
      const s = d.toString();
      if (out.length < 4_000_000) out += s;
      if (onOut) { buf += s; let i; while ((i = buf.indexOf('\n')) >= 0) { onOut(buf.slice(0, i).trim()); buf = buf.slice(i + 1); } }
    });
    child.stderr.on('data', d => { err = (err + d.toString()).slice(-4000); });
    child.on('error', e => { clearTimeout(t); resolve({ code: -1, out, err: e.message }); });
    child.on('close', code => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

// ── what a file is ──
const num = v => (v == null || v === 'N/A' || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const rate = r => { const [a, b] = String(r || '').split('/').map(Number); return a && b ? Math.round((a / b) * 100) / 100 : null; };
/** ffprobe's JSON as the fields the viewer shows. */
export function mediaInfo(j) {
  const streams = j?.streams || [];
  const v = streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic) || streams.find(s => s.codec_type === 'video');
  const a = streams.find(s => s.codec_type === 'audio');
  const rot = num(v?.side_data_list?.find(d => d.rotation != null)?.rotation) ?? num(v?.tags?.rotate) ?? 0;
  let w = num(v?.width), h = num(v?.height);
  if (Math.abs(rot) % 180 === 90) [w, h] = [h, w]; // as it's shown
  return {
    w, h, durationSec: num(j?.format?.duration) ?? num(v?.duration) ?? num(a?.duration),
    vcodec: v?.codec_name || null, acodec: a?.codec_name || null, fps: rate(v?.avg_frame_rate) || rate(v?.r_frame_rate),
    rotation: rot, frames: num(v?.nb_frames), format: j?.format?.format_name || null,
  };
}
export async function probe(file) {
  const b = ffBins();
  if (!b) throw new Error('ffmpeg isn’t installed (install it, or set FFMPEG_PATH in .env)');
  const r = await exec(b.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error((r.err || 'ffprobe failed').trim().split('\n').pop());
  return mediaInfo(JSON.parse(r.out || '{}'));
}

/** Does an mp4/mov keep its moov after mdat (so playback waits for the whole file)? Walks the top-level boxes. */
export function moovAtEnd(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, h = Buffer.alloc(16);
    let off = 0;
    for (let i = 0; i < 10_000 && off + 8 <= size; i++) {
      fs.readSync(fd, h, 0, 16, off);
      let len = h.readUInt32BE(0);
      const type = h.toString('latin1', 4, 8);
      if (len === 1) len = Number(h.readBigUInt64BE(8));
      else if (len === 0) len = size - off;
      if (type === 'moov') return false;
      if (type === 'mdat') return true;
      if (len < 8) return false;
      off += len;
    }
    return false;
  } finally { fs.closeSync(fd); }
}

/** Can Chrome/Edge (and Firefox, mostly) play this as is? */
export function playsAsIs(ext, info) {
  return PLAY_CONTAINER.has(ext) && PLAY_V.has(info.vcodec) && (!info.acodec || PLAY_A.has(info.acodec));
}

// ── files ──
const dirOf = a => path.join(previewsDir(), a.id, `v${a.version}`);
const FILES = { poster: 'poster.webp', thumb: 'thumb.webp', fit: 'fit.webp', preview: 'preview.webp' };
export const MEDIA_FILES = ['poster', 'thumb', 'fit', 'preview', 'play'];
/** The file behind /api/artifacts/:id/media/<what>, or null. `play` is the original when it plays as is. */
export function mediaFile(id, what) {
  const a = getArtifact(id);
  if (!a?.media) return null;
  if (what === 'play') {
    if (a.media.play === 'original') return openArtifact(id).file;
    const f = path.join(dirOf(a), a.kind === 'audio' ? 'audio.m4a' : 'play.mp4');
    return a.media.play && fs.existsSync(f) ? f : null;
  }
  if (!FILES[what] || !a.media[what]) return null;
  const f = path.join(dirOf(a), FILES[what]);
  return fs.existsSync(f) ? f : null;
}
export function drop(id) { if (/^art_[0-9a-f]{16}$/.test(id)) fs.rmSync(path.join(previewsDir(), id), { recursive: true, force: true }); }
/** Preview folders of artifacts the registry no longer has (or of their old versions). */
export function sweep() {
  let ids = [];
  try { ids = fs.readdirSync(previewsDir()); } catch { return; }
  for (const id of ids) {
    const a = getArtifact(id);
    if (!a) { drop(id); continue; }
    try { for (const v of fs.readdirSync(path.join(previewsDir(), id))) if (v !== `v${a.version}`) fs.rmSync(path.join(previewsDir(), id, v), { recursive: true, force: true }); } catch {}
  }
}

async function ff(args, out, opts) {
  const b = ffBins();
  if (!b) throw new Error('ffmpeg isn’t installed');
  const tmp = out.replace(/(\.\w+)$/, '.part$1');
  const r = await exec(b.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args, tmp], opts);
  if (r.code !== 0 || !fs.existsSync(tmp) || !fs.statSync(tmp).size) { fs.rmSync(tmp, { force: true }); throw new Error((r.err || 'ffmpeg failed').trim().split('\n').pop()); }
  fs.renameSync(tmp, out);
  return out;
}
const scaleTo = px => `scale='min(${px},iw)':-2:flags=lanczos`;
const still = (input, out, px, seek = null) => ff([...(seek != null ? ['-ss', String(seek)] : []), '-i', input, '-frames:v', '1', '-vf', scaleTo(px), '-c:v', 'libwebp', '-quality', '82'], out, { timeoutMs: 120_000 });

// ── the queue ──
const queue = [];
const waits = new Map(); // id → times seen still growing
let busy = false;
/** artifacts.mjs calls this on every new or changed image/video/audio. */
export function enqueue(a) {
  if (!a || !['image', 'video', 'audio'].includes(a.kind)) return;
  if (!queue.includes(a.id)) queue.push(a.id);
  setImmediate(pump);
}
async function pump() {
  if (busy) return;
  const id = queue.shift();
  if (!id) return;
  busy = true;
  try { await processOne(id); } catch (e) { console.error('[media]', id, e.message); try { updateMedia(id, { state: 'error', error: String(e.message).slice(0, 300) }); } catch {} }
  busy = false;
  setImmediate(pump);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = f => { const s = fs.statSync(f); return `${s.size}:${s.mtimeMs}`; };

async function processOne(id) {
  let a = getArtifact(id);
  if (!a) return;
  let file;
  try { file = openArtifact(id).file; } catch { return; } // gone, or outside the fence now
  a = getArtifact(id);
  const size = fs.statSync(file).size;
  if (size > LIMITS.bytes) return updateMedia(id, { state: 'too-big', bytes: size });
  // without ffmpeg the original still shows (native types), and the viewer says what's missing for the rest
  if (!ffBins()) return updateMedia(id, { state: 'no-ffmpeg', bytes: size, ...(a.kind === 'audio' && NATIVE_AUDIO.has(a.ext) ? { play: 'original' } : {}) });
  // a render still on its way in: say so, never play half an mp4
  if (a.kind !== 'image') {
    const s1 = stamp(file);
    await sleep(STABLE_MS);
    if (!fs.existsSync(file) || stamp(file) !== s1) {
      const n = (waits.get(id) || 0) + 1;
      waits.set(id, n);
      updateMedia(id, { state: 'processing', bytes: fs.existsSync(file) ? fs.statSync(file).size : size });
      if (n < MAX_WAITS) setTimeout(() => enqueue(getArtifact(id)), RECHECK_MS).unref?.();
      return;
    }
    waits.delete(id);
  }
  const ext = a.ext;
  let info;
  try { info = await probe(file); }
  catch (e) { return updateMedia(id, { state: a.kind === 'image' && NATIVE_IMG.has(ext) ? 'ready' : 'unsupported', error: String(e.message).slice(0, 300) }); }
  const dir = dirOf(a);
  fs.mkdirSync(dir, { recursive: true });
  for (const v of fs.readdirSync(path.dirname(dir))) if (v !== path.basename(dir)) fs.rmSync(path.join(path.dirname(dir), v), { recursive: true, force: true });
  const base = { ...info, bytes: size, state: 'working', poster: false, thumb: false, fit: false, preview: false, play: null, progress: null, error: null };
  updateMedia(id, base);
  const at = () => new Date().toISOString();

  if (a.kind === 'image') {
    const out = { ...base, state: 'ready' };
    if (NATIVE_IMG.has(ext)) {
      if (ext !== 'svg' && ext !== 'ico') {
        try { await still(file, path.join(dir, FILES.thumb), LIMITS.thumbPx); out.thumb = true; } catch {}
        if (size > LIMITS.hugeBytes || Math.max(info.w || 0, info.h || 0) > LIMITS.hugePx) { try { await still(file, path.join(dir, FILES.fit), LIMITS.fitPx); out.fit = true; } catch {} }
      }
    } else if (CONVERT_IMG.has(ext)) {
      try {
        await still(file, path.join(dir, FILES.preview), LIMITS.fitPx);
        out.preview = true;
        try { await still(path.join(dir, FILES.preview), path.join(dir, FILES.thumb), LIMITS.thumbPx); out.thumb = true; } catch {}
      } catch (e) { out.state = 'unsupported'; out.error = String(e.message).slice(0, 300); }
    } else out.state = 'unsupported';
    return updateMedia(id, { ...out, at: at() });
  }

  if (a.kind === 'audio') {
    if (NATIVE_AUDIO.has(ext)) return updateMedia(id, { state: 'ready', play: 'original', at: at() });
    if ((info.durationSec || 0) > LIMITS.seconds) return updateMedia(id, { state: 'too-long' });
    updateMedia(id, { state: 'transcoding', progress: 0 });
    await ff(['-i', file, '-vn', '-c:a', 'aac', '-b:a', '192k', '-progress', 'pipe:1', '-nostats'], path.join(dir, 'audio.m4a'), { onOut: progressFor(id, info.durationSec) });
    return updateMedia(id, { state: 'ready', play: 'copy', progress: null, at: at() });
  }

  // video: poster + thumb first, so the viewer has something to show while a copy is made
  const out = { state: 'ready' };
  if (info.vcodec) {
    try {
      await still(file, path.join(dir, FILES.poster), LIMITS.posterPx, info.durationSec ? Math.round(info.durationSec * 0.1 * 100) / 100 : 0);
      out.poster = true;
      await still(path.join(dir, FILES.poster), path.join(dir, FILES.thumb), LIMITS.thumbPx);
      out.thumb = true;
    } catch {}
    updateMedia(id, { poster: out.poster, thumb: out.thumb });
  }
  if (playsAsIs(ext, info)) {
    if (FASTSTART_CONTAINER.has(ext) && moovAtEnd(file)) {
      updateMedia(id, { state: 'remuxing' });
      try { await ff(['-i', file, '-map', '0', '-c', 'copy', '-movflags', '+faststart'], path.join(dir, 'play.mp4'), { timeoutMs: 3600_000 }); out.play = 'faststart'; }
      catch { out.play = 'original'; }
    } else out.play = 'original';
    return updateMedia(id, { ...out, at: at() });
  }
  if (!info.vcodec) return updateMedia(id, { ...out, state: 'unsupported', error: 'No video stream' });
  if ((info.durationSec || 0) > LIMITS.seconds) return updateMedia(id, { ...out, state: 'too-long' });
  updateMedia(id, { state: 'transcoding', progress: 0 });
  await ff([
    '-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-vf', "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2",
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats',
  ], path.join(dir, 'play.mp4'), { onOut: progressFor(id, info.durationSec) });
  return updateMedia(id, { ...out, play: 'copy', progress: null, at: at() });
}

/** Measured progress (out_time ÷ duration), sent at most once a second and only when it moves a whole percent. */
function progressFor(id, durationSec) {
  let last = -1, lastAt = 0;
  return line => {
    const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
    if (!m || !durationSec) return;
    const pct = Math.max(0, Math.min(99, Math.floor((Number(m[1]) / 1e6 / durationSec) * 100)));
    if (pct > last && Date.now() - lastAt > 1000) { last = pct; lastAt = Date.now(); updateMedia(id, { progress: pct }); }
  };
}

/** server.mjs: wire the pipeline into the registry. */
export function startMedia() {
  configure({ onRegistered: a => enqueue(a), onDropped: id => drop(id) });
  setTimeout(sweep, 10_000).unref?.();
}
/** For tests: wait until the queue is empty. */
export async function idle(timeoutMs = 120_000) {
  const t0 = Date.now();
  while ((busy || queue.length) && Date.now() - t0 < timeoutMs) await sleep(100);
}
