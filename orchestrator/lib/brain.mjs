// Orchy's brain: the harness Orchy thinks with when he answers by himself (chat replies, report-backs, the greeting,
// the weekly usage review) and, when Jev is off, the one that reads each message to route it (router.mjs).
// Claude Code when it is installed (orchy.mjs keeps its session memory and the Uploads reads); otherwise the first
// harness this PC has: Codex, OpenCode, Hermes. ORCHY_BRAIN=claude|codex|opencode|hermes picks one, =off none.
//
// Every brain runs on the harness's DEFAULT profile (the owner's own sign-in, as Orchy's Claude replies always did),
// in an empty folder of its own, and is text-only: it answers from what the prompt tells it.
//   claude    quickClaude with no tools (`--tools ""`)
//   codex     codex app-server, read-only sandbox, every approval declined, any tool it starts stops the turn
//   opencode  opencode serve with every tool on "ask", every ask refused, any tool it starts stops the turn
//   hermes    `hermes chat --oneshot --safe-mode -t todo` (no files, shell, MCP, plugins or hooks; checked on 0.21.7)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { env, DATA_DIR } from './env.mjs';
import { engine, engineHealth } from './engines/index.mjs';
import { quickClaude } from './claude.mjs';
import { launchCodexRun } from './codex.mjs';
import { launchOpenCodeRun } from './engines/opencode-run.mjs';
import { buildOpenCodeConfig } from './engines/opencode-config.mjs';
import { hermesEnv } from './engines/hermes.mjs';
import { SYSTEM, FENCE, buildSchema, mapAnswers } from './jev.mjs';

export const BRAIN_ORDER = ['claude', 'codex', 'opencode', 'hermes'];

const NO_TOOLS = 'You have no tools here, and you need none: answer only from the text you are given. Never try to read files, run commands, search the web or call a tool. If something you would need is missing, say so in one short line.';

/** The harness Orchy thinks with: its engine id, or null (none that runs here, or ORCHY_BRAIN=off). */
export function brainEngine() {
  const pick = String(env('ORCHY_BRAIN') || '').trim().toLowerCase();
  if (pick === 'off' || pick === 'none') return null;
  // one that is there but won't start (an install that didn't finish) is passed over for the next that runs
  const runs = id => engineHealth(engine(id)) === 'ok';
  if (BRAIN_ORDER.includes(pick)) return runs(pick) ? pick : null;
  return BRAIN_ORDER.find(runs) || null;
}

/** "Codex", "Hermes"…, or null. */
export const brainLabel = (id = brainEngine()) => (id ? engine(id)?.label || id : null);

/** An empty folder the brain starts in, so nothing it might look at is anyone's work. */
function emptyDir() {
  const d = path.join(DATA_DIR, 'brain', 'empty');
  fs.mkdirSync(d, { recursive: true });
  for (const f of fs.readdirSync(d)) fs.rmSync(path.join(d, f), { recursive: true, force: true });
  return d;
}

const noBrain = () => Object.assign(new Error('No agent harness is installed on this PC, so Orchy has nothing to think with. Install one: Settings → Set up Orchy → Tools.'), { code: 'NO_BRAIN' });

/**
 * One text-only answer from the brain. Returns { text, via }. `system` goes first; `model` only reaches Claude
 * (the others use the model their own config picks).
 */
export async function brainThink({ prompt, system = '', model = 'haiku', timeoutMs = 120_000, purpose = 'orchy', workspace = null, via = brainEngine() } = {}) {
  if (!via) throw noBrain();
  const sys = [system, NO_TOOLS].filter(Boolean).join('\n\n');
  if (via === 'claude') {
    const r = await quickClaude({ prompt: `${sys}\n\n${prompt}`, model, cwd: emptyDir(), tools: '', timeoutMs, purpose, workspace, sessionId: crypto.randomUUID() });
    return { text: r.text, via };
  }
  if (via === 'hermes') return { text: await viaHermes(sys, prompt, timeoutMs), via };
  return { text: await viaServer(via, sys, prompt, timeoutMs), via };
}

/** quickClaude's shape ({prompt, model, timeoutMs, purpose} → {text}) for callers that took quickClaude before. */
export const brainQuick = async opts => ({ text: (await brainThink(opts)).text });

/** The first JSON object in a reply (a harness may wrap it in a code fence or a sentence). */
export function firstJson(text) {
  const s = String(text || '').trim().replace(FENCE, '');
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) try { return JSON.parse(s.slice(a, b + 1)); } catch {}
  return null;
}

