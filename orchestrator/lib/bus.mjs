// Event bus: everything that happens is emitted here and streamed to the dashboard over SSE.
// Replayable (P1.1): each boot gets a random BOOT id and the last ~3000 frames stay in memory (never on disk).
// A frame's SSE id is `BOOT:seq`; a reconnect that sends Last-Event-ID from this boot, still inside the buffer,
// gets exactly the frames it missed. Anything else gets one `hello {boot, seq, resync:true}` and reloads.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(100);

export const BOOT = crypto.randomBytes(6).toString('hex');
const RING_MAX = 3000;               // frames
const RING_BYTES = 24 * 1024 * 1024; // and never more than this many characters in all
const clients = new Set();
const ring = [];                     // [{ seq, frame }] oldest first
let ringBytes = 0;
let seq = 0;

export function emit(type, data = {}) {
  const evt = { id: ++seq, type, at: new Date().toISOString(), ...data };
  const frame = `id: ${BOOT}:${evt.id}\nevent: ${type}\ndata: ${JSON.stringify(evt)}\n\n`;
  ring.push({ seq: evt.id, frame });
  ringBytes += frame.length;
  while (ring.length > RING_MAX || (ringBytes > RING_BYTES && ring.length > 1)) ringBytes -= ring.shift().frame.length;
  for (const res of clients) {
    try { res.write(frame); } catch { clients.delete(res); }
  }
  // listeners last: one that emits in turn (say, it reacts to a tool_done with an event of its own) must not put
  // its frame on the wire ahead of this one, or the dashboard drops this one as already seen
  bus.emit('event', evt);
  return evt;
}

/** Where the stream is now: { boot, seq }. */
export function cursor() { return { boot: BOOT, seq }; }

/**
 * The frames after `lastEventId` ("BOOT:seq"), or null when they can't be replayed
 * (no id, another boot, older than the buffer, or ahead of it).
 */
export function missedSince(lastEventId) {
  const m = String(lastEventId || '').trim().match(/^([0-9a-f]+):(\d+)$/);
  if (!m || m[1] !== BOOT) return null;
  const last = Number(m[2]);
  if (last > seq) return null;
  if (last === seq) return [];
  const first = ring.length ? ring[0].seq : seq + 1;
  if (last < first - 1) return null; // the next frame it needs already fell out of the buffer
  return ring.filter(f => f.seq > last).map(f => f.frame);
}

export function attachSSE(req, res, { lastEventId } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 2000\n\n`);
  const missed = missedSince(lastEventId || req.headers?.['last-event-id']);
  // a clean replay: hello (no id, so the browser keeps its place) then exactly what it missed
  if (missed) {
    res.write(`event: hello\ndata: ${JSON.stringify({ boot: BOOT, seq, resync: false, replayed: missed.length })}\n\n`);
    for (const f of missed) res.write(f);
  } else {
    // anything else: the dashboard reloads its state, and from here on it holds an id of this boot
    res.write(`id: ${BOOT}:${seq}\nevent: hello\ndata: ${JSON.stringify({ boot: BOOT, seq, resync: true })}\n\n`);
  }
  clients.add(res);
  const ping = setInterval(() => { try { res.write(`: ping\n\n`); } catch {} }, 20000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
}

export function clientCount() { return clients.size; }
