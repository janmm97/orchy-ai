// One CLI wrapper. Runs `one --agent ...` with a specific cwd, because One scopes
// connections by folder (the orchestrator root and each workspace folder with its own One login).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { env, DATA_DIR } from './env.mjs';
import { findBinary, probeVersion } from './claude.mjs';

function resolveCli() {
  const explicit = env('ONE_CLI_PATH');
  if (explicit && fs.existsSync(explicit)) return { cmd: process.execPath, pre: [explicit] };
  const found = findBinary('one');
  const real = (() => { try { return found && fs.realpathSync(found); } catch { return null; } })();
  const candidates = [
    real && /cli\.js$/.test(real) && real, // npm's `one` on macOS and Linux is a link to the package's bin/cli.js
    found && path.join(path.dirname(found), 'node_modules', '@withone', 'cli', 'bin', 'cli.js'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', '@withone', 'cli', 'bin', 'cli.js'),
    process.env.npm_config_prefix && path.join(process.env.npm_config_prefix, 'node_modules', '@withone', 'cli', 'bin', 'cli.js'),
    '/usr/local/lib/node_modules/@withone/cli/bin/cli.js',
    '/opt/homebrew/lib/node_modules/@withone/cli/bin/cli.js',
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', '@withone', 'cli', 'bin', 'cli.js'),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return { cmd: process.execPath, pre: [c] };
  // last resort: the `one` on PATH or in a standard folder (Homebrew, ~/.local/bin...). On Windows that's npm's one.cmd, which only a shell can start
  if (found && process.platform !== 'win32') return { cmd: found, pre: [] };
  return process.platform === 'win32' ? { cmd: found || 'one', pre: [], shell: true } : { cmd: 'one', pre: [] };
}
const CLI = resolveCli();

/** Is the One CLI installed and runnable? Returns its version line, or null. (Used by setup and the health check.) */
export function oneVersion() {
  const bin = CLI.pre[0] ? process.execPath : (CLI.cmd === 'one' ? findBinary('one') : CLI.cmd);
  return probeVersion(bin, CLI.pre[0] ? [CLI.pre[0], '--version'] : ['--version']);
}

// ── One and the Node it runs on ──
// One refuses to start (even for --version) on a Node that still trusts the compromised eMudhra certificates, so
// "it won't start" must never read as "not installed". Its package.json says which Node it takes: read that,
// never One's wording. One runs on Orchy's own Node (process.execPath), so updating Node means restarting Orchy.
const parseV = s => [...String(s).trim().replace(/^v/, '').split('.').map(n => parseInt(n, 10)), NaN, NaN].slice(0, 3);
/** Does a Node version meet an npm `engines` range? Handles the forms packages use: ^ ~ >= > <= < =, partial versions, || and spaces. */
export function nodeSatisfies(version, range) {
  if (!range || !String(range).trim()) return true;
  const v = parseV(version).map(n => n || 0);
  return String(range).split('||').some(alt => alt.trim().split(/\s+/).filter(Boolean).every(c => {
    const m = c.match(/^(\^|~|>=|<=|>|<|=)?v?(\d+(?:\.\d+){0,2})/);
    if (!m) return true; // a form this doesn't read (x-ranges, tags) never blocks One
    const t = parseV(m[2]), given = t.filter(n => !Number.isNaN(n)).length, tt = t.map(n => n || 0);
    const d = v[0] - tt[0] || v[1] - tt[1] || v[2] - tt[2];
    switch (m[1]) {
      case '^': return d >= 0 && v[0] === tt[0];
      case '~': return d >= 0 && v[0] === tt[0] && (given < 2 || v[1] === tt[1]);
      case '>=': return d >= 0;
      case '>': return d > 0;
      case '<=': return d <= 0;
      case '<': return d < 0;
      default: return v.slice(0, given).every((n, i) => n === tt[i]);
    }
  }));
}
/** "^22.23.4 || ^24.22.1 || >=26.12.1" → "22.23.4+, 24.22.1+ or 26.12.1+" (any other range is shown as it is). */
export function describeRange(range) {
  const parts = String(range || '').split('||').map(s => s.trim()).filter(Boolean);
  if (!parts.length || !parts.every(p => /^(\^|>=)\d+(\.\d+){0,2}$/.test(p))) return String(range || '').trim();
  const list = parts.map(p => `${p.replace(/^(\^|>=)/, '')}+`);
  return list.length < 2 ? list[0] : `${list.slice(0, -1).join(', ')} or ${list.at(-1)}`;
}
/**
 * The command that updates Node on this computer, by how it was installed (the same reading as One's own
 * upgradeCommand), or null when there's none to give (then: nodejs.org). It keeps the major line when that line has
 * the fix (22, 24, 26), else 24, the LTS.
 */
export function nodeUpdateCmd({ platform = process.platform, version = process.versions.node, execPath = process.execPath } = {}) {
  const major = parseInt(String(version).replace(/^v/, ''), 10);
  const line = [22, 24, 26].includes(major) ? major : 24;
  const p = String(execPath).replace(/\\/g, '/');
  if (/\/\.nvm\/versions\/node\//.test(p)) return `nvm install ${line} && nvm alias default ${line}`;
  if (/\/AppData\/(Roaming|Local)\/nvm\//i.test(p)) return `nvm install ${line} && nvm use ${line}`; // nvm-windows
  if (/\/\.?volta\//i.test(p)) return `volta install node@${line}`;
  if (/fnm/i.test(p)) return `fnm install ${line} && fnm default ${line}`;
  const brew = p.match(/\/Cellar\/(node(?:@(\d+))?)\//);
  if (brew) return !brew[2] || [22, 24, 26].includes(Number(brew[2])) ? `brew upgrade ${brew[1]}` : `brew install node@${line}`;
  if (platform === 'win32') return 'winget install OpenJS.NodeJS.LTS';
  return null;
}
/** The installed One CLI's package.json ({ version, engines }), or null when One isn't installed where Orchy looks. */
export function onePackage() {
  const cli = resolveCli().pre[0];
  if (!cli) return null;
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(cli), '..', 'package.json'), 'utf8')); } catch { return null; }
}
/**
 * One is installed but won't run on the Node Orchy runs on: { version, node, need, fix, message }, else null.
 * pkg and nodeVersion are for tests.
 */
export function oneNodeProblem({ pkg = onePackage(), nodeVersion = process.version, fix = nodeUpdateCmd(), allow = process.env.ONE_ALLOW_UNPATCHED_NODE } = {}) {
  const range = pkg?.engines?.node;
  // One's own override: with it set, One runs on any Node (and warns), so Orchy doesn't stand in its way
  if (!range || allow === '1' || nodeSatisfies(nodeVersion, range)) return null;
  const need = describeRange(range);
  return {
    version: pkg.version || null, node: nodeVersion, need, fix,
    message: `One CLI${pkg.version ? ` ${pkg.version}` : ''} is installed, but it won't run on Node ${nodeVersion}: it needs Node ${need} (older versions still trust the compromised eMudhra certificates). Update Node${fix ? '' : ' from https://nodejs.org'}, then restart Orchy, since One runs on Orchy's own Node.`,
  };
}
let blocked = null;
/** oneNodeProblem(), looked up at most every 30 seconds (every workspace summary asks). */
export function oneBlocked() {
  if (!blocked || Date.now() - blocked.at > 30_000) blocked = { at: Date.now(), p: oneNodeProblem() };
  return blocked.p;
}

// Through cmd.exe each argument is quoted for the program, then cmd's metacharacters are escaped twice:
// once for cmd.exe, once for the one.cmd shim's %* (the cross-spawn recipe). JSON, spaces and & stay intact.
const cmdArg = a => `"${String(a).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`.replace(/([()\][%!^"`<>&|;, *?])/g, '^^^$1');
const spawnCli = (args, opts) => (CLI.shell
  ? spawn([CLI.cmd, ...args.map(cmdArg)].join(' '), { ...opts, shell: true })
  : spawn(CLI.cmd, [...CLI.pre, ...args], opts));

/** Run `one --agent <args>` in cwd. Resolves to parsed JSON (or {raw} when not JSON). */
export function one(args, { cwd, timeoutMs = 90_000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnCli(['--agent', ...args], {
      cwd,
      windowsHide: true,
      env: { ...process.env, ONE_NO_AUTO_UPDATE: '1', NO_COLOR: '1' },
    });
    let out = '', err = '';
    const t = setTimeout(() => { child.kill(); reject(new Error(`one ${args[0]} timed out`)); }, timeoutMs);
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('error', e => { clearTimeout(t); reject(e); });
    child.on('close', code => {
      clearTimeout(t);
      const text = out.trim();
      try {
        const json = JSON.parse(text);
        if (json && json.error && code !== 0) return reject(new Error(json.error.message || json.error));
        return resolve(json);
      } catch {
        if (code !== 0) return reject(new Error((err || text || `one exited ${code}`).trim().slice(0, 800)));
        resolve({ raw: text });
      }
    });
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

/** Run a human-facing One command (no --agent), e.g. `connection add gmail`, which opens a browser page. Resolves { code, out }. */
export function oneInteractive(args, { cwd, timeoutMs = 6 * 60_000 } = {}) {
  return new Promise(resolve => {
    const e = { ...process.env, ONE_NO_AUTO_UPDATE: '1', NO_COLOR: '1' };
    delete e.ONE_AGENT;
    const child = spawnCli(args, { cwd, windowsHide: true, env: e, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const t = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', d => { out = (out + d).slice(-4000); });
    child.stderr.on('data', d => { out = (out + d).slice(-4000); });
    child.on('error', err => { clearTimeout(t); resolve({ code: -1, out: err.message }); });
    child.on('close', code => { clearTimeout(t); resolve({ code, out }); });
  });
}

// The list takes One ~8s to send, so it's also kept on disk: a restart (or Jev's action plan, which can't
// wait that long) uses the saved copy while a fresh one loads. One copy per workspace folder: each list comes
// from that workspace's own One login, so no workspace is shown (or waits on) another's.
const PLATFORMS_FILE = path.join(DATA_DIR, 'platforms.json');
const DAY = 86400_000;
let platformCache = {}; // resolved folder -> { at, data }
try { const saved = JSON.parse(fs.readFileSync(PLATFORMS_FILE, 'utf8')); if (saved?.byDir && typeof saved.byDir === 'object') platformCache = saved.byDir; } catch {}
const platformLoads = new Map(); // folder -> the `one platforms` in flight
const scopeKey = cwd => {
  if (!cwd) throw new Error('No workspace folder to ask One from');
  const p = path.resolve(cwd);
  return process.platform === 'linux' ? p : p.toLowerCase(); // Windows and macOS folders ignore case
};
/** Every app One can connect (900+), asked in this workspace folder: slug, name, category, a one-line description, OAuth or not. Cached for a day. */
export async function listPlatforms(cwd, { oneFn = one, persist = true } = {}) { // tests pass a fake One and persist: false
  const key = scopeKey(cwd);
  const hit = platformCache[key];
  if (hit && Date.now() - hit.at < DAY && hit.data?.length) return hit.data;
  if (!platformLoads.has(key)) {
    platformLoads.set(key, oneFn(['platforms'], { cwd, timeoutMs: 60_000 }).then(res => {
      // One can exit 0 with an error or with no list: that's an error to show, never an empty list kept for a day
      const why = res?.error?.message || (typeof res?.error === 'string' && res.error) || (typeof res?.raw === 'string' && res.raw.slice(0, 300));
      if (!Array.isArray(res?.platforms)) throw Object.assign(new Error(`One didn't send its app list${why ? `: ${why}` : ''}. Try again, or check this workspace's One sign-in.`), { status: 502 });
      const data = res.platforms.filter(p => p && p.platform && p.active !== false)
        .map(p => ({ platform: p.platform, name: String(p.title || p.name || p.platform), category: p.category || '', about: firstSentence(p.description), oauth: !!p.oauth }))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (!data.length) throw Object.assign(new Error("One sent an empty app list. Try again, or check this workspace's One sign-in."), { status: 502 });
      platformCache[key] = { at: Date.now(), data };
      if (persist) try { fs.writeFileSync(PLATFORMS_FILE, JSON.stringify({ byDir: platformCache })); } catch {}
      return data;
    }).finally(() => platformLoads.delete(key)));
  }
  return platformLoads.get(key);
}
const firstSentence = s => (String(s || '').match(/^.*?[.!?](?=\s|$)/)?.[0] || String(s || '')).slice(0, 160);

/** What each app does (slug → "Firecrawl: turns websites into…"), from this folder's copy: never waits. */
export function platformBlurbs(cwd) {
  const hit = platformCache[scopeKey(cwd)];
  if (!hit?.data?.length || Date.now() - hit.at > DAY) listPlatforms(cwd).catch(() => {});
  return Object.fromEntries((hit?.data || []).map(p => [p.platform, p.about || p.category || '']));
}

const connCache = new Map(); // cwd -> {at, data}

/** List connections for a scope folder. Cached for 5 minutes unless force. */
export async function listConnections(cwd, { force = false } = {}) {
  const hit = connCache.get(cwd);
  if (!force && hit && Date.now() - hit.at < 5 * 60_000) return hit.data;
  // Agent mode returns only 20 by default; ask for all of them.
  let res = await one(['list', '--limit', '1000'], { cwd });
  if (res.total > (res.connections || []).length) res = await one(['list', '--limit', String(res.total)], { cwd });
  const data = (res.connections || []).map(c => ({
    key: c.key,
    platform: c.platform,
    name: c.name || c.platform,
    state: c.state,
    access: c.access?.policy || 'full',
    source: 'one',
  }));
  connCache.set(cwd, { at: Date.now(), data });
  return data;
}

export async function whoami(cwd) {
  try { return await one(['whoami'], { cwd, timeoutMs: 30_000 }); } catch (e) { return { error: e.message }; }
}

/** Look up an action's method/title (for approval decisions). */
export async function describeAction(cwd, actionId) {
  try {
    const res = await one(['actions', 'load', actionId, '--toc'], { cwd, timeoutMs: 30_000 });
    const text = typeof res.raw === 'string' ? res.raw : JSON.stringify(res);
    const method = text.match(/"method"\s*:\s*"([A-Z]+)"/)?.[1] || text.match(/\b(GET|POST|PUT|PATCH|DELETE)\b/)?.[1] || null;
    const title = text.match(/"title"\s*:\s*"([^"]+)"/)?.[1] || text.match(/^#\s+(.+)$/m)?.[1] || null;
    const platform = text.match(/"platform"\s*:\s*"([^"]+)"/)?.[1] || null;
    return { method, title, platform };
  } catch {
    return { method: null, title: null };
  }
}
