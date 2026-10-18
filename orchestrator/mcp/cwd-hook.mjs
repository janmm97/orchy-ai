// Claude Code PreToolUse hook on an agent's Bash/PowerShell calls (runner.mjs#setupSettingsFile):
//   node orchestrator/mcp/cwd-hook.mjs <runId>
// Claude Code's shell keeps the folder a `cd` left it in from one command to the next, and only hooks are told
// which folder that is. Each call's folder goes to data/runs/<runId>.cwd.jsonl by tool_use_id, so the approval gate
// reads a bare `../x` from where the command really runs (gate.mjs#shellCwd). Never blocks the call: no output, exit 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runId = process.argv[2] || '';
let raw = '';
process.stdin.on('data', d => { raw += d; }).on('end', () => {
  try {
    if (!/^run_[a-z0-9]+$/i.test(runId)) return;
    const j = JSON.parse(raw);
    if (!j.cwd || !j.tool_use_id) return;
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'runs', `${runId}.cwd.jsonl`);
    fs.appendFileSync(file, `${JSON.stringify({ id: j.tool_use_id, cwd: j.cwd })}\n`);
  } catch {}
});
