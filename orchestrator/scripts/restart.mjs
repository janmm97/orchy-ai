// Restarts Orchy after he fixed himself (lib/backend.mjs#restartNow starts this, then exits).
//   node orchestrator/scripts/restart.mjs <old pid>
// Waits for the old Orchy to be gone, starts the new one in the background (
// logging to data/server.log), and waits for it to answer. If it doesn't, the files the fix changed go back from
// its snapshot and Orchy starts again on the old code. The new Orchy reads data/restart-result.json and says how it went.
// Self-contained on purpose: nothing here imports Orchy's own code, which may be what's broken.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ORCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(ORCH, '..');
const DATA = path.join(ORCH, 'data');
const plan = JSON.parse(fs.readFileSync(path.join(DATA, 'restart.json'), 'utf8'));
const oldPid = Number(process.argv[2]);
const port = plan.port || 8008;
const UP_MS = 60_000;
// the new Orchy takes this restart's report only with this token (server.mjs, /api/backend/restarted)
const REPORT_TOKEN = crypto.randomBytes(24).toString('hex');
const log = (...a) => console.log(new Date().toISOString(), '[restart]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const answers = () => fetch(`http://127.0.0.1:${port}/api/voice/config`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok).catch(() => false);

function start() {
  const out = fs.openSync(path.join(DATA, 'server.log'), 'a');
  const err = fs.openSync(path.join(DATA, 'server.err.log'), 'a');
  fs.writeSync(err, `\n--- restarted ${new Date().toISOString()} (${plan.why || 'fix'}) ---\n`);
  const child = spawn(process.execPath, ['orchestrator/server.mjs', '--no-open'], { cwd: ROOT, env: { ...process.env, ORCHY_RESTART_TOKEN: REPORT_TOKEN }, detached: true, stdio: ['ignore', out, err], windowsHide: true });
  child.unref();
  return child;
}

async function comesUp(child) {
  let exited = false;
  child.on('exit', () => { exited = true; });
  for (const until = Date.now() + UP_MS; Date.now() < until && !exited;) {
    if (await answers()) return true;
    await sleep(500);
  }
  return !exited && answers();
}

function stop(child) {
  if (!child.pid || !alive(child.pid)) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGKILL');
}

function errTail() {
  try {
    const t = fs.readFileSync(path.join(DATA, 'server.err.log'), 'utf8');
    // the crash's own lines (file:line, the code, the error), not the stack frames under them
    return t.slice(t.lastIndexOf('--- restarted')).split('\n').slice(1).filter(l => l.trim() && !/^\s+at /.test(l)).slice(0, 10).join('\n').slice(0, 2000);
  } catch { return ''; }
}

/** Put the snapshot back over the files the fix changed (added ones go). */
function rollBack() {
  for (const c of plan.files || []) {
    const to = path.resolve(ROOT, c.file);
    if (!to.startsWith(ROOT + path.sep)) continue;
    if (c.change === 'added') fs.rmSync(to, { force: true });
    else { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(plan.backup, c.file), to); }
  }
}

const result = { runId: plan.runId, session: plan.session, why: plan.why, reload: !!plan.reload, ok: false, rolledBack: false, stillDown: false, error: null, at: null };

/** Tell the Orchy that's up how it went (he says it in the chat); if he can't take it, he reads the file on his next start. */
async function report(up) {
  result.at = new Date().toISOString();
  if (up) {
    const ok = await fetch(`http://127.0.0.1:${port}/api/backend/restarted`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Orchy-Restart': REPORT_TOKEN }, body: JSON.stringify(result), signal: AbortSignal.timeout(5000) })
      .then(r => r.ok).catch(() => false);
    if (ok) return;
  }
  fs.writeFileSync(path.join(DATA, 'restart-result.json'), JSON.stringify(result, null, 2));
}

try {
  for (const until = Date.now() + 30_000; alive(oldPid) && Date.now() < until;) await sleep(300);
  // a copy still answering on the port would make the new one step aside ("already running")
  for (const until = Date.now() + 10_000; (await answers()) && Date.now() < until;) await sleep(500);
  log('starting Orchy');
  let child = start();
  let up = await comesUp(child);
  if (up) {
    result.ok = true;
    log('Orchy is up');
  } else {
    result.error = errTail() || 'It didn’t answer within a minute.';
    log('Orchy did not come up:', result.error);
    stop(child);
    if (plan.backup && plan.files?.length) {
      rollBack();
      result.rolledBack = true;
      log(`rolled back ${plan.files.length} file(s), starting again`);
      child = start();
      up = await comesUp(child);
      if (!up) {
        result.stillDown = true;
        log('Orchy still did not come up after the rollback:', errTail());
      }
    }
  }
  await report(up);
} catch (e) {
  result.error = result.error || e.message;
  log('failed:', e.stack || e.message);
  await report(false);
}
