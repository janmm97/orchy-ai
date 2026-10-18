// Small helpers the engine modules share (quoting for pasteable login commands, process-tree kill).
import { spawn } from 'node:child_process';
import { expandPath } from '../env.mjs';

// a PowerShell single-quoted string: nothing in it runs ($(…), backticks, ;). PowerShell also closes one at a
// curly quote, so those are doubled too.
export const psq = s => `'${String(s ?? '').replace(/['‘’‚‛]/g, '$&$&')}'`;
/** A POSIX single-quoted string: everything literal (a ' inside becomes '\'', the usual close, escaped quote, reopen). */
export const sq = s => `'${String(s ?? '').replace(/'/g, `'\\''`)}'`;

/**
 * A command line a harness runs through its own shell (a hook): POSIX single quotes on macOS and Linux; on Windows
 * double quotes and forward slashes, which Git Bash, cmd and Claude Code's hook runner all read the same way.
 */
export function shellLine(parts, win = process.platform === 'win32') {
  return parts.map(p => (win ? `"${String(p ?? '').replace(/\\/g, '/').replace(/"/g, '')}"` : sq(p))).join(' ');
}

/** The env assignments that pick a profile, as a prefix for a pasteable command (PowerShell on Windows, POSIX elsewhere). */
export function envPrefix(vars, win = process.platform === 'win32') {
  const entries = Object.entries(vars || {});
  if (!entries.length) return '';
  return win ? entries.map(([k, v]) => `$env:${k}=${psq(v)}; `).join('') : entries.map(([k, v]) => `${k}=${sq(v)} `).join('');
}

/** Expand `%VAR%` / `~` in a profile folder. */
export const profilePath = p => (p ? expandPath(p) : p);

/** Kill a child and everything it started (taskkill on Windows, SIGTERM elsewhere). */
export function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
    else child.kill('SIGTERM');
  } catch {}
}

// credentials come from the workspace's profile only: drop the PC's own provider keys so two workspaces never share one
const SECRETISH = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD|_ACCESS_KEY_ID|_SECRET_ACCESS_KEY)$/i;
/** A child's environment: the PC's env minus secret-looking variables and `dropPrefixes`/`dropNames`, plus the profile variables and `extra`. */
export function scrubbedEnv(profileEnv, extra = {}, { dropPrefixes = [], dropNames = [] } = {}, base = process.env) {
  const e = { ...base };
  for (const k of Object.keys(e)) {
    if (SECRETISH.test(k) || dropNames.includes(k) || dropPrefixes.some(p => k.startsWith(p)) || k === 'CLAUDECODE' || k === 'GOOGLE_APPLICATION_CREDENTIALS' || k === 'AWS_PROFILE') delete e[k];
  }
  return { ...e, ...profileEnv, ...extra };
}
