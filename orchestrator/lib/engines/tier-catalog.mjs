// Plan / tier and model lists for Hermes Agent and OpenCode, read from what the harness itself keeps: its auth.json
// (stored plan fields, OAuth token claims), Hermes's provider model cache, and `opencode auth list` / `opencode models`.
// Nothing is guessed: an unknown plan stays null and an unknown model list stays empty (the dashboard then offers
// "default", and the harness picks).
//
// The account fence: a workspace's own profile folder is where Orchy looks for that workspace. The PC's default login
// (~/.hermes, ~/.local/share/opencode, …) is read when no profile is given (the Add window's "default" row), and for
// Hermes only, the way Hermes itself reads it: a profile inside Hermes's home with no sign-in of its own for a provider
// uses the home's auth.json for that provider (Hermes 0.21 profile mode). OpenCode keeps each profile's sign-ins apart.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import YAML from 'yaml';
import { expandPath } from '../env.mjs';
import { parseHermesStatus } from './hermes-config.mjs';
import { openCodeEnv } from './opencode-run.mjs';

const WIN = process.platform === 'win32';
const MAX_MODELS = 120; // a provider like OpenRouter lists hundreds; the dropdown keeps the first ones

/** Decode the payload of a JWT (header.payload.sig) without throwing. */
export function decodeJwtClaims(token) {
  if (typeof token !== 'string') return null;
  const parts = token.trim().split('.');
  if (parts.length < 2) return null;
  try { return JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch { return null; }
}

const PROVIDER_NAMES = {
  nous: 'Nous Portal', 'openai-codex': 'ChatGPT', openai: 'ChatGPT', anthropic: 'Claude', copilot: 'GitHub Copilot',
  'copilot-acp': 'GitHub Copilot', 'github-copilot': 'GitHub Copilot', openrouter: 'OpenRouter', xai: 'xAI', 'xai-oauth': 'xAI',
  opencode: 'OpenCode', 'opencode-go': 'OpenCode Go', 'opencode-zen': 'OpenCode Zen', google: 'Google', gemini: 'Google',
  minimax: 'MiniMax', 'minimax-oauth': 'MiniMax', 'qwen-oauth': 'Qwen',
};
const providerName = p => PROVIDER_NAMES[String(p || '').toLowerCase()] || String(p || '');
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/** What a stored credential says about its plan and owner: a plan/tier field, else its token's claims. */
export function credentialPlan(cred) {
  const c = cred && typeof cred === 'object' ? cred : {};
  const claims = decodeJwtClaims(c.access_token || c.access || c.id_token || c.token || '') || {};
  const raw = c.account_tier || c.tier || c.plan || c.subscription_type || c.subscription?.tier || c.subscription?.plan
    || (typeof c.subscription === 'string' ? c.subscription : null)
    || claims['https://api.openai.com/auth']?.chatgpt_plan_type || claims.account_tier || claims.tier || claims.plan || null;
  const tier = raw && !/^(true|active|paid)$/i.test(String(raw)) ? String(raw).toLowerCase() : c.paid_service_access === false ? 'free' : null;
  const email = c.email || c.user?.email || claims.email || claims['https://api.openai.com/profile']?.email || null;
  return { tier, email };
}
const planLabel = (provider, tier) => (provider ? `${providerName(provider)}${tier ? ` · ${cap(tier)}` : ''}` : null);

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const hasSecret = v => !!v && typeof v === 'object' && !!(v.access_token || v.refresh_token || v.access || v.refresh || v.agent_key || v.api_key || v.key || v.token);

// ── Hermes ──

/** Where to look: the workspace's own profile only, or (no profile) the PC's Hermes home. */
export function hermesHomes(profileDir) {
  if (profileDir) return [expandPath(profileDir)];
  const out = [];
  if (process.env.HERMES_HOME) out.push(expandPath(process.env.HERMES_HOME));
  if (WIN && process.env.LOCALAPPDATA) out.push(path.join(process.env.LOCALAPPDATA, 'hermes'));
  out.push(path.join(os.homedir(), '.hermes'));
  return [...new Set(out)];
}

/** Hermes's own home on this computer: %LOCALAPPDATA%\hermes on Windows, ~/.hermes elsewhere (Orchy's runs never pass
 * HERMES_DATA_DIR_SUFFIX, so no suffix). */
export function hermesNativeHome() {
  return WIN ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'hermes') : path.join(os.homedir(), '.hermes');
}

