// Small helpers: escaping, time in the owner's timezone, markdown, fetch.
import { marked } from '/vendor/marked.js';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let TZ = 'America/New_York';
export function setTimezone(tz) { TZ = tz || TZ; }
export const timezone = () => TZ;
// The owner's name as the last /api/state said it ("you" until then; the server falls back to "the owner").
let OWNER = 'you', OWNER_SET = false, HIDE_NAMES = false;
export function setOwner(o) { const n = String(o?.name ?? '').trim(); OWNER_SET = !!(o?.set && n); OWNER = OWNER_SET ? n : 'you'; HIDE_NAMES = !!o?.hideBusinessNames; }
export const ownerName = () => OWNER;
/** Did the owner give their name (so "Morning, Alex." rather than "Good morning.")? */
export const ownerKnown = () => OWNER_SET;
/** The zone's short name for the clock: "ET", "PT", or "GMT+2" where it has none. */
export function zoneShort(d = new Date()) {
  const name = style => new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: style }).formatToParts(d).find(p => p.type === 'timeZoneName')?.value || '';
  try { const g = name('shortGeneric'); if (g && !/\s/.test(g)) return g; } catch {}
  return name('short');
}

export function clockET(d = new Date()) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
}
export function timeShort(iso) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}
export function dateTime(iso) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}
export function dur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h ? `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** Is the owner on shift right now (inside the work hours the server sends)? */
export function onShift(workHours, d = new Date()) {
  if (!workHours) return true;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).map(p => [p.type, p.value]));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const hm = `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`;
  return workHours.days.includes(day) && hm >= workHours.start && hm < workHours.end;
}

marked.setOptions({ gfm: true, breaks: false });
// Agent/LLM text is untrusted: render markdown, then keep only plain HTML elements and a few attributes.
// Unknown elements give way to their content; these go with everything in them.
const MD_TAGS = new Set('p br hr h1 h2 h3 h4 h5 h6 strong b em i del s code pre blockquote ul ol li a img table thead tbody tr th td span div sup sub'.split(' '));
const MD_DROP = new Set('script style template noscript iframe frame frameset object embed applet form input button select option textarea base link meta title svg math audio video source track canvas xmp noembed noframes plaintext'.split(' '));
const MD_ATTRS = { a: ['href'], img: ['src', 'alt'], th: ['colspan', 'rowspan', 'align'], td: ['colspan', 'rowspan', 'align'], ol: ['start'] };
const HTML_NS = 'http://www.w3.org/1999/xhtml';
/** A link or image address as the browser would read it, or null unless it's http(s) (or mailto for links).
 * Images only load from this page's own server: an outside image would fetch on sight and could carry data out. */
function safeURL(v, img) {
  try {
    const u = new URL(v, location.href);
    if (img) return u.origin === location.origin ? u.href : null;
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href : null;
  } catch { return null; }
}
function cleanTree(node) {
  for (const n of [...node.childNodes]) {
    if (n.nodeType === 3) continue;
    const tag = n.localName;
    if (n.nodeType !== 1 || n.namespaceURI !== HTML_NS || MD_DROP.has(tag)) { n.remove(); continue; }
    cleanTree(n);
    if (!MD_TAGS.has(tag)) { n.replaceWith(...n.childNodes); continue; }
    for (const { name, value } of [...n.attributes]) {
      if (name !== 'title' && !MD_ATTRS[tag]?.includes(name)) { n.removeAttribute(name); continue; }
      if (name !== 'href' && name !== 'src') continue;
      const url = safeURL(value, tag === 'img');
      if (url) n.setAttribute(name, url); else n.removeAttribute(name);
    }
    if (tag === 'a') { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener noreferrer'); }
  }
}
export function md(text) {
  const t = document.createElement('template');
  t.innerHTML = marked.parse(String(text || ''));
  cleanTree(t.content);
  return t.innerHTML;
}

// This browser's pairing key (orchestrator/lib/owner.mjs). Page storage is kept per port, unlike the cookie, so no
// other server on localhost can read it. Sent with every request this page makes to its own API.
const KEY_ITEM = 'orchy-owner-key';
let ownerKey = null; // used when the browser keeps no storage (then a reload asks to pair again)
export function setOwnerKey(key) {
  ownerKey = key || null;
  try { key ? localStorage.setItem(KEY_ITEM, key) : localStorage.removeItem(KEY_ITEM); } catch {}
}
export function ownerHeaders() {
  let key = ownerKey;
  try { key = localStorage.getItem(KEY_ITEM) || key; } catch {}
  return key ? { 'X-Orchy-Key': key } : {};
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...ownerHeaders(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  // a change from a browser that isn't paired (orchestrator/lib/owner.mjs): offer to pair it
  if (res.status === 401 && data?.code === 'unpaired') window.dispatchEvent(new CustomEvent('orchy:unpaired', { detail: { stale: !!data.stale } }));
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status, code: data?.code });
  return data;
}

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

const PLATFORM_NAMES = {
  gmail: 'Gmail', 'google-calendar': 'Google Calendar', 'google-drive': 'Google Drive', 'google-docs': 'Google Docs',
  slack: 'Slack', notion: 'Notion', stripe: 'Stripe', meta: 'Meta', lusha: 'Lusha', exa: 'Exa', tavily: 'Tavily',
  firecrawl: 'Firecrawl', 'hyper-browser': 'HyperBrowser', 'open-router': 'OpenRouter', typesafe: 'TypeSafe (Jev)',
  'conversion-tools': 'Conversion Tools', github: 'GitHub', 'deep-seek': 'DeepSeek', elevenlabs: 'ElevenLabs', deepgram: 'Deepgram', mcp: 'External (MCP)',
};
export function platformName(p) {
  return PLATFORM_NAMES[p] || String(p || '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// The workspace registry as the server last sent it (retired ones too, so old runs still have names).
// Orchy's own built-in workspace (fixing himself) isn't in the list: it only names his fix runs, in plain ink.
let WS = [], RETIRED = [], BACKEND = { id: 'orchy', name: 'Orchy', models: ['haiku', 'sonnet', 'opus'] };
export function setWorkspaces(list, retired, backend) { WS = list || WS; RETIRED = retired || RETIRED; BACKEND = backend || BACKEND; }
const findWs = id => WS.find(w => w.id === id) || RETIRED.find(w => w.id === id) || (id === BACKEND.id ? BACKEND : null);
// A workspace's own name, unless the owner switched on `owner.hideBusinessNames` in config.json (handy when sharing
// a screen): then "Business A, B, C…" in the order they sit in the list (retired ones after, so old runs keep a label).
// Display only: ids, config and forms keep real names.
export function wsName(id) {
  if (id === BACKEND.id) return BACKEND.name;
  const i = [...WS, ...RETIRED].findIndex(w => w.id === id);
  if (i < 0) return id;
  if (!HIDE_NAMES) return WS[i]?.name || RETIRED[i - WS.length]?.name || id;
  const n = i % 26, round = Math.floor(i / 26);
  return `Business ${String.fromCharCode(65 + n)}${round ? round + 1 : ''}`;
}
/** Short label for plates, tabs and bars. */
export const wsShort = wsName;
// Workspace inks: every workspace wears its own (config.json `color`, given by workspaces.mjs#nextInk): a named tint
// from tokens.css (cobalt, tomato, jade, violet…) or a hue drawn here ("h137").
function inkKey(id) {
  const c = String(findWs(id)?.color || '');
  return /^[a-z]{3,12}$|^h\d{1,3}$/.test(c) ? c : null;
}
const drawn = new Set();
/** A hue past the named tints: its --tint-h<n> colours (day and night) and its class, added to the page once. */
function drawHue(key) {
  if (!/^h\d{1,3}$/.test(key) || drawn.has(key) || typeof document === 'undefined') return;
  drawn.add(key);
  const h = Number(key.slice(1)) % 360;
  const day = `--tint-${key}:hsl(${h} 70% 26%);--on-tint-${key}:#ffffff;`;
  const night = `--tint-${key}:hsl(${h} 70% 68%);--on-tint-${key}:#0b0b0c;`;
  let el = document.getElementById('ws-hues');
  if (!el) { el = document.createElement('style'); el.id = 'ws-hues'; document.head.appendChild(el); }
  el.textContent += `:root{${day}}:root[data-theme="night"]{${night}}@media (prefers-color-scheme: dark){:root[data-theme="auto"]{${night}}}.t-${key}{--ws:var(--tint-${key});--on-ws:var(--on-tint-${key})}\n`;
}
/** The class that paints a workspace's plates, bars, swatches and pane head: `tint t-<ink>`, or ink (no colour). */
export function wsClass(id) {
  const k = inkKey(id);
  if (!k) return 'ink';
  drawHue(k);
  return `tint t-${k}`;
}
/** A workspace's tile colour and the colour on it, as CSS values (agent sprites draw with these). */
export function wsInk(id) {
  const k = inkKey(id);
  if (!k) return { bg: 'var(--ink)', fg: 'var(--paper)' };
  drawHue(k);
  return { bg: `var(--tint-${k})`, fg: `var(--on-tint-${k})` };
}
export function wsModels(id) { return findWs(id)?.models || ['haiku', 'sonnet', 'opus']; }
/** The model buttons to show: each distinct model once (an engine whose three tiers are all "default" shows one button). */
export const modelChoices = ms => [...new Set(ms)];
/** An engine whose models are all "default" lets the owner type a model id (e.g. provider/model); the server passes it through. */
export const modelIsFree = ms => ms.length > 0 && ms.every(m => m === 'default');

