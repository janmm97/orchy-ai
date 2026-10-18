// The media pipeline (media.mjs) on real ffmpeg fixtures in a temp folder: probe fields, the faststart decision (moov
// at the end), the transcode decision (HEVC mkv → H.264 copy with measured progress), posters and thumbs, fit views
// for huge images, previews for TIFF, audio copies, the still-being-written guard, Range 206 on `play`, and the guard
// on what it serves. Without ffmpeg: every file still registers and says `no-ffmpeg` (always checked, ffmpeg or not);
// the ffmpeg cases are skipped when it isn't installed, and single cases when its build lacks an encoder.
// The real state.json is never touched. Run: node orchestrator/scripts/test-media.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import * as A from '../lib/artifacts.mjs';
import * as M from '../lib/media.mjs';
import { sendTaskFile } from '../lib/clientspace.mjs';

let fail = 0;
const ok = (cond, label, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : `  ${extra}`}`); if (!cond) fail++; };
const skip = label => console.log(`skip  ${label}`);

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orchy-media-test-')));
const W = path.join(tmp, 'ws');
fs.mkdirSync(path.join(W, 'out'), { recursive: true });
const f = n => path.join(W, 'out', n);
const state = { runs: {}, artifacts: {} };
A.configure({ db: () => state, save: () => {}, emit: () => {}, workspace: id => ({ id, dir: W }), workspaces: () => [{ id: 'ws', dir: W }], previewsDir: path.join(tmp, 'previews'), eventsOf: () => [] });
M.startMedia();
const run = { id: 'run_m', workspace: 'ws', startedAt: new Date().toISOString() };
const reg = n => A.register(run, f(n), { source: 'workspace-scan' });
const finish = async code => { await new Promise(r => setTimeout(r, 300)); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }); console.log(fail ? `\n${fail} FAILED` : '\nall media checks passed'); process.exit(code ?? (fail ? 1 : 0)); };

// ── without ffmpeg: nothing breaks, the originals still open ──
const realBins = M.ffBins();
M.useBins(null);
fs.writeFileSync(f('plain.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
fs.writeFileSync(f('song.mp3'), Buffer.alloc(2000, 1));
fs.writeFileSync(f('clip0.mp4'), Buffer.alloc(2000, 2));
const n1 = reg('plain.png'), n2 = reg('song.mp3'), n3 = reg('clip0.mp4');
await M.idle();
ok([n1, n2, n3].every(a => a.media.state === 'no-ffmpeg'), 'no ffmpeg: image, audio and video say no-ffmpeg', JSON.stringify([n1.media, n2.media, n3.media]));
ok(n2.media.play === 'original' && M.mediaFile(n2.id, 'play') === f('song.mp3'), 'no ffmpeg: audio the browser plays still plays (the original)');
ok(M.mediaFile(n3.id, 'play') === null && M.mediaFile(n1.id, 'thumb') === null, 'no ffmpeg: no copies or thumbs are promised');
M.useBins(realBins);

const bins = M.ffBins();
if (!bins) { skip('the ffmpeg cases (no ffmpeg on this machine; set FFMPEG_PATH or install it to run them)'); await finish(); }
const encoders = (() => { try { return execFileSync(bins.ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } })();
const has = name => new RegExp(`\\s${name}\\s`).test(encoders);
if (!has('libx264') || !has('libwebp') || !has('aac')) { skip(`the ffmpeg cases (this ffmpeg build lacks ${['libx264', 'libwebp', 'aac'].filter(e => !has(e)).join(', ')})`); await finish(); }
const x265 = has('libx265'), wma = has('wmav2');

const ff = (...args) => execFileSync(bins.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe' });
ff('-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=3', '-f', 'lavfi', '-i', 'sine=f=440:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f('clip.mp4'));
ff('-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', f('fast.mp4'));
if (x265) ff('-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=3', '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-x265-params', 'log-level=error', f('hevc.mkv'));
else ff('-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=3', '-c:v', 'mpeg4', f('hevc.mkv')); // another codec the browser can't play
ff('-f', 'lavfi', '-i', 'testsrc=size=640x360', '-frames:v', '1', f('still.png'));
ff('-f', 'lavfi', '-i', 'testsrc=size=5000x400', '-frames:v', '1', f('wide.jpg'));
ff('-f', 'lavfi', '-i', 'testsrc=size=800x600', '-frames:v', '1', f('scan.tiff'));
if (wma) ff('-f', 'lavfi', '-i', 'sine=f=440:d=2', '-c:a', 'wmav2', f('voice.wma'));
ff('-f', 'lavfi', '-i', 'sine=f=440:d=2', f('tone.wav'));

// ── decisions on their own ──
const info = await M.probe(f('clip.mp4'));
ok(info.w === 640 && info.h === 360 && info.vcodec === 'h264' && info.acodec === 'aac' && Math.abs(info.durationSec - 3) < 0.2 && info.fps === 25, 'probe: w×h, codecs, duration, fps', JSON.stringify(info));
ok(M.moovAtEnd(f('clip.mp4')) === true && M.moovAtEnd(f('fast.mp4')) === false, 'moov at the end is spotted (and a faststart file isn’t)');
ok(M.playsAsIs('mp4', info) && !M.playsAsIs('mkv', { vcodec: 'hevc' }) && !M.playsAsIs('mp4', { vcodec: 'hevc', acodec: 'aac' }) && M.playsAsIs('webm', { vcodec: 'vp9', acodec: 'opus' }), 'plays as is: mp4/webm/mov with H.264/VP8/VP9/AV1; HEVC or mkv need a copy');
ok(M.mediaInfo({ streams: [{ codec_type: 'video', width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }], format: {} }).w === 1080, 'a rotated phone video reports its shown size');

// ── the pipeline ──
const clip = reg('clip.mp4'), fast = reg('fast.mp4'), hevc = reg('hevc.mkv'), still = reg('still.png'), wide = reg('wide.jpg'), scan = reg('scan.tiff'), wav = reg('tone.wav');
const wmaA = wma ? reg('voice.wma') : null;
ok([clip, fast, hevc, still, wide, scan, wav].every(a => a?.media?.state === 'queued'), 'media files register as queued');
await M.idle(240_000);
ok(clip.media.state === 'ready' && clip.media.play === 'faststart' && clip.media.poster && clip.media.thumb, 'h264 mp4 with moov at the end → faststart remux + poster + thumb', JSON.stringify(clip.media));
const play = M.mediaFile(clip.id, 'play');
ok(play && play.endsWith('play.mp4') && M.moovAtEnd(play) === false, 'the remuxed copy has moov first');
ok(fast.media.play === 'original' && M.mediaFile(fast.id, 'play') === f('fast.mp4'), 'a faststart mp4 plays the original');
ok(hevc.media.play === 'copy' && (await M.probe(M.mediaFile(hevc.id, 'play'))).vcodec === 'h264', `${x265 ? 'HEVC' : 'MPEG-4'} mkv → an H.264 playable copy`, JSON.stringify(hevc.media));
ok(still.media.thumb && !still.media.fit && still.media.w === 640, 'png: thumb, no fit view');
ok(wide.media.fit && wide.media.thumb && (await M.probe(M.mediaFile(wide.id, 'fit'))).w === 2560, 'a 5000 px jpg gets a 2560 px fit view');
ok(scan.media.preview && scan.media.thumb && (await M.probe(M.mediaFile(scan.id, 'preview'))).vcodec === 'webp', 'TIFF → preview.webp + thumb');
if (wmaA) ok(wmaA.media.play === 'copy' && M.mediaFile(wmaA.id, 'play').endsWith('audio.m4a'), 'wma → an audio.m4a copy');
else skip('wma → audio.m4a (no wmav2 encoder to make the fixture)');
ok(wav.media.play === 'original', 'wav plays as is');
ok(fs.readdirSync(path.join(tmp, 'previews', clip.id)).join() === 'v1' && !fs.readdirSync(path.join(tmp, 'previews', clip.id, 'v1')).some(n => n.includes('.part')), 'outputs live in previews/<id>/v<version>/, no half files left');

// ── progress is measured ──
const seen = [];
ff('-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=8', ...(x265 ? ['-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error'] : ['-c:v', 'mpeg4']), '-pix_fmt', 'yuv420p', f('long.mkv'));
const h2 = reg('long.mkv');
const tick = setInterval(() => { const p = h2.media?.progress; if (p != null && seen.at(-1) !== p) seen.push(p); }, 50);
await M.idle(240_000);
clearInterval(tick);
ok(h2.media.play === 'copy' && h2.media.progress === null, 'a longer copy finishes', JSON.stringify(h2.media));
ok(seen.every((v, i) => i === 0 || v > seen[i - 1]) && seen.every(v => v >= 0 && v <= 99), `progress only climbs, 0–99 (seen ${seen.join(',') || 'none: too fast to sample'})`);

// ── a new version gets new previews ──
ff('-f', 'lavfi', '-i', 'testsrc=size=320x200', '-frames:v', '1', f('still.png'));
A.register(run, f('still.png'), { source: 'edit' });
ok(still.version === 2 && still.media.state === 'queued', 'a changed image is queued again');
await M.idle();
ok(still.media.w === 320 && fs.readdirSync(path.join(tmp, 'previews', still.id)).join() === 'v2', 'its previews are remade for v2 and v1’s are gone');

// ── a render still being written ──
const grow = f('render.mp4');
fs.copyFileSync(f('clip.mp4'), grow);
const timer = setInterval(() => fs.appendFileSync(grow, Buffer.alloc(4096)), 300);
const g = reg('render.mp4');
await new Promise(r => setTimeout(r, 2600));
ok(g.media.state === 'processing' && g.media.bytes > 0 && !g.media.play, 'a file still growing is “processing”, never played', JSON.stringify(g.media));
clearInterval(timer);

// ── Range on play, and the guard ──
const srv = http.createServer((req, res) => { const file = M.mediaFile(clip.id, 'play'); sendTaskFile(res, file, {}, { req, media: true }); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const res = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: srv.address().port, path: '/', headers: { Range: 'bytes=100-199' } }, r => { r.resume(); r.on('end', () => resolve(r)); }).on('error', reject));
ok(res.statusCode === 206 && /^bytes 100-199\//.test(res.headers['content-range']) && res.headers['content-type'] === 'video/mp4', 'play answers Range with 206');
srv.close();
ok(M.mediaFile('art_0000000000000000', 'play') === null && M.mediaFile(clip.id, 'nope') === null && M.mediaFile(still.id, 'poster') === null, 'unknown ids, unknown kinds and absent previews → null');
fs.rmSync(f('fast.mp4'));
let err = null;
try { M.mediaFile(fast.id, 'play'); } catch (e) { err = e; }
ok(err?.status === 404, 'the original is re-checked by the guard before it’s served');

await finish();