/**
 * The home whose auth.json a profile falls back to, provider by provider: Hermes's `get_default_hermes_root` (0.21).
 * A profile inside Hermes's own home → that home; <root>/profiles/<name> elsewhere → <root>; anything else → none.
 */
export function hermesRootFor(profileHome, native = hermesNativeHome()) {
  const p = path.resolve(profileHome);
  const rel = path.relative(path.resolve(native), p); // case-insensitive on Windows, as the filesystem is
  if (!rel) return null; // the profile is the home itself
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return path.resolve(native);
  return path.basename(path.dirname(p)) === 'profiles' ? path.dirname(path.dirname(p)) : null;
}

function hermesConfig(dir) {
  try {
    const y = YAML.parse(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')) || {};
    const m = y.model;
    if (typeof m === 'string') return { provider: y.provider || null, model: m, raw: { model: m, ...(y.provider ? { provider: y.provider } : {}) } };
    if (m && typeof m === 'object') {
      const { api_key: _key, ...model } = m; // a key never moves between files
      return { provider: m.provider || y.provider || null, model: m.default || m.name || null, raw: { model, ...(y.provider ? { provider: y.provider } : {}) } };
    }
  } catch {}
  return { provider: null, model: null, raw: null };
}

/** The providers a Hermes home's auth.json is signed in to. `storedOnly`: count only rows that hold their secret (a row
 * Hermes re-reads from an environment variable or the gh CLI holds none, and a profile can't borrow it). */
function hermesAuthProviders(auth, { storedOnly = false } = {}) {
  const out = new Set();
  for (const [k, v] of Object.entries(auth.providers || {})) if (hasSecret(v)) out.add(k);
  for (const [k, list] of Object.entries(auth.credential_pool || {})) {
    if (Array.isArray(list) && (storedOnly ? list.some(hasSecret) : list.length)) out.add(k);
  }
  return out;
}

// *_API_KEY names Hermes itself files as tools or skills, not model providers (hermes_cli/config_defaults.py, 0.21.7:
// its _tool and _skill entries): a FIRECRAWL_API_KEY alone is no sign-in. Any other key still counts, so a provider
// Hermes adds later isn't refused.
const HERMES_NON_PROVIDER_KEYS = new Set(['EXA', 'PARALLEL', 'FIRECRAWL', 'TAVILY', 'PERPLEXITY', 'KEENABLE', 'BRAVE_SEARCH', 'BROWSERBASE', 'BROWSER_USE', 'CAMOFOX', 'KREA', 'ELEVENLABS', 'MISTRAL', 'HONCHO', 'HINDSIGHT', 'SUPERMEMORY', 'MEM0', 'RETAINDB', 'BRV', 'OPENVIKING', 'NOTION', 'LINEAR', 'AIRTABLE', 'TENOR']);

/** API-key providers Hermes reads from its home's .env (names only, values never read out). */
function hermesEnvProviders(dir) {
  let text = '';
  try { text = fs.readFileSync(path.join(dir, '.env'), 'utf8'); } catch { return []; }
  const out = [];
  for (const m of text.matchAll(/^\s*([A-Z][A-Z0-9_]*)_API_KEY\s*=\s*\S+/gm)) if (!HERMES_NON_PROVIDER_KEYS.has(m[1])) out.push(m[1].toLowerCase().replace(/_/g, '-'));
  return out;
}

/**
 * Hermes sign-in, plan/tier and model list for one profile (or the PC's default home when profileDir is null).
 * A profile is read the way Hermes reads it: its own sign-ins first, then, for a provider it has none for, the
 * computer's (the home it sits in). Those are `computerProviders`. Keys in the computer's .env are not shared.
 */
export function inspectHermesAccount(profileDir, { statusText = '', native } = {}) {
  const parsed = parseHermesStatus(statusText);
  const homes = hermesHomes(profileDir);
  const home = homes.find(d => ['auth.json', 'config.yaml', '.env'].some(f => fs.existsSync(path.join(d, f)))) || homes[0] || null;
  const auth = (home && readJson(path.join(home, 'auth.json'))) || {};
  const cfg = home ? hermesConfig(home) : { provider: null, model: null, raw: null };
  const cache = (home && readJson(path.join(home, 'provider_models_cache.json'))) || {};

  const own = hermesAuthProviders(auth);
  for (const p of parsed.providers) own.add(p);
  if (home) for (const p of hermesEnvProviders(home)) own.add(p);

  // the computer's sign-ins, for the providers this profile has none of its own for
  const root = profileDir && home ? hermesRootFor(home, native) : null;
  const pcAuth = (root && readJson(path.join(root, 'auth.json'))) || {};
  const computerProviders = root ? [...hermesAuthProviders(pcAuth, { storedOnly: true })].filter(p => !own.has(p)) : [];
  const pcCfg = computerProviders.length ? hermesConfig(root) : { provider: null, model: null, raw: null };
  const pcCache = (computerProviders.length && readJson(path.join(root, 'provider_models_cache.json'))) || {};

  const signed = new Set([...own, ...computerProviders]);
  const providers = [...signed];
  const loggedIn = providers.length > 0;
  // the computer's model choice counts only when its provider is one this profile can sign in to
  const pcModel = !cfg.model && pcCfg.model && (!pcCfg.provider || signed.has(pcCfg.provider)) ? pcCfg : null;
  const configuredModel = parsed.model || cfg.model || pcModel?.model || null;
  const active = [auth.active_provider, cfg.provider, pcModel?.provider, pcAuth.active_provider].find(p => typeof p === 'string' && signed.has(p)) || providers[0] || null;

  const borrowed = !own.has(active);
  const cred = borrowed ? (pcAuth.providers?.[active] || pcAuth.credential_pool?.[active]?.find(hasSecret) || null) : (auth.providers?.[active] || auth.credential_pool?.[active]?.[0] || null);
  const { tier, email } = credentialPlan(cred);
  const list = (borrowed ? pcCache : cache)[active]?.models || cache[active]?.models;
  let models = Array.isArray(list) ? list.filter(m => typeof m === 'string') : [];
  if (tier === 'free' && models.some(m => /:free$|welcome/i.test(m))) models = models.filter(m => /:free$|welcome/i.test(m));
  if (configuredModel && configuredModel !== 'default') models = [configuredModel, ...models];
  const plan = loggedIn ? planLabel(active, tier) : null;
  const whose = !computerProviders.length ? '' : own.size ? ` · ${computerProviders.join(', ')} from this computer's sign-in` : ` · this computer's sign-in`;

  return {
    loggedIn,
    email: loggedIn ? email : null,
    label: loggedIn ? providers.join(', ') + (configuredModel ? ` (${configuredModel})` : '') + whose : null,
    providers,
    computerProviders,
    activeProvider: active,
    configuredModel,
    // the computer's model block, for a profile without one (hermes.mjs writes it in before a run)
    computerModel: pcModel?.raw || null,
    plan,
    tier: loggedIn ? tier : null,
    subscription: plan,
    models: loggedIn ? [...new Set(models)].slice(0, MAX_MODELS) : [],
    homeDir: home,
  };
}

// ── OpenCode ──

const OC_AUTH_TYPES = /\s(stored|oauth|api|wellknown|token)\s*$/i;
/** `opencode auth list` → provider names ("OpenCode Console  Default   stored" → "OpenCode Console"). */
export function parseOpenCodeAuthList(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/^[\s●•*✓✔│├└─┌┐┘┴┬]+/, '').trimEnd();
    if (!OC_AUTH_TYPES.test(line)) continue;
    // OpenCode 2 pads columns ("OpenCode Console  Default   stored"); OpenCode 1 puts one space before the type ("Anthropic oauth")
    const name = line.replace(OC_AUTH_TYPES, '').split(/\s{2,}/)[0].trim();
    if (name && !/^(credentials|provider|environment)\b/i.test(name)) out.push(name);
  }
  return [...new Set(out)];
}
// the CLI's display names → auth.json keys
const ocKey = name => (/^opencode/i.test(name) ? 'opencode' : String(name).toLowerCase().replace(/\s+/g, '-'));

