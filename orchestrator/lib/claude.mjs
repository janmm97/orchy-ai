// Spawning Claude Code with the right account per workspace.
// Each workspace can pin its own CLAUDE_CONFIG_DIR (one Claude account per workspace); the default is ~/.claude.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { env, expandPath } from './env.mjs';

/** Standard install folders for CLI tools on this OS (npm globals, Homebrew, ~/.local/bin). Finder/Dock launches have a minimal PATH, so macOS needs these. */
export function standardBinDirs() {
  const home = os.homedir();
  if (process.platform === 'win32') return [process.env.APPDATA && path.join(process.env.APPDATA, 'npm'), path.join(home, '.local', 'bin')].filter(Boolean);
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin')];
  if (process.platform === 'darwin') dirs.push(path.join(home, '.claude', 'local'));
  return dirs;
}

/** Find a command: PATH first, then the standard folders and `extraPaths`. Returns an absolute path or null. */
export function findBinary(name, extraPaths = []) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = [...(process.env.PATH || '').split(path.delimiter), ...standardBinDirs(), ...extraPaths].filter(Boolean);
  for (const d of dirs) for (const x of exts) {
    const p = path.join(d, name + x);
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

/** `<bin> --version` with a short timeout. Returns the version line, or null when the binary doesn't run. */
export function probeVersion(bin, args = ['--version'], timeoutMs = 5000) {
  if (!bin) return null;
  try {
    const shell = /\.(cmd|bat)$/i.test(bin);
    const r = shell
      ? spawnSync(`"${bin}" ${args.join(' ')}`, { shell: true, timeout: timeoutMs, windowsHide: true, encoding: 'utf8' })
      : spawnSync(bin, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' });
    if (r.error || r.status !== 0) return null;
    return (r.stdout || r.stderr || '').trim().split(/\r?\n/)[0] || 'ok';
  } catch { return null; }
}

function resolveClaude() {
  const explicit = env('CLAUDE_CLI_PATH');
  if (explicit && fs.existsSync(explicit)) return explicit;
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const found = findBinary('claude', [path.join(os.homedir(), '.local', 'bin')]);
  if (found) return found;
  const local = path.join(os.homedir(), '.local', 'bin', exe);
  if (fs.existsSync(local)) return local;
  return 'claude'; // not found: spawn may still work through PATH; claudeAvailable() tells the truth
}
export const CLAUDE_BIN = resolveClaude();

let claudeProbe = null;
/** Does Claude Code really run here? `--version`, cached (a failure is retried after a minute). */
export function claudeVersion() {
  if (!claudeProbe || (!claudeProbe.version && Date.now() - claudeProbe.at > 60_000)) claudeProbe = { at: Date.now(), version: probeVersion(CLAUDE_BIN) };
  return claudeProbe.version;
}
export const claudeAvailable = () => !!claudeVersion();

// names of variables that hold secrets: a client's run never gets them (it could print its environment)
const SECRET_VAR = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE|CERT)/i;

/** A clean env for a child Claude Code: strip this process's Claude session vars, pin the profile. */
export function claudeEnv(configDir, extra = {}, { noSecrets = false } = {}) {
  const e = { ...process.env };
  for (const k of Object.keys(e)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_CONFIG_DIR' || k === 'ANTHROPIC_API_KEY' || k.startsWith('CLAUDE_AGENT_SDK')) delete e[k];
    else if (noSecrets && SECRET_VAR.test(k)) delete e[k];
  }
  if (configDir) e.CLAUDE_CONFIG_DIR = expandPath(configDir);
  return { ...e, ...extra };
}

// A .cmd only runs through cmd.exe, which re-reads its arguments: quote each one for the program, then escape
// cmd's own characters twice (the npm shim passes them through a second cmd line), as cross-spawn does.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
const cmdArg = a => `"${String(a).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`.replace(CMD_META, '^$1').replace(CMD_META, '^$1');

export function spawnClaude(args, { cwd, configDir, extraEnv, noSecrets = false } = {}) {
  const shell = /\.(cmd|bat)$/i.test(CLAUDE_BIN);
  return spawn(shell ? [`"${CLAUDE_BIN}"`, ...args.map(cmdArg)].join(' ') : CLAUDE_BIN, shell ? [] : args, {
    cwd,
    env: claudeEnv(configDir, extraEnv, { noSecrets }),
    windowsHide: true,
    shell,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

const authCache = new Map();

/** Which account is a profile logged into? Cached 60s (`maxAge` asks for a fresher answer). */
export function authStatus(configDir, { force = false, maxAge = 60_000 } = {}) {
  const key = configDir || '(default)';
  const hit = authCache.get(key);
  if (!force && hit && Date.now() - hit.at < maxAge) return Promise.resolve(hit.data);
  if (configDir) fs.mkdirSync(expandPath(configDir), { recursive: true });
  return new Promise(resolve => {
    const child = spawnClaude(['auth', 'status', '--json'], { configDir });
    let out = '';
    const t = setTimeout(() => child.kill(), 20_000);
    child.stdout.on('data', d => (out += d));
    child.on('error', e => { clearTimeout(t); resolve({ loggedIn: false, error: e.message }); });
    child.on('close', () => {
      clearTimeout(t);
      let data;
      try { data = JSON.parse(out); } catch { data = { loggedIn: false, error: out.trim().slice(0, 300) || 'no output' }; }
      authCache.set(key, { at: Date.now(), data });
      resolve(data);
    });
    child.stdin.end();
  });
}

/**
 * One-shot Claude call (for Orchy's own replies). Returns {text, sessionId, costUsd}.
 * Tool-less unless `tools` names some (e.g. 'Read'); they never ask, so reads outside `cwd` are refused.
 */
export function quickClaude({ prompt, systemFile, model = 'haiku', cwd, resume, sessionId, tools = '', timeoutMs = 120_000, configDir }) {
  const args = ['-p', '--output-format', 'json', '--model', model, '--tools', tools, '--strict-mcp-config', '--disable-slash-commands'];
  if (tools) args.push('--permission-mode', 'dontAsk');
  if (systemFile) args.push('--append-system-prompt-file', systemFile);
  if (resume) args.push('--resume', resume);
  else if (sessionId) args.push('--session-id', sessionId);
  return new Promise((resolve, reject) => {
    const child = spawnClaude(args, { cwd, configDir });
    let out = '', err = '';
    const t = setTimeout(() => { child.kill(); reject(new Error('Orchy took too long to think')); }, timeoutMs);
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('error', e => { clearTimeout(t); reject(e); });
    child.on('close', code => {
      clearTimeout(t);
      try {
        const j = JSON.parse(out);
        if (j.is_error) return reject(new Error(j.result || 'Claude returned an error'));
        resolve({ text: (j.result || '').trim(), sessionId: j.session_id, costUsd: j.total_cost_usd });
      } catch {
        reject(new Error((err || out || `claude exited ${code}`).trim().slice(0, 600)));
      }
    });
    child.stdin.end(prompt);
  });
}
