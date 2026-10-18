// Plan / tier and model lists for Hermes Agent and OpenCode, read from what the harness itself keeps: its auth.json
// (stored plan fields, OAuth token claims), Hermes's provider model cache, and `opencode auth list` / `opencode models`.
// Nothing is guessed: an unknown plan stays null and an unknown model list stays empty (the dashboard then offers
// "default", and the harness picks).
//
// The account fence: a workspace's own profile folder is the only place looked at for that workspace. The PC's
// default login (~/.hermes, ~/.local/share/opencode, …) is read only when no profile is given (the Add window's
// "default" row), never as a fallback for a profile that isn't signed in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
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

function hermesConfig(dir) {
  try {
    const y = YAML.parse(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')) || {};
    const m = y.model;
    if (typeof m === 'string') return { provider: y.provider || null, model: m };
    if (m && typeof m === 'object') return { provider: m.provider || y.provider || null, model: m.default || m.name || null };
  } catch {}
  return { provider: null, model: null };
}

/** API-key providers Hermes reads from its home's .env (names only, values never read out). */
function hermesEnvProviders(dir) {
  let text = '';
  try { text = fs.readFileSync(path.join(dir, '.env'), 'utf8'); } catch { return []; }
  const out = [];
  for (const m of text.matchAll(/^\s*([A-Z][A-Z0-9_]*)_API_KEY\s*=\s*\S+/gm)) out.push(m[1].toLowerCase().replace(/_/g, '-'));
  return out;
}

/** Hermes sign-in, plan/tier and model list for one profile (or the PC's default home when profileDir is null). */
export function inspectHermesAccount(profileDir, { statusText = '' } = {}) {
  const parsed = parseHermesStatus(statusText);
  const homes = hermesHomes(profileDir);
  const home = homes.find(d => ['auth.json', 'config.yaml', '.env'].some(f => fs.existsSync(path.join(d, f)))) || homes[0] || null;
  const auth = (home && readJson(path.join(home, 'auth.json'))) || {};
  const cfg = home ? hermesConfig(home) : { provider: null, model: null };
  const cache = (home && readJson(path.join(home, 'provider_models_cache.json'))) || {};

  const signed = new Set(parsed.providers);
  for (const [k, v] of Object.entries(auth.providers || {})) if (hasSecret(v)) signed.add(k);
  for (const [k, list] of Object.entries(auth.credential_pool || {})) if (Array.isArray(list) && list.length) signed.add(k);
  if (home) for (const p of hermesEnvProviders(home)) signed.add(p);
  const providers = [...signed];
  const loggedIn = providers.length > 0;
  const configuredModel = parsed.model || cfg.model || null;
  const active = [auth.active_provider, cfg.provider].find(p => typeof p === 'string' && signed.has(p)) || providers[0] || null;

  const cred = auth.providers?.[active] || auth.credential_pool?.[active]?.[0] || null;
  const { tier, email } = credentialPlan(cred);
  let models = Array.isArray(cache[active]?.models) ? cache[active].models.filter(m => typeof m === 'string') : [];
  if (tier === 'free' && models.some(m => /:free$|welcome/i.test(m))) models = models.filter(m => /:free$|welcome/i.test(m));
  if (configuredModel && configuredModel !== 'default') models = [configuredModel, ...models];
  const plan = loggedIn ? planLabel(active, tier) : null;

  return {
    loggedIn,
    email: loggedIn ? email : null,
    label: loggedIn ? providers.join(', ') + (configuredModel ? ` (${configuredModel})` : '') : null,
    providers,
    activeProvider: active,
    configuredModel,
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
    const name = line.split(/\s{2,}/)[0].trim();
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

let ocProbe = async (bin, env, isolated) => {
  const [auth, models] = await Promise.all([
    execText(bin, ['auth', 'list'], env, 8000),
    // a profile gets a private server so the background one (the PC's login) never answers for it
    execText(bin, isolated ? ['models', '--standalone'] : ['models'], env, 10000),
  ]);
  return { providers: parseOpenCodeAuthList(auth), models: models.split(/\r?\n/).map(l => l.trim()).filter(l => /^[a-z0-9][\w.-]*\/\S+$/i.test(l)) };
};
/** Tests swap the CLI probe for a stub (no real `opencode` is spawned). */
export function setOpenCodeProbeForTests(fn) { const prev = ocProbe; ocProbe = fn; return () => { ocProbe = prev; }; }

/** OpenCode sign-in, plan/tier and model list for one profile (or the PC's default login when profileDir is null). */
export async function inspectOpenCodeAccount(profileDir, { authPath = null, binPath = null, profileEnv = {} } = {}) {
  const files = profileDir
    ? [authPath || path.join(expandPath(profileDir), 'data', 'opencode', 'auth.json')]
    : [process.env.XDG_DATA_HOME && path.join(process.env.XDG_DATA_HOME, 'opencode', 'auth.json'), path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'), WIN && process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'opencode', 'auth.json')].filter(Boolean);
  let auth = {};
  for (const f of files) { const j = readJson(f); if (j && typeof j === 'object' && Object.values(j).some(Boolean)) { auth = j; break; } }

  const cli = binPath ? await ocProbe(binPath, { ...process.env, ...profileEnv }, !!profileDir).catch(() => ({ providers: [], models: [] })) : { providers: [], models: [] };
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