function execText(bin, args, env, timeout) {
  return new Promise(resolve => {
    const shell = /\.(cmd|bat)$/i.test(bin);
    // a .cmd shim needs a shell; the arguments are fixed words, never input
    execFile(shell ? `"${bin}" ${args.join(' ')}` : bin, shell ? [] : args, { env, timeout, windowsHide: true, shell }, (err, out) => resolve(err ? '' : String(out || '').replace(/\x1b\[[0-9;]*m/g, '')));
  });
}

/** OpenCode's major version from `opencode --version` ("opencode v2.0.28" → 2, "1.19.3" → 1), 0 when unknown. */
export const openCodeMajor = v => Number(String(v || '').match(/(\d+)\.\d+/)?.[1]) || 0;

let ocProbe = async (bin, env, standalone) => {
  // OpenCode 2 answers through a background service signed in as the computer: a profile asks a private server of its
  // own (`--standalone`; without it the service's port clashes and nothing is listed). OpenCode 1 has neither the
  // service nor the flag, and its strict parser refuses an unknown flag.
  const own = standalone ? ['--standalone'] : [];
  const [auth, models] = await Promise.all([
    execText(bin, ['auth', 'list', ...own], env, standalone ? 20000 : 8000),
    execText(bin, ['models', ...own], env, standalone ? 20000 : 10000),
  ]);
  return { providers: parseOpenCodeAuthList(auth), models: models.split(/\r?\n/).map(l => l.trim()).filter(l => /^[a-z0-9][\w.-]*\/\S+$/i.test(l)) };
};
/** Tests swap the CLI probe for a stub (no real `opencode` is spawned). */
export function setOpenCodeProbeForTests(fn) { const prev = ocProbe; ocProbe = fn; return () => { ocProbe = prev; }; }

/** OpenCode sign-in, plan/tier and model list for one profile (or the PC's default login when profileDir is null). */
export async function inspectOpenCodeAccount(profileDir, { authPath = null, binPath = null, profileEnv = {}, v2 = false } = {}) {
  // OpenCode 2 keeps sign-ins in its own database and never reads auth.json: only its CLI's answer counts there
  const standalone = !!profileDir && v2;
  const files = v2 ? [] : profileDir
    ? [authPath || path.join(expandPath(profileDir), 'data', 'opencode', 'auth.json')]
    : [process.env.XDG_DATA_HOME && path.join(process.env.XDG_DATA_HOME, 'opencode', 'auth.json'), path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'), WIN && process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'opencode', 'auth.json')].filter(Boolean);
  let auth = {};
  for (const f of files) { const j = readJson(f); if (j && typeof j === 'object' && Object.values(j).some(Boolean)) { auth = j; break; } }

  // a profile is asked with the environment its runs get (opencode-run.mjs#openCodeEnv: no computer API keys or
  // OPENCODE_* settings), so the list shows what its runs can actually use
  const probeEnv = profileDir ? openCodeEnv(profileEnv) : { ...process.env, ...profileEnv };
  const cli = binPath ? await ocProbe(binPath, probeEnv, standalone).catch(() => ({ providers: [], models: [] })) : { providers: [], models: [] };
  const providers = [...new Set([...Object.keys(auth).filter(k => auth[k]), ...cli.providers.map(ocKey)])];
  if (!providers.length) return { loggedIn: false, email: null, label: null, providers: [], plan: null, tier: null, subscription: null, models: [] };

  let email = null, tier = null;
  const plans = providers.map(p => {
    const info = credentialPlan(auth[p]);
    email ||= info.email; tier ||= info.tier;
    return planLabel(p, info.tier);
  });
  const plan = [...new Set(plans)].join(' + ') || null;
  return { loggedIn: true, email, label: providers.join(', '), providers, plan, tier, subscription: plan, models: [...new Set(cli.models)].slice(0, MAX_MODELS) };
}
