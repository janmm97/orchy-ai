// Engine adapter: Codex (`codex app-server`, JSON-RPC over stdio). The implementation stays in ../codex.mjs.
import { codexBin, codexAccount, launchCodexRun } from '../codex.mjs';
import { probeVersion } from '../claude.mjs';
import { profilePath, psq, sq } from './shared.mjs';

/** Convert Orchy's `.jos/mcp.json` registry entries into Codex `mcp_servers` config. Codex speaks stdio and streamable HTTP, not SSE. */
export function toCodexMcp(servers, names) {
  const out = {};
  for (const [name, s] of Object.entries(servers)) {
    if (!s.enabled || s.type === 'sse') continue;
    if (names && !names.includes(name)) continue;
    out[name] = s.type === 'stdio'
      ? { command: s.command, args: s.args || [], env: s.env || {}, tool_timeout_sec: 600 }
      : { url: s.url, http_headers: s.headers || {}, tool_timeout_sec: 600 };
  }
  return out;
}

let probe = null;

export default {
  id: 'codex',
  label: 'Codex',
  models: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'],
  blurb: 'OpenAI’s GPT models. Every command and file change still goes through your approvals.',
  fields: { account: 'codexAccount', profile: 'codexHome' },
  accountModel: 'email',
  instructionFile: 'AGENTS.md',
  defaultProfileLabel: '(default ~/.codex)',
  // the standalone installers from learn.chatgpt.com/docs/codex/cli (~/.local/bin; on Windows %LOCALAPPDATA%\Programs\OpenAI\Codexin)
  install: { cmd: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', winCmd: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"', signIn: 'codex login', bin: 'codex', optional: true, note: 'Optional: OpenAI’s agent harness.' },
  capabilities: {
    gated: true, mcp: true, resume: true, headless: true,
    clientSafe: false,
    clientReason: 'Codex reads files without asking, so it can’t be kept inside the client’s folder.',
    huddles: false,
    notes: 'codex app-server with approval policy "untrusted": every approval request is answered by the Orchy gate.',
  },
  bin: () => codexBin(),
  version() {
    const b = codexBin();
    if (!b) return null;
    if (!probe || probe.bin !== b || (!probe.v && Date.now() - probe.at > 60_000)) probe = { bin: b, at: Date.now(), v: probeVersion(b) };
    return probe.v;
  },
  available: () => !!codexBin(),
  async account(profileDir, opts = {}) {
    const s = await codexAccount(profileDir, opts);
    return { ...s, loggedIn: !!s.loggedIn, email: s.email || null, label: s.email || null, subscription: s.plan || null };
  },
  profileEnv: profileDir => (profileDir ? { CODEX_HOME: profilePath(profileDir) } : {}),
  loginCommand: (a, { win }) => (win ? `& ${psq(codexBin() || 'codex')} login` : `${sq(codexBin() || 'codex')} login`),
  loginAlt: (a, ws) => `Sign in to ChatGPT as ${ws?.codexAccount || a.email} in the browser window it opens.`,
  mcpConfig({ servers, allowed, bridge }) {
    // The owner's answers can take hours: the bridge's tools must not time out (Codex's default is 60s)
    return { jos: { ...bridge, tool_timeout_sec: 86400 }, ...toCodexMcp(servers, allowed) };
  },
  protocolNotes: ({ ownerName }) => `
## Working on Codex
- Edit files with apply_patch: edits inside this folder are approved automatically. Codex runs its own known-safe read commands (listing, reading, searching files) by itself; every other shell command passes ${ownerName}'s approval policy first: work in this folder goes straight through, anything outward waits for ${ownerName}.
- The jos tools above are MCP tools on the \`jos\` server; call them like any other tool.
- Skills in \`.claude/skills/<name>/\` are plain folders: when your instructions name one, read its \`SKILL.md\` and the files it points to, and follow them. Its Claude-only parts (the Skill tool, hooks, Claude subagents) don't run here: do those steps yourself, the way your instructions say.
- Commands run in Windows PowerShell 5.1, which strips double quotes from arguments it passes to programs. Escape every double quote inside a JSON argument: \`-d '{\\"key\\":\\"value\\"}'\`. For a long body, keep the JSON in a file, run \`$d = (Get-Content -Raw -Encoding UTF8 <file>) -replace '"','\\"'\`, then pass \`-d $d\`. Inside its text values use no straight double quotes (write “ ” instead) and no backslashes (write paths with /).
`,
  launch(run, ws, opts, rt) {
    const handle = launchCodexRun({
      cwd: ws.dir,
      codexHome: ws.codexHome || null,
      model: run.model,
      effort: run.effort,
      prompt: opts.prompt,
      developerInstructions: rt.instructions(ws, run, opts.agentMarkdown, opts.planText),
      mcpServers: opts.mcp,
      resumeThreadId: opts.resume || null,
    }, rt.hooks(run, ws));
    rt.live.set(run.id, { fingerprint: opts.fingerprint, stop: () => handle.stop() });
    run.pid = handle.pid;
  },
};
