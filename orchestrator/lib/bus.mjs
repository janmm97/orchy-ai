// Event bus: everything that happens is emitted here and streamed to the dashboard over SSE.
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(100);

const clients = new Set();
let seq = 0;

export function emit(type, data = {}) {
  const evt = { id: ++seq, type, at: new Date().toISOString(), ...data };
  bus.emit('event', evt);
  const frame = `id: ${evt.id}\nevent: ${type}\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const res of clients) {
    try { res.write(frame); } catch { clients.delete(res); }
  }
  return evt;
}

export function attachSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 2000\n\n`);
  clients.add(res);
  const ping = setInterval(() => { try { res.write(`: ping\n\n`); } catch {} }, 20000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
}

export function clientCount() { return clients.size; }
