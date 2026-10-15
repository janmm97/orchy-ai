// Cloudflare Access token checks for client pages, with no network: node orchestrator/scripts/test-cfaccess.mjs
// A throwaway RSA key stands in for the team's signing key and fetch serves its public half as the team's certs.
import crypto from 'node:crypto';
import { verifiedEmail } from '../lib/cfaccess.mjs';

let fail = 0;
const ok = (cond, label, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : `  ${extra}`}`); if (!cond) fail++; };

const cfg = { team: 'acme', aud: 'aud-123', issuer: 'https://acme.cloudflareaccess.com' };
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
let certFetches = 0;
globalThis.fetch = async url => {
  certFetches++;
  if (String(url) !== 'https://acme.cloudflareaccess.com/cdn-cgi/access/certs') return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => ({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] }) };
};

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
function jwt(claims = {}, { kid = 'k1', alg = 'RS256', key = privateKey } = {}) {
  const head = b64({ alg, kid, typ: 'JWT' });
  const body = b64({ iss: cfg.issuer, aud: [cfg.aud], email: 'Client@Example.com', iat: now, nbf: now, exp: now + 600, ...claims });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}
const req = token => ({ headers: token ? { 'cf-access-jwt-assertion': token } : {} });
const why = async token => { try { await verifiedEmail(req(token), cfg); return null; } catch (e) { return e.message; } };

ok(await verifiedEmail(req(jwt()), cfg) === 'client@example.com', 'a good token gives its email, lower-cased');
ok(/no Access token/.test(await why('')), 'no token: refused');
ok(/unreadable/.test(await why('a.b.c')), 'garbage: refused');
ok(/signature/.test(await why(jwt({}, { key: other.privateKey }))), 'signed with another key: refused');
ok(/another application/.test(await why(jwt({ aud: ['aud-999'] }))), 'another application’s audience: refused');
ok(/another team/.test(await why(jwt({ iss: 'https://evil.cloudflareaccess.com' }))), 'another team as issuer: refused');
ok(/expired/.test(await why(jwt({ exp: now - 3600 }))), 'expired: refused');
ok(/isn’t valid yet/.test(await why(jwt({ nbf: now + 3600 }))), 'not valid yet: refused');
ok(/no email/.test(await why(jwt({ email: '' }))), 'no email claim: refused');
ok(/RS256/.test(await why(jwt({}, { alg: 'none' }))), 'alg none: refused');
const before = certFetches;
ok(/doesn’t have/.test(await why(jwt({}, { kid: 'k9' }))), 'unknown key id: refused');
ok(certFetches === before, 'an unknown key id right after a fetch doesn’t refetch (no hammering Cloudflare)');
// a header-only email (the old way) is ignored
ok(/no Access token/.test(await (async () => { try { await verifiedEmail({ headers: { 'cf-access-authenticated-user-email': 'client@example.com' } }, cfg); return ''; } catch (e) { return e.message; } })()), 'the plain email header alone is not trusted');

console.log(fail ? `\n${fail} failed` : '\nall Cloudflare Access checks passed');
process.exit(fail ? 1 : 0);