// The names the owner calls agents by (Sam, Riley, Maya…), from the voice roster. The role title is the fallback.
let CALL = new Map(), VOICES = new Map(), ORCHY_VOICE = null;
export function setCallNames(voiceAgents) {
  CALL = new Map((voiceAgents?.agents || []).map(a => [`${a.workspace}/${a.slug}`, a.name]));
  VOICES = new Map((voiceAgents?.agents || []).filter(a => a.ready).map(a => [`${a.workspace}/${a.slug}`, { key: a.key, name: a.name }]));
  ORCHY_VOICE = voiceAgents?.orchy?.ready ? { key: 'orchy', name: voiceAgents.orchy.name || 'Orchy' } : null;
}
/** Who picks up when the owner calls an agent: its own voice agent, or Orchy for one without (generalists). Null: no voice at all. */
export function voiceOf(ws, slug) { return (slug && VOICES.get(`${ws}/${slug}`)) || ORCHY_VOICE; }
export function agentName(ws, slug, fallback) { return (slug && CALL.get(`${ws}/${slug}`)) || fallback || slug || 'an agent'; }
export const runName = r => agentName(r.workspace, r.isBuilder ? 'agent-builder' : r.agentSlug, r.agentName);
export const itemName = i => agentName(i.workspace, i.kind === 'connections' ? 'agent-builder' : i.agent?.slug, i.agent?.displayName);
/** "Riley · Head of Social", or just the role when the agent has no name yet. */
export function nameRole(name, role) { return role && role !== name ? `${name} · ${role}` : name; }

