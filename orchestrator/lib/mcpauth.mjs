// OAuth sign-in for remote MCP servers that take no API key: MCP's own auth flow.
// Discover the server's authorization server, register Orchy as a native client, PKCE sign-in in the owner's browser
// with a one-off callback listener on 127.0.0.1 (never the dashboard's port: its cross-site check stays as it is),
// then keep the token in Orchy's data (orchestrator/data/mcp-auth.json, mode 0600; never in a workspace folder, so its
// agents can't read it) and refresh it. Runs and the Test button get it as an Authorization header; a header the
// owner typed always wins. Services that only let approved apps register fall back to Claude Code's own MCP sign-in
// for the workspace's own Claude Code account (openClaudeLogin), so Orchy never holds that token at all.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { DATA_DIR, expandPath } from './env.mjs';
import { CLAUDE_BIN } from './claude.mjs';
import { openShellWindow } from './workspaces.mjs';
import { psq, sq } from './engines/shared.mjs';

const FILE = () => path.join(DATA_DIR, 'mcp-auth.json');
const LOGIN_MS = 5 * 60_000;
const logins = new Map(); // `${ws}:${name}` → { status: 'waiting'|'done'|'failed', error? }

const key = (ws, name) => `${ws.id}:${name}`;
const load = () => { try { return JSON.parse(fs.readFileSync(FILE(), 'utf8').replace(/^﻿/, '')); } catch { return {}; } };
function store(all) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(FILE(), 0o600); } catch {} // a file made before keeps its old mode otherwise
}
const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hasAuthHeader = def => Object.keys(def.headers || {}).some(h => h.toLowerCase() === 'authorization');

async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** The server's protected-resource metadata (RFC 9728), from its 401 or the well-known paths. */
export async function resourceMeta(url) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jos', version: '0.1' } } }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  const challenge = r?.headers.get('www-authenticate') || '';
  const hinted = challenge.match(/resource_metadata="([^"]+)"/)?.[1];
  // the scopes its 401 asks for, which MCP says to use as they are (some services refuse a token without them)
  const scopeHint = challenge.match(/scope="([^"]*)"/)?.[1]?.trim() || null;
  const u = new URL(url);
  const tries = [hinted, `${u.origin}/.well-known/oauth-protected-resource${u.pathname === '/' ? '' : u.pathname}`, `${u.origin}/.well-known/oauth-protected-resource`].filter(Boolean);
  for (const t of tries) { try { return { ...await getJson(t), scopeHint }; } catch {} }
  return { authorization_servers: [u.origin], scopeHint }; // older servers: the MCP host is its own authorization server
}

export async function authServerMeta(issuer) {
  const u = new URL(issuer);
  const p = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
  const tries = [`${u.origin}/.well-known/oauth-authorization-server${p}`, `${u.origin}${p}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration${p}`, `${u.origin}${p}/.well-known/openid-configuration`];
  for (const t of tries) { try { const m = await getJson(t); if (m.authorization_endpoint && m.token_endpoint) return m; } catch {} }
  throw new Error(`couldn't find how ${u.host} signs people in`);
}

let opener = url => {
  // not `cmd /c start`: cmd would cut the URL at its first &
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
};
/** Tests open the sign-in page themselves instead of a browser. */
export function setOpenerForTests(fn) { opener = fn; }

/** Where a sign-in stands: signed in (Orchy's own, or Claude Code's for the workspace's account), waiting, or the last error. */
export function authStatus(ws, name, def = null) {
  const saved = load()[key(ws, name)];
  const live = logins.get(key(ws, name));
  const viaClaude = !saved && !!def?.url && claudeSignedIn(ws, name, def.url);
  return { signedIn: !!saved || viaClaude, viaClaude, status: live?.status || (saved || viaClaude ? 'done' : null), error: live?.error || null };
}

