// Approval policy: what agents may do without asking the owner.
// "Only decisions" (default): routine work runs; money, sending, calendar, deleting and sharing
// pop an Approve/Deny window (see DECISIONS). "Every change": anything that creates, updates,
// sends, deletes or spends asks first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, save } from './store.mjs';
import { expandPath, ROOT, env, ownerName, readText } from './env.mjs';
import { workspaces, RETIRED_DIR } from './workspaces.mjs';
import { agyRoot } from './engines/antigravity.mjs';
import { cursorRoot } from './engines/cursor.mjs';
import { fencedDirs, guardedFile, rootRel, LOCK_MARKERS } from './backend.mjs';

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task', 'Agent', 'NotebookRead', 'ToolSearch', 'Skill', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'SendUserMessage']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

// One CLI subcommands that only read
const ONE_READ = [
  /^list\b/, /^ls\b/, /^whoami\b/, /^platforms?\b/, /^p\b/, /^guide\b/, /^actions?\s+(find|load|search|knowledge)\b/, /^a\s+(find|load)\b/,
  /^flow\s+(list|validate|show|get)\b/, /^f\s+(list|validate)\b/, /^relay\s+(list|platforms|event-types|events|deliveries)\b/,
  /^mem\s+(search|list|status|doctor|get)\b/, /^sync\s+(models|query|search|test|list)\b/, /^cache\s+list\b/, /^config\s+(get|show)\b/,
];

// Shell commands that are safe to run without asking
const SAFE_SHELL = /^(ls|dir|pwd|cd|cat|head|tail|less|more|wc|grep|rg|find|which|where|echo|printf|date|whoami|tree|stat|file|du|df|sort|uniq|cut|tr|jq|basename|dirname|realpath|type|test|true|Get-ChildItem|Get-Content|Get-Item|Get-Location|Select-String|Test-Path|Measure-Object|Format-\w+|Select-Object|Where-Object|ConvertFrom-Json|ConvertTo-Json|Resolve-Path|Get-Date)\b/i;
const SAFE_GIT = /^git\s+(status|log|diff|show|branch|remote\s+-v|rev-parse|ls-files|blame)\b/;
const SAFE_NODE = /^(node|npm|python|py)\s+(-v|--version)\b/;
// …unless they run something else: find -exec/-delete, rg --pre
const RUNS_MORE = /^find\b.*\s-(exec|execdir|ok|okdir|delete|fprint\w*|fls)\b|^rg\b.*\s--pre\b/i;
// a PowerShell value, not a command: $a.intent, $j.answers[0].title, 'text', 42
const VALUE = /^(\$[\w:]+|'[^']*'|"[^"`$]*"|\d+)(\.\w+|\[[^\]]*\])*$/;

const WRITE_VERBS = /(send|post|create|update|delete|remove|insert|upsert|patch|put|write|publish|charge|refund|cancel|invite|share|archive|move|rename|transfer|pay|submit|reply|forward|schedule|book|trash|label|modify|add|set|assign|merge|close|approve|execute|run|invoke|trigger|dispatch)/i;

/**
 * Does this One action only read? GETs do; a POST only when its title says it searches/lists/gets and names
 * no write verb. Everything else (or an unknown method) counts as changing data: `access: read` blocks it.
 * The Agent Builder's Jev tool pick uses the same rule, so the access it suggests is what the gate allows.
 */
// an MCP tool named for a read ("list posts", "get message", "search events"): its noun isn't what it does.
// A read verb only leads a read when nothing after it writes: get_or_send, find_or_create_refund,
// read_and_reply, check_and_post are not reads (the write word past the first verb gives them away).
const mcpReads = words => {
  const t = String(words).trim();
  if (!/^(list|get|search|find|query|read|fetch|lookup|retrieve|count|describe|view|show|check)\b/i.test(t)) return false;
  // a joiner then a write verb means it also writes: get_or_send, find_or_create_refund, read_and_reply, check_and_post
  const joined = t.match(/\b(?:or|and|then|plus)\b(.*)$/i);
  return !(joined && WRITE_VERBS.test(joined[1]));
};
export function isReadOnlyAction(method, title = '') {
  const m = String(method || '').toUpperCase();
  return m === 'GET' || (m === 'POST' && /\b(search|list|find|query|get|lookup|retrieve|read)\b/i.test(title) && !WRITE_VERBS.test(title.replace(/\b(search|list|find|query|get)\b/ig, '')));
}

/**
 * Split a shell line on top-level && || ; | (quote-aware, so inline scripts stay whole). Quotes close as `shell` reads
 * them: Bash escapes only inside "…" (with \), PowerShell with ` and keeps @'…'@ / @"…"@ here-strings whole.
 */
export function splitShell(command, shell) {
  const s = String(command);
  const ps = shell === 'PowerShell', esc = ps ? '`' : '\\';
  const out = [];
  let cur = '', q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (q === '"' && c === esc) { cur += c + (s[i + 1] ?? ''); i++; continue; }
      cur += c;
      if (c === q) q = null;
      continue;
    }
    if (c === esc && /^\r?\n/.test(s.slice(i + 1, i + 3))) { cur += ' '; i += s[i + 1] === '\r' ? 2 : 1; continue; } // \⏎ continues the line
    if (c === esc) { cur += c + (s[i + 1] ?? ''); i++; continue; } // \; and `; don't split
    if (ps && c === '@' && /^['"]\r?\n/.test(s.slice(i + 1, i + 4))) { // a here-string runs to a line starting '@ / "@
      const end = s.indexOf(`\n${s[i + 1]}@`, i + 2);
      const to = end < 0 ? s.length : end + 3;
      cur += s.slice(i, to);
      i = to - 1;
      continue;
    }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if ((c === '&' && s[i + 1] === '&') || (c === '|' && s[i + 1] === '|')) { out.push(cur); cur = ''; i++; continue; }
    if (c === ';' || c === '|' || c === '\n') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}

/**
 * Read one shell word from s[i] as `shell` does: quotes and escapes come off, so o""ne, "o"ne, o''ne, o\ne (Bash)
 * and o`ne, "`one", "on`e" (PowerShell) are all `one`. `loose` drops only the quotes (a Bash C:\x stays a path); `mixed`
 * marks a word that quoting or escapes split up. Stops at whitespace and ; | & < > ( ), and at ` in Bash.
 */
