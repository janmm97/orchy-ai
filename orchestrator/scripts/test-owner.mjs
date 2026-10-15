// Pairing a browser (lib/owner.mjs), with no network:
//   node orchestrator/scripts/test-owner.mjs
// A browser sends Orchy's cookie to every port on localhost, so the cookie alone must never be enough: a change also
// needs the key the page keeps in its own (per-port) storage and sends as X-Orchy-Key.
// Works in a throwaway temp folder; reads (never writes) orchestrator/data/owner-browsers.json on import.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as owner from '../lib/owner.mjs';

let fail = 0;
const ok = (cond, label, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : `  ${extra}`}`); if (!cond) fail++; };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orchy-owner-'));
const FILE = path.join(TMP, 'owner-browsers.json');
const PORT = 8008;
owner.useFile(FILE);

// a request as the server sees it: the cookie header, and the page's key header
const req = ({ cookie, key, agent = 'test' } = {}) => ({ headers: { 'user-agent': agent, ...(cookie && { cookie }), ...(key !== undefined && { [owner.KEY_HEADER]: key }) } });
const cookieOf = setCookie => setCookie.split(';')[0];
const pairBrowser = (old = {}) => { const { cookie, key } = owner.pair(owner.newPairCode(), req(old), PORT); return { cookie: cookieOf(cookie), key, setCookie: cookie }; };

// ── pairing hands out a cookie and a separate key ──
const a = pairBrowser();
ok(/^orchy_owner_8008=[\w-]{20,}; HttpOnly; SameSite=Strict; Path=\/;/.test(a.setCookie), 'the cookie is HttpOnly, SameSite=Strict and named for the port');
ok(typeof a.key === 'string' && a.key.length >= 40, 'pairing returns a key for the page');
ok(!a.setCookie.includes(a.key), 'the key is never in the cookie');
const disk = fs.readFileSync(FILE, 'utf8');
ok(!disk.includes(a.key) && !disk.includes(a.cookie.split('=')[1]), 'neither the key nor the cookie token is written to disk');
ok(owner.pairedCount() === 1, 'one paired browser');

// ── the cookie alone (what any other server on localhost receives) is refused ──
ok(owner.isOwner(req({ cookie: a.cookie, key: a.key }), PORT), 'cookie and key together: owner');
ok(!owner.isOwner(req({ cookie: a.cookie }), PORT), 'cookie without the key header: refused');
ok(owner.ownerState(req({ cookie: a.cookie }), PORT) === 'stale', 'cookie without the key reads as stale (the page offers to pair again)');
ok(!owner.isOwner(req({ cookie: a.cookie, key: '' }), PORT), 'cookie with an empty key: refused');
ok(!owner.isOwner(req({ cookie: a.cookie, key: `${a.key}x` }), PORT), 'cookie with a wrong key: refused');
ok(!owner.isOwner(req({ key: a.key }), PORT), 'key without the cookie: refused');
ok(owner.ownerState(req({ key: a.key }), PORT) === 'none', 'key without the cookie reads as none');
ok(!owner.isOwner(req({ cookie: a.cookie, key: a.key }), 8009), 'the same pair on another port: refused (cookie named for the port)');
ok(!owner.isOwner(req(), PORT), 'nothing at all: refused');
ok(!owner.isOwner(req({ cookie: `other=1; ${a.cookie.replace('orchy_owner_8008', 'orchy_owner_8009')}`, key: a.key }), PORT), 'a cookie for another port: refused');

// ── keys don't mix between browsers ──
const b = pairBrowser({ agent: 'second' });
ok(owner.isOwner(req({ cookie: b.cookie, key: b.key }), PORT), 'a second browser pairs');
ok(!owner.isOwner(req({ cookie: a.cookie, key: b.key }), PORT), "one browser's cookie with another's key: refused");
ok(!owner.isOwner(req({ cookie: b.cookie, key: a.key }), PORT), "and the other way round: refused");
ok(owner.isOwner(req({ cookie: a.cookie, key: a.key }), PORT), 'the first browser still works');

// ── a browser paired before keys: refused, offered a fresh pairing, which replaces its old entry ──
{
  const legacy = { hash: '', at: 1, seen: 1, agent: 'old' };
  const token = 'legacy-token-from-before-keys';
  const { createHash } = await import('node:crypto');
  legacy.hash = createHash('sha256').update(token).digest('hex');
  const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  fs.writeFileSync(FILE, JSON.stringify([...list, legacy], null, 2));
  owner.useFile(FILE);
  const old = `orchy_owner_${PORT}=${token}`;
  ok(!owner.isOwner(req({ cookie: old }), PORT), 'an old cookie without a key: refused');
  ok(!owner.isOwner(req({ cookie: old, key: 'anything' }), PORT), 'an old cookie with any key: refused');
  ok(owner.ownerState(req({ cookie: old }), PORT) === 'stale', 'an old cookie reads as stale, so the page asks to pair again');
  ok(owner.pairedCount() === 2, 'an old entry is not counted as paired');
  const again = pairBrowser({ cookie: old });
  ok(owner.isOwner(req({ cookie: again.cookie, key: again.key }), PORT), 'pairing again works');
  ok(owner.ownerState(req({ cookie: old }), PORT) === 'none', "pairing again replaces the browser's old entry");
  ok(JSON.parse(fs.readFileSync(FILE, 'utf8')).length === 3, 'no entry is left behind');
}

// ── pairing codes: single use, a few tries ──
{
  const code = owner.newPairCode();
  ok(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(code), 'a code looks like ABCDE-FGHJK');
  owner.pair(code.toLowerCase().replace('-', ' '), req(), PORT);
  ok(throws(() => owner.pair(code, req(), PORT), /expired/), 'a code works once');
  owner.newPairCode();
  for (let i = 0; i < 4; i++) throws(() => owner.pair('AAAAA-AAAAA', req(), PORT), /match/);
  ok(throws(() => owner.pair('AAAAA-AAAAA', req(), PORT), /Too many/), 'five wrong tries end the code');
}

// ── unpairing every other browser keeps only the one asking ──
{
  const c = pairBrowser({ agent: 'keeper' });
  const removed = owner.unpairOthers(req({ cookie: c.cookie, key: c.key }), PORT);
  ok(removed > 0 && owner.pairedCount() === 1, 'unpair-others leaves one browser');
  ok(owner.isOwner(req({ cookie: c.cookie, key: c.key }), PORT), 'the browser asking keeps working');
  ok(!owner.isOwner(req({ cookie: a.cookie, key: a.key }), PORT), 'the others are refused');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);
