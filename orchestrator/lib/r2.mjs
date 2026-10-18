// Cloudflare R2 for client video. Cloudflare's terms bar video (and large files) through a Tunnel hostname on
// non-Enterprise plans, so a client's page never streams video or audio from this PC: Orchy puts the playable copy
// in an R2 bucket and the page plays it from a presigned GET URL that lives ≤ 15 minutes, minted per view after the
// usual client checks (clientview.mjs).
//
// No SDK: AWS Signature Version 4 with node:crypto (R2 speaks S3; region "auto", path-style
// https://<account>.r2.cloudflarestorage.com/<bucket>/<key>). The signer is checked against AWS's published S3
// examples in scripts/test-clientviewer.mjs. Keys come from .env (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
// R2_SECRET_ACCESS_KEY, R2_BUCKET; all optional) and are read on every call, so editing .env switches it on
// without a restart. Without them, client pages show a video's poster and say playback isn't switched on.
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import { env } from './env.mjs';

export const MAX_EXPIRES = 900;      // a client's play link: 15 minutes at most
export const PLAY_EXPIRES = 600;     // what the portal hands out (10 minutes; the page asks again when it runs out)

const sha256 = d => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
export const EMPTY_SHA256 = sha256('');
export const UNSIGNED = 'UNSIGNED-PAYLOAD';

/** RFC 3986 encoding, as SigV4 wants it (encodeURIComponent leaves !'()* alone). */
export const enc = s => encodeURIComponent(String(s)).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encPath = p => String(p).split('/').map(enc).join('/');
export const amzDate = (d = new Date()) => d.toISOString().replace(/[:-]|\.\d{3}/g, '');
const canonicalQuery = q => Object.entries(q).map(([k, v]) => [enc(k), enc(v ?? '')]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
function signingKey(secret, day, region, service) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), service), 'aws4_request');
}
function finish({ method, path, query, headerLines, signed, payload, secretAccessKey, region, service, stamp }) {
  const day = stamp.slice(0, 8), scope = `${day}/${region}/${service}/aws4_request`;
  const canonical = [method, encPath(path), canonicalQuery(query), headerLines, signed, payload].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(secretAccessKey, day, region, service)).update(stringToSign).digest('hex');
  return { canonical, stringToSign, signature, scope };
}

/**
 * Sign a request with an Authorization header. `headers` are extra headers to sign (lower-cased here);
 * host, x-amz-date and x-amz-content-sha256 are added. Returns { headers, signature, canonical, stringToSign }.
 */
export function signRequest({ method = 'GET', host, path = '/', query = {}, headers = {}, payloadHash = UNSIGNED, accessKeyId, secretAccessKey, region = 'auto', service = 's3', date = new Date() }) {
  const stamp = amzDate(date);
  const h = { host, 'x-amz-date': stamp, 'x-amz-content-sha256': payloadHash };
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  const names = Object.keys(h).sort();
  const headerLines = names.map(n => `${n}:${String(h[n]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signed = names.join(';');
  const out = finish({ method, path, query, headerLines, signed, payload: payloadHash, secretAccessKey, region, service, stamp });
  h.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${out.scope}, SignedHeaders=${signed}, Signature=${out.signature}`;
  return { headers: h, ...out };
}

/** A presigned URL (query-string auth, only `host` signed, payload unsigned). `expires` in seconds (1 … 7 days). */
export function presign({ method = 'GET', host, path = '/', query = {}, accessKeyId, secretAccessKey, region = 'auto', service = 's3', date = new Date(), expires = PLAY_EXPIRES }) {
  const secs = Math.floor(Number(expires));
  if (!(secs >= 1 && secs <= 604800)) throw new Error('Presign expiry must be 1 s to 7 days');
  const stamp = amzDate(date);
  const q = {
    ...query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${accessKeyId}/${stamp.slice(0, 8)}/${region}/${service}/aws4_request`,
    'X-Amz-Date': stamp, 'X-Amz-Expires': String(secs), 'X-Amz-SignedHeaders': 'host',
  };
  const out = finish({ method, path, query: q, headerLines: `host:${host}\n`, signed: 'host', payload: UNSIGNED, secretAccessKey, region, service, stamp });
  return { url: `https://${host}${encPath(path)}?${canonicalQuery(q)}&X-Amz-Signature=${out.signature}`, ...out, expiresAt: new Date(date.getTime() + secs * 1000).toISOString() };
}

// ── config (.env; read on every call) ──
const KEYS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
let read = k => env(k).trim();
/** For tests: where the keys come from. */
export function configureR2({ readEnv = null, transport = null } = {}) { if (readEnv) read = readEnv; if (transport) send = transport; }

/** { on, reason, missing[] }: is client video switched on? */
export function r2Status() {
  const missing = KEYS.filter(k => !read(k));
  if (missing.length) return { on: false, reason: 'missing', missing };
  if (!/^[0-9a-f]{32}$/i.test(read('R2_ACCOUNT_ID'))) return { on: false, reason: 'bad-account', missing: [] };
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(read('R2_BUCKET'))) return { on: false, reason: 'bad-bucket', missing: [] };
  return { on: true, reason: null, missing: [] };
}
/** The bucket's settings, or null when R2 isn't (properly) set up. */
export function r2Config() {
  if (!r2Status().on) return null;
  const accountId = read('R2_ACCOUNT_ID').toLowerCase();
  return { accountId, accessKeyId: read('R2_ACCESS_KEY_ID'), secretAccessKey: read('R2_SECRET_ACCESS_KEY'), bucket: read('R2_BUCKET'), host: `${accountId}.r2.cloudflarestorage.com`, region: 'auto' };
}
/** The origin the client page's CSP must allow for media (null when off). */
export const mediaOrigin = () => { const c = r2Config(); return c ? `https://${c.host}` : null; };

/** Object keys: one prefix per client, one folder per artifact and version. */
export function keyFor(clientId, artifactId, version, file) {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(String(clientId)) || !/^art_[0-9a-f]{16}$/.test(String(artifactId)) || !Number.isInteger(version) || !/^[\w.-]{1,40}$/.test(String(file))) throw new Error('Bad R2 key');
  return `clients/${clientId}/${artifactId}/v${version}/${file}`;
}
export function clientPrefix(cid, artifactId = null) {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(String(cid)) || (artifactId && !/^art_[0-9a-f]{16}$/.test(String(artifactId)))) throw new Error('Bad R2 prefix');
  return `clients/${cid}/${artifactId ? `${artifactId}/` : ''}`;
}

