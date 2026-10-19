// First-run setup guide: which tools are installed here, and the commands to install the missing ones.
// Probes run asynchronously with a short timeout and are cached for 30 seconds, so the dashboard never waits on them for long.
import { execFile } from 'node:child_process';
import { engines, engineTools, engineRepairCmd, runRefusal } from './engines/index.mjs';
import { findBinary } from './claude.mjs';

const win = process.platform === 'win32', mac = process.platform === 'darwin';
const TTL = 30_000, TIMEOUT = 4000;

/** `<bin> --version`, async, never longer than TIMEOUT. Resolves to the first output line or null. */
function probe(bin, args = ['--version']) {
  return new Promise(resolve => {
    if (!bin) return resolve(null);
    const done = (err, out, errOut) => resolve(err ? null : String(out || errOut || '').trim().split(/\r?\n/)[0] || 'ok');
    try {
      // a .cmd shim needs a shell; one command line (the arguments are fixed words), so Node 24 has no args to warn about
      if (/\.(cmd|bat)$/i.test(bin)) execFile(`"${bin}" ${args.join(' ')}`, [], { shell: true, timeout: TIMEOUT, windowsHide: true }, done);
      else execFile(bin, args, { timeout: TIMEOUT, windowsHide: true }, done);
    } catch { resolve(null); }
  });
}

const NODE_INSTALL = win ? 'winget install OpenJS.NodeJS.LTS' : mac ? 'brew install node' : 'Install Node 20+ from https://nodejs.org (or your package manager)';

const NOTES = {
  node: { required: true, note: 'Orchy itself runs on Node 20 or newer.' },
  one: { required: false, recommended: true, note: 'Recommended: One connects your agents to Gmail, Slack, Notion and 1000+ other apps. Without it agents can still work with files and the web, but not your apps.' },
};
const ONE_INSTALL = 'npm install -g @withone/cli';

/** The engine's own binary, from the registry (the same lookup the server uses to run it). */
const locate = id => (id === 'one' ? findBinary('one') : engines().find(e => e.id === id)?.bin() || null);

let cache = null, inflight = null;
export async function toolStatus({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < TTL) return cache.tools;
  if (inflight) return inflight;
  inflight = (async () => {
    const list = [{ id: 'node', label: 'Node.js', kind: 'runtime', install: NODE_INSTALL }, ...engineTools(), { id: 'one', label: 'One CLI', kind: 'one', install: ONE_INSTALL }];
    const tools = await Promise.all(list.map(async t => {
      let version = t.id === 'node' ? process.version : await probe(locate(t.id));
      if (t.id === 'one' && !version) version = await probe(win ? 'one.cmd' : 'one') ; // PATH-only shims
      const n = NOTES[t.id] || {};
      // a harness whose program is there but won't start (an install that didn't finish) shows what finishes it
      const e = !version && t.kind === 'harness' ? engines().find(x => x.id === t.id) : null;
      const broken = !!e?.available();
      return { id: t.id, label: t.label, kind: t.kind || 'harness', found: !!version, version: version || null, broken, repairCmd: broken ? engineRepairCmd(e) || null : null, installCmd: t.install, required: !!n.required, recommended: !!n.recommended, note: n.note || t.note || '', gated: t.gated ?? null,
        // found, but a version Orchy won't run (OpenCode 2): why, and the way to one it does
        refusal: version && t.kind === 'harness' ? runRefusal(engines().find(x => x.id === t.id)) : null };
    }));
    cache = { at: Date.now(), tools };
    return tools;
  })().finally(() => { inflight = null; });
  return inflight;
}
