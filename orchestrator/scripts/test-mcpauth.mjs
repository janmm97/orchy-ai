// MCP OAuth sign-in (lib/mcpauth.mjs) against a fake MCP server + authorization server on 127.0.0.1, in a disposable
// Orchy copy (its own orchestrator/data). No browser, no network beyond loopback.
//   node orchestrator/scripts/test-mcpauth.mjs
// Checks: discovery from the 401 (resource metadata, scope hint), dynamic registration with a loopback redirect,
// PKCE (the token endpoint checks the verifier), a wrong `state` is refused, the token lands in data/mcp-auth.json
// (mode 0600 on macOS/Linux) and never in the workspace, withAuth adds it only for the URL it was made for and never
// over a header the owner typed, a near-expiry token refreshes, a refused registration says so (code
// register-refused), and forget/forgetWorkspace drop it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../lib/env.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orchy-mcpauth-test-')));
const orch = path.join(tmp, 'orchestrator');
const wsDir = path.join(tmp, 'workspaces', 'Acme');
fs.mkdirSync(orch); fs.mkdirSync(wsDir, { recursive: true });
fs.cpSync(path.join(ROOT, 'orchestrator/lib'), path.join(orch, 'lib'), { recursive: true });
if (fs.existsSync(path.join(ROOT, 'node_modules'))) fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
fs.writeFileSync(path.join(tmp, '.env'), 'JEV_PROVIDER=off\n');
fs.writeFileSync(path.join(orch, 'config.json'), JSON.stringify({ timezone: 'UTC', orchy: {}, workspaces: [{ id: 'acme', name: 'Acme Workspace', folder: 'workspaces/Acme', client: 'Acme', runtime: 'claude', claudeAccount: 'a@example.com' }] }));
fs.writeFileSync(path.join(orch, 'voice-agents.json'), '{"agents":[]}');