function readWord(s, i, shell) {
  const ps = shell === 'PowerShell', esc = ps ? '`' : '\\', from = i;
  let word = '', parts = 0, quoted = false, escaped = false;
  while (i < s.length) {
    const c = s[i];
    if (/[\s;|&<>()]/.test(c) || (!ps && c === '`')) break;
    parts++;
    if (c === esc) { // an escaped character, or a line continued (o\⏎ne is one)
      const nl = s[i + 1] === '\n' ? 1 : s[i + 1] === '\r' && s[i + 2] === '\n' ? 2 : 0;
      if (!nl) word += s[i + 1] ?? '';
      i += nl ? nl + 1 : 2; quoted = true; parts++;
      continue;
    }
    if (c === "'" || c === '"') {
      quoted = true;
      for (i++; i < s.length; i++) {
        const d = s[i];
        if (d === c) { if (ps && s[i + 1] === c) { word += c; i++; continue; } break; }
        if (c === '"' && d === esc && i + 1 < s.length && (ps || /[$`"\\\n]/.test(s[i + 1]))) { word += s[++i]; escaped = true; continue; }
        word += d;
      }
      i++;
      continue;
    }
    for (; i < s.length && !/[\s;|&<>()'"]/.test(s[i]) && s[i] !== esc && (ps || s[i] !== '`'); i++) word += s[i];
  }
  const raw = s.slice(from, i);
  return { word, loose: raw.replace(/["']/g, ''), raw, end: i, mixed: quoted && (parts > 1 || escaped) };
}
const WORD_GAP = (c, shell) => /[\s;|&<>()]/.test(c) || (shell !== 'PowerShell' && c === '`');
/** The words of a shell line as the shell reads them (operators left out). */
function shellWords(seg, shell) {
  const s = String(seg), out = [];
  for (let i = 0; i < s.length;) {
    if (WORD_GAP(s[i], shell)) { i++; continue; }
    const w = readWord(s, i, shell);
    if (w.end === i) { i++; continue; }
    out.push(w);
    i = w.end;
  }
  return out;
}
/** The line with every word that quotes or escapes split up put back together (o""ne → one), for spotting names in it. */
function plainWords(line, shell) {
  const s = String(line);
  let out = '';
  for (let i = 0; i < s.length;) {
    if (WORD_GAP(s[i], shell)) { out += s[i++]; continue; }
    const w = readWord(s, i, shell);
    if (w.end === i) { out += s[i++]; continue; }
    out += w.mixed && /^[\w.:@+/\\-]+$/.test(w.word) ? w.word : w.raw;
    i = w.end;
  }
  return out;
}
/** Plain spellings of the line and of what it nests ($(…), (…), {…}, `…`), where any differ from it. */
function plainViews(command, shell) {
  const out = [];
  const walk = (s, depth) => {
    const plain = plainWords(s, shell);
    if (plain !== s) out.push(plain);
    if (depth < 4) for (const b of scanShell(s, shell).subs) walk(b, depth + 1);
  };
  walk(String(command), 0);
  return out;
}

// Inline scripts that only parse/print data (e.g. `one ... | node -e "...JSON.parse..."`) are reads.
const INLINE = /^(node|python3?|py)\s+(-e|--eval|-c|-p|--print)\s+/;
const INLINE_DANGER = /(writeFile|appendFile|createWriteStream|unlink|rmSync|rmdir|mkdir|rename|copyFile|child_process|exec|spawn|fork\(|fetch\(|https?\.|net\.|dgram|require\(\s*['"](fs|http|https|net)['"]|from\s+['"](node:)?fs|import\(|process\.kill|open\(\s*[^)]*['"]w|os\.system|subprocess|shutil|requests\.|urllib|socket)/;
function inlineIsReadOnly(seg) {
  return INLINE.test(seg) && !INLINE_DANGER.test(seg);
}

const ONE_NAME_ONLY = /^(?:[^'"]*[\\/])?one(?:\.cmd|\.ps1|\.exe)?$/i;
/**
 * Read a shell line as the shell does. `code` is the line with quoted text blanked (same length), keeping what still
 * runs inside quotes ($(…), Bash `…`) and a quoted program name ("…\one.cmd"); `subs` are the commands nested in it:
 * $(…), Bash `…`, and outside quotes (…) and {…} (PowerShell sub-expressions and script blocks, Bash subshells and groups).
 */
function scanShell(s, shell) {
  const ps = shell === 'PowerShell';
  const code = s.split(''), subs = [];
  let i = 0, depth = 0;
  const esc = c => (ps ? c === '`' : c === '\\');
  const sub = close => {
    const from = i;
    depth++;
    const closed = run(close);
    depth--;
    if (!depth) subs.push(s.slice(from, closed ? i - 1 : i));
  };
  const quoted = () => {
    const q = s[i], from = i++, blank = [];
    let lit = i;
    while (i < s.length) {
      const c = s[i];
      if (c === q) { if (ps && s[i + 1] === q) { i += 2; continue; } break; }
      if (q === '"' && esc(c)) { i += 2; continue; }
      if (q === '"' && ((c === '$' && s[i + 1] === '(') || (!ps && c === '`'))) {
        blank.push([lit, i]);
        i += c === '`' ? 1 : 2;
        sub(c === '`' ? '`' : ')');
        lit = i;
        continue;
      }
      i++;
    }
    blank.push([lit, i]);
    if (!ONE_NAME_ONLY.test(s.slice(from + 1, i))) for (const [a, b] of blank) blankOut(a, b);
    i++;
  };
  const here = () => { // PowerShell @'…'@ is text; @"…"@ runs the $(…) in it
    const q = s[i + 1], end = s.indexOf(`\n${q}@`, i + 2), stop = end < 0 ? s.length : end;
    let lit = (i += 2);
    while (i < stop) {
      if (q === '"' && s[i] === '`') i += 2;
      else if (q === '"' && s[i] === '$' && s[i + 1] === '(') { blankOut(lit, i); i += 2; sub(')'); lit = i; }
      else i++;
    }
    blankOut(lit, stop);
    i = end < 0 ? s.length : end + 3;
  };
  const blankOut = (a, b) => { for (let k = a; k < b && k < s.length; k++) if (code[k] !== '\n') code[k] = ' '; };
  const skip = to => { blankOut(i, to); i = to; };
  function run(close) {
    while (i < s.length) {
      const c = s[i];
      if (close && c === close) { i++; return true; }
      if (esc(c)) i += 2;
      else if (ps && c === '@' && /^['"]\r?\n/.test(s.slice(i + 1, i + 4))) here();
      else if (c === '#' && (!i || /[\s;|&({]/.test(s[i - 1]))) skip(s.indexOf('\n', i) < 0 ? s.length : s.indexOf('\n', i)); // a comment
      else if (ps && c === '<' && s[i + 1] === '#') skip(s.indexOf('#>', i) < 0 ? s.length : s.indexOf('#>', i) + 2);
      else if (c === "'" || c === '"') quoted();
      else if (c === '$' && s[i + 1] === '{') { const j = s.indexOf('}', i); i = j < 0 ? s.length : j + 1; } // ${VAR}
      else if (!ps && c === '$' && s[i + 1] === '(' && s[i + 2] === '(') { // $((1 + 2)): only the $(…) in it run
        i += 3;
        for (let open = 0; i < s.length; i++) {
          if (s[i] === '$' && s[i + 1] === '(') { i += 2; sub(')'); i--; } else if (s[i] === '(') open++;
          else if (s[i] === ')' && !open--) { i += s[i + 1] === ')' ? 2 : 1; break; }
        }
      }
      else if (c === '$' && s[i + 1] === '(') { i += 2; sub(')'); }
      else if (c === '(' || c === '{') { i++; sub(c === '(' ? ')' : '}'); }
      else if (!ps && c === '`') { i++; sub('`'); }
      else i++;
    }
    return false;
  }
  run(null);
  return { code: code.join(''), subs };
}

// a here-document that is shell commands: fed to a shell, or saved as a shell script
const SHELL_DOC = /(^|[\s|(])(sh|bash|zsh|dash|cmd|powershell|pwsh|wsl|xargs|eval|source)(\.exe)?\b|\.(sh|bash|zsh|ps1|psm1|bat|cmd)\b/i;
/**
 * Bash here-documents in a line: `text` is the line with their bodies blanked (text a command reads, not commands;
 * a shell script's stay when `scripts` is set), `docs` each with its operator line, body and whether it's literal (<<'EOF').
 */
function heredocs(command, shell, scripts = false) {
  let s = String(command);
  const docs = [];
  if (shell === 'PowerShell' || !s.includes('<<')) return { text: s, docs };
  for (let from = 0; ;) {
    const at = scanShell(s.slice(from), shell).code.search(/(?<!<)<<(?!<)/); // not a <<< here-string
    if (at < 0) break;
    // only a plain EOF, 'EOF' or "EOF" word: anything fancier stays commands (Orchy never hides what Bash would run)
    const op = s.slice(from + at).match(/^<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2(?=[\s;|&<>)]|$)/);
    const nl = s.indexOf('\n', from + at);
    if (nl < 0) break;
    if (!op) { from += at + 2; continue; }
    let len = 0;
    for (const l of s.slice(nl + 1).split('\n')) { if ((op[1] ? l.replace(/^\t+/, '') : l).trim() === op[3]) break; len += l.length + 1; }
    const line = s.slice(s.lastIndexOf('\n', from + at) + 1, nl), body = s.slice(nl + 1, nl + 1 + len);
    const script = SHELL_DOC.test(line);
    docs.push({ line, body, literal: !!op[2], script });
    if (!(scripts && script)) s = s.slice(0, nl + 1) + body.replace(/[^\n]/g, ' ') + s.slice(nl + 1 + len);
    from = nl + 1 + len;
  }
  return { text: s, docs };
}

// `one` wherever it is called in a segment (any case, with or without a path or .cmd): at the start, after `=`
// (`$out = one …`), `&`, `(`, `$(`, `{`, `!` or a Bash keyword (`do one …`). Matched on the code, never quoted text.
const ONE_CALL = /(?:^|[=({&!]|\$\(|(?:^|\s)(?:do|then|else|time|exec|command|nohup|builtin)\s)\s*&?\s*(?:npx\s+)?(?:(['"])(?:[^'"]*[\\/])?one(?:\.cmd|\.ps1|\.exe)?\1|(?:[^\s'"=({&]*[\\/])?one(?:\.cmd|\.ps1|\.exe)?)\s+/gi;
const ONE_HEAD = /^(?:npx\s+)?(?:[^\s'"]*[\\/])?one(?:\.cmd|\.ps1|\.exe)?\s/i;
// The One CLI by its npm package name or the path of its cli.js — `npx @withone/cli …`, `pnpm dlx @withone/cli …`,
// `node …/@withone/cli/bin/cli.js …` (the path lib/one.mjs resolves). Rewritten to the bare word `one` so the One
// parser reads the action from the args that follow.
// The path starts at a word start, so a long word is scanned once, not once per character.
const WITHONE = /(?:(?:npx|pnpx|bunx|bun\s+x)\s+(?:-y\s+|--yes\s+)?|(?:npm|pnpm)\s+(?:exec|x|dlx)\s+(?:-y\s+)?(?:--\s+)?|yarn\s+dlx\s+|node\s+)?(?<![^\s=(&;|])(['"]?)[^\s'"]*@withone[\\/]cli(?:@[\w.-]+)?(?:[\\/][^\s'"]*cli\.js)?\1(?:\s+--(?=\s))?/gi;
// …and the package named as an option, its program after it: `npx -p @withone/cli one …`, `npm exec --package=@withone/cli -- one …`
const WITHONE_PKG = /(?:npx|pnpx|bunx|bun\s+x|(?:npm|pnpm)\s+(?:exec|x|dlx)|yarn\s+dlx)\s+(?:-y\s+|--yes\s+)?(?:-p|--package)(?:=|\s+)(['"]?)@withone[\\/]cli(?:@[\w.-]+)?\1\s+(?:-y\s+|--yes\s+)?(?:--\s+)?(?:one|cli)(?=\s|$)/gi;
const unwrapOneCli = line => /@withone/i.test(line) ? String(line).replace(WITHONE_PKG, 'one').replace(WITHONE, 'one') : String(line);
// The real One CLI, not a copy: a cli.js path must be outside the agent's folders (it can write freely only inside
// them), and npx @withone/cli must not find a node_modules/@withone the agent could have put in its own folders.
function realOneCli(seg, cwd, roots) {
  const m = seg.match(/^(?:node\s+)?(['"]?)([^\s'"]*@withone[\\/]cli[^\s'"]*cli\.js)\1/i);
  if (m) { try { return !inRoots(realPath(m[2], cwd), roots); } catch { return false; } }
  for (let d = path.resolve(cwd); inRoots(d, roots); d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'node_modules', '@withone'))) return false;
    if (path.dirname(d) === d) break;
  }
  return true;
}

// PowerShell reads “ ” „ as ", ‘ ’ ‚ ‛ as ' and – — ― as -: o“”ne is one, Set-Content –Path is -Path
const PS_LOOKALIKE = /[–-―‘-„]/;
const psPlain = s => String(s).replace(/[“-„]/g, '"').replace(/[‘-‛]/g, "'").replace(/[–-―]/g, '-');

/** Pull every `one ...` invocation out of a shell command line, spelled plainly or split by quotes (o""ne a""ctions …). */
export function parseOneCommands(command, shell) {
  const out = [], seen = new Set();
  const lines = [String(command), ...plainViews(command, shell)];
  if (shell === 'PowerShell' && PS_LOOKALIKE.test(command)) lines.push(psPlain(command), ...plainViews(psPlain(command), shell));
  for (const l of [...lines]) { const u = unwrapOneCli(l); if (u !== l) lines.push(u); } // the One CLI by its @withone/cli package or cli.js path
  for (const line of lines) {
    for (const c of oneCallsIn(line, shell)) {
      const k = [c.kind, c.platform, c.actionId, c.connectionKey, c.sub].join('|');
      if (!seen.has(k)) { seen.add(k); out.push(c); }
    }
  }
  return out;
}
function oneCallsIn(command, shell) {
  const out = [];
  for (const seg of splitShell(heredocs(command, shell, true).text, shell)) {
    const s = seg.trim();
    const starts = [...scanShell(s, shell).code.matchAll(ONE_CALL)].map(m => ({ at: m.index, end: m.index + m[0].length }));
    starts.forEach((m, i) => {
      const rest = s.slice(m.end, starts[i + 1]?.at ?? s.length).replace(/--agent\s*/gi, '').trim();
      // (`a` and `x` are the CLI's own short names for actions and execute)
      const exec = rest.match(/^(?:actions?|a)\s+(?:execute|x)\s+(\S+)\s+(\S+)\s+(\S+)/i);
      if (exec) {
        const clean = x => x.replace(/^['"]|['"),;]+$/g, '');
        out.push({ kind: 'execute', platform: clean(exec[1]), actionId: clean(exec[2]), connectionKey: clean(exec[3]), raw: s });
      } else {
        out.push({ kind: ONE_READ.some(r => r.test(rest)) ? 'read' : 'other', sub: rest.split(/\s+/).slice(0, 2).join(' '), raw: s, rest });
      }
    });
  }
  return out;
}

// where a redirect sends nothing to a file: the null device, the standard streams
const NO_FILE = /^(\/dev\/(null|stdin|stdout|stderr|tty|fd\/\d+)|\$null|nul|con)$/i;
/** The files a line's redirects write (>, >>, 2>, &>, *>, >|), each as a word the shell reads: "C:/x", '.claude/x', a"b". */
function redirectTargets(command, shell) {
  const s = String(command), { code } = scanShell(s, shell), out = [];
  for (let k = 0; k < code.length; k++) {
    if (code[k] !== '>' || code[k - 1] === '>') continue;
    let j = k + 1;
    if (code[j] === '>') j++;
    if (code[j] === '|') j++;
    if (code[j] === '&') { if (/[\d-]/.test(code[j + 1] ?? '')) continue; j++; } // 2>&1 copies a stream
    while (code[j] === ' ' || code[j] === '\t') j++;
    const w = j < s.length ? readWord(s, j, shell) : null;
    // a Bash `…` or $(…) in it ends the word for readWord, not for Bash: the setup check reads it whole
    const whole = w && shell !== 'PowerShell' ? bashWordEnd(s, j) : 0;
    if (w && whole > w.end) w.raw = s.slice(j, whole);
    if (w?.raw && !NO_FILE.test(w.word)) out.push(w);
  }
  return out;
}

/** Does the line redirect output into a file (outside quoted scripts), whatever the stream and however its target is quoted? */
function writesViaRedirect(command, shell) {
  const unquoted = String(command).replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '');
  if (/[^2&]>{1,2}\s*[^&\s]/.test(` ${unquoted}`) && !/^[^>]*2>\s*(&1|\/dev\/null|\$null|nul)[^>]*$/i.test(unquoted)) return true;
  return redirectTargets(heredocs(command, shell).text, shell).length > 0;
}

/** A piece that only reads, and so does every command it nests ($(…), (…), {…}, `…`). One calls count when `one` is set. */
function pieceIsSafe(seg, shell, one = false) {
  if (RUNS_MORE.test(seg) || RISKY_ANYWHERE.test(seg) || writesViaRedirect(seg, shell)) return false;
  if (/--out|^\s*sort\b/i.test(seg) && optionTargets(seg, shell).length) return false; // sort -o x, git diff --output=x
  if (!scanShell(seg, shell).subs.every(b => !b.trim() || VALUE.test(b.trim()) || shellIsSafe(b, shell))) return false;
  return SAFE_SHELL.test(seg) || SAFE_GIT.test(seg) || SAFE_NODE.test(seg) || inlineIsReadOnly(seg) || (one && ONE_HEAD.test(seg));
}

function shellIsSafe(command, shell) {
  const segs = splitShell(command, shell);
  if (!segs.length) return false;
  // the network or the system reached from anywhere in the line, and redirects that write files (outside quoted scripts)
  if (RISKY_ANYWHERE.test(command) || writesViaRedirect(command, shell)) return false;
  return segs.every(s => pieceIsSafe(s, shell, true));
}

const ONE_TOKEN = /(?<![\w.$\\/{-])(?:[^\s'"=({&;|]*[\\/])?one(?:\.cmd|\.ps1|\.exe)?(?![\w.:/\\=-])/gi;
const ONE_LIKE = /(?<![\w.-])one(?:\.cmd|\.ps1|\.exe)?['"]?\s+(?:--agent\b|(?:actions?|a)\s+(?:find|load|execute|knowledge|search)\b|(?:flow|relay)\s+\w)/gi;
// programs that run a command line they're given
const RUNNERS = new Set(['sh', 'bash', 'zsh', 'dash', 'cmd', 'powershell', 'pwsh', 'wsl', 'start', 'start-process', 'saps', 'start-job', 'iex', 'invoke-expression', 'invoke-command', 'icm', 'eval', 'xargs', 'find', 'watch', 'su', 'sudo', 'runas', 'schtasks', 'wt', 'ssh', 'env', 'nohup', 'timeout', 'time',
  'winpty', 'setsid', 'script', 'vim', 'vi', 'nvim', 'ex', 'forfiles', 'awk', 'gawk', 'mawk', 'sed']);
/** Is the One CLI started in a way the parser can't follow (an alias, a variable, xargs, find -exec, another shell's quoted line)? */
function hiddenOne(command, shell) {
  const lines = [String(command), ...plainViews(command, shell)];
  for (const l of [...lines]) { const u = unwrapOneCli(l); if (u !== l) lines.push(u); }
  return lines.some(line => splitShell(heredocs(line, shell, true).text, shell).some(seg => {
    const { code } = scanShell(seg, shell);
    const calls = [...code.matchAll(ONE_CALL)];
    const parsed = t => calls.some(c => t.index >= c.index && t.index < c.index + c[0].length);
    if ([...code.matchAll(ONE_TOKEN)].some(t => !t[0].includes('://') && !parsed(t))) return true;
    return RUNNERS.has(headOf(commandWords(seg, shell)[0] || '')) && (seg.match(ONE_LIKE) || []).length > (code.match(ONE_LIKE) || []).length;
  }));
}

/** Where a Bash word that starts at s[i] ends, with its quotes, $(…), (…), ${…} and `…` in it whole. */
function bashWordEnd(s, i) {
  let depth = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === "'") { i = s.indexOf("'", i + 1); if (i < 0) return s.length; continue; }
    if (c === '"' || c === '`') {
      for (i++; i < s.length && s[i] !== c; i++) if (s[i] === '\\') i++;
      continue;
    }
    if (c === '$' && /[({]/.test(s[i + 1] ?? '')) { depth++; i++; continue; }
    if (depth && (c === '(' || c === '{')) { depth++; continue; }
    if (depth && (c === ')' || c === '}')) { depth--; continue; }
    if (!depth && /[\s;|&<>()]/.test(c)) break;
  }
  return Math.min(i, s.length);
}
/** A Bash piece from its program on, past assignments and wrappers before it (X=1 time Y=$(date) cmd …); '' when none. */
function bashRest(s) {
  for (let i = 0, n = 0; ;) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) return '';
    const end = bashWordEnd(s, i);
    if (/^[A-Za-z_]\w*\+?=/.test(s.slice(i, end))) { i = end; continue; }
    const past = s.slice(i).replace(WRAPPER, '');
    if (past.length === s.length - i || ++n > 8) return s.slice(i);
    s = past; i = 0;
  }
}
const bashHead = s => (r => r.slice(0, bashWordEnd(r, 0)))(bashRest(s));
/**
 * Does the piece run a program named by a variable or an expression (PowerShell `& $x`, `. $x`, `& "o$()ne"`;
 * Bash `$X …`, `` `…` ``, $'\x6fne', o$()ne, o${x}ne, {one,}, on{e,})?
 */
function computedHead(seg, shell) {
  if (shell === 'PowerShell') {
    const s = String(seg), { code } = scanShell(s, shell);
    if (/(?:^|[^\w&>`-])&\s*[$(]|(?:^|[;({]\s*)\.\s+[$(]/.test(code)) return true;
    // a double-quoted name expands what's in it: & "o$()ne", . "o${x}ne" (not a folder: & "$env:ProgramFiles\x\node.exe")
    for (const m of code.matchAll(/(?:^|[^\w&>`-])&\s*(?=")|(?:^|[;({]\s*)\.\s+(?=")/g)) {
      if (/\$/.test(readWord(s, m.index + m[0].length, shell).raw.split(/[\\/]/).pop())) return true;
    }
    return false;
  }
  const s = seg.trim().replace(WRAPPER, '');
  if (/^["']?(?:\$[\w{('"]|`)/.test(s)) return true;
  const head = bashHead(s); // (what assignments run is judged as nested)
  return /[$`]/.test(head) || /\{[^{}\s]*(?:,|\.\.)[^{}\s]*\}/.test(head);
}

function insideDir(p, dir) {
  if (!p) return false;
  const rel = path.relative(dir, path.resolve(dir, p));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
// A "~" in a path Orchy checks may only be in the folder it lands in (Windows names a temp folder C:\Users\RUNNER~1\…):
// one below that folder could be a short name for a protected one (CLAUDE~1 is .claude), and one at the start is home
const tildeBelow = (abs, root) => /~/.test(path.relative(path.resolve(root), path.resolve(abs)));

// PowerShell file writes (how Codex on Windows saves files) are own-folder file work when every
// path stays inside the workspace and nothing in the line can run another command.
const PS_WRITE = /^(Set-Content|Add-Content|Out-File|New-Item)\b/i;
const PS_ACTIVE = /\$\(|@\(|`|\b(Invoke-|iex\b|iwr\b|irm\b|Start-Process)\b/i;
const PS_PATHS = ['path', 'literalpath', 'filepath'];
function psWriteInside(seg, cwd, ws, ctx) {
  if (!PS_WRITE.test(seg) || PS_ACTIVE.test(seg) || LINKS.test(seg)) return false;
  // outside quotes: no variables, sub-commands, call operators, redirects or lists of targets
  const bare = seg.replace(/'(?:[^']|'')*'/g, "''").replace(/"[^"]*"/g, '""');
  if (/[$(@&>,]/.test(bare)) return false;
  // its parameters, never a "-Path" inside a quoted -Value. One given as -Path:x, or shortened (-Pa, -LP, -PSPath),
  // is judged the long way, as is a second target; New-Item's -Name (-N, -Na…) is part of the path it makes
  const { code } = scanShell(seg, 'PowerShell');
  if (/(?<=^|\s)-\w+:/.test(code)) return false;
  let at = -1, nameAt = -1;
  for (const m of code.matchAll(/(?<=^|\s)-([A-Za-z]+)(?=\s)/g)) {
    const p = m[1].toLowerCase(), to = m.index + m[0].length + code.slice(m.index + m[0].length).match(/^\s*/)[0].length;
    if (PS_PATHS.includes(p)) { if (at >= 0) return false; at = to; }
    else if ([...PS_PATHS, 'pspath', 'lp'].some(n => n.startsWith(p))) return false;
    else if ('name'.startsWith(p)) { if (nameAt >= 0) return false; nameAt = to; }
  }
  const head = seg.match(PS_WRITE)[0].length, lead = seg.slice(head).match(/^\s*/)[0].length;
  if (at < 0 && /^[^\s-]/.test(seg.slice(head + lead))) at = head + lead;
  // the target as PowerShell reads it, quotes joined up: C"":/x is C:/x, .clau""de is .claude
  const target = at >= 0 ? readWord(seg, at, 'PowerShell').word : '';
  const name = nameAt >= 0 ? readWord(seg, nameAt, 'PowerShell').word : '';
  // not a variable, a network or device path, a provider's path (FileSystem::\\host, Registry::…), another drive (HKCU:),
  // the home folder (~) or a wildcard PowerShell fills in (CLAU*.md, AGENT[S].md)
  const off = t => /[$%*?[\]]/.test(t) || /^~/.test(t) || /^[\\/]{2}/.test(t) || /::|^[A-Za-z][\w.]+:/.test(t);
  if (!target || off(target) || (nameAt >= 0 && (!name || off(name)))) return false;
  const sep = t => (POSIX ? t.replace(/\\/g, '/') : t); // (PowerShell on macOS and Linux takes \ as / too)
  const abs = path.resolve(cwd, sep(target), sep(name));
  return insideDir(abs, ws.dir) && !setupFile(abs, ws, ctx);
}

// ── "Decisions only" mode (the default): agents work on their own and only bring the owner real decisions ──
// Matched against a One action's title (e.g. "Send Email", "Create Refund", "Insert Event"), an MCP
// tool's name, or the command. Plain English: add words freely. The owner can switch each kind off in Settings.
export const DECISIONS = [
  { key: 'money', label: 'Money', hint: 'refunds, charges, payments, payouts, invoices, subscriptions, coupons', re: /\b(refund|charge|payment|pay|payout|transfer|invoice|subscription|capture|purchase|checkout|dispute|price|coupon|discount)s?\b/i },
  { key: 'send', label: 'Sending', hint: 'emails, replies, forwards, messages, texts, posts', re: /\b(send|reply|forward|post|publish|tweet|broadcast|sms|notify)s?\b|postmessage/i },
  { key: 'calendar', label: 'Calendar', hint: 'creating, moving or cancelling events, bookings and RSVPs', re: /\b(event|meeting|appointment|booking|rsvp|invitation)s?\b/i, platforms: /calendar|calendly|cal-com|acuity/i },
  { key: 'delete', label: 'Deleting', hint: 'deleting, trashing or cancelling anything', re: /\b(delete|remove|destroy|purge|trash|cancel|revoke|void|deactivate|terminate|erase)s?\b/i },
  { key: 'share', label: 'Sharing', hint: 'sharing files, invites, permissions and access', re: /\b(shar(?:e|ing|ed)|invite|permission|collaborator|member|role|grant|access)s?\b/i },
];
/** Which decision (if any) an action is. Removing a label or tag is housekeeping, not deleting. */
export function decisionFor(text, platform = '') {
  const t = String(text || '');
  for (const d of DECISIONS) {
    if (!(d.platforms?.test(platform) || d.re.test(t))) continue;
    if (d.key === 'delete' && /\b(label|tag)s?\b/i.test(t) && !/\b(delete|destroy|purge|trash)\b/i.test(t)) continue;
    return d;
  }
  return null;
}
const asked = (d, ctx) => !!d && ctx.askFor?.[d.key] !== false;

// Shell work that still needs the owner in decisions mode: network, deleting, scripts, system changes, other folders.
const RISKY_HEADS = new Set(['curl', 'wget', 'invoke-webrequest', 'invoke-restmethod', 'iwr', 'irm', 'send-mailmessage', 'ssh', 'scp', 'sftp', 'ftp', 'rsync', 'telnet', 'nc', 'ncat',
  'start-process', 'start', 'saps', 'start-job', 'invoke-command', 'icm', 'xargs', 'shutdown', 'restart-computer', 'stop-computer', 'stop-process', 'taskkill', 'kill', 'reg', 'set-itemproperty', 'new-itemproperty', 'schtasks', 'sc', 'net', 'netsh',
  'winget', 'choco', 'scoop', 'msiexec', 'setx', 'set-executionpolicy', 'rm', 'del', 'erase', 'rmdir', 'rd', 'remove-item', 'ri', 'clear-content', 'clear-recyclebin', 'format', 'diskpart',
  'takeown', 'icacls', 'attrib', 'chmod', 'chown', 'sudo', 'runas', 'make', 'gmake', 'nmake', 'forfiles', 'winpty', 'setsid']);
const SCRIPT_HEADS = new Set(['node', 'python', 'python3', 'py', 'deno', 'bun', 'ruby', 'perl', 'php', 'powershell', 'pwsh', 'cmd', 'bash', 'sh', 'dash', 'zsh', 'wsl', 'java', 'dotnet', 'npx', 'pnpx', 'bunx', 'npm', 'pnpm', 'yarn', 'invoke-expression', 'iex', 'eval', 'source', 'script']);
// (git remote -v and git config <key> only read)
const RISKY_ANYWHERE = /Net\.WebClient|System\.Net|HttpClient|Diagnostics\.Process|\]::(Delete|Move|Copy|Write\w*|Append\w*|Start|Create\w*|SetEnvironmentVariable)\(|-(TypeDefinition|MemberDefinition)\b|--checkpoint-action[=\s]*exec|\bgit\s+(?:-[cC]\s+\S+\s+|--[\w-]+(?:=\S+)?\s+)*(push|clone|fetch|pull|submodule\s+(?:add|update|init)|remote\s+(?!-v\b|show\b|get-url\b)\S|config\s+(?!--get|--list|-l\b)(?:--\S+\s+)*[^\s;|&]+[ \t]+[^\s;|&-])|\bgit\s+(?:-[cC]\s+\S+\s+)*-[cC]\s+alias\.[\w.-]+\s*=/i;
// code produced at run time that Orchy can never read first: a shell or iex fed a pipe, a stdin redirect, a
// command substitution, an encoded command, or a scriptblock built from a string. It asks whatever Settings → Scripts.
const OPAQUE = /\|\s*(?:sh|bash|zsh|dash|iex|invoke-expression)\b(?![\w-])|(?:^|[\s;|&(])(?:sh|bash|zsh|dash)\s*<(?!<)|(?:^|[\s;|&(])(?:sh|bash|zsh|dash)\s+(?:-[a-z]+\s+)*-c\s+["']?\$[({]|\biex\b|\binvoke-expression\b|\[scriptblock\]::create|\.(?:invokescript|newscriptblock)\s*\(|(?:^|[\s;|&])(?:pwsh|powershell)(?:\.exe)?\s+(?:[^|;&]*\s)?-e(?:nc(?:odedcommand)?)?\b/i;
function commandWords(seg, shell) {
  const out = [], plain = [];
  // a word as the shell reads it: "C:\Program Files\x\curl.exe" and cu"r"l are curl
  const re = /(?:^|[(;|&]|(?<!\$)\{)\s*&?\s*((?:"[^"]*"|'[^']*'|[^\s{}()'"`;|&])+)/g;
  let m;
  while ((m = re.exec(seg))) {
    out.push(m[1].replace(/["']/g, ''));
    // …and with its escapes read too (c\url in Bash, cu`rl in PowerShell): judged as well, after the rest
    const w = readWord(seg, m.index + m[0].length - m[1].length, shell).word;
    if (w && w !== out[out.length - 1]) plain.push(w);
  }
  return [...out, ...plain];
}
// Where an agent may work freely besides its folder: the temp folder (scratch space for lookups) and
// its own Claude Code session folder (where Claude parks big tool results it reads back).
function workRoots(ws) {
  const profile = ws.claudeConfigDir ? expandPath(ws.claudeConfigDir) : path.join(os.homedir(), '.claude');
  return [ws.dir, os.tmpdir(), path.join(profile, 'projects', path.resolve(ws.dir).replace(/[^a-zA-Z0-9]/g, '-'))];
}
const inRoots = (p, roots) => roots.some(r => path.relative(path.resolve(r), path.resolve(p)) === '' || insideDir(p, r));
/** Turn shell spellings (/tmp, /c/Users, $env:TEMP, ~) into a real path, relative to cwd. */
function realPath(p, cwd) {
  let s = String(p || '').trim().replace(/^['"]|['"]$/g, '');
  s = s.replace(/^(\$env:(TEMP|TMP)|%(TEMP|TMP)%)/i, os.tmpdir()).replace(/^\/tmp(?=\/|$)/, os.tmpdir().replace(/\\/g, '/'))
    .replace(/^\/([a-zA-Z])(?=\/|$)/, POSIX ? '/$1' : '$1:/').replace(/^(~|\$HOME|\$\{HOME\}|\$env:(USERPROFILE|HOME)|%USERPROFILE%)(?=[\\/]|$)/i, os.homedir());
  // C:Users (what Bash leaves of an unquoted C:\Users): Git Bash goes to C:/Users, never a folder under cwd
  if (!POSIX) s = s.replace(/^([A-Za-z]):(?![\\/])/, '$1:/');
  return path.resolve(cwd, s);
}
const TEMP_REF = /\$env:(TEMP|TMP)\b|%(TEMP|TMP)%|(^|[\s'"=(])\/tmp(?=[\\/\s'"]|$)/gi;
// a drive path (C:\…, C:/…, 'C:\\…' in code), never a URL's "s://"
const DRIVE_PATH = /(?<![A-Za-z0-9])[A-Za-z]:(?:\\\\|\\|\/(?!\/))[^\s'"`;|,)]*/g;
// on macOS and Linux, an absolute path (/home/…, /Users/…, /), never a URL's "//"; the null device and the
// standard streams are no place. PowerShell there takes "\" as a separator too ("$env:TMP\x.md").
const POSIX = process.platform !== 'win32';
const POSIX_PATH = /(?<=^|[\s'"=(,])\/(?!\/)[^\s'"`;|,)]*/g;
const NOWHERE = /^\/dev\/(null|stdin|stdout|stderr|fd\/\d+)$/;
const absPaths = s => [...(s.match(DRIVE_PATH) || []),
  ...(POSIX ? (s.match(POSIX_PATH) || []).map(p => p.replace(/\\+/g, '/')).filter(p => !NOWHERE.test(p)) : [])];
// a network or device path (\\server\share, \\localhost\c$, //host/share, \\?\C:\, \\.\): never the agent's folder.
// In code only the backslash form (written '\\\\host\\share'): // starts a comment there. PowerShell names one after
// its provider too (FileSystem::\\host\share).
const UNC_PATH = /(?<=^|[\s'"`=(,>]|::)(?:\\{2,}|\/\/)[^\s\\/'"`]+[\\/]/;
const UNC_IN_CODE = /(?<=^|[\s'"`=(,])\\{2,}[^\s\\/'"`]+\\/;
// climbsOk: every climb (..) in the text was read word by word and stays inside (climbsInside)
function outsidePaths(text, roots, { code = false, climbsOk = false } = {}) {
  const s = POSIX ? String(text).replace(TEMP_REF, (_, a, b, lead) => `${lead || ''}${os.tmpdir()}`)
    : String(text).replace(TEMP_REF, '$1').replace(/(^|[\s'"=(])\/([a-zA-Z])\//g, '$1$2:/');
  if ((!climbsOk && /(^|[\s'"=])\.\.([\\/]|$|\s)/.test(s)) || /(^|[\s'"])~[\\/]/.test(s)) return true;
  if ((code ? UNC_IN_CODE : UNC_PATH).test(s)) return true;
  if (code ? /homedir\(\)|process\.env\.(USERPROFILE|HOME|APPDATA|LOCALAPPDATA)|expanduser|os\.environ/.test(s) : /\$env:|\$HOME\b|%\w+%/i.test(s)) return true;
  return absPaths(s).some(p => !inRoots(p, roots));
}
/**
 * Do the climbs (..) in a piece all land back inside `roots`, from every folder it may run from (2026-10-15:
 * `cd studio && ls ../projects` is still its own work)? Each word is read as the shell reads it; a climb word that is
 * more than a plain path (quoted text with spaces, a variable, a wildcard, code) or a folder Orchy can't name says no.
 */
function climbsInside(seg, shell, dirs, roots) {
  // a folder with a "~" counts only when it's inside a root and the "~" is in the root's own name (tildeBelow)
  const unnamed = d => !d || d === ELSEWHERE || /[$`%]|^~/.test(d) || (/~/.test(d) && !roots.some(r => inRoots(d, [r]) && !tildeBelow(d, r)));
  if (!dirs.length || dirs.some(unnamed)) return false;
  let any = false;
  for (const { word } of shellWords(seg, shell)) {
    if (!/(^|[^.])\.\.(?![^\\/])/.test(word)) continue;
    any = true;
    const m = word.match(/^(?:-{1,2}[\w-]+=|[A-Za-z_]\w*=)?([^\s'"`$*?~{}()=,;]+)$/);
    if (!m) return false;
    const p = POSIX ? m[1].replace(/\\/g, '/') : m[1];
    if (!dirs.every(d => inRoots(path.resolve(d, p), roots))) return false;
  }
  return any;
}

// Scripts an agent writes to shape data (parse JSON, build a request body) run on their own. One that
// launches programs, reaches the network or deletes files asks: it could send or spend behind the owner's back.
const SCRIPT_DANGER = /child_process|\bexec(Sync|File)?\s*\(|\bspawn(Sync)?\s*\(|\bfork\s*\(|\bfetch\s*\(|(require\(|from\s+|import\()\s*['"](node:)?(https?|http2|net|dgram|tls|child_process|worker_threads)['"]|\bimport\s*\(|XMLHttpRequest|WebSocket|axios|undici|node-fetch|\bgot\s*\(|subprocess|os\.system|os\.popen|requests\.|urllib|http\.client|\bsocket\b|smtplib|process\.kill|\beval\s*\(|new Function\(|Deno\.(run|Command)|Bun\.spawn|nodemailer|googleapis|googleapiclient|twilio|sendgrid|@slack\/|(require\(\s*|from\s+|import\s+)['"]?stripe\b/;
const SCRIPT_DELETE = /\bunlink(Sync)?\s*\(|\brm(Sync)?\s*\(|\brmdir(Sync)?\s*\(|os\.remove|os\.unlink|shutil\.rmtree|\.unlink\(\)/;
const SCRIPT_WRITE = /writeFile|appendFile|createWriteStream|copyFile|rename(Sync)?\s*\(|mkdir|open\(\s*[^)]*['"][wax]/;
const INTERPRETERS = new Set(['node', 'python', 'python3', 'py', 'deno', 'bun']);
const INLINE_CODE = seg => seg.match(/^\S+\s+(?:-\S+\s+)*?(?:-e|--eval|-c|-p|--print)\s+(['"])([\s\S]*)\1\s*$/) || seg.match(/^\S+\s+(?:-e|--eval|-c|-p|--print)\s+(\S[\s\S]*)$/);
/** The script file an interpreter runs (`node x.js`), or null for inline code. */
const scriptFile = seg => (INLINE_CODE(seg) ? null : seg.match(/^\S+\s+(?:-\S+\s+)*(['"]?)([^\s'"]+\.(?:js|mjs|cjs|py|ts))\1/i)?.[2] || null);
function scriptCode(seg, cwd) {
  const inline = INLINE_CODE(seg);
  if (inline) return inline[2] ?? inline[1];
  const file = scriptFile(seg);
  if (!file) return null;
  try { const p = realPath(file, cwd); if (fs.statSync(p).size < 300_000) return fs.readFileSync(p, 'utf8'); } catch {}
  return null;
}
function scriptNeedsOwner(code, ws, ctx, roots, away, cwd) {
  if (SCRIPT_DANGER.test(code)) return 'runs a script that launches programs or reaches the network';
  if (SCRIPT_DELETE.test(code)) return 'runs a script that deletes files';
  const other = otherClientIn(code, ws, ctx);
  if (other) return `runs a script that reaches into ${other}, another client's folder`;
  if (outsidePaths(code, roots, { code: true }) && SCRIPT_WRITE.test(code)) return 'runs a script that writes outside its folder';
  if (away && SCRIPT_WRITE.test(code)) return 'runs a script that writes outside its folder';
  if (SCRIPT_WRITE.test(code) && setupNamed(code, cwd, ws, ctx)) return `runs a script that ${SETUP_WHY(ws)}`;
  return null;
}

// Settings → Scripts on: scripts run on their own unless what they do is a decision the owner keeps (money, sending,
// calendar, deleting, sharing, as switched on below it). A script can only do those in an app by reaching the
// network or starting a program, so only then is its code read for them; deleting files counts as deleting.
// Words as code spells them (`refunds.create`, `sendMail(`, `chat.postMessage`), not DECISIONS' plain English,
// which code is full of (`event`, `post`, `remove`, `access`).
const SCRIPT_DECISIONS = {
  money: /\b(refunds|charges|payouts|transfers|paymentIntents|payment_intents|invoices|subscriptions|checkout\.sessions)\.(create|update|cancel|del|pay|send|finalize|capture)\b|\/v1\/(refunds|charges|payouts|transfers|invoices|subscriptions|payment_intents|checkout)|\b(create|issue)_?refund\w*\s*\(/i,
  send: /\bsend(?:[A-Z_]\w*)?\s*\(|\bsend[_-]?(mail|email|message|sms|text)\b|\bsendmail\b|smtplib|nodemailer|messages\/send|chat\.postMessage|\/Messages\.json|\b(reply|forward)(?:[A-Z_]\w*)?\s*\(/i,
  calendar: /googleapis\.com\/calendar|calendar\/v3|\bcalendarId\b|calendly\.com|api\.cal\.com|\bevents\.(insert|update|patch|delete|move|quickAdd)\b/i,
  delete: /\bdelete[A-Z_]\w*\s*\(|method\s*[:=]\s*['"]DELETE['"]|-X\s*DELETE\b|\b(trash|purge)\w*\s*\(|\.delete\(\s*\)/,
  share: /\bshare(?:[A-Z_]\w*)?\s*\(|\bpermissions\.create\b|\/permissions\b|addCollaborator|\binvite(?:[A-Z_]\w*)?\s*\(/i,
};
// Orchy's own dashboard: a change there already needs the owner's paired browser (lib/owner.mjs), and a script
// that talks to it asks as well, Scripts setting or not, and so does a command in "Scripts and commands" (curl, wget,
// Invoke-RestMethod… to it). Orchy's screenshot script only loads the page.
const DASHBOARD_WHY = 'talks to Orchy’s own dashboard, where your approvals and settings live';
// this PC by any of its loopback spellings: localhost, 127.x.x.x, 0.0.0.0, http://0:…, [::1], [0:0:…:1], [::ffff:127…],
// 0x7f000001, 2130706433
const LOCAL_HOST = /\b(?:localhost|127(?:\.\d{1,3}){1,3}|0\.0\.0\.0|0x7f[0-9a-f]*|2130706433)\b|\[(?:0{0,4}:){2,7}0{0,3}1\]|\[::ffff:(?:127\.|7f)|\/\/0(?=[:/])/i;
// the port read from Orchy's own setting rather than written out: $PORT, $env:PORT, %PORT%, process.env.PORT, os.environ['PORT']
const PORT_REF = /\$\{?PORT\b|\$env:PORT\b|%PORT%|env\.PORT\b|environ(?:\.get\(\s*|\[\s*)['"]PORT['"]|getenv\(\s*['"]PORT['"]/i;
const CDP_SCRIPT = path.join(ROOT, 'orchestrator', 'scripts', 'cdp.mjs').toLowerCase();
function talksToDashboard(n) {
  if (n.file && [path.resolve(n.file), path.resolve(ROOT, n.file)].some(p => p.toLowerCase() === CDP_SCRIPT)) return false;
  const port = new RegExp(`(^|\\D)${Number(env('PORT', '8008'))}(\\D|$)`);
  return [n.code, n.piece].some(t => t && LOCAL_HOST.test(t) && (port.test(t) || PORT_REF.test(t)));
}
// a One send from a script, with the `actions`=`a` and `execute`=`x` aliases, and after --agent: `a x`, `actions x`,
// `a execute`. Tested on code with string concatenation ('act'+'ions') joined up first.
const ONE_IN_SCRIPT = /\bactions['"`\s,]+execute\b|--agent\b[\s\S]{0,80}?\b(?:actions|a)['"`,\s]+(?:execute|x)\b/i;
const SCRIPT_LAUNCH = /child_process|\bexec(Sync|File)?\s*\(|\bspawn(Sync)?\s*\(|subprocess|os\.system|os\.popen|Deno\.(run|Command)|Bun\.spawn/;
/**
 * A script Settings lets run on its own (need.script) that still asks: its decision, as { why } for the pop-up, or
 * null. One actions it runs are looked up by ID and judged like any other; ones it doesn't name ask.
 */
async function scriptDecision(n, ctx) {
  // string concatenation ('act'+'ions execute') is joined up so the One-CLI check can't be split apart
  const code = n.code == null ? null : String(n.code).replace(/['"`]\s*\+\s*['"`]/g, '');
  const name = (n.file ? path.basename(n.file) : '').replace(/\.\w+$/, '').replace(/[-_.]+/g, ' ');
  const hit = d => asked(d, ctx) && { why: `runs a script that looks like ${d.label.toLowerCase()} (${d.hint})` };
  let d;
  if (code == null) return (d = decisionFor(name)) ? hit(d) : null; // unread: its name is all Orchy has
  if (SCRIPT_DELETE.test(code) && (d = hit(DECISIONS.find(x => x.key === 'delete')))) return d;
  // a script that launches programs from decoded or encoded input can run anything: Orchy can't read what
  if (SCRIPT_LAUNCH.test(code) && /base64|FromBase64String|b64decode|\batob\s*\(|Buffer\.from\s*\([^)]*,\s*['"]base64/i.test(code)) return { why: 'runs code it decodes at run time, which Orchy can’t read first' };
  // the One CLI only runs from a script that starts programs (a page that shows "one actions execute" doesn't)
  const shellScript = /\.(sh|bash|ps1|bat|cmd)$/i.test(n.file || '') || /^(?:do\s+|then\s+|time\s+)*(?:sh|bash|zsh|dash|pwsh|powershell)\b/i.test(String(n.piece || '').trim());
  const runsOne = ONE_IN_SCRIPT.test(code) && (shellScript || SCRIPT_LAUNCH.test(code));
  // stays on this PC: nothing to send or spend (shell scripts reach out with curl and the like)
  if (!SCRIPT_DANGER.test(code) && !runsOne && !(shellScript && /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Send-MailMessage|ssh|scp)\b/i.test(code))) return null;
  for (const x of DECISIONS) if ((SCRIPT_DECISIONS[x.key]?.test(code) || decisionFor(name)?.key === x.key) && (d = hit(x))) return d;
  // a wrapper (gh.sh conn_mod_def::… '{…}') takes its action IDs on the command line
  const ids = [...new Set((code + ' ' + n.piece).match(/conn_mod_def::[\w-]+::[\w-]+/g) || [])];
  if (runsOne || ids.length) {
    if (!ids.length) return { why: 'runs One actions from a script without naming them, so Orchy can’t tell what they do' };
    for (const id of ids) {
      const a = await ctx.resolveAction?.(id);
      if (!a?.title) return { why: 'runs a One action from a script that Orchy couldn’t look up' };
      if (isReadOnlyAction(a.method, a.title)) continue;
      if ((d = hit(decisionFor(a.title, a.platform)))) return { why: `runs "${a.title}" from a script: ${d.why.replace(/^runs a script that looks like /, '')}` };
    }
  }
  return null;
}

// ── Settings → "Scripts and commands" (2026-10-15): in the owner's own runs, commands, scripts and One CLI calls run on
// their own; one asks only when it visibly does a decision the owner keeps (askFor). Never in a client's run, a head's
// hand-off or Orchy fixing himself, and never for Orchy's dashboard, setup, sign-ins, other folders or system changes.
// The kinds of shell work (shellNeedsOwner) that may run there:
const FREE_KINDS = new Set(['network', 'program', 'outside', 'link', 'delete']);
// RISKY_HEADS by what they do: the network, starting programs, file modes; the rest (stopping processes, the registry,
// scheduled tasks, installers, environment, disks, admin rights, sending mail) changes the system and always asks
const NET_HEADS = new Set(['curl', 'wget', 'invoke-webrequest', 'invoke-restmethod', 'iwr', 'irm', 'ssh', 'scp', 'sftp', 'ftp', 'rsync', 'telnet', 'nc', 'ncat']);
const PROGRAM_HEADS = new Set(['start-process', 'start', 'saps', 'start-job', 'invoke-command', 'icm', 'xargs', 'forfiles', 'winpty', 'setsid']);
const FILE_MODE_HEADS = new Set(['chmod', 'chown', 'attrib']);
// RISKY_ANYWHERE's plain network part: .NET web clients, and git reaching a remote with no -c setting (which can name
// a program to run). The rest of it (starting processes, deleting through .NET, git config and aliases) changes the system.
const NET_ANYWHERE = /Net\.WebClient|System\.Net\.(?:WebClient|Http\w*)|HttpClient|\bgit\s+(?:--[\w-]+(?:=\S+)?\s+)*(?:push|clone|fetch|pull)\b/gi;
const writeKind = (why, ws) => (why === SETUP_WHY(ws) ? 'setup' : /outside its folder/.test(why) ? 'outside' : 'unclear');
/** A decision a command line spells as code does (curl …/v1/refunds, chat.postMessage…), as { why }, or null. */
function pieceDecision(text, ctx) {
  for (const x of DECISIONS) if (SCRIPT_DECISIONS[x.key]?.test(text) && asked(x, ctx)) return { why: `looks like ${x.label.toLowerCase()} (${x.hint})` };
  return null;
}
/** The One actions named in some text (conn_mod_def::…), judged like any action: { why } for the first decision, or null. */
async function idsDecision(text, ctx, { none = null } = {}) {
  const ids = [...new Set(String(text).match(/conn_mod_def::[\w-]+::[\w-]+/g) || [])];
  if (!ids.length) return none;
  for (const id of ids) {
    const a = await ctx.resolveAction?.(id);
    if (!a?.title) return { why: 'runs a One action Orchy couldn’t look up' };
    if (isReadOnlyAction(a.method, a.title)) continue;
    const d = decisionFor(a.title, a.platform);
    if (asked(d, ctx)) return { why: `runs "${a.title}": ${d.label.toLowerCase()} (${d.hint})` };
  }
  return null;
}
/** A flow's file: <dir>/.one/flows/<key>/flow.json or <key>.flow.json, from where the command runs or the workspace. */
function flowText(key, dirs) {
  for (const d of dirs) for (const p of [path.join(d, '.one', 'flows', key, 'flow.json'), path.join(d, '.one', 'flows', `${key}.flow.json`)]) {
    try { return readText(p); } catch {}
  }
  return null;
}
// the One subcommands free mode lets run (flows and actions, judged by what they run; memory, sync and cache are
// One's own records). Anything else (init, login, add, config, relay…) can change which account or connections the
// folder uses, or set up something that runs later outside the gate: it asks as before.
const ONE_FREE = /^(?:flow|f|actions?|a|mem|sync|cache)\b/i;
/** A `one …` call that isn't a plain read or a parsed action: what it does that the owner keeps, as { why }, or null. */
async function oneOtherDecision(c, command, cwd, ws, ctx) {
  const rest = String(c.rest ?? '').trim();
  if (/(^|\s)(--help|-h)(\s|$)/.test(rest)) return null;
  if (!ONE_FREE.test(rest)) return { why: `runs \`one ${c.sub}\`, which can change this workspace’s One account, connections or relays` };
  const flow = rest.match(/^(?:flow|f)\s+(?:execute|run|exec)\s+['"]?([\w.-]+)/i);
  if (flow) {
    const text = flowText(flow[1], [cwd, ws.dir]);
    if (text == null) return { why: `runs the One flow "${flow[1]}", which Orchy couldn’t find to read first` };
    return pieceDecision(text, ctx) || idsDecision(text, ctx);
  }
  // `one actions execute` with its action in a variable or a loop: judged by the IDs the line names
  if (/^(?:actions?|a)\s+(?:execute|x)\b/i.test(rest)) return idsDecision(command, ctx, { none: { why: 'runs a One action without naming it, so Orchy can’t tell what it does' } });
  return null;
}
/** Can a line run a One action or flow at all (`which one`, `cat $(which one)` and `--help` can't)? */
const mayRunOne = command => /\b(execute|exec|run|create|trigger|x)\b(?!\s+(--help|-h)\b)/i.test(String(command));
/** Does a delete name the workspace's setup, or the folder that holds it (rm -rf ., rm -rf ../ws, rm -rf *)? */
function deletesSetup(seg, cwd, ws, ctx, shell) {
  return shellWords(seg, shell).slice(1).some(w => {
    if (/^-/.test(w.word) || /^\/[a-z]$/i.test(w.word)) return false;
    const abs = realPath(w.word, cwd);
    return inRoots(ws.dir, [abs]) || setupFile(abs, ws, ctx) || setupPattern(w.raw, cwd, ws, ctx, shell) || setupPattern(w.word, cwd, ws, ctx, shell);
  });
}
/**
 * A delete whose targets all land in the run's folder or the temp folder, read the way the line spells them:
 * variables set earlier in the line ($R, ${D}) and $TEMP/$TMP filled in, `..` followed. Its setup, .git and other
 * clients' sandboxes stay out, and so does a target Orchy still can't read (an unknown variable).
 */
function deleteInWork(seg, cwd, command, ws, ctx) {
  const vars = {};
  for (const m of String(command).matchAll(/(?:^|[;&|\s])([A-Za-z_]\w*)=("[^"$`]*"|'[^']*'|[^\s"'$`;|&]+)(?=[\s;|&]|$)/g)) vars[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  const fill = t => t.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (m, v) => (/^(TEMP|TMP)$/i.test(v) ? os.tmpdir() : vars[v] ?? m));
  const tokens = seg.match(/"[^"]*"|'[^']*'|[^\s]+/g) || [];
  if (!DELETES.test(headOf(tokens[0] || ''))) return false;
  const targets = tokens.slice(1).filter(t => !/^-/.test(t) && !/^\/[a-z]$/i.test(t)).map(t => fill(t.replace(/^['"]|['"]$/g, '')));
  if (!targets.length) return false;
  const roots = [ctx.home || ws.dir, ...workRoots(ws).slice(1)];
  return targets.every(t => {
    if (/[$%`]|^~/.test(t)) return false;
    const abs = realPath(t, cwd);
    const root = roots.find(r => insideDir(abs, r));
    if (!root || tildeBelow(abs, root)) return false;
    if (/(^|[\\/])(\.clients|\.git|\.claude|\.jos|\.codex|\.cursor)([\\/]|$)/i.test(path.relative(ws.dir, abs)) || setupFile(abs, ws, ctx)) return false;
    return !/[*?[]/.test(t) || path.basename(t).replace(/[*?[\]]/g, '').replace(/[^A-Za-z0-9]/g, '').length >= 2;
  });
}
/**
 * The settings of the harness this run uses (its Claude or Codex profile, ~/.claude.json): hooks and permissions there
 * run in every later run, past the approval gate. Not the run's own session folder, where Claude parks tool results.
 */
function harnessPlace(piece, dirs, ws) {
  const home = os.homedir();
  const places = [...profileDirs(ws), path.join(home, '.claude.json'), ...(ws.claudeConfigDir ? [path.join(expandPath(ws.claudeConfigDir), '.claude.json')] : [])];
  const work = [workRoots(ws)[2]]; // its own session folder
  for (const t of String(piece).match(/"[^"]*"|'[^']*'|[^\s;|&()<>=,]+/g) || []) {
    if (/^['"]?[a-z][\w+.-]*:\/\//i.test(t)) continue; // a URL
    for (const d of dirs) {
      const abs = realPath(t, d);
      if (inRoots(abs, places) && !inRoots(abs, work)) return true;
    }
  }
  return false;
}
/** Free mode: why a piece of shell work that may run on its own still asks, as { why }, or null. */
function freeDecision(n, command, ws, ctx, cwd) {
  const del = DECISIONS.find(x => x.key === 'delete');
  if (harnessPlace(n.piece, [...new Set([n.cwd || cwd, cwd])], ws)) return { why: 'changes the settings of the harness this run uses, which every later run loads' };
  // deleting: files in its folder or the temp folder go; elsewhere it's the "Deleting" decision
  if (n.kind === 'delete') return asked(del, ctx) && !(n.seg && deleteInWork(n.seg, n.cwd || cwd, command, ws, ctx)) ? { why: 'deletes files outside its folder' } : null;
  // a program that runs a delete it's handed (xargs rm, setsid rm -rf …) can't be checked for where: Deleting decides
  if (n.kind === 'program' && /(^|[\s'"(;&|])(rm|del|erase|rmdir|rd|remove-item|ri)(?=[\s'")]|$)/i.test(n.piece) && asked(del, ctx)) return { why: 'deletes files Orchy can’t check first' };
  return pieceDecision(n.piece, ctx);
}

const WRITE_HEADS = new Set(['cp', 'mv', 'copy', 'move', 'mkdir', 'md', 'touch', 'tee', 'tee-object', 'install', 'dd', 'set-content', 'add-content', 'out-file', 'new-item', 'ni', 'copy-item', 'cpi', 'move-item', 'mi', 'rename-item', 'rni', 'ren', 'export-csv', 'export-clixml']);
const headOf = w => w.split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
const CD = /^(?:cd|chdir|set-location|sl|pushd|push-location)\s+(?:-(?:Literal)?Path\s+)?(.+?)\s*$/i;
// what runs the command after it: `do rm x`, `then curl …`, `time node x.js`, `timeout 30 curl …`, `env A=1 sh x.sh`
const WRAPPER = /^(?:(?:do|then|else|elif|if|while|until|!|time|nohup|command|builtin|exec|nice(?:\s+-n)?(?:\s+-?\d+)?|timeout(?:\s+-\S+)*\s+\S+|env(?:\s+-\S+)*(?:\s+\w+=\S*)*|stdbuf(?:\s+-\S+)*)\s+)+(?=\S)/i;
const DELETES = /^(rm|del|erase|rmdir|rd|remove-item|ri|clear-content|clear-recyclebin)$/;
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CD_HEADS = new Set(['cd', 'chdir', 'set-location', 'sl', 'pushd', 'push-location']);
// a place guaranteed outside every work root, for a `cd` Orchy can't follow: a bare cd (HOME), `cd -`, a PowerShell drive
const ELSEWHERE = POSIX ? '/\u0001orchy-elsewhere' : 'Z:\\\u0001orchy-elsewhere';
/**
 * The working folder after a `cd`/`Set-Location`/`pushd` piece, or null when the piece isn't one. Reads past wrappers,
 * a quoted or escaped `cd`, bash options (`-P`, `--`) and PowerShell `-Path:`/`-LiteralPath`. A target Orchy can't
 * follow (bare cd → HOME, `cd -` → previous, a PowerShell drive HKCU:/Env:/FileSystem::) resolves to ELSEWHERE (outside).
 */
function cdResolve(piece, cwd, shell) {
  const ps = shell === 'PowerShell';
  const words = shellWords(String(piece).replace(WRAPPER, ''), shell);
  if (!words.length || !CD_HEADS.has(headOf(words[0].word))) return null;
  let tgt = null;
  for (let k = 1; k < words.length; k++) {
    const w = words[k].word;
    if (ps) {
      const m = w.match(/^-(?:literal)?path:?(.*)$/i);
      if (m) { tgt = m[1] || words[++k]?.word || ''; break; }
      if (/^-/.test(w)) continue;
    } else {
      if (w === '--') { tgt = words[k + 1]?.word ?? ''; break; }
      if (/^-/.test(w)) continue; // bash `cd -P`, `-L`, `-e`, `-@`
    }
    tgt = w; break;
  }
  if (tgt == null || tgt === '' || tgt === '-') return ELSEWHERE;
  if (ps && (PS_DRIVE.test(tgt) || PS_PROVIDER.test(tgt))) return ELSEWHERE;
  if (/^[\\/]{2}/.test(tgt)) return ELSEWHERE; // a network or device path is never the agent's folder (as in off())
  return realPath(tgt, cwd);
}
// programs that copy or move into a destination (so <dest>/<source-basename> is what they touch) beyond WRITE_HEADS
const COPY_HEADS = new Set(['cp', 'mv', 'copy', 'move', 'copy-item', 'cpi', 'move-item', 'mi', 'install', 'xcopy', 'robocopy']);
const baseName = p => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
/**
 * The extra places a copy/move/extract/split/patch/awk head writes that aren't the plain word list: a destination
 * folder joined with each source's basename (`cp a .` → ./a), a `-t`/`--target-directory` (glued forms too), an
 * archive's output folder (tar -C, unzip -d, 7z -o, Expand-Archive), a split prefix, an in-place awk/patch target.
 * Returns { words, why }: word-objects for writeWordWhy, and a reason when the target can't be seen (patch < x.diff).
 */
function writeHeadExtra(seg, shell, cwd) {
  const words = shellWords(seg, shell);
  if (!words.length) return { words: [], why: null };
  const head = headOf(words[0].word);
  const args = words.slice(1), out = [];
  const place = (p, raw) => ({ word: String(p), loose: String(p), raw: raw ?? String(p), target: true });
  const join = (d, s) => `${String(d).replace(/[\\/]+$/, '')}/${baseName(s)}`;
  const ps = shell === 'PowerShell';
  const positionals = args.filter(w => !/^-/.test(w.word)).map(w => w.word);
  const targetDir = () => {
    for (let k = 0; k < args.length; k++) {
      const w = args[k].word;
      let m = w.match(/^--target-directory(?:=(.*))?$/i);
      if (m) return m[1] != null ? m[1] : args[k + 1]?.word;
      const d = ps && w.match(/^-destination:?(.*)$/i); // PowerShell -Destination
      if (d) return d[1] || args[k + 1]?.word;
      m = !ps && w.match(/^-[a-z]*t(.*)$/i); // GNU cp/mv/install short -t / -vt / -Dt (glued target)
      if (m) return m[1] || args[k + 1]?.word;
    }
    return null;
  };
  const gitMv = head === 'git' && /^\s*git\s+mv\b/i.test(seg);
  if (COPY_HEADS.has(head) || gitMv) {
    const base = gitMv ? positionals.slice(2) : positionals;
    let srcs, dest;
    const t = targetDir();
    if (t != null) { dest = t; srcs = base; }
    else if (head === 'robocopy') { dest = base[1]; srcs = base.slice(2); } // robocopy SRC DST [file …]
    else { dest = base[base.length - 1]; srcs = base.slice(0, -1); }
    if (dest != null && dest !== '') {
      out.push(place(dest));
      for (const s of srcs) out.push(place(join(dest, s)));
      // a whole folder's contents copied in (cp -r x/. ., cp x/* .): the files are unknown, so could be setup
      const contents = /(?:^|\s)-\S*[rRa]|--recursive\b/.test(seg) || srcs.some(s => /[*?[]|[\\/]\.?\*?$/.test(s));
      if (contents) for (const name of ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'GEMINI.md', '.claude', '.codex', '.one', '.agents', '.mcp.json', '.jos', 'Resources']) out.push(place(join(dest, name)));
    }
  } else if (head === 'git' && /\bgit\s+(?:-[cC]\s+\S+\s+)*(?:checkout|restore)\b/i.test(seg)) {
    // git checkout <ref> -- <paths> / git restore <paths>: each path is overwritten from another version
    const restore = /\brestore\b/i.test(seg);
    const dd = args.findIndex(w => w.word === '--');
    const paths = dd >= 0 ? args.slice(dd + 1) : restore ? args.filter(w => !/^-/.test(w.word)).slice(1) : [];
    for (const w of paths) out.push(place(w.word, w.raw));
  } else if (head === 'tar') {
    const m = seg.match(/(?:^|\s)-C\s*([^\s;|&]+)|--directory(?:[=\s]+)([^\s;|&]+)/i);
    if (m) out.push(place(m[1] || m[2]));
  } else if (head === 'unzip') {
    const m = seg.match(/(?:^|\s)-d\s*([^\s;|&]+)/i); if (m) out.push(place(m[1]));
  } else if (head === '7z' || head === '7za' || head === '7zr') {
    const m = seg.match(/(?:^|\s)-o\s*([^\s;|&]+)/i); if (m) out.push(place(m[1]));
  } else if (head === 'expand-archive') {
    const m = seg.match(/-destinationpath\s+([^\s;|&]+)/i);
    const d = m ? m[1] : positionals[1];
    if (d) out.push(place(d));
  } else if (head === 'split') {
    const p = positionals[positionals.length - 1]; if (p) out.push(place(p)); // output prefix
  } else if (head === 'patch') {
    const files = positionals.filter(p => !/\.(diff|patch)$/i.test(p));
    if (files.length) for (const f of files) out.push(place(f));
    else return { words: [], why: 'edits files in place that Orchy can’t see first (a patch from standard input)' };
  } else if ((head === 'awk' || head === 'gawk') && /-i(?:nplace)?\b|--in-?place\b/i.test(seg)) {
    const p = positionals[positionals.length - 1]; if (p) out.push(place(p)); // the file gawk rewrites
  }
  return { words: out, why: null };
}
const mentions = (text, name) => new RegExp(`(^|[\\s'"/\\\\=>])${reEsc(name)}($|[\\s'";|&)])`, 'i').test(text);
const firstWords = s => String(s).trim().split(/\s+/).slice(0, 2).join(' ');
/**
 * The literal text an earlier piece on the same line put into `file` (echo/printf/Set-Content or a redirect into it),
 * so a script written and run in one line is judged by what was written, not by its name. Null when a piece touches
 * the file in a way Orchy can't read (cp/mv it), undefined when nothing earlier wrote it.
 */
function writtenInline(file, segs, i, shell) {
  const base = path.basename(String(file));
  for (let k = i - 1; k >= 0; k--) {
    const p = segs[k];
    if (cdResolve(p, '.', shell) != null) continue;
    const tgts = redirectTargets(p, shell).map(w => path.basename(w.word));
    const ps = PS_WRITE.test(p) && new RegExp(`(^|[\\s'"/\\\\])${reEsc(base)}($|[\\s'"])`).test(p);
    if (tgts.includes(base) || ps) {
      // the content: the piece minus its write head and the redirect target, quotes peeled off
      const raw = p.replace(/^[^>]*?\b(?:echo|printf|cat|Set-Content|Add-Content|Out-File|tee|Tee-Object)\b/i, '')
        .replace(/\d?>>?\s*\S+/g, '');
      // what the shell writes is not the literal text when it expands or decodes something (\x2e, %b, $'…',
      // $(…), `…`, $var): Orchy can't read that script first. The file's own name may hold a \ (.\s.ps1).
      const body = raw.split(/\s+/).filter(w => !w.includes(base)).join(' ');
      if (/\\|%[bq]|\$['"({\[A-Za-z_]|`/.test(body)) return null;
      return raw.replace(/['"`]/g, ' ');
    }
    if (mentions(p, base)) return null; // touched it some other way (a cp/mv): Orchy can't tell what it holds
  }
  return undefined;
}
/** In decisions mode: the pieces of a shell line that need the owner, as [{ why, piece }] (none: it may run). Starts in cwd. */
function shellNeedsOwner(command, ws, ctx, cwd, shell, out = []) {
  const roots = workRoots(ws);
  let cands = [cwd]; // cands: every place a piece may run from (a cd might not run)
  const { text, docs } = heredocs(command, shell);
  const segs = splitShell(text, shell);
  const vars = {};
  const nested = (s, at) => { for (const b of scanShell(s, shell).subs) if (b.trim() && !VALUE.test(b.trim()) && !shellIsSafe(b, shell)) shellNeedsOwner(b, ws, ctx, at, shell, out); };
  // kind: what Settings → "Scripts and commands" weighs (decideOnce's free mode): network, program, outside, link and
  // delete may run there; setup, system, opaque and unclear always ask
  if (RISKY_ANYWHERE.test(text)) out.push({ why: 'reaches the network or changes the system', kind: RISKY_ANYWHERE.test(text.replace(NET_ANYWHERE, ' ')) ? 'system' : 'network', cwd, piece: segs.find(s => RISKY_ANYWHERE.test(s)) || command });
  if (OPAQUE.test(text)) out.push({ why: 'runs code worked out at run time that Orchy can’t read first', kind: 'opaque', cwd, piece: segs.find(s => OPAQUE.test(s)) || command });
  // a here-document without quotes around its EOF runs the $(…) and `…` in it
  for (const d of docs) if (!d.literal && !d.script) nested(`"${d.body.replace(/"/g, ' ')}"`, cwd);
  segs.forEach((piece, i) => {
    const add = (why, kind, more = {}) => { out.push({ why, piece, kind, cwd, ...more }); };
    const nc = cdResolve(piece, cwd, shell);
    if (nc != null) { cwd = nc; cands = nextDirs(cands, piece, i, shell) || [ELSEWHERE]; return; } // where it works decides what its writes touch
    const set = shell !== 'PowerShell' && piece.match(/^([A-Za-z_]\w*)=(?:"([^"$`]*)"|'([^']*)'|([^\s"'$`]*))$/);
    if (set) vars[set[1]] = set[2] ?? set[3] ?? set[4];
    nested(piece, cwd); // what it nests runs too: $(…), (…), {…}, `…`
    // past `do`, `time`, `timeout 30`, `env`…, and a Bash variable naming the program, as set earlier in the line
    const seg = piece.replace(WRAPPER, '').replace(/^"?\$\{?([A-Za-z_]\w*)\}?"?(?=\s|$)/, (m, v) => vars[v] ?? m);
    if (computedHead(seg, shell)) return add('runs a program Orchy can’t name first', 'program');
    // FOO=1 curl …: the program after the assignments is judged as well
    const rest = shell === 'PowerShell' ? '' : bashRest(seg);
    if (rest && rest !== seg.trim()) shellNeedsOwner(rest, ws, ctx, cwd, shell, out);
    const away = !inRoots(cwd, roots);
    // where its redirects write, whatever it runs (a script, a One call): each target as the shell reads it
    const sent = writeWordWhy(redirectTargets(seg, shell).map(w => ({ ...w, target: true })), cwd, roots, ws, ctx, shell);
    if (sent) add(sent, writeKind(sent, ws), { writes: true }); // and judge what it runs too, so a network or script reason (and its outward flag) stays
    if (ONE_HEAD.test(seg) || (ONE_HEAD.test(unwrapOneCli(seg)) && realOneCli(seg, cwd, roots))) return; // judged action by action above (@withone/cli too)
    const words = commandWords(seg, shell);
    if (INTERPRETERS.has(headOf(words[0] || ''))) {
      // a script written or moved earlier in the same line can't be read before it runs, unless that was
      // a here-document whose text is right here (cat > x.js <<'EOF' … EOF; node x.js)
      const file = scriptFile(seg);
      const earlier = file ? segs.slice(0, i).filter(p => !CD.test(p) && mentions(p, path.basename(file)) && scriptFile(p.replace(WRAPPER, '')) !== file) : [];
      const doc = earlier.length === 1 && /^(cat|tee)\b/.test(earlier[0]) && docs.find(d => d.literal && d.line.includes(earlier[0]));
      // code fed on stdin (python - <<'EOF' … EOF) is read from the here-document
      const fed = !file && /<</.test(seg) && docs.find(d => d.line.includes(seg.split('<<')[0].trim()));
      // a script echoed into a file on this same line is judged by what was echoed
      const inline = file && earlier.length ? writtenInline(file, segs, i, shell) : undefined;
      const code = doc ? doc.body : fed ? fed.body : inline != null ? inline : earlier.length ? null : scriptCode(seg, cwd);
      // script: Settings → Scripts lets these through (ctx.scriptsFree), unless scriptDecision finds a decision in it
      if (code == null) return out.push({ why: 'runs a script Orchy can’t read first', piece, script: true, file, code: null });
      const why = scriptNeedsOwner(code, ws, ctx, roots, away, cwd);
      if (why) out.push({ why, piece, script: true, file, code });
      return;
    }
    for (const w of words) {
      const head = headOf(w);
      if (RISKY_HEADS.has(head)) {
        if (w === words[0] && freeDelete(seg, cwd, ws, ctx)) continue; // tidying files in its own folder
        if (DELETES.test(head)) return add('deletes files', deletesSetup(seg, cwd, ws, ctx, shell) ? 'setup' : 'delete', { seg });
        return add('reaches the network or changes the system', NET_HEADS.has(head) ? 'network' : PROGRAM_HEADS.has(head) ? 'program' : FILE_MODE_HEADS.has(head) ? 'outside' : 'system');
      }
      if (SCRIPT_HEADS.has(head) || /\.(ps1|sh|bat|cmd|js|mjs|py)$/i.test(w)) {
        let file = seg.split(/\s+/).map(x => x.replace(/^['"]|['"]$/g, '')).find(x => /\.(ps1|sh|bash|bat|cmd|js|mjs|cjs|py)$/i.test(x));
        // a shell given a bare filename (sh s): its first non-option word
        if (!file && /^(sh|bash|zsh|dash)$/.test(head)) file = shellWords(seg, shell).slice(1).map(x => x.word).find(a => !/^-/.test(a));
        let code = null;
        const inline = file ? writtenInline(file, segs, i, shell) : undefined;
        if (inline != null) code = inline;
        else if (file) try { const p = realPath(file, cwd); if (fs.statSync(p).size < 300_000) code = fs.readFileSync(p, 'utf8'); } catch {}
        return out.push({ why: 'runs a script, which could do anything', piece, script: true, file, code });
      }
    }
    if (/^find\b/i.test(seg)) {
      if (/\s-delete\b/i.test(seg)) return add('deletes files', 'delete');
      const run = seg.match(/\s-(?:exec|execdir|ok|okdir)\s+(.+?)(?:\s+\\?;|\s+\+)?\s*$/i);
      if (run) shellNeedsOwner(run[1], ws, ctx, cwd, shell, out);
    }
    if (words.some(w => /^(ln|mklink)$/.test(headOf(w))) || /\b(junction|symboliclink|hardlink)\b/i.test(seg)) return add('makes a link to somewhere else', 'link');
    // a climb (..) that keeps inside from every place the piece may run from (a cd before it might not have run) is its own work
    if (outsidePaths(ownWordsOut(seg, shell, cwd, roots), roots, { climbsOk: climbsInside(seg, shell, cands, roots) })) return add('touches files outside its folder', 'outside');
    const sedIn = /^sed\b/i.test(seg) && /\s(?:-[a-zA-Z]*i|--in-place\b)/.test(seg), heads = words.some(w => WRITE_HEADS.has(headOf(w)));
    const extra = writeHeadExtra(seg, shell, cwd); // cp/mv into a folder, tar -C, unzip -d, 7z -o, split, patch, awk -i
    if (extra.why) return add(extra.why, 'unclear');
    const outs = optionTargets(seg, shell);
    const writes = writesViaRedirect(seg, shell) || sedIn || heads || outs.length > 0 || extra.words.length > 0;
    if (writes && away) return add('writes files outside its folder', 'outside', { writes: true });
    // a PowerShell write that works its path out at run time (a parent, a drive, $pwd, a .NET call) can't be checked
    if (writes && shell === 'PowerShell' && (PATH_BUILD.test(seg) || /\$(?:pwd|PWD)\b[\\/]/.test(seg))) return add('works out a path Orchy can’t check', 'unclear');
    if (writes && setupNamed(seg.replace(/^\S+/, ''), cwd, ws, ctx)) return add(SETUP_WHY(ws), 'setup');
    // what it writes to, read as the shell reads it: an --output file, sed -i's files, every word of a command that writes
    if (writes) {
      // (dd writes only its of=: if=/dev/zero is what it reads)
      const dd = !sedIn && words.some(w => headOf(w) === 'dd') && words.every(w => !WRITE_HEADS.has(headOf(w)) || headOf(w) === 'dd');
      const all = shellWords(seg, shell).slice(1).filter(w => !(dd && /^(?!of=)[a-z]+=/i.test(w.word)));
      const why = writeWordWhy([...outs, ...extra.words, ...(sedIn ? sedTargets(all) : heads ? all : []), ...(sedIn || heads ? bashSubWords(seg, shell) : [])], cwd, roots, ws, ctx, shell);
      if (why) return add(why, writeKind(why, ws), { writes: true });
    }
  });
  return out;
}

/**
 * The line with each redirect into its own folder by a quoted path with a space in it (> "C:/…/Alpha Studio/x.md")
 * taken out: one word to the shell, where outsidePaths would read "C:/…/Alpha" and a second word. writeWordWhy has
 * judged it whole already. Not one that expands ($, `), climbs (..) or names a second place. Bash only, as before
 * the redirect check (PowerShell's > "C:/…/a b/x" has always asked).
 */
function ownWordsOut(seg, shell, cwd, roots) {
  let s = String(seg);
  if (shell === 'PowerShell') return s;
  for (const w of redirectTargets(s, shell).reverse()) {
    if (!/\s/.test(w.word) || /[$`*?[{~]/.test(w.raw) || !/^([A-Za-z]:[\\/]|\/(?!\/))/.test(w.word)) continue;
    if (/[A-Za-z]:[\\/]|[\\/]{2}|(^|[\\/])\.\.([\\/]|$)/.test(w.word.slice(2))) continue;
    if (inRoots(realPath(w.word, cwd), roots)) s = `${s.slice(0, w.end - w.raw.length)}""${s.slice(w.end)}`;
  }
  return s;
}

/** Bash words a `…` or $(…) splits where shellWords can't see them whole (.clau`true`de): as written, for the setup check. */
function bashSubWords(seg, shell) {
  const s = String(seg), out = [];
  if (shell === 'PowerShell') return out;
  for (let i = 0; i < s.length;) {
    const end = /[\s;|&<>()]/.test(s[i]) ? i : bashWordEnd(s, i);
    if (end === i) { i++; continue; }
    if (/`|\$\(/.test(s.slice(i, end))) out.push({ word: '', loose: '', raw: s.slice(i, end) });
    i = end;
  }
  return out;
}

/** Files a command writes through an option: --output=x, --output x (git diff, …), sort -o x. */
function optionTargets(seg, shell) {
  const words = shellWords(seg, shell), out = [];
  const take = (w, v, loose) => out.push({ ...w, word: v, loose, target: true });
  for (let k = 1; k < words.length; k++) {
    const w = words[k], m = w.word.match(/^--(?:output|output-file|out-file)(?:=(.*))?$/i);
    const o = !m && headOf(words[0].word) === 'sort' && w.word.match(/^-[a-zA-Z]*?o(.*)$/);
    if (m && m[1] != null) take(w, m[1], w.loose.replace(/^[^=]*=/, ''));
    else if (o && o[1]) take(w, o[1], w.loose.replace(/^-[a-zA-Z]*?o/, ''));
    else if ((m || o) && words[k + 1]) { k++; take(words[k], words[k].word, words[k].loose); }
  }
  return out;
}

/**
 * What `sed -i` writes, from the words after `sed`: its files (past its options and its script, given by -e/-f or
 * as the first word), a backup suffix that names a folder (-i'bak/*'), and the files its script's w command writes.
 * The script itself is judged only for setup names: /^$/d is an address, not the root.
 */
function sedTargets(words) {
  const out = [], scripts = [], pos = [];
  let given = false, opts = true;
  const arg = (k, rest) => (rest ? { k, v: rest } : { k: k + 1, v: words[k + 1]?.word });
  for (let k = 0; k < words.length; k++) {
    const t = words[k].word;
    if (!opts || !/^-./.test(t)) { pos.push(words[k]); continue; }
    if (t === '--') { opts = false; continue; }
    if (t.startsWith('--')) {
      const m = t.match(/^--(expression|file|line-length|in-place)(?:=(.*))?$/);
      if (m?.[1] === 'in-place') { if (m[2] != null) out.push({ ...words[k], word: m[2], loose: m[2], suffix: true }); continue; }
      if (!m) continue;
      const a = m[2] != null ? { k, v: m[2] } : arg(k, '');
      k = a.k;
      if (m[1] !== 'line-length') { given = true; if (m[1] === 'expression' && a.v != null) scripts.push(a.v); }
      continue;
    }
    for (let j = 1; j < t.length; j++) {
      const c = t[j], rest = t.slice(j + 1);
      if (c === 'i') {
        // -i.bak, -i'bak/*'; BSD sed's -i '' and -i .bak
        if (rest) out.push({ ...words[k], word: rest, loose: rest, suffix: true });
        else if (t === '-i' && /^(\.\w*)?$/.test(words[k + 1]?.word ?? '-')) k++;
        break;
      }
      if (c === 'e' || c === 'f' || c === 'l') {
        const a = arg(k, rest);
        k = a.k;
        if (c !== 'l') { given = true; if (c === 'e' && a.v != null) scripts.push(a.v); }
        break;
      }
    }
  }
  if (!given && pos.length) scripts.push(pos.shift().word);
  for (const s of scripts) {
    for (const m of String(s).matchAll(/(?:^|[\s;{}\d$!/]|\/[gpiImMe\d]+)[wW]\s+([^\n]+)/gm)) out.push({ word: m[1].trim(), loose: m[1].trim(), raw: m[1] });
    out.push({ word: s, loose: s, raw: s, setupOnly: true });
  }
  return [...out.filter(w => !w.suffix || /[\\/]/.test(w.word)).map(w => (w.suffix ? { ...w, word: w.word.replace(/\*/g, 'x'), target: true } : w)),
    ...pos.map(w => ({ ...w, target: true }))];
}

// a word that names a place by itself: a drive (C:\, C:/), a network or device path (\\host, //host, \\?\), a climb
// (a/../..), a root (\Users\x, /etc/x: on Windows the current drive's; not a switch like /Y)
const PLACE_WORD = /^([A-Za-z]:[\\/]|[\\/]{2}|[\\/](?![\w?]{1,2}$)(?=[^\s\\/]\S*$))|(^|[\\/])\.\.([\\/]|$)/;
/**
 * Why a write needs the owner by the words it writes to, each as the shell reads it (quotes and escapes off) and as
 * written: a place outside its folder ("C:/a b/../../x", \\localhost\c$\x) or its setup (".claude/settings.json",
 * .clau""de/x). Null when every one stays inside. In PowerShell a provider's path (FileSystem::\\host\x, Registry::…)
 * and another drive (HKCU:\…, Env:) are places too.
 */
const PS_PROVIDER = /^(?:[\w.]+\\)?([\w.]+)::/;
const PS_DRIVE = /^(?:(?:HKCU|HKLM|HKCR|HKU|HKCC|Env|Variable|Function|Alias|Cert|WSMan):(?:[\\/]|[\w.-]*$)|[A-Za-z][\w.]+:[\\/])/i;
function writeWordWhy(words, cwd, roots, ws, ctx, shell) {
  const ps = shell === 'PowerShell';
  for (const w of words) {
    // a target whose leading folder is worked out at run time ($(…), `…`, ${…}) can't be checked: a known in-folder
    // prefix (Tasks/$(date).md) or a computed leaf name (`date +%F`.txt) is fine, a computed folder ahead of a
    // separator (`$(dirname $PWD)/x`, `` `dirname $PWD`/x ``) isn't
    if (w.target) {
      const parts = String(w.raw ?? w.word).replace(/^['"]+/, '').split(/[\\/]/);
      if (parts.length > 1 && /\$\(|`|\$\{/.test(parts[0])) return 'writes to a path Orchy can’t work out';
    }
    const seen = new Set([w.word, w.loose, w.word.replace(/^-{1,2}[\w-]+[=:]/, ''), w.word.replace(/^\w+=/, '')]);
    // a ${var:-default} / ${var:=default} falls back to its default, which may itself be a place (../x, CLAUDE.md)
    for (const m of String(w.raw ?? w.word).matchAll(/\$\{[^}]*:[-=?+]([^}]*)\}/g)) if (m[1]) seen.add(m[1]);
    // PowerShell takes a comma list of paths (Set-Content x.txt,..\y.txt): judge each one
    if (ps) for (const t of [w.word, w.loose]) if (t.includes(',')) for (const p of t.split(',')) if (p) seen.add(p);
    for (const t of seen) {
      if (!t || NO_FILE.test(t) || /^[a-z][\w+.-]*:\/\//i.test(t)) continue; // nothing, the null device, a URL
      if (w.setupOnly) {
        if (SETUP_NAMES.test(t) && setupFile(realPath(t, cwd), ws, ctx)) return SETUP_WHY(ws);
        continue;
      }
      if (ps && PS_PROVIDER.test(t)) {
        if (!/^filesystem$/i.test(t.match(PS_PROVIDER)[1])) return 'writes files outside its folder';
        seen.add(t.replace(PS_PROVIDER, '')); // judged as the path it names (a Set takes it in this same loop)
        continue;
      }
      if (ps && PS_DRIVE.test(t)) return 'writes files outside its folder';
      if (UNC_PATH.test(t)) return 'writes files outside its folder';
      const abs = realPath(t, cwd);
      if ((w.target || PLACE_WORD.test(t)) && !inRoots(abs, roots)) return 'writes files outside its folder'; // a redirect's target is a path, whatever it looks like
      if ((SETUP_NAMES.test(t) && setupFile(abs, ws, ctx)) || setupPattern(t, cwd, ws, ctx, shell)) return SETUP_WHY(ws);
    }
    if (!w.setupOnly && w.raw && setupPattern(w.raw, cwd, ws, ctx, shell)) return SETUP_WHY(ws);
  }
  return null;
}

// ── A workspace's own setup: what its agents load (settings, hooks, skills, agents, instructions, MCP servers) ──
// Agents keep working files in .jos (tmp/, state/, ledgers) and .agents (notes the marketing skills share, like
// product-marketing.md): only .jos's mcp.json and retired/, and .agents/skills, are setup there. Changing
// setup asks the owner in every run, except the AI Agent Builder writing agent files (and retiring them) and Resources/.
// .agents also holds hooks, plugins and rules some harnesses load (.agents/{plugins,rules}/, .agents/{hooks,plugins,skills}.json),
// and GEMINI.md is an instructions file like CLAUDE.md. Resources/ (the workspace's skills, MCP servers and CLIs in one
// place) is setup too. .one/flows are flows an agent writes for its work: what they run is judged when they run
// (oneOtherDecision), so they aren't setup.
const SETUP_FILES = /^(\.claude|\.codex|\.cursor|\.one(?!\/flows(\/|$))|\.agents\/(skills|plugins|rules)|\.agents\/(hooks|plugins|skills)\.json)(\/|$)|^\.jos\/(mcp\.json|retired)(\/|$)|^(CLAUDE|CLAUDE\.local|AGENTS|GEMINI)\.md$|^\.mcp\.json$|^Resources(\/|$)/i;
const BUILDER_FILES = /^\.claude\/agents(\/[^/]*)?$|^\.jos\/retired(\/|$)|^Resources(\/|$)/i;
const SETUP_NAMES = /\bResources\b|\.claude\b|\.codex\b|\.cursor\b|\.agents\b|\.jos\b|(^|[\s'"\\/])\.one\b|\bCLAUDE(\.local)?\.md\b|\bAGENTS\.md\b|\bGEMINI\.md\b|\bmcp\.json\b|\bsettings(\.local)?\.json\b|\bretired\b/i;
const SETUP_WHY = ws => `changes ${ws.name}'s own setup (its settings, skills, agents, instructions or connections)`;
/** A path inside the folder as Windows reads it ("CLAUDE.md ", ".claude./x" and "x::$DATA" name the same files), or null. */
function wsRel(p, dir) {
  const rel = path.relative(dir, path.resolve(dir, String(p))).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split('/').map(s => s.replace(/:.*$/, '').replace(/[. ]+$/, '')).join('/');
}
function setupFile(p, ws, ctx) {
  const rel = wsRel(p, ws.dir);
  if (!rel) return false;
  if (SETUP_FILES.test(rel)) return !(ctx.run?.isBuilder && BUILDER_FILES.test(rel));
  return SHORT_NAME.test(rel) && setupLike(rel); // CLAUDE~1\settings.json: Windows' short name for .claude
}

// The setup a name could reach once the shell or Windows fills it in: a wildcard (.clau?e, CLAU*.md, AGENT[S].md), an
// expansion (.clau$()de, .clau${x}de), braces (.clau{de,}) or a short name (CLAUDE~1). A part that is one whole
// variable ("$f", "$OUT/x.md") is judged as written, as it always was.
const SETUP_TOPS = ['.claude', '.codex', '.cursor', '.one', '.agents/skills', '.agents/plugins', '.agents/rules', '.agents/hooks.json', '.agents/plugins.json', '.agents/skills.json', '.jos/mcp.json', '.jos/retired', 'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'GEMINI.md', '.mcp.json', 'Resources'].map(t => t.split('/'));
const ANY = '\u0001';
const FILLED = /\$\([^)]*\)?|\$\{[^}]*\}?|\$(?:[\w:]+|[@*#?!$-]|$)/g;
const SHORT_NAME = /(^|\/)[^/~]{1,6}~\d+(\.[^./]{0,3})?(\/|$)/i;
const FUZZY = /[*?[\u0001]|^[^~]{1,6}~\d+(\.[^.]{0,3})?$/;
function partMatches(g, name) {
  const short = g.match(/^([^~]{1,6})~\d+(?:\.[^.]{0,3})?$/);
  if (short) return name.replace(/[^A-Za-z0-9]/g, '').toLowerCase().startsWith(short[1].replace(/[^A-Za-z0-9]/g, '').toLowerCase());
  if (!FUZZY.test(g)) return g.toLowerCase() === name.toLowerCase();
  if (/^\u0001+$/.test(g)) return false;
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i], close = c === '[' ? g.indexOf(']', i + 2) : -1;
    if (c === '*' || c === ANY) re += '.*';
    else if (c === '?') re += '.';
    else if (close > 0) { re += '.'; i = close; }
    else re += reEsc(c);
  }
  return new RegExp(`^${re}$`, 'is').test(name);
}
/** Could this path inside the folder (as wsRel gives it) be setup once filled in? Only where a part of it is filled in. */
function setupLike(rel) {
  const parts = rel.split('/');
  return SETUP_TOPS.some(top => parts.length >= top.length && top.some((_, i) => FUZZY.test(parts[i])) && top.every((n, i) => partMatches(parts[i], n)));
}
/** Bash's {a,b} and {1..3} spelled out (a few levels, a few dozen forms; a range is any text). */
function braceForms(t, depth = 0) {
  const m = /\{([^{}]*(?:,|\.\.)[^{}]*)\}/.exec(t);
  if (!m || depth > 4) return [t];
  const alts = m[1].includes(',') ? m[1].split(',') : [ANY];
  return alts.flatMap(a => braceForms(t.slice(0, m.index) + a + t.slice(m.index + m[0].length), depth + 1)).slice(0, 64);
}
/** Does a written word (as read, or as written: "$x"de) name the folder's setup once filled in (see setupLike)? */
function setupPattern(t, cwd, ws, ctx, shell) {
  if (!/[*?[{$`~]/.test(t)) return false;
  // Bash runs `…`; PowerShell's ` only escapes the next character
  const filled = String(t).replace(FILLED, ANY).replace(shell === 'PowerShell' ? /`(.?)/g : /`[^`]*`?/g, shell === 'PowerShell' ? '$1' : ANY);
  return braceForms(filled.replace(/["']/g, '')).some(f => {
    const abs = realPath(f, cwd), rel = wsRel(abs, ws.dir);
    return !!rel && (setupLike(rel) || setupFile(abs, ws, ctx));
  });
}
/** Does a command or script that writes name a setup file, or run inside the setup? */
function setupNamed(text, cwd, ws, ctx) {
  if (setupFile(cwd, ws, ctx)) return true;
  const tokens = String(text).match(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|[^\s'"`;|&()<>,=+]+/g) || [];
  return tokens.some(t => SETUP_NAMES.test(t) && setupFile(realPath(t.replace(/^`|`$/g, ''), cwd), ws, ctx));
}

/**
 * A plain delete (rm, del, Remove-Item…) of files inside the run's own folder runs on its own (2026-10-15: agents tidying
 * their scratch files). Not its setup, a client's sandbox, .git, a path Orchy can't read (a variable,
 * ~, ..), a bare wildcard (`rm *`), or a whole folder near the top (`rm -rf Tasks`: a recursive delete reaches two
 * folders down at least, with no wildcard).
 */
function freeDelete(seg, cwd, ws, ctx) {
  const own = ctx.home || ws.dir;
  const tokens = seg.match(/"[^"]*"|'[^']*'|[^\s]+/g) || [];
  if (!DELETES.test(headOf(tokens[0] || ''))) return false;
  let recursive = false;
  const targets = [];
  for (const t of tokens.slice(1)) {
    if (/^-(?:-?recursive|r|R|rf|fr|Rf|fR|Recurse)$/i.test(t) || /^\/s$/i.test(t)) { recursive = true; continue; }
    if (/^-/.test(t) || /^\/[a-z]$/i.test(t)) continue; // -f, -Force, -Path, /q
    targets.push(t.replace(/^['"]|['"]$/g, ''));
  }
  if (!targets.length) return false;
  return targets.every(t => {
    if (/[$%`]|^~|(^|[\\/])\.\.([\\/]|$)/.test(t)) return false;
    const abs = path.resolve(cwd, t);
    const rel = path.relative(path.resolve(own), abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || /~/.test(rel)) return false;
    if (/(^|[\\/])(\.clients|\.git|\.claude|\.jos|\.codex|\.cursor)([\\/]|$)/i.test(rel) || setupFile(abs, ws, ctx)) return false;
    const wild = /[*?[]/.test(t);
    if (wild && path.basename(t).replace(/[*?[\]]/g, '').replace(/[^A-Za-z0-9]/g, '').length < 2) return false;
    if (recursive && (wild || rel.split(/[\\/]/).length < 2)) return false;
    return true;
  });
}

// ── Sign-ins on this PC: another workspace's Claude or Codex profile, any Claude or Codex login file, One's logins ──
// (each workspace's Antigravity and Cursor folders too: its agents' settings, hooks and MCP servers, engines/antigravity.mjs,
// engines/cursor.mjs), Cursor's sign-in file and its own folder (~/.cursor: every workspace's Cursor chats)
const profileDirs = w => [w.claudeConfigDir ? expandPath(w.claudeConfigDir) : path.join(os.homedir(), '.claude'), w.codexHome ? expandPath(w.codexHome) : path.join(os.homedir(), '.codex'), agyRoot(w), cursorRoot(w)];
const samePath = (a, b) => path.relative(path.resolve(a), path.resolve(b)) === '';
/** Which sign-in a path reaches, or null. */
function signInArea(p, ws, ctx) {
  const abs = path.resolve(String(p));
  const own = profileDirs(ws);
  const base = path.basename(abs).toLowerCase();
  if (base === '.credentials.json' || (base === 'auth.json' && (/^\.codex/i.test(path.basename(path.dirname(abs))) || samePath(own[1], path.dirname(abs))))) return 'a sign-in file';
  if (base === 'auth.json' && /^cursor$/i.test(path.basename(path.dirname(abs)))) return 'a sign-in file';
  if (inRoots(abs, [path.join(ctx.oneHome ?? (env('ONE_HOME') || os.homedir()), '.one')])) return 'One’s sign-ins';
  if (inRoots(abs, [path.join(ctx.home ?? os.homedir(), '.cursor')])) return 'Cursor’s own folder (its sign-in state and every workspace’s Cursor chats)';
  const other = (ctx.profileDirs ?? workspaces().filter(w => w.id !== ws.id).flatMap(profileDirs))
    .find(d => !own.some(o => samePath(o, d)) && inRoots(abs, [d]));
  return other ? `another workspace’s sign-in profile (${path.basename(other)})` : null;
}
/** The first sign-in a shell line names, with the piece that names it. */
function shellSignIn(command, ws, ctx, cwd, shell) {
  let dir = cwd;
  for (const piece of splitShell(command, shell)) {
    const cd = piece.match(CD);
    for (const t of piece.match(/"[^"]*"|'[^']*'|[^\s;|&()<>=,]+/g) || []) {
      if (/^['"]?[a-z][\w+.-]*:\/\//i.test(t)) continue; // a URL
      const area = signInArea(realPath(t, dir), ws, ctx);
      if (area) return { area, piece };
    }
    if (cd) dir = realPath(cd[1], dir);
  }
  return null;
}

/** Never mix clients: does the line reach into another workspace's folder (or the retired ones)? */
function otherClientIn(command, ws, ctx) {
  const norm = s => String(s).replace(/\\ /g, ' ').replace(/\\/g, '/').toLowerCase();
  const cmd = norm(command);
  const others = ctx.otherDirs ?? [...workspaces().filter(w => w.id !== ws.id).map(w => w.dir), RETIRED_DIR];
  for (const dir of others) {
    const d = norm(path.resolve(dir));
    const folder = d.split('/').pop();
    const byName = dir !== RETIRED_DIR && (cmd.includes(`${folder}/`) || cmd.includes(`"${folder}"`) || cmd.includes(`'${folder}'`));
    if (cmd.includes(d) || cmd.includes(`../${folder}`) || cmd.includes(d.replace(/^([a-z]):/, '/$1')) || byName) return path.basename(dir);
  }
  return null;
}

/** Where in Orchy a path lands outside the agent's own folder: another workspace's name, 'Orchy' (LOGS.md, Orchy's data…) or null. */
function josArea(p, ws, ctx) {
  const abs = path.resolve(ws.dir, String(p));
  if (inRoots(abs, [ws.dir])) return null;
  const others = ctx.otherDirs ?? [...workspaces().filter(w => w.id !== ws.id).map(w => w.dir), RETIRED_DIR];
  const other = others.find(d => inRoots(abs, [d]));
  if (other) return path.basename(other);
  return inRoots(abs, [ctx.josRoot ?? ROOT]) ? 'Orchy' : null;
}

// ── A run a client started from their own page (portal.mjs) ──
// It never hands work to the workspace's agents that aren't shared with the client, and never changes the
// workspace's own setup (agents, instructions, connections): that waits for the owner (rule keys outside one:/conn:/mcp:
// go to the owner, see clients.mjs#askFields). Claude Code runs also get matching deny rules (clients.mjs#clientDenyRules).
const SETUP_REL = /(^|\/)(\.claude|\.codex|\.cursor|\.agents|\.jos|\.one)(\/|$)|(^|\/)(CLAUDE|AGENTS|GEMINI)\.md$|^\.mcp\.json$/i;
const SETUP_WORDS = /\.claude\b|\.codex\b|\.cursor\b|\.agents\b|\.jos\b|(^|[\s'"\\/])\.one\b|CLAUDE\.md|AGENTS\.md|GEMINI\.md|\.mcp\.json/i;
function setupPath(p, ws) {
  const rel = wsRel(p, ws.dir);
  return !!rel && SETUP_REL.test(rel);
}
function clientRunLimits(toolName, input, { run, ws, clientAgents, wsAgents = [] }) {
  const who = run.clientName || 'the client';
  const helper = (toolName === 'Task' || toolName === 'Agent') && String(input.subagent_type || '');
  if (helper && wsAgents.includes(helper) && !clientAgents.includes(helper)) {
    return { decision: 'deny', reason: `${helper} isn't shared with ${who}, so it can't help with this task. Do it yourself or say what's missing in your report.` };
  }
  const file = EDIT_TOOLS.has(toolName) ? input.file_path || input.notebook_path || input.path : null;
  if (file && setupPath(file, ws)) {
    return { decision: 'ask', reason: `This changes ${ws.name}'s own setup (agents, instructions or connections) during ${who}'s run`, summary: `${toolName} ${path.basename(String(file))} in ${ws.name}'s setup`, detail: String(file), ruleKey: `setup:${toolName}` };
  }
  const command = SHELL_TOOLS.has(toolName) ? String(input.command || '') : '';
  if (command && SETUP_WORDS.test(command) && !shellIsSafe(command, toolName)) {
    return { decision: 'ask', reason: `This command touches ${ws.name}'s own setup (agents, instructions or connections) during ${who}'s run`, summary: `Run a command: ${command.trim().split(/\s+/).slice(0, 2).join(' ')}`, detail: command, ruleKey: 'setup:shell' };
  }
  return null;
}

// ── The fence around a client's run (clientspace.mjs) ──
// It works in <workspace>/.clients/<id>/ and nowhere else. Claude Code already refuses reads outside it and sends
// every command here; this is the second lock. Reads and edits outside are refused, other clients' folders and other
// workspaces are refused outright, and a command that could reach elsewhere (a path out, a variable, a script, a link)
// waits for the owner. Scripts can compute any path, so only tiny data-shaping node one-liners run on their own.
const CLIENT_DIRS = /(?:^|[\\/'"\s=(])\.clients(?:[\\/]+([^\\/'"\s)]*))?/gi;
const CLIMB = /(^|[\\/\s'"=(:,;&|])\.\.([\\/\s'"),;&|]|$)/;
const POSIX_ABS = /(^|[\s'"=(,])\/(?!\/)/;                       // /etc/…, / (URLs' // aren't)
const ROOT_REL = /(^|[\s'"=(,])\\/;                                // \Users\…, \\server\share
const DRIVE_ONLY = /(^|[\s'"=(,])[A-Za-z]:(?![\\/])/;             // C:, C:Users (that drive's current folder)
const PS_DRIVES = /(^|[\s'"=(,])(env|hklm|hkcu|hkcr|hku|hkcc|cert|variable|function|alias|wsman|registry)::?/i;
const VARIABLES = /\$[A-Za-z_{(]|%[A-Za-z_]\w*%|`|\$\(/;
const ENV_DUMP = /(^|[\s;&|(])(env|printenv|set|export|declare|compgen)(?=\s*($|[;&|)]))/;
const LINKS = /\b(mklink|ln|junction|symboliclink|hardlink)\b/i;
// moving to another folder (cd.., cd\ included), and PowerShell working a path out ((Get-Item .).Parent, Split-Path…)
const MOVES = /^(cd|chdir|set-location|sl|pushd|popd|push-location|pop-location)(?:$|[.\\/])/i;
const PATH_BUILD = /\.(Parent|Root|PSParentPath|PSPath|PSDrive|Directory|DirectoryName|FullName)\b|\b(Split-Path|Join-Path|Resolve-Path|Convert-Path|Get-PSDrive|Get-Location|GetFolderPath|GetParent)\b|\[(System\.)?(IO\.|Environment\])/i;
const NODE_SAFE_BAN = /\b(require|import|global|globalThis|this|eval|Function|constructor|prototype|__proto__|Reflect|Proxy|module|exports|Buffer|atob|btoa|fromCharCode|fromCodePoint|WebAssembly|Worker|setTimeout|setInterval|queueMicrotask|with)\b|process(?!\.std(in|out)\b)|\\x|\\u|\[\s*['"`]/;
const unquoted = s => String(s).replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');

/** Is this node one-liner pure data shaping (stdin in, text out) with no way to reach files or the network? */
function nodeShapingOnly(seg) {
  const m = seg.match(/^node(?:\.exe)?\s+(?:-e|--eval|-p|--print)\s+(['"])([\s\S]*)\1\s*$/i);
  return !!m && !NODE_SAFE_BAN.test(m[2]);
}

/** Why a command in a client's run waits for the owner, or null. */
function clientShellWhy(command, roots, shell) {
  const c = String(command);
  if (VARIABLES.test(c)) return 'uses variables or sub-commands Orchy can’t check';
  if (CLIMB.test(c)) return 'climbs out of the client’s folder';
  if (splitShell(c, shell).some(seg => commandWords(seg, shell).some(w => MOVES.test(w)))) return 'changes folder, and Orchy can’t follow where to';
  if (PATH_BUILD.test(c)) return 'works out a path Orchy can’t check';
  if (LINKS.test(c)) return 'makes a link to somewhere else';
  if (ENV_DUMP.test(c) || PS_DRIVES.test(c)) return 'reads the computer’s settings';
  if (POSIX_ABS.test(unquoted(c)) || ROOT_REL.test(c) || DRIVE_ONLY.test(c) || outsidePaths(c, roots)) return 'reaches outside the client’s folder';
  for (const seg of splitShell(c, shell)) {
    const head = headOf(commandWords(seg, shell)[0] || '');
    if ((SCRIPT_HEADS.has(head) || /\.(ps1|sh|bat|cmd|js|mjs|cjs|py|ts|vbs)$/i.test(seg.split(/\s+/)[0] || '')) && !nodeShapingOnly(seg)) return 'runs a script, which could reach anything on the computer';
  }
  return null;
}

/** Does any `.clients/<id>` in the text name a client other than this one (or the folder of all of them)? */
function otherClientFolder(text, ownId) {
  for (const m of String(text).matchAll(CLIENT_DIRS)) if ((m[1] || '').toLowerCase() !== String(ownId).toLowerCase()) return true;
  return false;
}

function clientFence(toolName, input, ctx, ws) {
  const { run } = ctx;
  const who = run.clientName || 'the client';
  const readable = [ws.dir, ...(ctx.readRoots || [])];
  const deny = reason => ({ decision: 'deny', reason });
  const off = `That's outside ${who}'s folder, which is all this task can use. Work with the files here.`;
  if (READ_TOOLS.has(toolName)) {
    if (/^\s*file:/i.test(String(input.url || ''))) return deny('Local files can’t be fetched. Use the files in this folder.');
    const glob = toolName === 'Glob' && input.pattern ? path.resolve(ws.dir, input.path || '', String(input.pattern).split(/[*?[{]/)[0]) : null;
    const paths = [input.file_path, input.notebook_path, input.path, glob].filter(Boolean);
    if (paths.some(p => otherClientFolder(path.resolve(ws.dir, String(p)).replace(/\\/g, '/'), run.client) && !inRoots(p, [ws.dir]))) return deny('Other clients’ folders are off-limits.');
    if (paths.some(p => !inRoots(path.resolve(ws.dir, String(p)), readable))) return deny(off);
    if (toolName === 'Glob' && CLIMB.test(String(input.pattern || ''))) return deny(off);
    return null;
  }
  if (EDIT_TOOLS.has(toolName)) {
    const file = input.file_path || input.notebook_path || input.path;
    if (!file || !insideDir(file, ws.dir)) return deny(`${off} Save files in this task's folder.`);
    if (setupPath(file, ws)) return deny('That file is part of the setup, not the task: leave it.');
    return { decision: 'allow', reason: `file work inside ${who}'s folder` };
  }
  if (SHELL_TOOLS.has(toolName)) {
    const command = String(input.command || '');
    if (otherClientFolder(command.replace(/\\/g, '/'), run.client)) return deny('Other clients’ folders are off-limits.');
    const other = otherClientIn(command, ws, ctx);
    if (other) return deny(`${other} is another workspace: off-limits.`);
    if (shellSignIn(command, ws, ctx, ws.dir, toolName)) return deny('Sign-ins on this computer are off-limits.');
    const why = clientShellWhy(command, readable, toolName);
    if (why) {
      const first = command.trim().split(/\s+/).slice(0, 2).join(' ');
      return { decision: 'ask', reason: `This command ${why}, during ${who}'s task`, summary: `Run a command: ${first}`, detail: command, ruleKey: `shell:${first}`, outward: true };
    }
    return null; // the usual rules, with the client's folder as its own
  }
  if (toolName.startsWith('mcp__')) {
    const s = JSON.stringify(input || {});
    if (/file:\/\//i.test(s) || otherClientFolder(s.replace(/\\\\/g, '/'), run.client) || outsidePaths(s, readable)) {
      return { decision: 'ask', reason: `This external tool is given a place on the computer outside ${who}'s folder`, summary: `${toolName.split('__').slice(1).join(' ')} with a local path`, detail: s.slice(0, 2000), ruleKey: `path:${toolName}`, outward: true };
    }
  }
  return null;
}

/** Orchy's own files or another workspace's folder named in a command (the owner's runs: these ask, as Read does), with the piece naming it. */
/**
 * The folders the next piece of a line may run from, after `piece` (the i-th). A first-piece cd into a folder that is
 * there always runs and lands there; any other cd may not run (`false && cd x`, `cd x || …`, a cd that fails), so its
 * target joins the folders it may be in (ELSEWHERE for one Orchy can't follow, so no climb from there is trusted).
 */
function nextDirs(dirs, piece, i, shell) {
  const to = dirs.map(d => cdResolve(piece, d, shell));
  if (to.every(t => t == null)) return dirs;
  if (i === 0 && dirs.length === 1 && to[0] !== ELSEWHERE) { try { if (fs.statSync(to[0]).isDirectory()) return [to[0]]; } catch {} }
  const out = [...dirs];
  for (const t of to) if (t != null && !out.includes(t)) out.push(t);
  return out.length > 16 ? null : out; // more places than Orchy follows: the caller asks
}
// `..` is read from every folder the piece may run from (2026-10-15: `cd studio && cat ../../LOGS.md` reaches Orchy's
// LOGS.md): where the line starts, and each `cd` before it, which may or may not have run. A plain read of a path that
// isn't there reads nothing (often a spaced path cut short), so it doesn't ask; anything else that names one still does,
// as it could create it.
function shellJosArea(command, ws, ctx, cwd, shell) {
  const drive = new RegExp(DRIVE_PATH.source);
  const exists = ctx.exists ?? fs.existsSync;
  let dirs = [cwd];
  for (const [i, piece] of splitShell(command, shell).entries()) {
    const reads = pieceIsSafe(piece, shell, true);
    // after a cd out of the folder, a plain relative name can land in Orchy too (cd /home/me && cat orchy/LOGS.md)
    const away = dirs.filter(d => !inRoots(d, [ws.dir]));
    for (const [k, t] of (piece.replace(TEMP_REF, '$1').match(/"[^"]*"|'[^']*'|[^\s;|&()<>]+/g) || []).entries()) {
      const p = t.replace(/^['"]|['"]$/g, '').replace(/^file:\/+(?=[A-Za-z]:)/i, '');
      if (/^[a-z]+:\/\//i.test(p)) continue;
      const posixAbs = POSIX && /^\/(?!\/)/.test(p);
      const placed = drive.test(p) || posixAbs || CLIMB.test(` ${p}`);
      // (a relative word only when it reads as a path: not the program's name, an option or a line of code)
      if (!placed && (!away.length || !k || !/^[\w.@+-][\w .@+-]*(?:[\\/][\w .@+-]*)*$/.test(p) || /^-/.test(p))) continue;
      // a whole (maybe quoted, maybe spaced) path, or the path inside a token like --file=C:/… or --out=../x
      const target = /^[A-Za-z]:[\\/]/.test(p) || posixAbs ? p : (p.match(drive)?.[0] || p.replace(/^(?:-{1,2}[\w-]+|[A-Za-z_]\w*)=(?=\.\.)/, ''));
      for (const d of placed ? dirs : away) {
        const abs = realPath(target, d);
        if (reads && !exists(abs)) continue;
        const area = josArea(abs, ws, ctx);
        if (area) return { area, piece };
      }
    }
    dirs = nextDirs(dirs, piece, i, shell);
    if (!dirs) return { area: null, piece };
  }
  return null;
}

/** A WebFetch of file:///… is a read of that file. */
function fileUrlPath(url) {
  if (!/^\s*file:/i.test(String(url || ''))) return null;
  try { return fileURLToPath(String(url).trim()); } catch { return String(url).replace(/^\s*file:\/*/i, ''); }
}

/**
 * A turn in a huddle only talks (huddle.mjs): reads and lookups go on to the usual checks, anything that could change
 * something is refused (never asked: the owner approves the agreement instead). Returns a deny, or null to decide as usual.
 */
async function huddleTalk(toolName, input, ctx) {
  const no = what => ({ decision: 'deny', reason: `You're in a huddle, so you only talk: ${what} waits until ${ownerName()} approves your agreement. Put it in the plan instead.` });
  if (EDIT_TOOLS.has(toolName)) return no('changing files');
  if (SHELL_TOOLS.has(toolName)) {
    const command = String(input.command || '');
    const calls = parseOneCommands(command, toolName);
    const other = calls.find(c => c.kind === 'other');
    if (other) return no(`\`one ${other.sub}\``);
    if (hiddenOne(command, toolName)) return no('a One call Orchy can’t read');
    for (const c of calls.filter(c => c.kind === 'execute')) {
      const action = await ctx.resolveAction(c.actionId, c.platform);
      if (!isReadOnlyAction(action?.method, action?.title || '')) return no(`"${action?.title || 'that One action'}"`);
    }
    if (!shellIsSafe(command, toolName)) return no('a command that isn’t a plain read');
    return null;
  }
  if (toolName.startsWith('mcp__')) {
    const [, server, ...rest] = toolName.split('__');
    const words = rest.join('__').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
    if (!mcpReads(words) && (WRITE_VERBS.test(words) || decisionFor(words, server))) return no(`${words} (${server})`);
    return null;
  }
  if (READ_TOOLS.has(toolName)) return null;
  return no(toolName);
}

// ── Orchy fixing his own code (backend.mjs): the Orchy folder is the run's folder, but its client workspaces aren't his ──
// Checks and tests of his own code run without asking; stopping or starting Orchy is his to do after the run.
const BACKEND_CHECK = /^(?:node(?:\.exe)?\s+(?:--check|-c)\s+[^\s;|&<>`$]+|node(?:\.exe)?\s+(?:\.[\\/])?orchestrator[\\/]scripts[\\/](?:test-[\w-]+|doctor|cdp|jev-metrics)\.mjs(?:\s+(?:"[^"`$]*"|'[^']*'|[^\s;|&<>`$"']+))*|npm\s+run\s+check)(?:\s+2>(?:&1|\s*\/dev\/null|\s*\$null|\s*nul))?$/i;
const backendCheck = seg => BACKEND_CHECK.test(seg) && !/--live\b/.test(seg); // --live asks real Jev and One
const STOPS_ORCHY = s => /^(taskkill|stop-process|spps|kill|pkill|killall)\b/i.test(s)
  || (/^(node|npm|npx)\b/i.test(s) && /server\.mjs|\bnpm\s+(run\s+)?(start|dev)\b/i.test(s) && !/\s--check\b/.test(s))
  || /(start|stop)-jos\.ps1|Start Orchy\.(cmd|command|sh)/i.test(s);
const lockCount = s => (String(s ?? '').match(new RegExp(LOCK_MARKERS.source, 'gi')) || []).length;

/** Does an edit to Orchy's server code take out text naming one of his locks (fewer mentions after than before)? */
function dropsLock(toolName, file, input) {
  const rel = rootRel(file);
  if (!rel || !/^orchestrator\/.*\.(mjs|cjs|js)$/i.test(rel)) return false;
  if (toolName === 'Edit') return lockCount(input.old_string) > lockCount(input.new_string);
  if (toolName === 'MultiEdit') return (input.edits || []).some(e => lockCount(e.old_string) > lockCount(e.new_string));
  if (toolName === 'Write') { let cur = ''; try { cur = fs.readFileSync(path.resolve(ROOT, rel), 'utf8'); } catch {} return lockCount(cur) > lockCount(input.content); }
  return false;
}

/** The change itself, so the owner approves what they can read. */
function changeDetail(toolName, file, input) {
  const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}\n…` : t; };
  if (toolName === 'Edit') return `${file}\n\n--- before\n${clip(input.old_string, 900)}\n\n+++ after\n${clip(input.new_string, 900)}`;
  if (toolName === 'MultiEdit') return `${file}\n\n${(input.edits || []).slice(0, 4).map(e => `--- before\n${clip(e.old_string, 400)}\n+++ after\n${clip(e.new_string, 400)}`).join('\n\n')}`;
  return `${file}\n\n${clip(input.content ?? JSON.stringify(input), 1800)}`;
}

async function backendLimits(toolName, input, ctx) {
  const { ws } = ctx;
  const fenced = ctx.fencedDirs ?? fencedDirs();
  const fencedIn = p => fenced.find(d => inRoots(path.resolve(ws.dir, String(p)), [d]));
  const off = d => ({ decision: 'deny', reason: `${path.basename(d)} is a client workspace: fixing Orchy never reads or changes it. If a client's agent file is what's broken, say so in your report (the AI Agent Builder fixes agents).` });
  const paths = [input.file_path, input.notebook_path, input.path, toolName === 'Glob' && input.pattern ? path.resolve(ws.dir, input.path || '', String(input.pattern).split(/[*?[{]/)[0]) : null, fileUrlPath(input.url)].filter(Boolean);
  if (READ_TOOLS.has(toolName) || EDIT_TOOLS.has(toolName)) {
    for (const p of paths) { const d = fencedIn(p); if (d) return off(d); }
  }
  if (EDIT_TOOLS.has(toolName)) {
    const file = input.file_path || input.notebook_path || input.path;
    if (!file) return null;
    const ask = why => ({ decision: 'ask', reason: `This ${why}. Approve only if the change looks right`, summary: `Change ${rootRel(file) || path.basename(String(file))}`, detail: changeDetail(toolName, file, input), ruleKey: null });
    if (guardedFile(file)) return ask('changes a file that holds Orchy’s hard rules (accounts, One logins, approvals, client fences) or his settings and keys');
    if (dropsLock(toolName, file, input)) return ask('takes out code naming one of Orchy’s locks (the dashboard’s origin check, the account check, the approval gate)');
    return null; // anything else in the Orchy folder is his own code
  }
  if (READ_TOOLS.has(toolName)) {
    for (const p of paths) {
      const rel = rootRel(p);
      if (rel === '.env') return { decision: 'ask', reason: 'This reads Orchy’s .env (API keys)', summary: 'Read Orchy’s .env', detail: path.resolve(ws.dir, p), ruleKey: 'read:.env', floor: true };
      // a file the owner attached to this fix (a screenshot of the problem) is named in the task: that one it just reads
      if (rel && /^Uploads(\/|$)/i.test(rel) && !String(ctx.run?.instruction || '').includes(`\`${rel}\``)) return { decision: 'ask', reason: 'This reads the files you gave Orchy (Uploads)', summary: `Read ${path.basename(String(p))} in Uploads`, detail: path.resolve(ws.dir, p), ruleKey: 'read:uploads', floor: true };
    }
    return null;
  }
  if (SHELL_TOOLS.has(toolName)) {
    const command = String(input.command || '');
    if (parseOneCommands(command, toolName).length || hiddenOne(command, toolName)) {
      return { decision: 'deny', reason: 'Fixing Orchy doesn’t use the One CLI: the Orchy folder’s One login is the orchestrator’s own. Work from Orchy’s code, logs and records.' };
    }
    const d = fenced.find(dir => otherClientIn(command, ws, { ...ctx, otherDirs: [dir] }));
    if (d) return off(d);
    const segs = splitShell(heredocs(command, toolName).text, toolName);
    if (segs.some(STOPS_ORCHY)) return { decision: 'deny', reason: 'Don’t stop or start Orchy yourself (it would cut this run off). Orchy restarts on his own after your report when server code changed, and rolls your change back if he won’t start. Check server code with `node --check <file>` and the test scripts.' };
    if (segs.length && !RISKY_ANYWHERE.test(command) && segs.every(s => backendCheck(s) || pieceIsSafe(s, toolName))) return { decision: 'allow', reason: 'checks and tests of Orchy’s own code' };
    return null;
  }
  return null;
}

/**
 * Decide on a tool call.
 * ctx: { run, ws, agent (summary or null), connections: [...], resolveAction(actionId), oneScoped, remembered(ruleKey),
 *        mode: 'decisions' (default: only real decisions ask) | 'all' (every change asks), askFor: { money, send, … },
 *        home (a client's run: its own folder), readRoots (more folders it may read: the workspace's skills),
 *        scriptsFree (Settings → Scripts and commands), exists(path) (fs.existsSync unless a test stands in) }
 * returns { decision: 'allow'|'ask'|'deny', reason, summary, detail, ruleKey, outward }
 * `outward` marks an ask that reaches beyond the workspace (a decision, the network, an unknown action):
 * in a run a head handed over, those always ask the owner, even with an "always allow" rule (gate.mjs).
 * A PowerShell line with “ ” ‘ ’ or – in it is judged as written and as PowerShell reads it; the stricter call stands.
 */
const STRICTNESS = { allow: 0, ask: 1, deny: 2 };
// Nesting a reader would have to walk for a long time (or overflow on): asked about without parsing.
const TOO_DEEP = 40;
function nestingDepth(s) {
  let d = 0, max = 0;
  for (const c of s) if (c === '{' || c === '(') { if (++d > max) max = d; } else if ((c === '}' || c === ')') && d) d--;
  return max;
}
export async function decide(toolName, input, ctx) {
  const command = String(input?.command ?? '');
  // never allow what Orchy couldn't judge: no remembered rule, and outward so no head's "always allow" covers it
  const unread = why => ({ decision: 'ask', reason: `Orchy could not read this call to judge it (${why})`, summary: `${toolName}${command ? `: ${command.trim().split(/\s+/).slice(0, 2).join(' ')}` : ''}`, detail: (command || JSON.stringify(input ?? {})).slice(0, 2000), ruleKey: null, outward: true });
  if (SHELL_TOOLS.has(toolName) && nestingDepth(command) > TOO_DEEP) return unread('nested too deeply');
  try { return await decideChecked(toolName, input, ctx); } catch (e) { return unread(e?.message || 'error'); }
}
async function decideChecked(toolName, input, ctx) {
  const v = await decideOnce(toolName, input, ctx);
  const command = String(input?.command ?? '');
  if (toolName !== 'PowerShell' || !PS_LOOKALIKE.test(command)) return v;
  const p = await decideOnce(toolName, { ...input, command: psPlain(command) }, ctx);
  if ((STRICTNESS[p.decision] ?? 1) <= (STRICTNESS[v.decision] ?? 1)) return v;
  return p.detail === psPlain(command) ? { ...p, detail: command } : p;
}

async function decideOnce(toolName, input, ctx) {
  const { run, agent } = ctx;
  // a client's run treats the client's own folder as its whole world
  const ws = ctx.home ? { ...ctx.ws, dir: ctx.home } : ctx.ws;
  const decisionsOnly = ctx.mode !== 'all';
  if (toolName.startsWith('mcp__jos__')) return { decision: 'allow', reason: 'orchestrator bridge' };
  if (run?.backend) { const v = await backendLimits(toolName, input, ctx); if (v) return v; }
  if (run?.huddleTalk) { const v = await huddleTalk(toolName, input, ctx); if (v) return v; }
  if (ctx.home) { const v = clientFence(toolName, input, ctx, ws); if (v) return v; }
  if (ctx.clientAgents) { const v = clientRunLimits(toolName, input, { ...ctx, ws }); if (v) return v; }
  // the workspace's own agents never run inside another run: a head hands work over with mcp__jos__delegate,
  // which gives the team agent its own logged, gated run. Generic helpers (general-purpose, Explore) still pass.
  const helper = (toolName === 'Task' || toolName === 'Agent') && String(input.subagent_type || '');
  if (helper && ctx.wsAgents?.includes(helper)) {
    return { decision: 'deny', reason: `${helper} is one of ${ws.name}'s agents, so it only runs as its own Orchy run. If it's on your team, hand it the work with mcp__jos__delegate; otherwise do it yourself.` };
  }
  // headless runs have no question box: it would sit as a meaningless "Use AskUserQuestion" pop-up
  if (toolName === 'AskUserQuestion') return { decision: 'deny', reason: `${ownerName()} can’t see that question box from here. Ask the same question with mcp__jos__ask_user (put the choices in options).` };
  if (READ_TOOLS.has(toolName)) {
    // reads in its own folder never reach here (Claude Code allows them itself); elsewhere in Orchy is other clients' ground
    const glob = toolName === 'Glob' && input.pattern ? path.resolve(ws.dir, input.path || '', String(input.pattern).split(/[*?[{]/)[0]) : null;
    const exists = ctx.exists ?? fs.existsSync;
    for (const p of [input.file_path, input.notebook_path, input.path, glob, fileUrlPath(input.url)].filter(Boolean)) {
      if (ctx.readRoots && inRoots(path.resolve(ws.dir, p), ctx.readRoots)) continue; // a client's run reading the workspace's skills
      const abs = path.resolve(ws.dir, p);
      // a guessed path that isn't there reads nothing: the harness answers "does not exist", no point asking the owner
      // (not the Glob prefix, which can be half a file name)
      if (p !== glob && !exists(abs)) continue;
      const sign = signInArea(abs, ws, ctx);
      if (sign) return { decision: 'ask', reason: `This reads ${sign}`, summary: `${toolName} a sign-in: ${path.basename(abs)}`, detail: abs, ruleKey: `read:${abs}`, outward: true, floor: true };
      const area = josArea(p, ws, ctx);
      if (!area) continue;
      return {
        decision: 'ask', reason: area === 'Orchy' ? `This reads Orchy's own files (logs and records that cover every client), outside ${ws.name}'s folder` : `This reads ${area}, another client's folder`,
        summary: `${toolName} outside ${ws.name}: ${path.basename(abs)}`, detail: abs, ruleKey: `read:${toolName === 'Read' ? path.dirname(abs) : abs}`, floor: true,
      };
    }
    return { decision: 'allow', reason: 'read-only tool' };
  }

  if (EDIT_TOOLS.has(toolName)) {
    const file = input.file_path || input.notebook_path || input.path;
    // Codex asked to change files without naming them
    if (!file) return { decision: 'ask', reason: 'This changes files Orchy can’t see first', summary: `${toolName} files it didn’t name${input.grant_root ? ` (under ${input.grant_root})` : ''}`, detail: JSON.stringify(input), ruleKey: null };
    const abs = path.resolve(ws.dir, file);
    const sign = signInArea(abs, ws, ctx);
    if (sign) return { decision: 'ask', reason: `This writes ${sign}`, summary: `${toolName} a sign-in: ${path.basename(abs)}`, detail: abs, ruleKey: null, outward: true };
    if (setupFile(abs, ws, ctx)) return { decision: 'ask', reason: `This ${SETUP_WHY(ws)}`, summary: `${toolName} ${path.basename(abs)} in ${ws.name}'s setup`, detail: abs, ruleKey: `setup:${wsRel(abs, ws.dir)}`, floor: true };
    if (insideDir(file, ws.dir)) return { decision: 'allow', reason: 'file work inside its own workspace' };
    if (decisionsOnly && file && inRoots(file, workRoots(ws)) && !otherClientIn(file, ws, ctx)) return { decision: 'allow', reason: 'scratch file in the temp folder' };
    return {
      decision: 'ask', reason: 'writes a file outside its workspace',
      summary: `${toolName} a file outside ${ws.name}`, detail: file, ruleKey: `${toolName}:${path.dirname(file || '')}`,
      // into Orchy's own folder or another client's: floor (one agent's "always allow" at most)
      ...(josArea(file, ws, ctx) || otherClientIn(file, ws, ctx) ? { floor: true } : {}),
    };
  }

  if (SHELL_TOOLS.has(toolName)) {
    const command = String(input.command || '');
    const shell = toolName;
    const calls = parseOneCommands(command, shell);
    const hidden = hiddenOne(command, shell);
    const segs = splitShell(heredocs(command, shell).text, shell);
    const allowedKeys = agent?.connections?.length ? new Set(agent.connections.map(c => c.key)) : null;
    // without its own One login the CLI would quietly use the orchestrator's account: never let that happen
    // (nor a One call Orchy can't read, or a program named by a variable, which could be it)
    if (ctx.oneScoped === false && (calls.length || hidden || segs.some(s => computedHead(s, shell)))) {
      return { decision: 'deny', reason: `${ws.name} isn't signed in to its own One account yet, so the One CLI is off here${calls.length ? '' : ' (and so is a program called through a variable or alias, which could be it: call programs by name)'}. Do the task without One, or tell ${ownerName()} (mcp__jos__ask_user) that One needs signing in from the Workspaces window.` };
    }
    // each ask names the piece of the line that needs it; one the owner always allows passes and the next one asks
    // (never an outward one in a run a head handed over)
    const need = v => (ctx.remembered?.(v.ruleKey) && !(run?.delegatedBy && v.outward) ? null : v);
    const askPiece = (reason, piece, extra = {}) => need({ decision: 'ask', reason, summary: `Run a command: ${firstWords(piece)}`, detail: command, ruleKey: `shell:${firstWords(piece)}`, ...extra });
    let v;
    // Codex says where a command runs: judge it from there, and ask when that's outside the run's folder
    const cwd = input.cwd ? realPath(input.cwd, ws.dir) : ws.dir;
    if (!inRoots(cwd, [ws.dir]) && (v = need({ decision: 'ask', reason: `This command runs in ${cwd}, outside ${ws.name}'s folder`, summary: `Run a command in ${path.basename(cwd)}`, detail: command, ruleKey: `cwd:${cwd}` }))) return v;
    const sign = shellSignIn(command, ws, ctx, cwd, shell);
    if (sign && (v = askPiece(`This reaches ${sign.area}`, sign.piece, { outward: true, floor: true }))) return v;
    const other = otherClientIn(command, ws, ctx);
    if (other && (v = askPiece(`This reaches into ${other}, another client's folder`, segs.find(s => otherClientIn(s, ws, ctx)) || command, { floor: true }))) return v;
    // reading Orchy's own files (LOGS.md, its records) from a shell asks, the same as the Read tool does
    const area = ctx.home ? null : shellJosArea(command, ws, ctx, cwd, shell);
    if (area && (v = askPiece(!area.area ? 'This command changes folder more ways than Orchy can follow' : area.area === 'Orchy' ? `This reaches Orchy's own files (logs and records that cover every client), outside ${ws.name}'s folder` : `This reaches into ${area.area}, another client's folder`, area.piece, { floor: true }))) return v;
    // a `cd`/`Set-Location` in the line moves where the writes land, which this fast path doesn't track: hand those to
    // the full check (shellNeedsOwner follows the cd)
    if (!segs.some(s => cdResolve(s, cwd, shell) != null) && segs.some(s => psWriteInside(s, cwd, ws, ctx)) && !writesViaRedirect(command, shell) && segs.every(s => psWriteInside(s, cwd, ws, ctx) || pieceIsSafe(s, shell))) {
      return { decision: 'allow', reason: 'file work inside its own workspace' };
    }

    const live = new Set(ctx.connections.map(x => x.key));
    for (const c of calls.filter(c => c.kind === 'execute')) {
      const conn = ctx.connections.find(x => x.key === c.connectionKey);
      if (!conn) {
        // a reconnected app gets a new key: point the agent at it rather than leave it guessing
        const old = agent?.connections?.find(x => x.key === c.connectionKey);
        const now = old && ctx.connections.find(x => x.platform === old.platform && x.name === old.name);
        if (now) return { decision: 'deny', reason: `"${now.name}" was reconnected and has a new key. Use ${now.key} instead of ${c.connectionKey}.` };
        return { decision: 'deny', reason: `Connection ${c.connectionKey} is not part of ${ws.name}. Use \`one --agent list --limit 1000\` from this folder and only those keys.` };
      }
      // the agent's grant follows a reconnected app to its new key (same platform and name, old key gone)
      const grant = agent?.connections?.find(x => x.key === c.connectionKey)
        || agent?.connections?.find(x => !live.has(x.key) && x.platform === conn.platform && x.name === conn.name);
      // an action ID held in a variable (A=conn_mod_def::…; … execute gmail $A …): the one ID the line names is it
      const named = /^\$/.test(c.actionId) ? [...new Set(command.match(/conn_mod_def::[\w-]+::[\w-]+/g) || [])] : [];
      const action = await ctx.resolveAction(named.length === 1 ? named[0] : c.actionId, c.platform);
      const method = action?.method || null;
      const title = action?.title || 'an action';
      const readOnly = isReadOnlyAction(method, title);
      // a decision by its title; an action that changes data and matches none gets Jev's second look
      // (jevdecide.mjs), which can only add a decision, never clear one
      const d = readOnly ? null : decisionFor(title, conn.platform)
        || (action?.title && ctx.classify ? await ctx.classify({ key: c.actionId, title, platform: conn.platform, method, path: action?.path }) : null);
      // outside the agent's connections: the owner decides (once, or always = it joins this agent's connections)
      const connRule = `conn:${c.connectionKey}`;
      // outward: a decision (sending, money, calendar, deleting, sharing) or an action Orchy can't read
      const outward = !readOnly && (!method || !!d);
      if (allowedKeys && !grant && !ctx.remembered?.(connRule)) {
        return {
          decision: 'ask', reason: `"${conn.name}" isn't one of this agent's connections`,
          summary: `${title} — ${conn.name} (${conn.platform})`, detail: command, ruleKey: connRule,
          action: { ...c, title, method, connectionName: conn.name }, outward,
        };
      }
      if (grant && String(grant.access || '').toLowerCase() === 'read' && !readOnly) {
        return { decision: 'deny', reason: `You only have read access to "${conn.name}". "${title}" changes data there.` };
      }
      if (!readOnly) {
        const ask = (reason) => need({
          decision: 'ask', reason,
          summary: `${title} — ${conn.name} (${conn.platform})`,
          detail: command, ruleKey: `one:${c.actionId}:${c.connectionKey}`,
          action: { ...c, title, method, connectionName: conn.name }, outward,
        });
        v = !decisionsOnly ? ask(method ? `${method} request changes data` : 'unknown action type')
          : !method && !action?.title ? ask('Orchy couldn’t tell what this action does')
            : asked(d, ctx) ? ask(`${d.label} needs your OK (${d.hint})${d.byJev ? '. Jev flagged it: its name doesn’t say so' : ''}`)
              : null; // not a decision (a draft, a label, a note, a doc edit…): it just runs
        if (v) return v;
      }
    }
    // Settings → "Scripts and commands" (on by default): in the owner's own runs, commands, scripts and One CLI calls run
    // on their own; only a decision the owner keeps (askFor) still asks. Not in a client's run, Orchy fixing himself, or
    // a run a head handed over (there every outward step asks the owner), nor in "Every change" mode.
    const free = decisionsOnly && ctx.scriptsFree === true && !run?.backend && !run?.delegatedBy && !run?.client && !ctx.home && !run?.huddleTalk;
    for (const c of calls.filter(c => c.kind === 'other')) {
      if (free) {
        const d = await oneOtherDecision(c, command, cwd, ws, ctx);
        if (d && (v = need({ decision: 'ask', reason: `This ${d.why}`, summary: `Run One CLI: one ${c.sub}`, detail: command, ruleKey: `one-sub:${c.sub}`, outward: true }))) return v;
        continue;
      }
      if ((v = need({ decision: 'ask', reason: `\`one ${c.sub}\` can change things`, summary: `Run One CLI: one ${c.sub}`, detail: command, ruleKey: `one-sub:${c.sub}`, outward: true }))) return v;
    }
    // never remembered: what it runs can change from one call to the next. In free mode it's judged by the action IDs the
    // line names; a line that names none and could run one (execute, run, x…) still asks
    if (hidden) {
      const d = !free ? null : !mayRunOne(command) ? false
        : await idsDecision(command, ctx, { none: { why: 'starts the One CLI in a way Orchy can’t read (an alias, a variable, xargs or another shell) and names no action, so it can’t tell which one runs' } });
      if (d !== false && (!free || d)) return { decision: 'ask', reason: d ? `This ${d.why}` : 'This starts the One CLI in a way Orchy can’t read (an alias, a variable, xargs, find -exec or another shell), so it can’t tell which action runs', summary: `Run a command: ${firstWords(command)}`, detail: command, ruleKey: null, outward: true };
    }
    if (shellIsSafe(command, shell)) return { decision: 'allow', reason: calls.length ? 'One read/allowed action' : 'read-only shell command' };
    const needs = shellNeedsOwner(command, ws, ctx, cwd, shell);
    // the network, or a script or program Orchy can't vet, could reach outside this PC
    const reaches = why => /network|script|program/.test(why || '');
    if (decisionsOnly) {
      // the settings of the harness this run uses ask wherever its profile lives, also inside a folder that is otherwise
      // the run's own (a profile kept in the temp folder): hooks there run in every later run, past the gate
      if (harnessPlace(command, [cwd], ws) && (v = askPiece('This command changes the settings of the harness this run uses, which every later run loads', command, { outward: true, floor: true }))) return v;
      for (const n of needs) {
        // Orchy's own dashboard (approvals, settings) never runs on its own: curl, Invoke-RestMethod, a script's fetch…
        if ((free || (ctx.scriptsFree && n.script)) && talksToDashboard({ ...n, piece: command }) && (v = askPiece(`This command ${DASHBOARD_WHY}`, n.piece, { outward: true, floor: true }))) return v;
        if (ctx.scriptsFree && n.script) {
          // Settings → Scripts: it runs on its own unless it looks like a decision the owner keeps
          const d = await scriptDecision(n, ctx);
          if (d && (v = askPiece(`This command ${d.why}`, n.piece, { outward: true }))) return v;
          continue;
        }
        if (free && FREE_KINDS.has(n.kind)) {
          const d = freeDecision(n, command, ws, ctx, cwd);
          if (d && (v = askPiece(`This command ${d.why}`, n.piece, { outward: true }))) return v;
          continue;
        }
        // a change to the workspace's own setup (agents, instructions, connections) is floor: one agent's "always allow" at most
        if ((v = askPiece(`This command ${n.why}`, n.piece, { outward: reaches(n.why), ...(n.kind === 'setup' ? { floor: true } : {}) }))) return v;
      }
      return { decision: 'allow', reason: calls.length ? 'One work that isn’t a decision' : 'work inside its own folder' };
    }
    const pieces = segs.filter(s => !pieceIsSafe(s, shell, true));
    for (const piece of pieces.length ? pieces : [command]) {
      if ((v = askPiece('shell command', piece, { outward: needs.some(n => piece.includes(n.piece) && reaches(n.why)) }))) return v;
    }
    return { decision: 'allow', reason: `every piece is one ${ownerName()} always allows` };
  }

  if (toolName.startsWith('mcp__')) {
    const [, server, ...rest] = toolName.split('__');
    const tool = rest.join('__');
    if (agent?.mcpServers?.length && !agent.mcpServers.includes(server)) {
      return { decision: 'deny', reason: `MCP server "${server}" is not in your allowed connections.` };
    }
    const words = tool.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
    // a tool that runs an arbitrary external action, workflow or zap (execute_action, run_zap, run_workflow): Orchy
    // can't see what it does, so it always asks — it could send, spend or delete behind the owner's back
    if (/^(?:execute|run|invoke|trigger|dispatch)\b.*\b(action|actions|workflow|zap|command|job|flow|script|automation|tool)s?\b/i.test(words)) {
      return { decision: 'ask', reason: 'runs an external action Orchy can’t see first', summary: `${words} via ${server}`, detail: JSON.stringify(input, null, 2).slice(0, 2000), ruleKey: `mcp:${toolName}`, outward: true };
    }
    // as for One actions: the name's words first, then Jev's second look at a tool that sounds like it writes
    const d = mcpReads(words) ? null : decisionFor(words, server)
      || (WRITE_VERBS.test(words) && ctx.classify ? await ctx.classify({ key: `mcp:${toolName}`, title: words, platform: server }) : null);
    // every change asks at least what decisions mode asks
    if (asked(d, ctx) || (!decisionsOnly && (d || (WRITE_VERBS.test(tool) && !mcpReads(words))))) {
      return { decision: 'ask', reason: d ? `${d.label} needs your OK (${d.hint})${d.byJev ? '. Jev flagged it: its name doesn’t say so' : ''}` : 'external tool may change data', summary: `${words} via ${server}`, detail: JSON.stringify(input, null, 2).slice(0, 2000), ruleKey: `mcp:${toolName}`, outward: !!d };
    }
    return { decision: 'allow', reason: decisionsOnly ? 'external tool, not a decision' : 'external read tool' };
  }

  return { decision: 'ask', reason: 'unrecognised tool', summary: `Use ${toolName}`, detail: JSON.stringify(input, null, 2).slice(0, 2000), ruleKey: `tool:${toolName}`, outward: true };
}

// ── Remembered "always allow" rules (per workspace + agent + ruleKey; agent EVERY_AGENT: every agent in the workspace) ──
export const EVERY_AGENT = '*';
export function ruleMatches(run, ruleKey, rules = db().rules) {
  if (!ruleKey) return false;
  return rules.some(r => r.workspace === run.workspace && (r.agent === run.agentSlug || r.agent === EVERY_AGENT) && r.ruleKey === ruleKey);
}

/** The agent a new rule covers. everyAgent: the whole workspace, but never for a floor ask (a sign-in, another
 *  client, Orchy's own files, the dashboard, the harness's settings, a workspace's setup): those stay with one agent. */
export const ruleAgent = (run, { everyAgent = false, floor = false } = {}) => (everyAgent && !floor ? EVERY_AGENT : run.agentSlug);

export function addRule(run, ruleKey, summary, scope = {}) {
  if (!ruleKey) return;
  const agent = ruleAgent(run, scope);
  if (db().rules.some(r => r.workspace === run.workspace && r.agent === agent && r.ruleKey === ruleKey)) return;
  db().rules.push({ workspace: run.workspace, agent, ruleKey, summary, at: new Date().toISOString() });
  save();
}

export function removeRule(index) {
  db().rules.splice(index, 1);
  save();
}
