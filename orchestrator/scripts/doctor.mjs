// Health check: `npm run check`. Verifies everything Orchy needs, in plain words.
import fs from 'node:fs';
import path from 'node:path';
import { config, env, ROOT, ORCH_DIR } from '../lib/env.mjs';
import { workspaces, accountCheck, oneScope, listRetired } from '../lib/workspaces.mjs';
import { listConnections, one, oneVersion } from '../lib/one.mjs';
import { jevMode, jevLabel, models, PROVIDERS } from '../lib/jev.mjs';
import { CLAUDE_BIN, claudeVersion } from '../lib/claude.mjs';
import { engines, engineTools, brokenMessage } from '../lib/engines/index.mjs';
import { listAgents } from '../lib/agents.mjs';
import { clients, clientBase, CLIENT_PORT } from '../lib/clients.mjs';
import { ffBins } from '../lib/media.mjs';

let failed = 0;
const ok = (m) => console.log(`  ✔ ${m}`);
const bad = (m, fix) => { failed++; console.log(`  ✘ ${m}${fix ? `\n      → ${fix}` : ''}`); };
const off = (m) => console.log(`  · ${m}`);
const warn = (m, fix) => console.log(`  ! ${m}${fix ? `\n      → ${fix}` : ''}`);

console.log('\nOrchy health check\n');
console.log('System');
Number(process.versions.node.split('.')[0]) >= 20 ? ok(`Node ${process.version}`) : bad(`Node ${process.version} is too old`, 'Orchy needs Node 20 or newer: https://nodejs.org');
fs.existsSync(path.join(ORCH_DIR, 'config.json')) ? ok('config.json present') : off('No config.json yet (Orchy creates it the first time it starts)');
{
  const ff = ffBins();
  ff ? ok(`ffmpeg: ${ff.ffmpeg} (thumbnails, video posters and playable copies in the file viewer)`)
    : off('ffmpeg: not found (optional: files still open; install it for thumbnails, video posters and playable copies, or set FFMPEG_PATH)');
}

console.log('\nAgent harnesses (at least one is needed)');
// every engine the registry knows: found / version / install command / gated
const cv = claudeVersion();
const harness = engineTools().map(t => {
  const e = engines().find(x => x.id === t.id);
  const v = e.available() ? e.version() : null;
  return { ...t, v, broken: !v && e.available() ? brokenMessage(e) : null };
});
for (const h of harness) {
  const gate = h.gated ? 'approvals: yes' : 'approvals: NO, runs only where the workspace sets allowUngated';
  h.v ? ok(`${h.label}: ${h.v} [${gate}]`) : h.broken ? warn(h.broken) : off(`${h.label}: not found${h.optional ? ' (optional)' : ''}. Install: ${h.install} [${gate}]`);
}
if (!harness.some(h => h.v)) bad('No agent harness found', harness[0].install);
else if (cv) off(`Claude Code runs from ${CLAUDE_BIN}`);


console.log('\nOne CLI');
const oneV = oneVersion();
if (!oneV) warn('One CLI not found. It connects agents to Gmail, Slack, Notion and 1000+ apps (strongly recommended)', 'npm install -g @withone/cli (then open a new terminal). Guide: docs/ONE.md');
else {
  ok(`One CLI ${oneV}`);
  try {
    const w = await one(['whoami'], { cwd: ROOT, timeoutMs: 20_000 });
    const who = w.email || w.user?.email || w.organization?.name || w.org?.name || w.raw;
    who ? ok(`whoami (in this folder): ${typeof who === 'string' ? who.split('\n')[0] : JSON.stringify(who)}`) : off('whoami answered, but with no account name');
  } catch (e) { warn(`whoami failed: ${e.message.split('\n')[0]}`, 'Sign in at https://app.withone.ai/sign-in, then Orchy → Workspaces → your workspace → Sign in to One'); }
}

console.log('\nAccounts (must never mix)');
for (const ws of workspaces()) {
  // its own engine, plus any engine one of its agents pins (e.g. a Codex designer in a Claude workspace)
  const pinned = listAgents(ws.id).filter(x => x.engine && x.engine !== ws.runtime);
  for (const rt of [ws.runtime, ...new Set(pinned.map(x => x.engine))]) {
    const a = await accountCheck(ws, { force: true, runtime: rt });
    const forWho = rt === ws.runtime ? '' : ` for ${pinned.filter(x => x.engine === rt).map(x => x.displayName).join(', ')}`;
    const tag = `${ws.name} [${a.runtimeLabel}${forWho}]${ws.enabled ? '' : ' (switched off)'}`;
    if (a.ok) ok(`${tag} → ${a.actual}${a.sandbox && a.sandbox !== 'ready' ? ` · Windows sandbox ${a.sandbox}: every command goes through Orchy approvals` : ''}`);
    else bad(`${tag} needs ${a.expected || 'an account'} (now: ${a.actual || 'not logged in'})`, a.error && /install|account set/i.test(a.error) ? a.error : `In PowerShell: ${a.fix}${a.fixAlt ? `\n      → ${a.fixAlt}` : ''}`);
  }
}

