// Engine adapter: Generic / Custom CLI runner (`custom`).
// Allows running any user-specified CLI tool, command, or script.
// Injects Orchy bridge environment variables so scripts can call the orchestrator's MCP server.
// Safety: Prompts the owner via whole-run approval (`approveRun`) before starting.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { env, expandPath, config } from '../env.mjs';
import { killTree, psq, sq, scrubbedEnv } from './shared.mjs';

function resolveCommand(ws) {
  const wsCmd = ws?.customCommand || (ws?.id === 'orchy' ? config.orchy?.customCommand : null);
  if (wsCmd && typeof wsCmd === 'string' && wsCmd.trim()) return wsCmd.trim();
  const envCmd = env('CUSTOM_CLI_PATH');
  if (envCmd && typeof envCmd === 'string' && envCmd.trim()) return envCmd.trim();
  return process.execPath; // default fallback: node
}

export default {
  id: 'custom',
  label: 'Custom CLI',
  models: ['default', 'default', 'default'],
  openModels: true,
  blurb: 'Configurable CLI runner. Runs any command, script or coding tool with Orchy approvals and bridge access.',
  fields: { account: 'customAccount', profile: 'customProfile' },
  accountModel: 'profile',
  instructionFile: 'AGENTS.md',
  defaultProfileLabel: '(custom executable / script)',
  install: {
    cmd: 'echo "Configure your command in Workspaces or CUSTOM_CLI_PATH in .env"',
    winCmd: 'Write-Output "Configure your command in Workspaces or CUSTOM_CLI_PATH in .env"',
    signIn: '',
    bin: 'node',
    optional: true,
    note: 'Configurable custom CLI agent or script runner.',
  },
  capabilities: {
    gated: true,
    mcp: true,
    resume: false,
    headless: true,
    clientSafe: false,
    clientReason: 'Custom CLIs run arbitrary commands on the system.',
    huddles: false,
    notes: 'Runs any executable or script with owner approval before execution.',
  },
  bin: ws => resolveCommand(ws),
  version: () => '1.0',
  available: () => true,
  async account(profileDir, { force = false } = {}) {
    return {
      loggedIn: true,
      label: 'Configured',
      subscription: 'Custom Runner',
    };
  },
  profileEnv: () => ({}),
  loginCommand: (a, { win }) => (win ? 'Write-Output "Custom CLI is ready."' : 'echo "Custom CLI is ready."'),
  loginAlt: () => 'Set CUSTOM_CLI_PATH in .env or configure customCommand on the workspace.',
  mcpConfig: ({ servers, allowed, bridge }) => ({ servers, allowed, bridge }),
  protocolNotes: ({ ownerName }) => `
## Working with Custom CLI
- Executes the configured command line in the workspace folder.
- Passes the task instruction in the environment as ORCHY_INSTRUCTION and through stdin.
- The Orchy bridge is available at JOS_URL with JOS_TOKEN.
`,
  launch(run, ws, opts, rt) {
    const hooks = rt.hooks(run, ws);
    const rawCmd = resolveCommand(ws);
    const isWin = process.platform === 'win32';

    (async () => {
      const ok = await hooks.approveRun({
        title: `Run Custom CLI in ${ws.name}`,
        message: `Execute: "${rawCmd}" for: "${(run.instruction || '').slice(0, 100)}"`,
      });
      if (!ok) {
        hooks.done({ code: 1, status: 'denied', error: 'Approval declined by owner' });
        return;
      }

      // Prepare bridge and environment
      const bridgeEnv = opts.mcp?.bridge?.env || {};
      const envVars = scrubbedEnv({}, {
        ORCHY_INSTRUCTION: run.instruction || '',
        ORCHY_RUN_ID: run.id,
        ORCHY_WORKSPACE: ws.id,
        ...bridgeEnv,
      });

      let child;
      try {
        child = spawn(rawCmd, [], {
          cwd: ws.dir,
          env: envVars,
          shell: true,
          windowsHide: true,
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

      // Pipe instruction to stdin
      if (child.stdin) {
        try {
          child.stdin.write(run.instruction || '');
          child.stdin.end();
        } catch {}
      }

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

