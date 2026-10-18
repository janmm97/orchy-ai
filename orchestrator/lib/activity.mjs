// What each agent is doing right now, derived only from events a run really recorded.
// No guessing: a tool we can't place is "Working", and image/video states need the tool or action to say so.
// Also home to the redaction pass every recorded event goes through (runner.mjs#record) and the safe `brief`
// a finished tool gets (counts only, never the payload).
import path from 'node:path';

// ── redaction ──
const SECRET_KEY = /^(?:authorization|proxy-authorization|x-api-key|api[-_]?key|apikey|secret|client[-_]?secret|password|passwd|pwd|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|token|bearer|private[-_]?key)$/i;
const RULES = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-[redacted]'],
  [/\b(gh[pousr]_)[A-Za-z0-9]{20,}/g, '$1[redacted]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_[redacted]'],
  [/\b(xox[abposr]-)[A-Za-z0-9-]{8,}/g, '$1[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, 'AIza[redacted]'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '$1[redacted]'],
  // ?key=… &token=… in URLs
  [/([?&](?:api[-_]?key|apikey|key|token|access[-_]?token|auth|secret|password|sig|signature|client[-_]?secret)=)[^&\s"'#]+/gi, '$1[redacted]'],
  // .env-looking NAME=secret (also $env:NAME="…" and export NAME=…)
  [/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?|AUTH)[A-Z0-9_]*)(\s*=\s*)("[^"\n]*"|'[^'\n]*'|[^\s"'&;|]+)/g, '$1$2[redacted]'],
  // "api_key": "…" in JSON text
  [/("(?:authorization|x-api-key|api[-_]?key|apikey|secret|client[-_]?secret|password|access[-_]?token|refresh[-_]?token|token)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"'],
];

/** One string with secrets blanked. */
export function redact(s) {
  if (typeof s !== 'string' || !s) return s;
  let out = s;
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out;
}

function redactDeep(v, depth = 0) {
  if (typeof v === 'string') return redact(v);
  if (!v || typeof v !== 'object' || depth > 8) return v;
  if (Array.isArray(v)) return v.map(x => redactDeep(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = typeof x === 'string' && SECRET_KEY.test(k) && x ? '[redacted]' : redactDeep(x, depth + 1);
  return out;
}

/** A run event with its `summary`, `text` and `input` redacted (everything else as it was). */
export function redactEvent(evt) {
  if (!evt || typeof evt !== 'object') return evt;
  const e = { ...evt };
  if (typeof e.summary === 'string') e.summary = redact(e.summary);
  if (typeof e.text === 'string') e.text = redact(e.text);
  if (e.input && typeof e.input === 'object') e.input = redactDeep(e.input);
  return e;
}

// ── a finished tool's brief: counts only ──
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function flatten(content) {
  let text = '', images = 0;
  const walk = (c, d = 0) => {
    if (c == null || d > 6) return;
    if (typeof c === 'string') { text += (text ? '\n' : '') + c; return; }
    if (Array.isArray(c)) { for (const x of c) walk(x, d + 1); return; }
    if (typeof c === 'object') {
      if (c.type === 'image') { images++; return; }
      if (typeof c.text === 'string') return walk(c.text, d + 1);
      if (c.content != null) return walk(c.content, d + 1);
    }
  };
  walk(content);
  return { text: text.trim(), images };
}

/** "42 lines", "3 files", "5 results", "1 image", "no output": never any of the output itself. */
export function briefFor(tool, content) {
  const { text, images } = flatten(content);
  const img = images ? plural(images, 'image') : '';
  if (!text) return img || 'no output';
  const lines = text.split(/\r?\n/).filter(l => l.trim()).length;
  const both = s => (img ? `${s}, ${img}` : s);
  const name = String(tool || '');
  if (name === 'Glob') return /^No files found/i.test(text) ? '0 files' : plural(lines, 'file');
  if (name === 'Grep') {
    if (/^No (?:files|matches) found/i.test(text)) return '0 matches';
    const m = text.match(/^Found (\d+) (file|line|match|occurrence)/i);
    if (m) { const n = Number(m[1]), w = m[2].toLowerCase(); return w === 'match' ? `${n} match${n === 1 ? '' : 'es'}` : plural(n, w); }
    return plural(lines, 'line');
  }
  if (name === 'WebSearch') { const n = (text.match(/"url"\s*:/g) || []).length; return n ? plural(n, 'result') : plural(lines, 'line'); }
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name)) return 'saved';
  if (name === 'WebFetch') return text.length >= 1000 ? `${(text.length / 1000).toFixed(1)}k chars` : plural(text.length, 'char');
  return both(lines > 1 ? plural(lines, 'line') : plural(text.length, 'char'));
}

// ── states ──
export const LABELS = {
  queued: 'Queued', paused: 'Paused (usage limit)', planning: 'Planning', 'searching-web': 'Searching web', 'reading-sources': 'Reading sources',
  'reading-files': 'Reading files', 'writing-code': 'Writing code', 'creating-document': 'Creating document', 'running-tests': 'Running tests',
  'running-command': 'Running a command', 'using-app': 'Using an app', 'looking-up-actions': 'Looking up actions', 'generating-image': 'Generating image',
  'rendering-video': 'Rendering video', waiting: 'Waiting on you', huddle: 'In huddle', 'handing-off': 'Handing off', validating: 'Orchy is checking',
  reporting: 'Writing the report', working: 'Working', stopping: 'Stopping', completed: 'Completed', failed: 'Failed', stopped: 'Stopped',
};

const CODE_EXT = new Set('.js .mjs .cjs .ts .tsx .jsx .mts .cts .py .rb .go .rs .java .kt .swift .c .h .cpp .hpp .cc .cs .php .sh .bash .zsh .ps1 .psm1 .bat .cmd .css .scss .sass .less .vue .svelte .json .jsonc .yaml .yml .toml .xml .sql .lua .r .ipynb .gradle .tf'.split(' '));
const DOC_EXT = new Set('.md .markdown .mdx .docx .doc .pdf .html .htm .txt .csv .tsv .xlsx .xls .pptx .ppt .rtf .odt .ods .odp'.split(' '));
const SHELL = new Set(['Bash', 'PowerShell']);
const READS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const EDITS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const NAMES = { github: 'GitHub', gitlab: 'GitLab', openrouter: 'OpenRouter', elevenlabs: 'ElevenLabs', hubspot: 'HubSpot', linkedin: 'LinkedIn', youtube: 'YouTube', deepseek: 'DeepSeek', openai: 'OpenAI', hyperbrowser: 'HyperBrowser', deepgram: 'Deepgram', clickup: 'ClickUp', quickbooks: 'QuickBooks', woocommerce: 'WooCommerce', wordpress: 'WordPress', tiktok: 'TikTok', 'data-for-seo': 'DataForSEO', 'serp-api': 'SerpApi', serpapi: 'SerpApi' };
/** `google-calendar` → "Google Calendar", `claude_ai_Notion` → "Notion", `jitter-mcp` → "Jitter". */
export function appName(id) {
  let s = String(id || '').trim().replace(/^claude_ai_/i, '').replace(/^plugin_[^_]+_/i, '').replace(/[-_]mcp$/i, '').replace(/^mcp[-_]/i, '');
  if (NAMES[s.toLowerCase()]) return NAMES[s.toLowerCase()];
  return s.split(/[-_\s]+/).filter(Boolean).map(w => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(' ') || 'an app';
}

const says = {
  image: s => /image|img|picture|photo/i.test(s) && /generat|creat|render|draw|edit|make|to[-_ ]?image|text[-_ ]?to/i.test(s),
  video: s => /video/i.test(s) && /render|generat|creat|export|make/i.test(s),
};
const SEARCH_APPS = /exa|tavily|serp|firecrawl|brave|perplexity|google[-_]?search|bing|jina|you[-_]?com|search/i;
// web-reading apps (the search apps read pages too: tavily's Extract, exa's contents)
const SOURCE_APPS = /firecrawl|hyperbrowser|browser|fetch|jina|apify|playwright|puppeteer|scrap|tavily|exa/i;
const SOURCE_VERBS = /scrape|crawl|fetch|extract|navigate|browse|read[-_ ]?url|get[-_ ]?page|open[-_ ]?url|get[-_ ]?contents/i;

// shell
const ONE = String.raw`(?:^|[\s;&|(]|[\\/])one(?:\.cmd|\.ps1|\.exe)?\s+(?:--agent\s+)?`;
const ONE_EXEC = new RegExp(`${ONE}(?:actions|a)\\s+execute\\s+(['"]?)([\\w.-]+)\\1`, 'i');
const ONE_LOOKUP = new RegExp(`${ONE}(?:(?:actions|a)\\s+(?:find|load|knowledge|search)|list|guide)\\b`, 'i');
const TESTS = /(?:^|[\s;&|(])(?:(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?test\b|npx\s+(?:vitest|jest|mocha|playwright\s+test)\b|(?:vitest|jest|mocha|pytest)\b|node\s+(?:--test\b|\S*test[-_.]\S*\.[mc]?[jt]s\b)|python3?\s+-m\s+(?:pytest|unittest)\b|(?:go|cargo|dotnet)\s+test\b)/i;
const VIDEO_CMD = /(?:^|[\s;&|(])(?:npx\s+)?remotion(?:\.cmd)?\s+render\b/i;

const act = (state, extra = {}) => ({ state, label: LABELS[state], ...extra });

function shellActivity(command, summary) {
  const cmd = String(command || '');
  if (VIDEO_CMD.test(cmd)) return act('rendering-video');
  const exec = cmd.match(ONE_EXEC);
  if (exec) {
    const app = exec[2].toLowerCase();
    // the action's title is in the summary describeTool wrote ("Running <title> on <platform>")
    const title = String(summary || '').match(/^Running (.+) on \S+$/)?.[1] || '';
    if (title && says.image(title)) return act('generating-image', { app });
    if (title && says.video(title)) return act('rendering-video', { app });
    if (/search/i.test(title) && SEARCH_APPS.test(app)) return act('searching-web', { app });
    if (SOURCE_VERBS.test(title) && SOURCE_APPS.test(app)) return act('reading-sources', { app });
    return act('using-app', { app, label: `Using ${appName(app)}` });
  }
  if (ONE_LOOKUP.test(cmd)) return act('looking-up-actions');
  if (TESTS.test(cmd)) return act('running-tests');
  return act('running-command');
}

function fileActivity(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  if (CODE_EXT.has(ext)) return act('writing-code');
  if (DOC_EXT.has(ext)) return act('creating-document');
  return null;
}

/** Who a huddle call names: `agents` (one or more slugs) or the older single `agent`, as "a, b and c" (≤ 40 chars). */
export function huddleWith(input) {
  const list = (Array.isArray(input?.agents) ? input.agents : input?.agent ? [input.agent] : []).map(a => String(a || '').trim()).filter(Boolean);
  if (!list.length) return 'a colleague';
  const text = list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
  return text.length > 40 ? `${text.slice(0, 39).trimEnd()}…` : text;
}

function mcpActivity(server, tool, input, run) {
  if (server === 'jos') {
    if (tool === 'ask_user' || tool === 'request_connections') return act('waiting', { label: run?.client && tool === 'ask_user' && run.clientName ? `Waiting on ${run.clientName}` : LABELS.waiting });
    if (tool === 'report_done') return act('reporting');
    if (tool === 'delegate') return act('handing-off', { label: `Handing to ${String(input?.agent || 'a teammate').slice(0, 40)}` });
    if (tool === 'huddle') return act('huddle', { label: `Huddling with ${huddleWith(input)}` });
    if (tool === 'jev_pick_tools') return act('looking-up-actions');
    return null; // note, call_owner, voice_agent: over in a moment, nothing to show
  }
  const both = `${server}__${tool}`;
  if (says.image(tool)) return act('generating-image', { app: server });
  if (says.video(tool)) return act('rendering-video', { app: server });
  if (/search/i.test(tool) && SEARCH_APPS.test(server)) return act('searching-web', { app: server });
  if (SOURCE_VERBS.test(tool) && SOURCE_APPS.test(both)) return act('reading-sources', { app: server });
  return act('using-app', { app: server, label: `Using ${appName(server)}` });
}

/**
 * The activity one recorded event starts, or null if it starts none.
 * → { state, label, tool, app } (tool/app null when there's none).
 */
export function activityFor(event, run = null) {
  if (!event) return null;
  if (event.kind === 'plan') return { ...act('planning'), tool: null, app: null };
  if (event.kind === 'report') return { ...act('reporting'), tool: 'mcp__jos__report_done', app: null };
  if (event.kind !== 'tool') return null;
  const tool = String(event.tool || ''), input = event.input || {};
  let a = null;
  if (SHELL.has(tool)) a = shellActivity(input.command, event.summary);
  else if (tool.startsWith('mcp__')) { const [, server, ...rest] = tool.split('__'); a = mcpActivity(server, rest.join('__'), input, run); if (!a) return null; }
  else if (READS.has(tool)) a = act('reading-files');
  else if (EDITS.has(tool)) a = tool === 'NotebookEdit' ? act('writing-code') : fileActivity(input.file_path || input.notebook_path || input.path) || act('working');
  else if (tool === 'WebSearch') a = act('searching-web');
  else if (tool === 'WebFetch') a = act('reading-sources');
  else if (tool === 'TodoWrite' || tool === 'ExitPlanMode') a = act('planning');
  else if (says.image(tool)) a = act('generating-image'); // e.g. a harness's own image tool (generate_image)
  else if (says.video(tool)) a = act('rendering-video');
  else a = act('working');
  return { tool, app: null, ...a };
}

/** The state a run is in when no tool is in flight. */
export function baseActivity(run) {
  if (run.endedAt || ['done', 'failed', 'stopped'].includes(run.status)) {
    const o = run.outcome || (run.status === 'done' ? 'completed' : run.status);
    const state = o === 'failed' ? 'failed' : o === 'stopped' ? 'stopped' : 'completed';
    return act(state, { label: LABELS[o] || `Finished (${o})` });
  }
  if (run.status === 'queued') return act('queued');
  if (run.status === 'starting') return act('queued', { label: 'Starting' });
  if (run.status === 'paused-limit') return act('paused');
  if (run.status === 'waiting') return act('waiting');
  if (run.status === 'stopping') return act('stopping');
  return run.huddleTalk ? act('huddle') : act('working');
}

// tools in flight per run (memory only: a restart ends every live run anyway) and the last plan/report hint
const open = new Map(); // runId -> { tools: [{ id, a }], hint }
const OPEN_MAX = 24;

function shape(a, at, prev) {
  const next = { state: a.state, label: a.label, tool: a.tool || null, app: a.app || null, toolUseId: a.toolUseId || null };
  if (prev && prev.state === next.state && prev.label === next.label && prev.tool === next.tool && prev.app === next.app && prev.toolUseId === next.toolUseId) return prev;
  return { ...next, since: at };
}

/**
 * The run's activity after one recorded event (or after a status change when `event` is null).
 * tool → that tool's activity; tool_done/tool_error/denied close it (by toolUseId; without one, the latest)
 * and the run goes back to the newest tool still open, else to its run-level state. Waiting and the end win.
 */
export function nextActivity(run, event = null, { statusChanged = false } = {}) {
  const at = event?.t || new Date().toISOString();
  if (run.endedAt || ['done', 'failed', 'stopped'].includes(run.status)) {
    open.delete(run.id);
    return shape(baseActivity(run), at, run.activity);
  }
  let o = open.get(run.id);
  if (!o) open.set(run.id, (o = { tools: [], hint: null }));
  if (statusChanged) o.hint = null;
  if (event) {
    if (event.kind === 'tool') {
      const a = activityFor(event, run);
      if (a) { o.tools.push({ id: event.toolUseId || null, a: { ...a, toolUseId: event.toolUseId || null } }); o.hint = null; }
      if (o.tools.length > OPEN_MAX) o.tools.shift();
    } else if (event.kind === 'tool_done' || event.kind === 'tool_error' || event.kind === 'denied') {
      const i = event.toolUseId ? o.tools.findIndex(t => t.id === event.toolUseId) : o.tools.length - 1;
      if (i >= 0) o.tools.splice(i, 1);
    } else if (event.kind === 'plan' || event.kind === 'report') {
      o.hint = activityFor(event, run);
    }
  }
  const top = o.tools.at(-1)?.a;
  let a;
  if (run.status === 'waiting') a = top?.state === 'waiting' ? top : { ...baseActivity(run), tool: top?.tool || null, toolUseId: top?.toolUseId || null };
  else if (run.status === 'queued' || run.status === 'paused-limit' || run.status === 'stopping') a = baseActivity(run);
  else a = top || o.hint || baseActivity(run);
  return shape(a, at, run.activity);
}

/** Forget a run's open tools (tests). */
export function forgetRun(runId) { open.delete(runId); }

/**
 * Coalesces streamed text deltas into one text event per message: add() deltas, flush() when a non-text event
 * comes or the message ends (a new `key`, e.g. a harness's message id or step index, starts a new message).
 */
export function textBuffer(onFlush) {
  let buf = '', key;
  const flush = () => { const t = buf.trim(); buf = ''; key = undefined; if (t) onFlush(t); };
  return {
    add(text, k) { if (buf && k !== undefined && key !== undefined && k !== key) flush(); if (k !== undefined) key = k; buf += String(text || ''); },
    flush,
    get pending() { return buf; },
  };
}
