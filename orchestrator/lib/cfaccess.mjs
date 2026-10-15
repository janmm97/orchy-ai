// Cloudflare Access in front of client pages. Each request Access lets through carries a token Cloudflare signed
// (Cf-Access-Jwt-Assertion): checked here against the team's public keys, the team as issuer and the Access
// application's audience tag. The plain email header is never trusted: anyone can send it to a tunnel that has
// no Access application in front of it.
//   .env: CF_ACCESS_TEAM_DOMAIN (yourteam, or yourteam.cloudflareaccess.com) and CF_ACCESS_AUD (the
//   application's "Application Audience (AUD) Tag" in Zero Trust → Access → Applications).
import crypto from 'node:crypto';
import { env } from './env.mjs';

const SKEW_S = 60;
const KEYS_TTL_MS = 3_600_000;
const REFETCH_MS = 30_000; // an unknown key id refetches, but not more often than this
let cache = { team: null, at: 0, keys: new Map() };

/** { team, aud, issuer } when both settings are there, else null. */
export function accessConfig() {
  const team = String(env('CF_ACCESS_TEAM_DOMAIN') || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.cloudflareaccess\.com$/, '');
  const aud = String(env('CF_ACCESS_AUD') || '').trim();
  if (!team || !aud || !/^[a-z0-9-]+$/.test(team)) return null;
  return { team, aud, issuer: `https://${team}.cloudflareaccess.com` };
}

async function signingKey(cfg, kid) {
  const age = Date.now() - cache.at;
  const stale = cache.team !== cfg.team || age > KEYS_TTL_MS;
  if (stale || (!cache.keys.has(kid) && age > REFETCH_MS)) {
    const res = await fetch(`${cfg.issuer}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Cloudflare's keys didn't load (${res.status})`);
    const { keys = [] } = await res.json();
    const map = new Map();
    for (const k of keys) if (k?.kty === 'RSA' && k.kid) { try { map.set(k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })); } catch {} }
    cache = { team: cfg.team, at: Date.now(), keys: map };
  }
  return cache.keys.get(kid);
}

const part = s => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

/** The email of the person Access let through, once its signed token checks out; throws with the reason otherwise. */
export async function verifiedEmail(req, cfg) {
  const token = String(req.headers['cf-access-jwt-assertion'] || '');
  const [h, p, sig] = token.split('.');
  if (!h || !p || !sig) throw new Error('no Access token on the request');
  let head, claims;
  try { head = part(h); claims = part(p); } catch { throw new Error('the Access token is unreadable'); }
  if (head.alg !== 'RS256' || !head.kid) throw new Error('the Access token isn’t RS256');
  const key = await signingKey(cfg, head.kid);
  if (!key) throw new Error('the Access token is signed with a key this team doesn’t have');
  if (!crypto.verify('sha256', Buffer.from(`${h}.${p}`), key, Buffer.from(sig, 'base64url'))) throw new Error('the Access token’s signature is wrong');
  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== cfg.issuer) throw new Error('the Access token is from another team');
  if (!aud.includes(cfg.aud)) throw new Error('the Access token is for another application');
  if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < now) throw new Error('the Access token has expired');
  if (typeof claims.nbf === 'number' && claims.nbf - SKEW_S > now) throw new Error('the Access token isn’t valid yet');
  const email = String(claims.email || '').trim().toLowerCase();
  if (!email) throw new Error('the Access token has no email');
  return email;
}
