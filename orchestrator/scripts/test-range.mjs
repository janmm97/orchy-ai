// Offline checks for HTTP Range on task files (clientspace.mjs#sendTaskFile): video/audio answer
// `Range: bytes=` with 206 + Content-Range + Accept-Ranges, bad ranges get 416, everything else is as before
// (CSP sandbox + nosniff kept, media still downloads unless a route passes `media: true`, as the artifact routes do).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { sendTaskFile, parseRange } from '../lib/clientspace.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchy-range-test-'));
const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
for (const n of ['clip.mp4', 'voice.mp3', 'notes.txt']) fs.writeFileSync(path.join(tmp, n), bytes);
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  sendTaskFile(res, path.join(tmp, u.searchParams.get('f')), {}, { req, media: u.searchParams.has('media') });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const get = (f, range) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: srv.address().port, path: `/?f=${f}`, headers: range ? { Range: range } : {} }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c)).on('end', () => resolve({ status: res.statusCode, h: res.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject);
});
const ok = name => console.log(`ok - ${name}`);

try {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=990-5000', 1000), { start: 990, end: 999 });
  assert.equal(parseRange('bytes=1000-', 1000), 'bad');
  assert.equal(parseRange('bytes=50-10', 1000), 'bad');
  assert.equal(parseRange('bytes=0-1,5-9', 1000), null); // a list → the whole file
  assert.equal(parseRange('', 1000), null);
  ok('parseRange: start-end, open end, suffix, clamp, unsatisfiable, lists');

  let r = await get('clip.mp4');
  assert.equal(r.status, 200); assert.equal(r.h['accept-ranges'], 'bytes'); assert.equal(Number(r.h['content-length']), 1000);
  assert.equal(r.h['content-type'], 'application/octet-stream'); assert.match(r.h['content-disposition'], /^attachment/); // no inline media yet
  assert.equal(r.h['x-content-type-options'], 'nosniff'); assert.match(r.h['content-security-policy'], /^sandbox;/);
  ok('mp4 without Range: 200, Accept-Ranges, still a download, CSP sandbox + nosniff');

  r = await get('clip.mp4', 'bytes=100-199');
  assert.equal(r.status, 206); assert.equal(r.h['content-range'], 'bytes 100-199/1000'); assert.equal(Number(r.h['content-length']), 100);
  assert.deepEqual(r.body, bytes.subarray(100, 200));
  assert.equal(r.h['x-content-type-options'], 'nosniff'); assert.match(r.h['content-security-policy'], /^sandbox;/);
  r = await get('voice.mp3', 'bytes=-10');
  assert.equal(r.status, 206); assert.equal(r.h['content-range'], 'bytes 990-999/1000'); assert.deepEqual(r.body, bytes.subarray(990));
  ok('mp4/mp3 with Range: 206 + Content-Range + exact bytes');

  r = await get('clip.mp4', 'bytes=5000-');
  assert.equal(r.status, 416); assert.equal(r.h['content-range'], 'bytes */1000'); assert.equal(r.body.length, 0);
  ok('unsatisfiable Range: 416 + bytes */size');

  r = await get('notes.txt', 'bytes=0-9');
  assert.equal(r.status, 200); assert.equal(r.body.length, 1000); assert.equal(r.h['accept-ranges'], undefined);
  assert.match(r.h['content-type'], /^text\/plain/);
  ok('non-media files: unchanged (Range ignored, no Accept-Ranges)');

  const inline = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: srv.address().port, path: '/?f=clip.mp4&media=1', headers: { Range: 'bytes=0-0' } }, res => { res.resume(); res.on('end', () => resolve(res)); }).on('error', reject));
  assert.equal(inline.statusCode, 206); assert.equal(inline.headers['content-type'], 'video/mp4'); assert.match(inline.headers['content-disposition'], /^inline/);
  ok('media: true (the artifact routes) → inline video/mp4');
  console.log('test-range: all passed');
} finally {
  srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
