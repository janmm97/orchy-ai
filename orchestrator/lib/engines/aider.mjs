// Engine adapter: Aider CLI (`aider`, https://aider.chat).
// Aider is a git-integrated coding agent that reads files, applies edits, and tests them.
// Runs headless with `--yes --no-auto-commits --message <prompt>`, gated via Orchy's whole-run approval.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { env, expandPath, ROOT } from '../env.mjs';
import { findBinary, probeVersion } from '../claude.mjs';
import { psq, sq, killTree, profilePath, scrubbedEnv } from './shared.mjs';

let binCache = null;
function resolveBin() {
  const explicit = env('AIDER_CLI_PATH');
  if (explicit && fs.existsSync(expandPath(explicit))) return expandPath(explicit);
  const extra = [
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.cargo', 'bin'),
  ];
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) {
      extra.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python311', 'Scripts'));
      extra.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python312', 'Scripts'));
      extra.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Scripts'));
    }
    if (process.env.APPDATA) {
      extra.push(path.join(process.env.APPDATA, 'Python', 'Scripts'));
    }
  }
  return findBinary('aider', extra);
}

export const aiderBin = () => {
  if (!binCache || !fs.existsSync(binCache)) binCache = resolveBin();
  return binCache;
};

let probe = null;

const PROVIDER_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'ORCA_API_KEY',
  'OPENAI_API_BASE',
  'GEMINI_API_KEY',
  'DEEPSEEK_API_KEY',
  'GROQ_API_KEY',
  'OLLAMA_API_BASE',
];

export default {
  id: 'aider',
  label: 'Aider',
  models: ['sonnet', 'sonnet', 'opus'],
  openModels: true,
  blurb: 'Git-integrated terminal coding agent. Edits files in your workspace directly with safety approvals.',
  fields: { account: 'aiderAccount', profile: 'aiderProfile' },
  accountModel: 'profile',
  instructionFile: 'AGENTS.md',
  defaultProfileLabel: '(default environment / .env)',
  install: {
    cmd: 'curl -LsSf https://aider.chat/install.sh | sh',
    winCmd: 'powershell -ExecutionPolicy ByPass -c "irm https://aider.chat/install.ps1 | iex"',
    signIn: 'aider --version',
    bin: 'aider',
    optional: true,
    note: 'Optional: Python git-integrated AI coding agent.',
  },
  capabilities: {
    gated: true,
    mcp: false,
    resume: false,
    headless: true,
    clientSafe: false,
    clientReason: 'Aider reads and edits workspace files directly without a sandbox.',
    huddles: false,
    notes: 'Runs headless aider with whole-run approval before starting.',
  },
  bin: () => aiderBin(),
  version() {
    const b = aiderBin();
    if (!b) return null;
    if (!probe || probe.bin !== b || (!probe.v && Date.now() - probe.at > 5_000)) probe = { bin: b, at: Date.now(), v: probeVersion(b) };
    return probe.v;
  },
  available: () => !!aiderBin(),
  async account(profileDir, { force = false } = {}) {
    // Check if any provider API key is present in profile dir .env, or in process.env
    let pEnv = {};
    if (profileDir) {
      try {
        const dotEnv = path.join(profilePath(profileDir), '.env');
        if (fs.existsSync(dotEnv)) {
          const lines = fs.readFileSync(dotEnv, 'utf8').split(/\r?\n/);
          for (const l of lines) {
            const m = l.match(/^([A-Za-z0-9_]+)=(.*)$/);
            if (m) pEnv[m[1].trim()] = m[2].trim();
          }
        }
      } catch {}
    }
    const found = PROVIDER_KEYS.find(k => (pEnv[k] && pEnv[k].length > 4) || (process.env[k] && process.env[k].length > 4));
    if (found) {
      const label = found === 'OPENAI_API_BASE' ? 'OpenAI Base' : found.replace(/_API_KEY$/, '');
      return { loggedIn: true, label, subscription: 'API Key' };
    }
    return {
      loggedIn: false,
      error: 'Aider needs an API key: set OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENAI_API_BASE in .env.',
    };
  },
  profileEnv: profileDir => {
    const envFile = profileDir ? path.join(profilePath(profileDir), '.env') : path.join(ROOT, '.env');
    return fs.existsSync(envFile) ? { AIDER_ENV_FILE: envFile } : {};
  },
  loginCommand: (a, { win }) => (win ? `& ${psq(aiderBin() || 'aider')} --version` : `${sq(aiderBin() || 'aider')} --version`),
  loginAlt: () => 'Set OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENAI_API_BASE in .env, then Re-check accounts.',
  mcpConfig: () => ({}),
  protocolNotes: ({ ownerName }) => `
## Working on Aider
- Runs aider in git repository mode or standalone mode. Edits are proposed and applied to workspace files.
- Ensure all relevant repository files are clean before starting tasks.
`,
  launch(run, ws, opts, rt) {
    const hooks = rt.hooks(run, ws);
    const bin = aiderBin() || 'aider';
    const isWin = process.platform === 'win32';

    // Whole-run approval gate check
    (async () => {
      const ok = await hooks.approveRun({
        title: `Run Aider in ${ws.name}`,
        message: `Run Aider to: "${(run.instruction || '').slice(0, 120)}"`,
      });
      if (!ok) {
        hooks.done({ code: 1, status: 'denied', error: 'Approval declined by owner' });
        return;
      }

      const args = ['--yes', '--no-auto-commits'];
      if (run.model && run.model !== 'default') {
        args.push('--model', run.model);
      }
      args.push('--message', run.instruction);

      let child;
      try {
        const extraEnv = {
          NO_COLOR: '1',
          GIT_TERMINAL_PROMPT: '0',
        };
        if (process.env.OPENAI_API_BASE) extraEnv.OPENAI_API_BASE = process.env.OPENAI_API_BASE;
        child = spawn(bin, args, {
          cwd: ws.dir,
          env: scrubbedEnv(this.profileEnv(ws.aiderProfile), extraEnv),
          windowsHide: true,
          shell: isWin && /\.(cmd|bat)$/i.test(bin),
        });
      } catch (e) {
        hooks.done({ code: 1, status: 'failed', error: e.message });
        return;
      }

      rt.live.set(run.id, {
        fingerprint: opts.fingerprint,
        stop: () => {
          killTree(child);
          hooks.done({ code: null, status: 'interrupted' });
        },
      });
      run.pid = child.pid;

      child.stdout?.on('data', d => {
        const text = String(d || '');
        if (text.trim()) hooks.record({ kind: 'text', text: text.trim() });
      });

      child.stderr?.on('data', d => {
        const text = String(d || '');
        if (text.trim() && !/^\s*$/m.test(text)) hooks.record({ kind: 'text', text: text.trim() });
      });

      child.on('error', e => {
        hooks.done({ code: 1, status: 'failed', error: e.message });
      });

      child.on('close', code => {
        hooks.done({ code: code ?? 0, status: code === 0 ? 'completed' : 'failed' });
      });
    })().catch(e => {
      hooks.done({ code: 1, status: 'failed', error: e.message });
    });
  },
};

