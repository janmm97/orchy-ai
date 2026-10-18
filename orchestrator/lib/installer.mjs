// "Install" in the Add window and the setup guide: Orchy installs a harness for the owner. It opens a terminal window
// (PowerShell on Windows, Terminal on macOS, the desktop's terminal on Linux) that runs the harness's official
// installer for this OS (engines/*: install.cmd / install.winCmd), then its sign-in for the default profile
// (install.signIn), so the owner only answers the installer's and the browser's prompts. The commands come from the
// engine registry, never from the request. The dashboard watches GET /api/runtimes until the harness is found.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR } from './env.mjs';
import { engine, engineOffered, engineInstallCmd, offeredRefusal } from './engines/index.mjs';
import { openShellWindow } from './workspaces.mjs';
import { psq } from './engines/shared.mjs';

const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const jobs = new Map(); // engine id → { startedAt, cmd }

/** Where the official installers put their programs (the window's PATH is from before the install). */
export function installBinDirs({ win = process.platform === 'win32', home = os.homedir(), appData = process.env.APPDATA, localAppData = process.env.LOCALAPPDATA } = {}) {
  if (win) {
    return [path.join(home, '.local', 'bin'), appData && path.join(appData, 'npm'), localAppData && path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin'),
      localAppData && path.join(localAppData, 'hermes', 'bin'), path.join(home, '.opencode', 'bin')].filter(Boolean);
  }
  return ['$HOME/.local/bin', '$HOME/.opencode/bin', '$HOME/.hermes/bin', '$HOME/.npm-global/bin', '/opt/homebrew/bin', '/usr/local/bin'];
}

// the variables that would point a sign-in at another profile than the default one
const PROFILE_VARS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HERMES_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'CLAUDECODE'];

/** The install script for this OS: install, refresh the PATH, then sign in when the program is there. */
export function installScript(e, { win = process.platform === 'win32', dirs = installBinDirs({ win }) } = {}) {
  const i = e.install || {};
  const cmd = engineInstallCmd(e, { win });
  const bin = i.bin || e.id;
  const label = e.label.replace(/\s+/g, ' ');
  if (win) {
    // the BOM makes Windows PowerShell read it as UTF-8
    return `﻿# Orchy: install ${label}
$Host.UI.RawUI.WindowTitle = ${psq(`Install ${label}`)}
Write-Host ${psq(`Orchy is installing ${label} with its official installer. Answer any prompts here.`)} -ForegroundColor Yellow
Write-Host ${psq(`> ${cmd}`)}
${cmd}
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + ${psq(dirs.join(';'))}
foreach ($v in @(${PROFILE_VARS.map(psq).join(', ')})) { Remove-Item "Env:$v" -ErrorAction SilentlyContinue }
if (Get-Command ${psq(bin)} -ErrorAction SilentlyContinue) {
  Write-Host ''
  Write-Host ${psq(`${label} is installed.${i.signIn ? ' Now sign in to your account (a browser window may open).' : ''}`)} -ForegroundColor Green
${i.signIn ? `  ${i.signIn}\n` : ''}  Write-Host ''
  Write-Host 'Done. Go back to Orchy: it notices on its own.' -ForegroundColor Green
} else {
  Write-Host ''
  Write-Host ${psq(`${label} didn't install. Scroll up for the installer's message, then try again from Orchy.`)} -ForegroundColor Red
}
`;
  }
  return `#!/bin/sh
# Orchy: install ${label}
printf '%s\\n' ${shq(`Orchy is installing ${label} with its official installer. Answer any prompts here.`)}
printf '> %s\\n' ${shq(cmd)}
${cmd}
PATH="${dirs.join(':')}:$PATH"; export PATH
unset ${PROFILE_VARS.join(' ')}
if command -v ${shq(bin)} >/dev/null 2>&1; then
  printf '\\n%s\\n' ${shq(`${label} is installed.${i.signIn ? ' Now sign in to your account (a browser window may open).' : ''}`)}
${i.signIn ? `  ${i.signIn}\n` : ''}  printf '\\nDone. Go back to Orchy: it notices on its own.\\n'
else
  printf '\\n%s\\n' ${shq(`${label} didn't install. Scroll up for the installer's message, then try again from Orchy.`)}
fi
exec "\${SHELL:-/bin/sh}"
`;
}

/** The owner pressed Install: open the window. Returns { started, already, cmd }. */
export function installHarness(id) {
  const e = engine(id);
  if (!e) throw Object.assign(new Error(`Unknown harness "${id}"`), { status: 404 });
  if (!engineOffered(e)) throw Object.assign(new Error(offeredRefusal(e)), { status: 409 });
  const cmd = engineInstallCmd(e);
  if (!cmd || !e.install) throw Object.assign(new Error(`Orchy has no installer for ${e.label}. Install it yourself, then press Re-check.`), { status: 400 });
  if (e.available()) return { already: true, cmd };
  const win = process.platform === 'win32';
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, `install-${e.id}.${win ? 'ps1' : 'sh'}`);
  fs.writeFileSync(file, installScript(e, { win }), { mode: 0o700 });
  // the sign-in is for the default profile: nothing this Orchy runs with may point it at another
  const childEnv = { ...process.env };
  for (const k of PROFILE_VARS) delete childEnv[k];
  if (win) spawn('cmd.exe', ['/c', 'start', '""', 'powershell', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', file], { detached: true, stdio: 'ignore', windowsHide: true, env: childEnv }).unref();
  else openShellWindow(file, cmd, { env: childEnv });
  jobs.set(e.id, { startedAt: new Date().toISOString(), cmd });
  return { started: true, cmd };
}

/** An install Orchy started (and when), or null. */
export const installJob = id => jobs.get(id) || null;