// ── the fake service: an MCP endpoint that wants a token, its metadata, registration, authorize and token ──
const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
let registerOk = true, issued = 0;
const codes = new Map(); // code → { challenge, redirect }
const body = req => new Promise(r => { let s = ''; req.on('data', d => { s += d; }); req.on('end', () => r(s)); });
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, base);
  const json = (code, j, h = {}) => res.writeHead(code, { 'Content-Type': 'application/json', ...h }).end(JSON.stringify(j));
  if (u.pathname === '/mcp') {
    if (req.headers.authorization === `Bearer tok-${issued}` && issued) return json(200, { jsonrpc: '2.0', id: 1, result: {} });
    return json(401, { error: 'unauthorized' }, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="read write"` });
  }
  if (u.pathname === '/.well-known/oauth-protected-resource/mcp') return json(200, { resource: `${base}/mcp`, authorization_servers: [`${base}/auth`] });
  if (u.pathname === '/.well-known/oauth-authorization-server/auth') return json(200, { issuer: `${base}/auth`, authorization_endpoint: `${base}/auth/authorize`, token_endpoint: `${base}/auth/token`, registration_endpoint: `${base}/auth/register`, scopes_supported: ['read', 'write', 'offline_access'] });
  if (u.pathname === '/auth/register') {
    const j = JSON.parse(await body(req));
    if (!registerOk) return json(403, { error: 'access_denied' });
    assert.ok(/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(j.redirect_uris[0]), 'a loopback redirect');
    assert.equal(j.token_endpoint_auth_method, 'none');
    return json(201, { client_id: 'cid-1' });
  }
  if (u.pathname === '/auth/authorize') {
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(u.searchParams.get('scope'), 'read write offline_access');
    const code = `code-${Math.random().toString(36).slice(2)}`;
    codes.set(code, { challenge: u.searchParams.get('code_challenge'), redirect: u.searchParams.get('redirect_uri') });
    const to = new URL(u.searchParams.get('redirect_uri'));
    to.searchParams.set('code', code); to.searchParams.set('state', u.searchParams.get('state'));
    return res.writeHead(302, { Location: to.toString() }).end();
  }
  if (u.pathname === '/auth/token') {
    const p = new URLSearchParams(await body(req));
    if (p.get('grant_type') === 'authorization_code') {
      const c = codes.get(p.get('code'));
      if (!c || b64url(crypto.createHash('sha256').update(p.get('code_verifier') || '').digest()) !== c.challenge || p.get('redirect_uri') !== c.redirect) return json(400, { error: 'invalid_grant' });
      issued++;
      return json(200, { access_token: `tok-${issued}`, refresh_token: 'ref-1', expires_in: 60 }); // under 5 minutes: the next use refreshes
    }
    if (p.get('grant_type') === 'refresh_token' && p.get('refresh_token') === 'ref-1') { issued++; return json(200, { access_token: `tok-${issued}`, expires_in: 3600 }); }
    return json(400, { error: 'unsupported_grant_type' });
  }
  res.writeHead(404).end();
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

const mod = file => import(pathToFileURL(path.join(orch, 'lib', file)).href);
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 300; i++) { const v = fn(); if (v) return v; await delay(20); } throw new Error('Test timed out'); }

try {
  const A = await mod('mcpauth.mjs');
  const W = await mod('workspaces.mjs');
  const ws = W.workspace('acme');
  const def = { type: 'http', url: `${base}/mcp`, headers: {}, enabled: true };
  const authFile = path.join(orch, 'data', 'mcp-auth.json');

  // a browser that follows the authorize redirect to Orchy's callback (a stale state first: refused, nothing saved)
  let opened = null;
  A.setOpenerForTests(url => { opened = url; });
  const done = [];
  const r = await A.startLogin(ws, 'svc', def, { onDone: st => done.push({ ...st }) });
  assert.equal(r.status, 'waiting');
  assert.ok(opened?.startsWith(`${base}/auth/authorize?`));
  const stale = await fetch(`${r.redirect}?code=x&state=nope`).then(x => x.text());
  assert.match(stale, /stale/); assert.equal(fs.existsSync(authFile), false);
  assert.equal(A.authStatus(ws, 'svc', def).status, 'waiting');
  const page = await fetch(opened).then(x => x.text()); // authorize → 302 → the callback, which trades the code
  assert.match(page, /Signed in/);
  await until(() => done.length);
  assert.equal(done[0].status, 'done');
  assert.equal(A.authStatus(ws, 'svc', def).signedIn, true);

  // the token lives in Orchy's data, private, never in the workspace
  const saved = JSON.parse(fs.readFileSync(authFile, 'utf8'))['acme:svc'];
  assert.equal(saved.accessToken, 'tok-1'); assert.equal(saved.clientId, 'cid-1');
  if (process.platform !== 'win32') assert.equal(fs.statSync(authFile).mode & 0o777, 0o600);
  const inWs = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else inWs.push(fs.readFileSync(p, 'utf8')); } })(wsDir);
  assert.ok(!inWs.some(t => t.includes('tok-1')));

  // withAuth: a near-expiry token refreshes; only for its own URL; never over the owner's header
  const a1 = await A.withAuth(ws, 'svc', def);
  assert.equal(a1.headers.Authorization, 'Bearer tok-2');
  assert.equal((await A.withAuth(ws, 'svc', def)).headers.Authorization, 'Bearer tok-2'); // fresh for an hour now
  assert.equal((await W.testMcp(a1)).ok !== undefined, true);
  assert.equal((await A.withAuth(ws, 'svc', { ...def, url: 'https://elsewhere.example/mcp' })).headers.Authorization, undefined);
  assert.equal((await A.withAuth(ws, 'svc', { ...def, headers: { authorization: 'Bearer mine' } })).headers.authorization, 'Bearer mine');
  const all = await A.serversWithAuth(ws, { svc: def, off: { ...def, enabled: false }, local: { type: 'stdio', command: 'x' } });
  assert.equal(all.svc.headers.Authorization, 'Bearer tok-2'); assert.equal(all.off.headers.Authorization, undefined); assert.equal(all.local.headers, undefined);

  // testMcp says a 401 needs a sign-in
  const t401 = await W.testMcp(def);
  assert.equal(t401.ok, false); assert.equal(t401.needsLogin, true);

  // a service that turns registration down: register-refused (the server then offers Claude Code's own sign-in)
  registerOk = false;
  await assert.rejects(A.startLogin(ws, 'svc2', def), e => e.code === 'register-refused');

  // forget / forgetWorkspace
  A.forget(ws, 'svc');
  assert.equal(A.authStatus(ws, 'svc', def).signedIn, false);
  assert.equal((await A.withAuth(ws, 'svc', def)).headers.Authorization, undefined);
  console.log('MCP sign-in checks passed: discovery, registration, PKCE, stale state, token kept in Orchy’s data (0600), refresh, URL-bound, owner header wins, 401 → needsLogin, register-refused, forget.');
} catch (e) {
  console.error(e); process.exitCode = 1;
} finally {
  srv.close();
  assert.ok(path.resolve(tmp).startsWith(fs.realpathSync(os.tmpdir())));
  await delay(200);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
  process.exit(process.exitCode || 0);
}