/** A short-lived GET link for one object (≤ 15 min). `download` makes the browser save it under that name. */
export function presignGet(cfg, key, { expires = PLAY_EXPIRES, download = null, date = new Date() } = {}) {
  const secs = Math.min(MAX_EXPIRES, Math.max(1, Math.floor(Number(expires) || PLAY_EXPIRES)));
  const query = download ? { 'response-content-disposition': `attachment; filename*=UTF-8''${enc(download)}` } : {};
  const { url, expiresAt } = presign({ method: 'GET', host: cfg.host, path: `/${cfg.bucket}/${key}`, query, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, region: cfg.region, date, expires: secs });
  return { url, expiresAt };
}

// ── S3 calls ──
/** One HTTPS request (swappable for tests). Resolves { status, text }. */
let send = ({ host, method, path, query, headers, file = null, body = null }) => new Promise((resolve, reject) => {
  const qs = canonicalQuery(query);
  const req = https.request({ host, method, path: `${encPath(path)}${qs ? `?${qs}` : ''}`, headers, timeout: 120_000 }, res => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', d => { if (text.length < 200_000) text += d; });
    res.on('end', () => resolve({ status: res.statusCode, text }));
  });
  req.on('timeout', () => req.destroy(new Error('R2 took too long to answer')));
  req.on('error', reject);
  if (file) fs.createReadStream(file).on('error', reject).pipe(req);
  else req.end(body || undefined);
});

async function call(cfg, { method, key = '', query = {}, headers = {}, file = null }) {
  const path = `/${cfg.bucket}${key ? `/${key}` : ''}`;
  const s = signRequest({ method, host: cfg.host, path, query, headers, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, region: cfg.region });
  const r = await send({ host: cfg.host, method, path, query, headers: s.headers, file });
  if (r.status >= 300) {
    const code = String(r.text).match(/<Code>([^<]{1,80})<\/Code>/)?.[1] || `HTTP ${r.status}`;
    throw Object.assign(new Error(`R2 ${method} failed: ${code}`), { status: r.status, code });
  }
  return r;
}

/** Upload a file (streamed; single PUT, R2 takes up to 5 GB that way). */
export async function putFile(cfg, key, file, contentType = 'application/octet-stream') {
  const size = fs.statSync(file).size;
  await call(cfg, { method: 'PUT', key, headers: { 'content-type': contentType, 'content-length': String(size) }, file });
  return { key, size };
}
export const deleteKey = (cfg, key) => call(cfg, { method: 'DELETE', key });

const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
/** Every key under a prefix (ListObjectsV2, up to `max`). */
export async function listKeys(cfg, prefix, max = 5000) {
  const keys = [];
  let token = null;
  do {
    const query = { 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) };
    const { text } = await call(cfg, { method: 'GET', query });
    for (const m of text.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(unxml(m[1]));
    token = /<IsTruncated>true<\/IsTruncated>/.test(text) ? unxml(text.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/)?.[1] || '') || null : null;
  } while (token && keys.length < max);
  return keys;
}
/** Remove everything under a prefix (a client's, or one artifact's). Only ever a `clients/<id>/…` prefix. */
export async function deletePrefix(cfg, prefix) {
  if (!/^clients\/[a-z0-9][a-z0-9-]{0,80}\/(?:art_[0-9a-f]{16}\/)?$/.test(String(prefix))) throw new Error('Bad R2 prefix');
  const keys = await listKeys(cfg, prefix);
  for (const k of keys) if (k.startsWith(prefix)) await deleteKey(cfg, k);
  return keys.length;
}

/** A client was removed: every copy under their prefix goes (the bucket's 30-day rule catches anything missed). */
export async function forgetClientCopies(cid) {
  const cfg = r2Config();
  if (!cfg) return 0;
  return deletePrefix(cfg, clientPrefix(cid));
}
