// Engine adapter: OpenCode CLI (`opencode`, https://opencode.ai).
// Runs OpenCode coding agent with provider keys or OpenCode Zen.
// Safety: Gated via whole-run approval (`approveRun`) before execution.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { env, expandPath } from '../env.mjs';
import { findBinary, probeVersion } from '../claude.mjs';
import { psq, sq, killTree, profilePath, scrubbedEnv } from './shared.mjs';

let binCache = null;
function resolveBin() {
  const explicit = env('OPENCODE_CLI_PATH');
  if (explicit && fs.existsSync(expandPath(explicit))) return expandPath(explicit);
  const extra = [
    path.join(os.homedir(), '.opencode', 'bin'),
  ];
  if (process.platform === 'win32' && process.env.APPDATA) {
    extra.push(path.join(process.env.APPDATA, 'npm'));
  }
  return findBinary('opencode', extra);
}

export const openCodeBin = () => {
  if (!binCache || !fs.existsSync(binCache)) binCache = resolveBin();
  return binCache;
};

let probe = null;

export default {
  id: 'opencode',
  label: 'OpenCode',
  models: ['default', 'default', 'default'],
  openModels: true,
  blurb: 'Open-source coding agent (`opencode.ai`). Runs OpenCode with your provider keys or OpenCode Zen.',
  fields: { account: 'opencodeAccount', profile: 'opencodeProfile' },
  accountModel: 'profile',
  instructionFile: 'AGENTS.md',
  defaultProfileLabel: '(its own profile folder)',
  install: {
    cmd: 'curl -fsSL https://opencode.ai/install | bash',
    winCmd: 'npm install -g opencode-ai',
    winRepair: 'cd "$env:APPDATA\\npm\\node_modules\\opencode-ai"; node postinstall.mjs',
    signIn: 'opencode auth login',
    bin: 'opencode',
    optional: true,
    note: 'Optional: an open-source agent harness.',
  },
  capabilities: {
    gated: true,
    mcp: true,
    resume: false,
    headless: true,
    clientSafe: false,
    clientReason: 'Orchy has not verified that OpenCode can be kept inside a client’s folder yet.',
    huddles: false,
    notes: 'Runs OpenCode with whole-run approval before starting.',
  },
  bin: () => openCodeBin(),
  version() {
    const b = openCodeBin();
    if (!b) return null;
    if (!probe || probe.bin !== b || (!probe.v && Date.now() - probe.at > 5_000)) probe = { bin: b, at: Date.now(), v: probeVersion(b) };
    return probe.v;
  },
  available: () => !!openCodeBin(),
  async account(profileDir, { force = false } = {}) {
    const key = env('OPENCODE_API_KEY');
    if (key) {
      return { loggedIn: true, label: 'OpenCode Zen', subscription: 'API Key' };
    }
    // Also check standard provider keys
    const alt = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'].find(k => !!env(k));
    if (alt) {
      return { loggedIn: true, label: alt.replace(/_API_KEY$/, ''), subscription: 'Provider' };
    }
    return {
      loggedIn: false,
      error: 'OpenCode needs an API key: set OPENCODE_API_KEY or run `opencode auth login`.',
    };
  },
  profileEnv: profileDir => (profileDir ? { OPENCODE_CONFIG_DIR: path.join(profilePath(profileDir), 'config') } : {}),
  loginCommand: (a, { win }) => (win ? `& ${psq(openCodeBin() || 'opencode')} auth login` : `${sq(openCodeBin() || 'opencode')} auth login`),
  loginAlt: () => 'Set OPENCODE_API_KEY in .env or run opencode auth login in a terminal.',
  mcpConfig: ({ servers, allowed, bridge }) => ({ servers, allowed, bridge }),
  protocolNotes: ({ ownerName }) => `
## Working on OpenCode
- Runs OpenCode on tasks within this workspace. Work in this folder goes through; outward actions wait for ${ownerName}.
`,
  launch(run, ws, opts, rt) {
    const hooks = rt.hooks(run, ws);
    const bin = openCodeBin() || 'opencode';
    const isWin = process.platform === 'win32';

    (async () => {
      const ok = await hooks.approveRun({
        title: `Run OpenCode in ${ws.name}`,
        message: `Run OpenCode: "${(run.instruction || '').slice(0, 100)}"`,
      });
      if (!ok) {
        hooks.done({ code: 1, status: 'denied', error: 'Approval declined by owner' });
        return;
      }

      const args = ['run', run.instruction || ''];
      if (run.model && run.model !== 'default') {
        args.unshift('--model', run.model);
      }

      let child;
      try {
        child = spawn(bin, args, {
          cwd: ws.dir,
          env: scrubbedEnv(this.profileEnv(ws.opencodeProfile), {
            NO_COLOR: '1',
          }),
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

