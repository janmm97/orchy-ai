// The pre-tool hook Antigravity (agy) and Hermes run before every tool call: it hands the call to Orchy's approval gate
// (POST /api/bridge/tool-hook) and answers the harness allow or deny. Fail closed: no answer from Orchy, a run it
// doesn't know, or anything unreadable is a deny (and a non-zero exit, which both harnesses also treat as a block).
//   node tool-hook.mjs <antigravity|hermes> <credentials file>
// The credentials file (written by Orchy, in its data folder, which agents can't read) holds { url, token }. The run is
// found by the session id the harness puts in every payload, so two runs sharing an agy folder or a Hermes profile
// can't be mixed up. agy waits as long as the hook takes; Hermes kills a hook after 5 minutes, so for Hermes Orchy
// answers "still waiting" a little before that and the agent tries again (the same pending approval, not a new one).
import fs from 'node:fs';
import http from 'node:http';
import { agyHookCalls, hermesHookCalls } from '../lib/engines/hookmap.mjs';

const [engine, credsFile] = process.argv.slice(2);
const MAX_WAIT = { antigravity: 6 * 3600_000, hermes: 270_000 };

// Hermes: exit 2 blocks even if the JSON were lost. agy: a deny exits 0 so the agent sees the reason (a non-zero exit
// also blocks, but agy then reports only "hook failed"); a failure of the hook itself exits 1 on both.
function answer(allow, reason = '', failed = false) {
  const why = String(reason || '').slice(0, 1000) || 'Orchy refused this.';
  if (engine === 'hermes') process.stdout.write(JSON.stringify(allow ? {} : { decision: 'block', reason: why }));
  else process.stdout.write(JSON.stringify(allow ? { decision: 'allow' } : { decision: 'deny', reason: why }));
  process.exitCode = allow ? 0 : failed ? 1 : engine === 'hermes' ? 2 : 0;
}

function post(url, token, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    // node:http, not fetch: fetch gives up on a response after 5 minutes, and an owner may take longer to answer
    const req = http.request(new URL('/api/bridge/tool-hook', url), { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'x-jos-token': token } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', d => { text += d; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(text); } catch {}
        if (res.statusCode !== 200 || !json) return reject(new Error(json?.error || `Orchy answered ${res.statusCode}`));
        resolve(json);
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', async () => {
  try {
    if (engine !== 'antigravity' && engine !== 'hermes') throw new Error(`unknown harness "${engine}"`);
    const { url, token } = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
    const payload = JSON.parse(input.replace(/^﻿/, ''));
    const { sessionId, calls } = engine === 'hermes' ? hermesHookCalls(payload) : agyHookCalls(payload);
    if (!sessionId || !calls.length) throw new Error('the harness sent no session or tool');
    const v = await post(url, token, { engine, sessionId, calls, maxWaitMs: MAX_WAIT[engine] });
    answer(v.allow === true, v.reason);
  } catch (e) {
    answer(false, `Orchy couldn't check this tool call (${String(e.message || e).slice(0, 200)}), so it is refused.`, true);
  }
});
