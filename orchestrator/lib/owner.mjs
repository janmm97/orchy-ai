// The owner's browsers. The dashboard API has no login, and the agents Orchy runs live on this same PC, so a
// change (POST, PUT, DELETE on /api/*) is only taken from a browser the owner paired. Reads stay open to this PC:
// they show what is on disk in orchestrator/data/ anyway.
//   Pairing: Orchy opens the dashboard with a one-time code (?pair=…), or the owner types a code printed in
//   Orchy's terminal or shown on a browser that is already paired (Settings → This browser). The browser then
//   holds two random secrets: an HttpOnly cookie, and a key the page keeps in its own storage and sends as the
//   X-Orchy-Key header. A browser sends cookies to every port on localhost, so another local server (a dev server,
//   any app) gets the cookie; page storage is kept per port, so the key never leaves Orchy's own pages. A change
//   needs both. Only their SHA-256 hashes are kept on disk, so an agent that reads data/ finds nothing it can use,
//   and no code, token or key is ever written to a log.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './env.mjs';

let FILE = path.join(DATA_DIR, 'owner-browsers.json');
const MAX_BROWSERS = 20;
const CODE_TTL_MS = 15 * 60_000;
const MAX_TRIES = 5;
const MAX_AGE_S = 400 * 24 * 3600; // the longest a browser keeps a cookie
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I/L to misread
const CODE_LEN = 10;

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const sameHash = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

function readBrowsers() {
  try {
    const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(list) ? list.filter(b => typeof b?.hash === 'string') : [];
  } catch { return []; }
}
let browsers = readBrowsers();
const persist = () => fs.writeFileSync(FILE, JSON.stringify(browsers, null, 2));

let code = null; // { hash, expires, tries }: one live code at a time; a newer one replaces it
const normCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** A fresh single-use pairing code ("ABCDE-FGHJK"), good for 15 minutes. */
export function newPairCode() {
  // rejection sampling keeps every letter equally likely
  let raw = '';
  while (raw.length < CODE_LEN) for (const b of crypto.randomBytes(16)) if (b < 248 && raw.length < CODE_LEN) raw += ALPHABET[b % ALPHABET.length];
  code = { hash: sha(raw), expires: Date.now() + CODE_TTL_MS, tries: 0 };
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

export const cookieName = port => `orchy_owner_${port}`;
export const KEY_HEADER = 'x-orchy-key';

function cookieToken(req, port) {
  const name = cookieName(port);
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** 'paired', 'stale' (a known cookie without its key: paired before keys, or the page lost its storage) or 'none'. */
export function ownerState(req, port) {
  const token = cookieToken(req, port);
  if (!token) return 'none';
  const h = sha(token);
  const b = browsers.find(x => sameHash(Buffer.from(x.hash, 'hex'), h));
  if (!b) return 'none';
  const key = req.headers[KEY_HEADER];
  if (typeof b.keyHash !== 'string' || typeof key !== 'string' || !key || !sameHash(Buffer.from(b.keyHash, 'hex'), sha(key))) return 'stale';
  if (Date.now() - (b.seen || 0) > 3_600_000) { b.seen = Date.now(); try { persist(); } catch {} }
  return 'paired';
}

/** Is this request from a browser the owner paired? Its cookie and its key both have to match the same entry. */
export const isOwner = (req, port) => ownerState(req, port) === 'paired';

/** Trade a pairing code for this browser's cookie and key. Returns { cookie: the Set-Cookie value, key: for the page
 *  to keep }; throws 400 on a bad or old code. */
export function pair(input, req, port) {
  const bad = msg => Object.assign(new Error(msg), { status: 400, code: 'pair' });
  if (!code || Date.now() > code.expires) { code = null; throw bad('That code has expired. Start Orchy again, or make a new code on a browser that is already paired (Settings → This browser).'); }
  code.tries++;
  if (!sameHash(sha(normCode(input)), code.hash)) {
    if (code.tries >= MAX_TRIES) code = null;
    throw bad(code ? 'That code doesn’t match. Check it and try again.' : 'Too many wrong tries: that code no longer works. Make a new one.');
  }
  code = null;
  // a browser pairing again (Orchy opened it with a fresh code) replaces its own entry, so others aren't pushed out
  const old = cookieToken(req, port);
  if (old) { const h = sha(old); browsers = browsers.filter(b => !sameHash(Buffer.from(b.hash, 'hex'), h)); }
  const token = crypto.randomBytes(32).toString('base64url');
  const key = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  browsers.push({ hash: sha(token).toString('hex'), keyHash: sha(key).toString('hex'), at: now, seen: now, agent: String(req.headers['user-agent'] || '').slice(0, 120) });
  browsers = browsers.slice(-MAX_BROWSERS);
  persist();
  return { cookie: `${cookieName(port)}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE_S}`, key };
}

/** Forget every paired browser except the one asking (the owner lost a device, or wants a clean slate). */
export function unpairOthers(req, port) {
  const token = cookieToken(req, port);
  const keep = token ? sha(token) : null;
  const before = browsers.length;
  browsers = browsers.filter(b => keep && sameHash(Buffer.from(b.hash, 'hex'), keep));
  persist();
  return before - browsers.length;
}

// entries from before keys can't make changes any more: they only wait for their browser to pair again
export const pairedCount = () => browsers.filter(b => typeof b.keyHash === 'string').length;

/** Tests only: keep the list in another file (a temp folder), starting from what is in it. */
export function useFile(file) { FILE = file; browsers = readBrowsers(); code = null; }