// ── Claude Code's own MCP sign-in, for services that only let approved apps register ──
// A Claude Code run finds a token Claude Code saved for a server of the same name and URL (`claude mcp login`),
// even with --strict-mcp-config, so those services work in runs without Orchy ever holding the token. The token
// lives in the workspace's own Claude Code account (its CLAUDE_CONFIG_DIR), never another account's, never the workspace.
const claudeDir = ws => (ws.claudeConfigDir ? expandPath(ws.claudeConfigDir) : path.join(os.homedir(), '.claude'));
const sameUrl = (a, b) => String(a || '').replace(/\/+$/, '') === String(b || '').replace(/\/+$/, '');
const SAFE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** Does the workspace's Claude Code account hold a usable Claude Code sign-in for this server? Reads presence and expiry only. */
export function claudeSignedIn(ws, name, url) {
  if (!ws.claudeAccount) return false;
  try {
    const all = JSON.parse(fs.readFileSync(path.join(claudeDir(ws), '.credentials.json'), 'utf8')).mcpOAuth || {};
    return Object.values(all).some(t => t?.serverName === name && sameUrl(t.serverUrl, url) && (t.refreshToken || (t.accessToken && (!t.expiresAt || t.expiresAt > Date.now()))));
  } catch { return false; }
}

/** Open a terminal that signs the workspace's Claude Code account in to this server with `claude mcp login`. */
export function openClaudeLogin(ws, name, def) {
  if (!ws.claudeAccount) throw Object.assign(new Error(`${ws.name} has no Claude Code account, so it can't use Claude Code's sign-in`), { status: 400 });
  if (!SAFE_NAME.test(name) || !/^https:\/\//i.test(def.url || '')) throw Object.assign(new Error('Only https servers with a plain name (letters, digits, . _ -) sign in this way'), { status: 400 });
  // the server is registered in a folder of Orchy's own (local scope), so it never loads in a workspace or the owner's sessions
  const dir = path.join(DATA_DIR, 'mcp-login', ws.id);
  fs.mkdirSync(dir, { recursive: true });
  const intro = `${new URL(def.url).host} only lets approved apps sign in, so this signs ${ws.name}'s Claude Code account (${ws.claudeAccount}) in instead. Its agents' runs use that sign-in.`;
  const done = 'Done. Go back to Orchy: Connections shows it as signed in via Claude Code. You can close this window.';
  if (process.platform === 'win32') {
    const file = path.join(DATA_DIR, `mcp-login-${ws.id}-${name}.ps1`);
    const env = ws.claudeConfigDir ? `$env:CLAUDE_CONFIG_DIR=${psq(claudeDir(ws))}\n` : 'Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue\n';
    fs.writeFileSync(file, `﻿# Orchy: sign ${ws.name}'s Claude Code account in to the MCP server ${name}
$Host.UI.RawUI.WindowTitle = ${psq(`Sign in to ${name} (${ws.name})`)}
${env}Set-Location -LiteralPath ${psq(dir)}
Write-Host ${psq(intro)} -ForegroundColor Yellow
& ${psq(CLAUDE_BIN)} mcp remove --scope local ${psq(name)} 2>$null | Out-Null
& ${psq(CLAUDE_BIN)} mcp add --scope local --transport http ${psq(name)} ${psq(def.url)}
& ${psq(CLAUDE_BIN)} mcp login ${psq(name)}
Write-Host ""; Write-Host ${psq(done)} -ForegroundColor Green
`);
    spawn('cmd.exe', ['/c', 'start', '""', 'powershell', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return { status: 'terminal' };
  }
  const file = path.join(DATA_DIR, `mcp-login-${ws.id}-${name}.sh`);
  const claude = sq(CLAUDE_BIN || 'claude');
  const lines = [
    `cd ${sq(dir)}`,
    ws.claudeConfigDir ? `export CLAUDE_CONFIG_DIR=${sq(claudeDir(ws))}` : 'unset CLAUDE_CONFIG_DIR',
    `${claude} mcp remove --scope local ${sq(name)} >/dev/null 2>&1`,
    `${claude} mcp add --scope local --transport http ${sq(name)} ${sq(def.url)}`,
    `${claude} mcp login ${sq(name)}`,
  ];
  fs.writeFileSync(file, `#!/bin/sh\n# Orchy: sign ${ws.name}'s Claude Code account in to the MCP server ${name}\nprintf '%s\\n\\n' ${sq(intro)}\n${lines.join('\n')}\nprintf '\\n%s\\n' ${sq(done)}\nexec "\${SHELL:-/bin/sh}"\n`, { mode: 0o700 });
  openShellWindow(file, lines.join(' && '));
  return { status: 'terminal' };
}

/** Start the browser sign-in for MCP server `name` of workspace `ws`. Resolves once the browser is open. */
export async function startLogin(ws, name, def, { onDone } = {}) {
  if (!def?.url) throw Object.assign(new Error('Only http/sse servers sign in'), { status: 400 });
  if (!/^https?:\/\//i.test(def.url)) throw Object.assign(new Error('The server URL must start with https://'), { status: 400 });
  const k = key(ws, name);
  if (logins.get(k)?.status === 'waiting') return { status: 'waiting' };
  const resource = await resourceMeta(def.url);
  const meta = await authServerMeta(resource.authorization_servers?.[0] || new URL(def.url).origin);
  // offline_access when offered, so the sign-in lasts (refresh token) instead of ending with the first access token
  const scopes = resource.scopeHint ? resource.scopeHint.split(/\s+/) : (resource.scopes_supported || meta.scopes_supported || []).filter(s => s !== 'openid');
  if (meta.scopes_supported?.includes('offline_access') && !scopes.includes('offline_access')) scopes.push('offline_access');
  const scope = scopes.join(' ');

  // A service that hands out its own sign-in app (a client ID and a fixed callback port, like `claude mcp add
  // --client-id --callback-port`) gets that one; the rest register Orchy on a one-off port.
  const preset = def.oauth?.clientId ? def.oauth : null;
  const port = preset?.callbackPort || 0;
  const server = http.createServer();
  await new Promise((res, rej) => server.listen(port, '127.0.0.1', res).on('error', rej))
    .catch(e => { throw new Error(e.code === 'EADDRINUSE' ? `Port ${port} is busy (another sign-in, or Claude Code's /mcp, may be using it). Close that and try again.` : e.message); });
  // localhost, as these apps are registered with: browsers try ::1 too, so listen there as well when the port is fixed
  const server6 = preset ? http.createServer() : null;
  if (server6) await new Promise(res => server6.listen(port, '::1', res).on('error', res));
  const redirect = `http://${preset ? 'localhost' : '127.0.0.1'}:${server.address().port}/callback`;
  const close = () => { try { server.close(); } catch {} try { server6?.close(); } catch {} };
  let client;
  try {
    if (preset) client = { client_id: preset.clientId };
    else if (!meta.registration_endpoint) throw Object.assign(new Error(`${new URL(def.url).host} doesn't let apps register themselves: add the client ID it gives out under Sign-in app (Edit), or an API key in Headers`), { code: 'register-refused' });
    else {
      const r = await fetch(meta.registration_endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ client_name: 'Orchy', application_type: 'native', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...(scope ? { scope } : {}) }),
      });
      if (!r.ok) throw Object.assign(new Error(`${new URL(def.url).host} turned down Orchy registering itself (HTTP ${r.status}): add the client ID it gives out under Sign-in app (Edit)`), { code: 'register-refused' });
      client = await r.json();
    }
  } catch (e) { close(); throw e; }

  const verifier = b64url(crypto.randomBytes(32));
  const state = b64url(crypto.randomBytes(16));
  const auth = new URL(meta.authorization_endpoint);
  Object.entries({
    response_type: 'code', client_id: client.client_id, redirect_uri: redirect, state,
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
    resource: resource.resource || def.url, ...(scope ? { scope } : {}),
    ...(preset?.connection ? { connection: preset.connection } : {}), // Auth0: straight to that login instead of the email box
  }).forEach(([a, b]) => auth.searchParams.set(a, b));

  const st = { status: 'waiting', error: null };
  logins.set(k, st);
  let timer = null;
  const finish = (error) => {
    clearTimeout(timer); close();
    Object.assign(st, error ? { status: 'failed', error } : { status: 'done', error: null });
    onDone?.(st);
  };
  timer = setTimeout(() => finish('It timed out (nothing was finished in the browser within 5 minutes).'), LOGIN_MS);
  timer.unref?.();
  const onRequest = async (req, res) => {
    const u = new URL(req.url, redirect);
    if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
    const page = (msg) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" }).end(`<!doctype html><meta charset="utf-8"><title>Orchy</title><body style="font:16px system-ui;padding:40px">${msg}</body>`);
    if (u.searchParams.get('state') !== state) { page('This sign-in link is stale. Start again from Orchy.'); return; }
    const code = u.searchParams.get('code');
    if (!code) { page('Sign-in was cancelled. You can close this tab.'); finish(u.searchParams.get('error_description') || u.searchParams.get('error') || 'Sign-in was cancelled'); return; }
    try {
      const tok = await tokenRequest(meta.token_endpoint, { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier, resource: resource.resource || def.url }, client);
      const all = load();
      all[k] = { url: def.url, tokenEndpoint: meta.token_endpoint, clientId: client.client_id, clientSecret: client.client_secret || null, resource: resource.resource || def.url, ...tokenFields(tok), signedInAt: new Date().toISOString() };
      store(all);
      page(`Signed in. Orchy's agents can use ${String(name).replace(/[<&]/g, '')} now. You can close this tab.`);
      finish(null);
    } catch (e) { page(`Sign-in didn't finish: ${String(e.message).replace(/[<&]/g, c => (c === '<' ? '&lt;' : '&amp;'))}`); finish(e.message); }
  };
  server.on('request', onRequest);
  server6?.on('request', onRequest);
  opener(await signInPage(auth.toString()));
  return { status: 'waiting', redirect };
}

// Some servers answer the authorize URL with JSON naming their sign-in page instead of redirecting, which a browser
// would just print: open that page then.
async function signInPage(url) {
  try {
    const r = await fetch(url, { redirect: 'manual', headers: { Accept: 'text/html,application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!/json/i.test(r.headers.get('content-type') || '')) return url;
    const j = await r.json();
    const next = j?.url || j?.redirect_url || j?.location;
    return typeof next === 'string' && /^https:\/\//.test(next) ? next : url;
  } catch { return url; }
}

async function tokenRequest(endpoint, params, client) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (client?.client_secret) headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString('base64')}`;
  const r = await fetch(endpoint, { method: 'POST', headers, body: new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)), signal: AbortSignal.timeout(15_000) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.access_token) throw new Error(body.error_description || body.error || `token request failed (HTTP ${r.status})`);
  return body;
}

const tokenFields = (tok, prev = {}) => ({
  accessToken: tok.access_token,
  refreshToken: tok.refresh_token || prev.refreshToken || null,
  expiresAt: tok.expires_in ? Date.now() + tok.expires_in * 1000 : null,
});

/** A fresh access token for this server, refreshed when it has under 5 minutes left. Null if not signed in. */
async function accessToken(ws, name, def) {
  const k = key(ws, name);
  const all = load();
  const t = all[k];
  if (!t || t.url !== def.url) return null; // the URL changed: that sign-in was for another server
  if (!t.expiresAt || t.expiresAt - Date.now() > 5 * 60_000 || !t.refreshToken) return t.expiresAt && t.expiresAt <= Date.now() ? null : t.accessToken;
  try {
    const tok = await tokenRequest(t.tokenEndpoint, { grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: t.clientId, resource: t.resource }, { client_id: t.clientId, client_secret: t.clientSecret });
    all[k] = { ...t, ...tokenFields(tok, t) };
    store(all);
    return all[k].accessToken;
  } catch (e) {
    console.warn(`[mcp-auth] ${k}: refresh failed: ${e.message}`);
    return t.expiresAt > Date.now() ? t.accessToken : null;
  }
}

/** `def` with its stored sign-in as an Authorization header (unless the owner set one). */
export async function withAuth(ws, name, def) {
  if (!def?.url || hasAuthHeader(def)) return def;
  const token = await accessToken(ws, name, def);
  return token ? { ...def, headers: { ...(def.headers || {}), Authorization: `Bearer ${token}` } } : def;
}

/** Every server of `servers` (a readMcp map) with its sign-in applied. */
export async function serversWithAuth(ws, servers) {
  const out = {};
  for (const [name, def] of Object.entries(servers || {})) out[name] = def?.enabled === false ? def : await withAuth(ws, name, def);
  return out;
}

/** Drop a server's sign-in (the server was removed). */
export function forget(ws, name) {
  logins.delete(key(ws, name));
  const all = load();
  if (!all[key(ws, name)]) return;
  delete all[key(ws, name)];
  store(all);
}

/** Drop every sign-in of a workspace (it was retired for good). */
export function forgetWorkspace(wsId) {
  const all = load();
  const ks = Object.keys(all).filter(k => k.startsWith(`${wsId}:`));
  if (!ks.length) return;
  for (const k of ks) delete all[k];
  store(all);
}
