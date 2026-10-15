// How much Jev's action plan saves: lookup turns (`one actions find`/`load`, `one list`) and time to the
// first `actions execute`, for runs with a plan vs without, plus Jev's own call times by purpose.
//   node orchestrator/scripts/jev-metrics.mjs [--since 2026-10-09] [--ws one]
// Reads data/state.json, data/runs/*.jsonl and data/jev-calls.jsonl; writes nothing.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../lib/env.mjs';

const arg = (name, d = null) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const since = arg('since', '2000-01-01');
const wsOnly = arg('ws');

const state = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'state.json'), 'utf8'));
const LOOKUP = /\bone(?:\s+--agent)?\s+(?:(?:actions|a)\s+(?:find|load|search|knowledge)|list|guide)\b/;
const EXEC = /\bone(?:\s+--agent)?\s+(?:actions|a)\s+execute\b/;

function events(id) {
  const p = path.join(DATA_DIR, 'runs', `${id}.jsonl`);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function measure(run) {
  const evs = events(run.id);
  const tools = evs.filter(e => e.kind === 'tool');
  const cmd = e => String(e.input?.command || '');
  // calls within 1.5s of each other are one turn (parallel tool use)
  let lookupTurns = 0, last = 0, turnHasOther = false, turnHasLookup = false;
  const close = () => { if (turnHasLookup && !turnHasOther) lookupTurns++; turnHasLookup = turnHasOther = false; };
  for (const e of tools) {
    const t = Date.parse(e.t);
    if (t - last > 1500) close();
    last = t;
    if (LOOKUP.test(cmd(e))) turnHasLookup = true; else turnHasOther = true;
  }
  close();
  const firstExec = tools.find(e => EXEC.test(cmd(e)));
  return {
    lookupTurns,
    lookups: tools.filter(e => LOOKUP.test(cmd(e))).length,
    toFirstExec: firstExec ? (Date.parse(firstExec.t) - Date.parse(run.startedAt)) / 1000 : null,
    turns: run.numTurns ?? null,
    secs: run.durationMs != null ? run.durationMs / 1000 : null,
    cost: run.costUsd ?? null,
  };
}

const median = xs => { const v = xs.filter(x => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
const mean = xs => { const v = xs.filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const f = (x, d = 1) => x == null ? '–' : Number(x).toFixed(d);

const runs = Object.values(state.runs).filter(r => r.endedAt && r.startedAt >= since && !r.isBuilder && (!wsOnly || r.workspace === wsOnly));
const groups = new Map();
for (const r of runs) {
  const m = measure(r);
  if (m.lookups === 0 && m.toFirstExec == null) continue; // runs that never touched One say nothing either way
  const key = `${r.plan?.status === 'planned' ? 'with plan' : 'no plan'} · ${r.agentSlug ? 'specialist' : 'generalist'}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(m);
}

console.log(`Runs that used One since ${since}${wsOnly ? ` in ${wsOnly}` : ''}\n`);
console.log(['group'.padEnd(26), 'runs', 'lookup turns (avg)', 's to 1st execute (median)', 'turns (median)', 'minutes (median)', '$ (median)'].join(' | '));
for (const [k, ms] of [...groups].sort()) {
  console.log([k.padEnd(26), String(ms.length).padStart(4), f(mean(ms.map(m => m.lookupTurns)), 2).padStart(18), f(median(ms.map(m => m.toFirstExec))).padStart(25), f(median(ms.map(m => m.turns)), 0).padStart(14), f(median(ms.map(m => (m.secs == null ? null : m.secs / 60)))).padStart(16), f(median(ms.map(m => m.cost)), 2).padStart(10)].join(' | '));
}

const callsFile = path.join(DATA_DIR, 'jev-calls.jsonl');
if (fs.existsSync(callsFile)) {
  const calls = fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(c => c && c.t >= since);
  const by = new Map();
  for (const c of calls) { if (!by.has(c.purpose)) by.set(c.purpose, []); by.get(c.purpose).push(c); }
  console.log(`\nJev calls since ${since}`);
  for (const [p, cs] of by) {
    const ok = cs.filter(c => c.ok);
    console.log(`  ${String(p).padEnd(12)} ${String(cs.length).padStart(4)} calls · ${cs.length - ok.length} failed · median ${ok.length ? `${f(median(ok.map(c => c.ms)), 0)}ms` : '–'} · input tokens ${ok.reduce((a, c) => a + (c.usage?.input_tokens || 0), 0).toLocaleString()}`);
  }
}
