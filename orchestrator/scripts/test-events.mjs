// Offline checks for the replayable SSE stream (bus.mjs): BOOT:seq ids, Last-Event-ID replay, hello/resync
// for a foreign boot, a bad id or an overflowed buffer. Runs its own tiny HTTP server on a random port.
import assert from 'node:assert/strict';
import http from 'node:http';
import { bus, emit, attachSSE, BOOT, cursor, missedSince } from '../lib/bus.mjs';

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  attachSSE(req, res, { lastEventId: req.headers['last-event-id'] || u.searchParams.get('last') || '' });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;

/** Connect, collect frames until `until(frames)` is true (or a timeout), then hang up. */
function connect({ lastEventId, query = '', until = f => f.length >= 1, ms = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const req = http.get({ host: '127.0.0.1', port, path: `/${query}`, headers: lastEventId ? { 'Last-Event-ID': lastEventId } : {} }, res => {
      assert.equal(res.statusCode, 200);
      assert.match(res.headers['content-type'], /text\/event-stream/);
      let buf = '';
      const done = () => { clearTimeout(t); req.destroy(); resolve(frames); };
      const t = setTimeout(done, ms);
      res.setEncoding('utf8');
      res.on('data', d => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, i); buf = buf.slice(i + 2);
          const f = {};
          for (const line of raw.split('\n')) {
            const m = line.match(/^(\w+): ?(.*)$/);
            if (m) f[m[1]] = m[2];
          }
          if (!f.event) continue; // retry: / : ping
          f.json = JSON.parse(f.data);
          frames.push(f);
        }
        if (until(frames)) done();
      });
    });
    req.on('error', e => (e.code === 'ECONNRESET' ? null : reject(e)));
  });
}
const ok = (name) => console.log(`ok - ${name}`);

try {
  // fresh connect: one hello asking for a resync, carrying an id of this boot
  let f = await connect();
  assert.equal(f[0].event, 'hello');
  assert.equal(f[0].json.boot, BOOT);
  assert.equal(f[0].json.resync, true);
  assert.equal(f[0].id, `${BOOT}:${cursor().seq}`);
  ok('fresh connect → hello resync with BOOT:seq id');

  // live frames carry BOOT:seq ids and the numeric seq in the payload
  const live = connect({ until: x => x.length >= 6 });
  await new Promise(r => setTimeout(r, 50));
  const sent = [];
  for (let i = 0; i < 5; i++) sent.push(emit('test.ping', { i }));
  f = await live;
  assert.deepEqual(f.slice(1).map(x => x.id), sent.map(e => `${BOOT}:${e.id}`));
  assert.deepEqual(f.slice(1).map(x => x.json.i), [0, 1, 2, 3, 4]);
  assert.deepEqual(f.slice(1).map(x => x.event), Array(5).fill('test.ping'));
  ok('live frames: id BOOT:seq, event type, payload id = seq');

  // reconnect mid-way: exactly the missed ones, in order, after a hello without resync
  const mid = sent[1].id;
  f = await connect({ lastEventId: `${BOOT}:${mid}`, until: x => x.length >= 4 });
  assert.equal(f[0].event, 'hello');
  assert.equal(f[0].json.resync, false);
  assert.equal(f[0].json.replayed, 3);
  assert.equal(f[0].id, undefined); // the browser keeps its place
  assert.deepEqual(f.slice(1).map(x => x.json.id), [sent[2].id, sent[3].id, sent[4].id]);
  ok('Last-Event-ID mid-stream → only the 3 missed frames');

  // the same via ?last= (a fresh EventSource from the dashboard's load())
  f = await connect({ query: `?last=${encodeURIComponent(`${BOOT}:${sent[3].id}`)}`, until: x => x.length >= 2 });
  assert.equal(f[0].json.resync, false);
  assert.deepEqual(f.slice(1).map(x => x.json.id), [sent[4].id]);
  ok('?last=BOOT:seq replays the same way');

  // up to date: a clean hello, nothing replayed
  f = await connect({ lastEventId: `${BOOT}:${cursor().seq}`, ms: 300 });
  assert.equal(f.length, 1); assert.equal(f[0].json.resync, false); assert.equal(f[0].json.replayed, 0);
  ok('up-to-date id → hello, nothing replayed');

  // foreign boot, garbage, an id from the future → resync
  for (const bad of ['deadbeef0000:3', 'not-an-id', `${BOOT}:${cursor().seq + 10}`]) {
    f = await connect({ lastEventId: bad, ms: 300 });
    assert.equal(f.length, 1, bad); assert.equal(f[0].json.resync, true, bad);
    assert.equal(f[0].id, `${BOOT}:${cursor().seq}`);
  }
  ok('foreign boot / garbage / future id → hello resync');

  // a listener that emits in turn (one that reacts to an event with its own) goes out after the frame
  // that caused it, so ids reach the browser in order and its dedupe (seq not newer → drop) keeps both
  {
    const nested = connect({ until: x => x.length >= 3 });
    await new Promise(r => setTimeout(r, 50));
    const onEvt = e => { if (e.type === 'test.outer') emit('test.inner', {}); };
    bus.on('event', onEvt);
    emit('test.outer', {});
    bus.off('event', onEvt);
    f = await nested;
    assert.deepEqual(f.slice(1).map(x => x.event), ['test.outer', 'test.inner']);
    const ids = f.slice(1).map(x => Number(x.id.split(':')[1]));
    assert.ok(ids[0] < ids[1], `frames in seq order (${ids})`);
    assert.deepEqual(missedSince(`${BOOT}:${ids[0] - 1}`).map(fr => fr.match(/^event: (.+)$/m)[1]), ['test.outer', 'test.inner']);
    ok('nested emit: the outer frame goes out (and into the ring) before the inner one');
  }

  // overflow: 3100 more frames push the early ones out of the 3000-frame buffer
  const before = cursor().seq;
  for (let i = 0; i < 3100; i++) emit('test.flood', { i });
  assert.equal(missedSince(`${BOOT}:${before}`), null);
  f = await connect({ lastEventId: `${BOOT}:${before}`, ms: 300 });
  assert.equal(f[0].json.resync, true);
  ok('overflowed buffer → hello resync');

  // the oldest frame still held replays in full (3000 frames)
  const edge = cursor().seq - 3000;
  const missed = missedSince(`${BOOT}:${edge}`);
  assert.equal(missed.length, 3000);
  assert.equal(missedSince(`${BOOT}:${edge - 1}`), null);
  f = await connect({ lastEventId: `${BOOT}:${cursor().seq - 2}`, until: x => x.length >= 3 });
  assert.equal(f[0].json.replayed, 2);
  assert.deepEqual(f.slice(1).map(x => x.json.i), [3098, 3099]);
  ok('buffer edge: 3000 frames replayable, one older is not');

  console.log('test-events: all passed');
} finally {
  srv.close();
  srv.closeAllConnections?.();
}
