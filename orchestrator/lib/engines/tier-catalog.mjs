// Plan / tier and model lists for Hermes Agent, read from what Hermes itself keeps: its auth.json (stored plan fields,
// OAuth token claims) and its provider model cache.
// Nothing is guessed: an unknown plan stays null and an unknown model list stays empty (the dashboard then offers
// "default", and the harness picks).
//
// The account fence: a workspace's own profile folder is where Orchy looks for that workspace. The PC's default login
// (~/.hermes, %LOCALAPPDATA%\hermes) is read when no profile is given (the Add window's "default" row), and for a
// profile the way Hermes itself reads it: a profile inside Hermes's home with no sign-in of its own for a provider uses
// the home's auth.json for that provider (Hermes 0.21 profile mode).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { expandPath } from '../env.mjs';
import { parseHermesStatus } from './hermes-config.mjs';

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

const lc = p => String(p || '').trim().toLowerCase();
// the providers a config sends work to besides its main one: fallback_providers and auxiliary.<task>.provider
// ('auto' and 'main' follow the main provider)
function hermesSideProviders(y) {
  const out = [];
  for (const f of Array.isArray(y.fallback_providers) ? y.fallback_providers : []) out.push(typeof f === 'string' ? f : f?.provider);
  for (const t of Object.values(y.auxiliary && typeof y.auxiliary === 'object' ? y.auxiliary : {})) if (t && typeof t === 'object') out.push(t.provider);
  return out.map(lc).filter(p => p && p !== 'auto' && p !== 'main');
}

function hermesConfig(dir) {
  try {
    const y = YAML.parse(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')) || {};
    // endpoints the config itself holds (custom, custom:<name>, a `providers:` entry) need no sign-in
    const endpoints = Object.keys(y.providers && typeof y.providers === 'object' ? y.providers : {}).map(lc);
    const m = y.model;
    // the provider Hermes itself goes by: model.provider only (0.21 resolve_requested_provider; a top-level one isn't read)
    const more = { pinned: m && typeof m === 'object' ? m.provider || null : null, side: hermesSideProviders(y), endpoints };
    if (typeof m === 'string') return { provider: y.provider || null, model: m, raw: { model: m, ...(y.provider ? { provider: y.provider } : {}) }, ...more };
    if (m && typeof m === 'object') {
      const { api_key: _key, ...model } = m; // a key never moves between files
      return { provider: m.provider || y.provider || null, model: m.default || m.name || null, raw: { model, ...(y.provider ? { provider: y.provider } : {}) }, ...more };
    }
    return { provider: null, model: null, raw: null, ...more };
  } catch {}
  return { provider: null, model: null, raw: null, pinned: null, side: [], endpoints: [] };
}

/**
 * A profile on its own sign-in must send every request to a provider it signed in to itself: Hermes falls back to the
 * computer's auth.json for any provider the profile lacks, and with no provider named it picks one by itself (0.21:
 * resolve_provider "auto"). The config's main provider, fallbacks and side-task providers are checked. null = fine.
 */
function ownLoginProblem(cfg, own) {
  const mine = p => own.has(p) || p === 'custom' || p.startsWith('custom:') || cfg.endpoints.includes(p);
  const main = lc(cfg.pinned);
  if (!main) return "its Hermes config names no provider (model.provider), so Hermes could pick this computer's sign-in by itself. Pick a model on its own sign-in (press Log in, or run `hermes model` with its profile), then Re-check.";
  const away = [main, ...cfg.side].filter(p => !mine(p));
  if (!away.length) return null;
  return `its Hermes config sends work to ${[...new Set(away)].map(providerName).join(', ')}, which it isn't signed in to itself, so Hermes would use this computer's sign-in for that. Sign it in there too (Log in), or pick a model on its own sign-in (\`hermes model\` with its profile), then Re-check.`;
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
 * `borrow: false` (a workspace set to its own sign-in): only the profile's own sign-ins count, and `problem` says why
 * a run would still reach the computer's (ownLoginProblem).
 */
export function inspectHermesAccount(profileDir, { statusText = '', native, borrow = true } = {}) {
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
  const root = profileDir && home && borrow ? hermesRootFor(home, native) : null;
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
    problem: profileDir && !borrow && loggedIn ? ownLoginProblem(cfg, own) : null,
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