export const STAGES = ['queued', 'routed', 'working', 'waiting', 'done'];
export function stageOf(run) {
  if (!run) return { idx: 0, label: 'queued' };
  if (run.status === 'starting') return { idx: 1, label: 'routed' };
  if (run.status === 'working') return { idx: 2, label: 'working' };
  if (run.status === 'waiting') return { idx: 3, label: 'waiting on you', wait: true };
  if (run.status === 'stopping') return { idx: 2, label: 'stopping' };
  if (run.status === 'failed') return { idx: 4, label: 'failed', failed: true };
  if (run.status === 'stopped') return { idx: 4, label: 'stopped', failed: true };
  return { idx: 4, label: run.outcome === 'completed' ? 'done' : run.outcome || 'done' };
}
export function stripHTML(run) {
  const st = stageOf(run);
  const live = ['starting', 'working', 'waiting', 'stopping'].includes(run?.status);
  const cells = STAGES.map((_, i) => {
    let cls = i < st.idx ? 'on' : '';
    if (i === st.idx) cls = st.wait ? 'wait' : live ? 'now' : 'on';
    return `<i class="${cls}"></i>`;
  }).join('');
  return `<span class="strip${st.failed ? ' failed' : ''}" aria-hidden="true">${cells}</span><span class="stage${st.failed ? ' failed' : ''}">${esc(st.label)}</span>`;
}

/** A run a client started from their own page (not the owner's reply on it): their conversation, kept off the owner's chat and panes. */
export const clientOwn = r => !!(r?.client && !r.ownerReply);