console.log('\nOne connections per folder');
try { const c = await listConnections(ROOT, { force: true }); ok(`Orchestrator (root): ${c.length} connections`); }
catch (e) { off(`Orchestrator (root): ${e.message.split('\n')[0]} (only needed for Orchy's own One use)`); }
for (const ws of workspaces()) {
  if (!oneScope(ws).own) { bad(`${ws.name}: not signed in to its own One account (One is blocked there until it is)`, `Workspaces → ${ws.name} → Sign in to One`); continue; }
  try { const c = await listConnections(ws.dir, { force: true }); ok(`${ws.name}: ${c.length} connections`); }
  catch (e) { bad(`${ws.name}: ${e.message}`, 'Run `one init --auth browser --project` in that folder (Workspaces → Sign in to One)'); }
}
for (const r of listRetired()) off(`${r.name}: retired ${String(r.retiredAt).slice(0, 10)} → Retired/${r.archivedFolder}${r.dirExists ? '' : ' (folder missing)'}`);

console.log('\nRouting (Jev)');
const mode = jevMode();
if (mode === 'none') {
  const named = String(env('JEV_PROVIDER') || '').trim().toLowerCase();
  if (named && named !== 'off') bad(`JEV_PROVIDER is "${named}", but its key isn't set: Jev is off`, 'Run npm run setup, or add the key in Settings');
  else warn('Jev is off: routing uses keywords only', 'Run npm run setup to add a TypeSafe, OpenRouter, Vercel AI Gateway or OpenCode Zen key');
} else if (PROVIDERS[mode].native) {
  try { const m = await models(); ok(`Jev reachable via ${jevLabel()} · models: ${(m.models || []).map(x => x.name || x.id).join(', ')}`); }
  catch (e) { bad(`Jev unreachable: ${e.message}`, `Check ${PROVIDERS[mode].key} in .env`); }
} else ok(`Jev via ${jevLabel()} (chat emulation)`);

console.log('\nVoice');
if (/^(0|false|off|no)$/i.test(String(env('VOICE_ENABLED', '1')).trim())) off('Voice is switched off: chat only (Settings → Voice, or VOICE_ENABLED in .env)');
else if (env('DEEPGRAM_API_KEY')) ok('Deepgram key set (backup voice)');
else off('No DEEPGRAM_API_KEY: no backup voice if ElevenLabs fails (optional; add it in Settings)');
if (/^(0|false|off|no)$/i.test(String(env('VOICE_ENABLED', '1')).trim())) { /* voice off: nothing to check */ }
else if (env('ELEVENLABS_API_KEY')) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${env('ELEVENLABS_VOICE_ID', '21m00Tcm4TlvDq8ikWAM')}?output_format=mp3_22050_32`, {
    method: 'POST', headers: { 'xi-api-key': env('ELEVENLABS_API_KEY'), 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'ok', model_id: env('ELEVENLABS_MODEL', 'eleven_flash_v2_5') }),
  }).catch(e => ({ ok: false, status: e.message }));
  r.ok ? ok('ElevenLabs can speak (voice)') : bad(`ElevenLabs refused (${r.status})`, 'elevenlabs.io → Developers → API keys → edit the key → enable "Text to Speech" and "Voices: Read". Deepgram Aura speaks meanwhile.');
} else off('No ELEVENLABS_API_KEY: voice is optional (Deepgram Aura or the browser voice speaks instead)');

console.log('\nAgents');
for (const a of listAgents()) (a.error ? bad : ok)(`${a.workspace} · ${a.displayName}${a.scheduleText ? ` · ${a.scheduleText}` : ''}${a.error ? ` · PROBLEM: ${a.error}` : ''}`);

console.log('\nClient pages');
const base = clientBase();
for (const c of clients()) {
  const tag = `${c.name} → ${c.agents.join(', ')} in ${c.workspace}${c.enabled === false ? ' (switched off)' : ''}`;
  if (!c.email && /^https:/.test(base)) bad(`${tag}: no email, so Cloudflare Access can't be matched to them`, `Workspaces → ${c.workspace} → Client access → Edit`);
  else ok(tag);
}
if (!clients().length) off('No client links yet (Workspaces → a workspace → Client access)');
/^https:/.test(base) ? ok(`Online at ${base} (port ${CLIENT_PORT()})`) : off(`Only on this PC: ${base}. README → Client pages puts them online.`);

console.log(`\nDashboard: http://localhost:${env('PORT', '8008')}  ·  timezone ${config.timezone}${failed ? `  ·  ${failed} problem${failed === 1 ? '' : 's'} above` : ''}\n`);
process.exit(failed ? 1 : 0);