/**
 * Jev's questions answered by the brain, when Jev is off (router.mjs): the same chat emulation the OpenRouter and
 * OpenCode Zen providers use (jev.mjs), through a harness. Same return shape as jev.ask(), with via 'harness:<id>'.
 */
export async function askViaHarness(state, questions, { purpose = 'routing', timeoutMs = 90_000, via = brainEngine(), think = brainThink } = {}) {
  if (!via) throw noBrain();
  const t0 = Date.now();
  const prompt = `${JSON.stringify({ state, questions })}\n\nThe JSON schema your answer must match:\n${JSON.stringify(buildSchema(questions))}\n\nReply with the JSON object only.`;
  const { text } = await think({ prompt, system: SYSTEM, model: 'haiku', timeoutMs, purpose: `jev-${purpose}`, via });
  const parsed = firstJson(text);
  if (!parsed || typeof parsed !== 'object') throw new Error(`${brainLabel(via)} did not answer the routing questions as JSON`);
  return { model: brainLabel(via), answers: mapAnswers(questions, parsed), ms: Date.now() - t0, via: `harness:${via}` };
}

// Codex and OpenCode: the run adapters Orchy already drives, with a gate that refuses everything
function viaServer(id, system, prompt, timeoutMs) {
  return new Promise((resolve, reject) => {
    let handle = null, settled = false;
    const finish = (err, text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) { Promise.resolve().then(() => handle?.stop?.()).catch(() => {}); reject(err); } else resolve(text);
    };
    const timer = setTimeout(() => finish(new Error(`Orchy took too long to think (${brainLabel(id)})`)), timeoutMs);
    const label = brainLabel(id);
    const hooks = {
      // a tool started without asking (Codex's own read commands): this brain is text-only, so the answer is dropped
      record: evt => { if (evt.kind === 'tool') finish(new Error(`${label} tried to use a tool while answering, so Orchy stopped it.`)); },
      started: () => {},
      gate: async () => ({ allow: false, reason: 'Orchy answers from what he was told: no tools here.' }),
      ask: async () => ({}),
      usage: () => {}, cost: () => {},
      done: ({ code, error, resultText }) => (code === 0 && resultText ? finish(null, resultText) : finish(new Error(error || `${label} gave no answer`))),
    };
    const cwd = emptyDir();
    if (id === 'codex') {
      handle = launchCodexRun({ cwd, codexHome: null, prompt, developerInstructions: system, mcpServers: {}, sandbox: 'read-only' }, hooks);
    } else if (id === 'opencode') {
      const runDir = path.join(DATA_DIR, 'brain', `opencode-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
      handle = launchOpenCodeRun({
        cwd, bin: engine('opencode').bin(), profileEnv: {}, runDir, config: buildOpenCodeConfig({ servers: {}, allowed: [], bridge: null }),
        model: 'default', prompt, system, title: 'Orchy',
        cleanup: () => { try { fs.rmSync(runDir, { recursive: true, force: true }); } catch {} },
      }, hooks);
    } else finish(new Error(`${id} can't be Orchy's brain`));
  });
}

// Hermes: one question on stdin, the answer on stdout. --safe-mode drops the owner's config, plugins, MCP servers
// and rules; -t todo leaves only its task list (no files, no shell, no web).
export const HERMES_BRAIN_ARGS = ['chat', '--query-file', '-', '-Q', '--oneshot', '-t', 'todo', '--safe-mode', '--source', 'tool', '--max-turns', '3'];
function viaHermes(system, prompt, timeoutMs) {
  const bin = engine('hermes').bin();
  return new Promise((resolve, reject) => {
    const shell = /\.(cmd|bat)$/i.test(bin);
    const child = spawn(shell ? `"${bin}"` : bin, HERMES_BRAIN_ARGS, { cwd: emptyDir(), env: hermesEnv(null), windowsHide: true, shell, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { child.kill(); reject(new Error('Orchy took too long to think (Hermes)')); }, timeoutMs);
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('error', e => { clearTimeout(t); reject(e); });
    child.on('close', code => {
      clearTimeout(t);
      const text = out.split(/\r?\n/).filter(l => !/^session_id:\s/.test(l)).join('\n').trim();
      if (text) return resolve(text);
      reject(new Error(err.trim().split(/\r?\n/).slice(-3).join(' ') || `Hermes exited with code ${code}`));
    });
    child.stdin.end(`${system}\n\n${prompt}`);
  });
}
