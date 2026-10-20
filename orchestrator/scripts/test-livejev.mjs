// Jev reading as the owner types (livejev.mjs), with the router faked: one read at a time per session, newer drafts
// supersede waiting ones, Enter reuses the read of the same text, and the caps hold.
// Nothing is saved: reads here don't count toward today's total. Run: node orchestrator/scripts/test-livejev.mjs
import * as live from '../lib/livejev.mjs';
import { route as realRoute } from '../lib/router.mjs';
import { db } from '../lib/store.mjs';

let fail = 0;
const ok = (cond, label, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : `  ${extra}`}`); if (!cond) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let calls = [];
const fakeRoute = (ms = 5, extra = {}) => async (text, opts) => {
  calls.push({ text, opts });
  await sleep(ms);
  return { intent: 'task', workspace: 'alpha', agent: null, model: 'sonnet', confidence: 0.9, needsChoice: false, source: 'jev', text, ...extra };
};
const read = (sid, text, ms, extra) => live.read(sid, text, { routeFn: fakeRoute(ms, extra), counting: false });
const fresh = () => { live.reset(); calls = []; };

// ── the same message, for routing purposes ──
ok(live.norm('  check  the inbox. ') === live.norm('check the inbox'), 'spacing and a trailing full stop are the same draft');
ok(live.norm('send it for Alpha') !== live.norm('send it for alpha'), 'case is not ("for Alpha" names a workspace)');
ok(live.wordCount('hi there') === 2 && live.wordCount('@alpha check inbox') === 3, 'word count');

// ── a read, then the same draft again ──
{
  fresh();
  const a = await read(null, 'check the support inbox');
  ok(a.routing?.workspace === 'alpha' && calls.length === 1, 'a draft is read');
  ok(calls[0].opts.purpose === 'live', 'logged as a live read', calls[0].opts.purpose);
  ok(calls[0].opts.recent.at(-1)?.text === 'check the support inbox' && calls[0].opts.runs.length === 0, 'at home: only the draft as context');
  const b = await read(null, 'check the support inbox.');
  ok(b.cached && calls.length === 1, 'the same draft is not read twice');
}

// ── one read at a time: the owner kept typing ──
{
  fresh();
  const p1 = read(null, 'check the', 60);
  await sleep(5);
  const p2 = read(null, 'check the support', 5);
  const p3 = read(null, 'check the support inbox', 5);
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  ok(r1.routing && r2.superseded && r3.routing?.text === 'check the support inbox', 'a waiting draft is superseded by a newer one', JSON.stringify([!!r1.routing, r2, r3.routing?.text]));
  ok(calls.map(c => c.text).join('|') === 'check the|check the support inbox', 'only the first and the newest are read', calls.map(c => c.text).join('|'));
}

// ── Enter ──
{
  fresh();
  await read(null, 'draft the reply to Maria');
  const fp = live.fingerprint(null);
  const r = await live.take(null, 'draft the reply to Maria ', fp);
  ok(r?.text === 'draft the reply to Maria', 'Enter takes the read of the same text');
  ok(await live.take(null, 'draft the reply to Maria', fp) === null, 'and only once (the draft is cleared)');

  await read(null, 'draft the reply to Maria');
  ok(await live.take(null, 'draft the reply to Maria and cc Sam', fp) === null, 'changed text: no reuse, Jev is asked on Enter');

  await read(null, 'draft the reply to Maria');
  ok(await live.take(null, 'draft the reply to Maria', 'something else') === null, 'the session moved on since the read: no reuse');

  fresh();
  const p = read(null, 'summarise the board deck', 80);
  await sleep(5);
  const t0 = Date.now();
  const r2 = await live.take(null, 'summarise the board deck', live.fingerprint(null));
  ok(r2?.text === 'summarise the board deck' && Date.now() - t0 >= 15 && calls.length === 1, 'Enter mid-read waits for that read instead of asking again', JSON.stringify({ text: r2?.text, elapsed: Date.now() - t0, calls: calls.length }));
  await p;

  fresh();
  await read(null, 'check the support inbox', 1, { source: 'heuristic' });
  ok(await live.take(null, 'check the support inbox', live.fingerprint(null)) === null, 'a heuristic guess (Jev offline) is never reused');

  fresh();
  await read('s_live_test', 'check the support inbox');
  ok(await live.take(null, 'check the support inbox', 'new') === null, 'a read in one session does not fit another');
}

// ── caps ──
{
  fresh();
  const s = db().settings;
  const before = { m: s.liveReadsPerMessage, d: s.liveReadsPerDay };
  try {
    s.liveReadsPerMessage = 2;
    s.liveReadsPerDay = 0;
    await read(null, 'one two three');
    await read(null, 'one two three four');
    const c = await read(null, 'one two three four five');
    ok(c.capped === 'message' && calls.length === 2, 'per-message cap', JSON.stringify(c));
    ok(live.limits().perMessage === 2 && live.limits().perDay === 0, '0 means no daily cap');
    await live.take(null, 'x', 'new');
    const d = await read(null, 'a new message here');
    ok(d.routing && calls.length === 3, 'Enter starts a new message: the count resets');
    s.liveReadsPerMessage = 0;
    const counted = db().liveReads;
    db().liveReads = { day: new Date().toISOString().slice(0, 10), n: 5 };
    s.liveReadsPerDay = 5;
    ok((await read(null, 'yet another draft here')).capped === 'day', 'per-day cap');
    db().liveReads = counted;
    if (counted === undefined) delete db().liveReads;
  } finally {
    s.liveReadsPerMessage = before.m;
    s.liveReadsPerDay = before.d;
    if (before.m === undefined) delete s.liveReadsPerMessage;
    if (before.d === undefined) delete s.liveReadsPerDay;
  }
}

// ── the router passes the purpose to Jev ──
{
  let purpose = null;
  const W = [{ id: 'alpha', name: 'Alpha Studio', client: 'Alpha Studio Ltd', blurb: '', aliases: [], runtime: 'claude', enabled: true }];
  const ask = async (_state, _q, opts) => { purpose = opts.purpose; return { model: 'fake', ms: 1, answers: { intent: { choice: 'task', confidence: 0.9 }, workspace: { choice: 'alpha', confidence: 0.9 } } }; };
  await realRoute('check the inbox', { ask, workspaces: W, agents: [], purpose: 'live' });
  ok(purpose === 'live', 'route() logs live reads as purpose "live"', purpose);
  await realRoute('check the inbox', { ask, workspaces: W, agents: [] });
  ok(purpose === 'routing', 'and Enter as "routing"', purpose);
}

live.reset();
console.log(fail ? `\n${fail} failed` : '\nall good');
process.exit(fail ? 1 : 0);
