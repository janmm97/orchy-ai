// Loads .env and config.json once. No dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ORCH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = path.resolve(ORCH_DIR, '..');
export const DATA_DIR = path.join(ORCH_DIR, 'data');
export const DASHBOARD_DIR = path.join(ROOT, 'dashboard');
export const LOGS_PATH = path.join(ROOT, 'LOGS.md');

fs.mkdirSync(path.join(DATA_DIR, 'runs'), { recursive: true });

/** A file's text without a leading byte-order mark (Notepad on Windows writes one). */
export const readText = file => fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');

/** Parse a JSON file a person may have edited by hand. Throws on bad JSON. */
export const readJson = file => JSON.parse(readText(file));

/**
 * Keep a file Orchy couldn't read (name.corrupt-<time>) and say so in the terminal, so starting fresh never
 * overwrites it. Returns where it went, or null when it could be neither moved nor copied.
 */
export function setAside(file, why) {
  const stamp = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  let to = stamp;
  for (let n = 2; fs.existsSync(to); n++) to = `${stamp}-${n}`; // two in the same millisecond: never one over the other
  try { fs.renameSync(file, to); } catch { try { fs.copyFileSync(file, to); } catch { return null; } }
  console.warn(`\n  ! ${path.basename(file)} couldn't be read (${String(why || 'unknown error').slice(0, 200)}).\n    Kept it as ${to} and started fresh.\n`);
  return to;
}

export function parseEnv(text) {
  const out = {};
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

let fileEnv = {};
export function reloadEnv() {
  const p = path.join(ROOT, '.env');
  fileEnv = fs.existsSync(p) ? parseEnv(fs.readFileSync(p, 'utf8')) : {};
  return fileEnv;
}
reloadEnv();

/** Read a setting: .env wins over the process environment, so editing .env + reload is enough. */
export function env(key, fallback = '') {
  const v = fileEnv[key] ?? process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

/** Write a key into .env, preserving comments and order. */
export function setEnv(key, value) {
  const p = path.join(ROOT, '.env');
  let text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${String(value ?? '').replace(/[\r\n]+/g, '')}`; // one line; `$&` in a value stays as typed
  text = re.test(text) ? text.replace(re, () => line) : `${text.replace(/\s*$/, '')}\n${line}\n`;
  fs.writeFileSync(p, text);
  reloadEnv();
}

export function expandPath(p) {
  if (!p) return p;
  return p
    .replace(/%([^%]+)%/g, (_, k) => process.env[k] ?? `%${k}%`)
    .replace(/^~(?=$|[\\/])/, process.env.USERPROFILE || process.env.HOME || '~');
}

// First boot: no config.json yet, so start from config.example.json. Your own settings live in
// config.json, which is git-ignored.
const CONFIG_FILE = path.join(ORCH_DIR, 'config.json');
if (!fs.existsSync(CONFIG_FILE)) fs.copyFileSync(path.join(ORCH_DIR, 'config.example.json'), CONFIG_FILE);
export const config = (() => {
  try { return readJson(CONFIG_FILE); }
  catch (e) { // a plain message, not a stack trace: this is a hand-edited file, not a bug
    console.error(`\n  orchestrator/config.json isn't valid JSON (${e.message}).\n  Fix it, or delete it to start again from config.example.json.\n`);
    process.exit(1);
  }
})();

/** Who Orchy works for. Prompts and the dashboard say this name instead of a hardcoded one. */
export const ownerName = () => (config.owner?.name || '').trim() || 'the owner';

export function saveConfig() {
  fs.writeFileSync(path.join(ORCH_DIR, 'config.json'), JSON.stringify(config, null, 2) + '\n');
}
