// The shared ACP client (engines/acp.mjs) against a FAKE ACP agent (a Node script spawned as the subprocess; no real
// harness, no network), plus the Hermes and DeepSeek generated configs:
//   node orchestrator/scripts/test-engine-acp.mjs
// Checks: initialize declines fs/terminal; a read-like tool is approved once; `git push`, an unknown tool and an
// outward kind are refused by the REAL policy (no pop-up decision is made: the stub gate refuses whatever would need
// one); a gate that throws → reject (fail closed); allow_always/reject_always are never chosen; a malformed request
// and fs/terminal requests are refused; an agent acting without asking aborts the run; a process exit fails it;
// the bridge MCP server rides in session/new. Nothing is saved or installed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide } from '../lib/policy.mjs';
import { launchAcpRun, pickOption, gateCalls, toAcpMcp, mcpName, AcpConnection, CLIENT_CAPABILITIES } from '../lib/engines/acp.mjs';
import { buildHermesConfigYaml, hermesConfigLooksSafe, HERMES_APPROVALS, parseHermesStatus } from '../lib/engines/hermes-config.mjs';
import { hermesEnv, hermesArgs, hermesHookCommand } from '../lib/engines/hermes.mjs';
import { hermesHookCalls, actionKind } from '../lib/engines/hookmap.mjs';
import hermes from '../lib/engines/hermes.mjs';
import { inspectHermesAccount, hermesRootFor } from '../lib/engines/tier-catalog.mjs';

let fail = 0;
const ok = (cond, label, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : `  ${extra}`}`); if (!cond) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-acp-agent.mjs');
// the real path: macOS's temp folder is /var/… by one name and /private/var/… (what the agent reports) by the other
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orchy-acp-test-')));
const CWD = path.join(TMP, 'workspaces', 'Alpha');
fs.mkdirSync(CWD, { recursive: true });
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });
const WS = { id: 'alpha', name: 'Alpha', dir: CWD };
const BRIDGE = { command: 'node', args: ['bridge.mjs'], env: { JOS_TOKEN: 'tok', JOS_RUN: 'r1' } };

async function run(scenario, over = {}, { cfg = {}, io = {}, afterStart, takeHookAllow } = {}) {
  const log = path.join(TMP, `log-${Math.random().toString(36).slice(2)}.jsonl`);
  const out = { records: [], gated: [], started: null, done: null, wouldAsk: [], log, handle: null };
  const gateCtx = { run: { workspace: 'alpha', agentSlug: null }, ws: WS, agent: null, connections: [], mode: 'decisions', askFor: {}, oneScoped: false, remembered: () => false, resolveAction: async () => ({ method: null }), wsAgents: [], otherDirs: [], josRoot: TMP };
  const hooks = {
    record: e => out.records.push(e),
    started: s => { out.started = s; },
    gate: async (tool, input) => {
      out.gated.push({ tool, input });
      if (String(input.url || '').startsWith('boom://')) throw new Error('gate down');
      const v = await decide(tool, input, gateCtx);
      if (v.decision === 'allow') return { allow: true };
      out.wouldAsk.push({ tool, decision: v.decision, reason: v.reason });
      return { allow: false, reason: v.reason };
    },
    usage: t => { out.usage = t; },
    cost: c => { out.cost = c; },
    done: d => { out.done = d; out.resolve?.(); },
    ...(takeHookAllow ? { takeHookAllow } : {}),
  };
  const finished = new Promise(r => { out.resolve = r; });
  out.handle = launchAcpRun({
    cwd: CWD, bin: process.execPath, args: [FAKE], label: 'FakeAgent',
    env: { ...process.env, FAKE_ACP: JSON.stringify({ scenario, ...cfg }), FAKE_ACP_LOG: log },
    prompt: 'Tidy the notes', system: 'You are inside Orchy', mcpServers: toAcpMcp({}, null, BRIDGE), ...over,
  }, hooks, { graceMs: 80, cancelGraceMs: 600, ...io });
  afterStart?.(out);
  await Promise.race([finished, sleep(12_000).then(() => { throw new Error(`the run "${scenario}" never finished`); })]);
  out.msgs = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  out.sent = (method) => out.msgs.filter(m => m.dir === 'in' && m.msg.method === method).map(m => m.msg);
  out.answers = out.msgs.filter(m => m.dir === 'in' && m.msg.method === undefined && m.msg.id >= 1000).map(m => m.msg);
  return out;
}

// ── pure bits ──
{
  const opts = [{ optionId: 'a', kind: 'allow_always' }, { optionId: 'o', kind: 'allow_once' }, { optionId: 'r', kind: 'reject_once' }, { optionId: 'x', kind: 'reject_always' }];
  ok(pickOption(opts, true) === 'o' && pickOption(opts, false) === 'r', 'pickOption picks the *_once options');
  ok(pickOption([{ optionId: 'a', kind: 'allow_always' }], true) === null && pickOption([{ optionId: 'x', kind: 'reject_always' }], false) === null && pickOption(null, true) === null && pickOption([{ kind: 'allow_once' }], true) === null, 'pickOption never falls back to an *_always option (or a malformed one)');
  ok(CLIENT_CAPABILITIES.terminal === false && CLIENT_CAPABILITIES.fs.readTextFile === false && CLIENT_CAPABILITIES.fs.writeTextFile === false, 'the declared client capabilities are all off');
  const g = (tc, names = ['jos']) => gateCalls(tc, { cwd: CWD, serverNames: names });
  ok(g({ kind: 'execute', rawInput: { command: 'git push' } })[0].tool === 'Bash' && g({ kind: 'execute', rawInput: { command: ['ls', '-la'] } })[0].input.command === 'ls -la', 'execute → Bash with the command');
  const e = g({ kind: 'edit', locations: [{ path: 'a.txt' }, { path: 'b.txt' }] });
  ok(e.length === 2 && e.every(c => c.tool === 'Edit' && path.isAbsolute(c.input.file_path)), 'edit → Edit per path, made absolute');
  ok(g({ kind: 'delete', rawInput: { path: 'x' } })[0].tool === 'Edit' && g({ kind: 'move', rawInput: { source: 'a', destination: 'b' } }).length === 2, 'delete/move → Edit, both paths for a move');
  ok(g({ kind: 'fetch', rawInput: { url: 'https://x.test' } })[0].tool === 'WebFetch', 'fetch → WebFetch');
  ok(g({ kind: 'other', name: 'jos__ask_user' })[0].tool === 'mcp__jos__ask_user' && mcpName('other_server_tool', ['jos']) === null, 'a known MCP server\'s tool → mcp__server__tool; an unknown name is not');
  ok(g({ kind: 'other', title: 'Deploy' })[0].tool.startsWith('acp:') && g({ kind: 'switch_mode', title: 'Go' })[0].tool.startsWith('acp:') && g({ kind: 'brand_new', title: 'Z' })[0].tool.startsWith('acp:'), 'other / switch_mode / unknown kinds become an unrecognised tool (policy asks)');
  ok(g({ kind: 'execute', name: 'jos__x', title: 'jos__x', rawInput: { command: 'rm -rf /' } })[0].tool === 'Bash', 'a tool that names itself jos__ but is a shell command is still Bash');
  const m = toAcpMcp({ a: { enabled: true, type: 'stdio', command: 'c', args: ['x'], env: { K: 'v' } }, b: { enabled: true, type: 'sse', url: 'u' }, c: { enabled: false, type: 'stdio', command: 'z' } }, null, BRIDGE);
  ok(m.length === 2 && m[0].name === 'jos' && m[0].env[0].name === 'JOS_TOKEN' && Array.isArray(m[0].env) && m[1].name === 'a' && m[1].env[0].value === 'v', 'MCP servers → ACP stdio form (env as name/value list); remote and disabled ones are left out');
  // the connection: garbage lines are reported, never trusted
  let garbage = 0, got = null;
  let cb; const t = { onData: c => { cb = c; }, write() {} };
  new AcpConnection(t, { onGarbage: () => garbage++, onNotification: (mm, p) => { got = [mm, p]; } });
  cb('not json\n{"jsonrpc":"1.0"}\n{"jsonrpc":"2.0","method":"session/update","params":{"a":1}}\n{"jsonrpc":"2.0","id":99,"result":1}\n');
  ok(garbage === 3 && got?.[0] === 'session/update', 'unreadable lines, wrong versions and answers nobody asked for are garbage; notifications still arrive');
}

// ── 1. the main path ──
{
  const o = await run('main');
  const init = o.sent('initialize')[0];
  ok(init?.params?.protocolVersion === 1 && init.params.clientCapabilities.terminal === false && init.params.clientCapabilities.fs.readTextFile === false && init.params.clientCapabilities.fs.writeTextFile === false, 'initialize declines fs and terminal capabilities', JSON.stringify(init?.params));
  const sn = o.sent('session/new')[0];
  ok(path.resolve(sn?.params?.cwd) === path.resolve(CWD) && sn.params.mcpServers?.[0]?.name === 'jos' && sn.params.mcpServers[0].command === 'node' && sn.params.mcpServers[0].args[0] === 'bridge.mjs' && sn.params.mcpServers[0].env.some(e => e.name === 'JOS_TOKEN' && e.value === 'tok'), 'the bridge MCP server is passed in session/new (stdio form)', JSON.stringify(sn?.params));
  const p = o.sent('session/prompt')[0];
  ok(p.params.sessionId === 'sess_1' && p.params.prompt[0].type === 'text' && p.params.prompt[0].text.includes('You are inside Orchy') && p.params.prompt[0].text.includes('Tidy the notes'), 'the prompt carries the system text and the task');
  const by = Object.fromEntries(o.answers.map((a, i) => [i, a.result?.outcome]));
  ok(o.answers.length === 6, 'every permission request is answered once', String(o.answers.length));
  ok(by[0]?.outcome === 'selected' && by[0].optionId === 'ao', 'a read inside the folder is approved with allow_once');
  ok(o.gated[0].tool === 'Read' && o.gated[0].input.file_path.endsWith('notes.md'), 'the read reaches the gate as Read with its path', JSON.stringify(o.gated[0]));
  ok(o.gated[1].tool === 'Bash' && o.gated[1].input.command === 'git push origin main' && by[1]?.optionId === 'ro' && o.wouldAsk.some(w => w.tool === 'Bash' && w.decision === 'ask'), 'git push is refused by the real policy (reject_once)', JSON.stringify([o.gated[1], by[1]]));
  ok(o.gated[2].tool.startsWith('acp:') && by[2]?.optionId === 'ro' && o.wouldAsk.some(w => w.tool.startsWith('acp:') && w.decision === 'ask'), 'an unknown / outward kind is refused (policy asks, the stub refuses)', JSON.stringify([o.gated[2], by[2]]));
  ok(o.gated[3].tool === 'Edit' && by[3]?.optionId === 'ao', 'an edit inside the folder is allowed once', JSON.stringify(o.gated[3]));
  ok(o.gated[4].tool === 'mcp__jos__report_done' && by[4]?.optionId === 'ao', 'the Orchy bridge tool maps to mcp__jos__* and is allowed');
  ok(by[5]?.outcome === 'cancelled', 'allow wanted but allow_once not offered (only allow_always) → cancelled, never allow_always');
  ok(!o.answers.some(a => ['aa', 'ra'].includes(a.result?.outcome?.optionId)), 'allow_always / reject_always are never chosen');
  ok(o.done?.code === 0 && o.done.status === 'completed' && o.done.resultText === 'All done.', 'the run ends done with the agent\'s last message', JSON.stringify(o.done));
  ok(o.started?.threadId === 'sess_1' && Math.abs(o.cost - 0.02) < 1e-9, 'the session id is the resume key and the cost is reported', JSON.stringify([o.started, o.cost]));
  const tools = o.records.filter(r => r.kind === 'tool');
  ok(tools.some(t => t.tool === 'Bash' && t.input.command === 'git push origin main') && tools.some(t => t.tool === 'Edit'), 'tool steps reach the feed with policy-style names', JSON.stringify(tools.map(t => t.tool)));
  ok(o.records.filter(r => r.kind === 'tool_error').length === 3, 'refused tools show as failed steps');
  ok(o.handle.info().gatedEvidence && o.handle.info().permissionRequests === 6, 'the run saw the agent ask through ACP (gating evidence)');
}

// ── 2. the gate throws → reject ──
{
  const o = await run('gatethrow');
  ok(o.answers[0]?.result?.outcome?.optionId === 'ro' && o.records.some(r => r.kind === 'denied' && /check|refused/i.test(r.text)), 'a gate that throws is answered reject_once (fail closed)', JSON.stringify(o.answers));
}
// ── 3. the gate hangs → timeout → reject ──
{
  const o = await run('gatethrow', {}, { io: { gateTimeoutMs: 50 } });
  ok(o.done && o.answers[0]?.result?.outcome?.optionId === 'ro', 'a gate that takes too long (or fails) still ends in a refusal');
}
// ── 4. the agent acts without asking ──
{
  const o = await run('noask');
  ok(o.done?.code === 1 && /acted without asking/i.test(o.done.error) && o.records.some(r => r.kind === 'denied'), 'a shell tool running without a permission request aborts the run', JSON.stringify(o.done));
  const o2 = await run('noask', { strict: false });
  ok(o2.done?.code === 0 && o2.records.some(r => r.kind === 'system' && /without asking/.test(r.text)), 'strict:false (allowUngated workspaces) notes it on the feed and carries on');
  const o3 = await run('ranAfterReject');
  ok(o3.done?.code === 1 && /refused/i.test(o3.done.error), 'a tool that runs after Orchy refused it aborts the run', JSON.stringify(o3.done));
  // an engine with Orchy's pre-tool hook (Hermes): the hook's OK for the same kind of action counts as asking
  const took = [];
  const o5 = await run('noask', {}, { takeHookAllow: (kind, file) => { took.push([kind, file]); return kind === 'execute'; } });
  ok(o5.done?.code === 0 && took.some(([k]) => k === 'execute'), 'strict: a shell tool the pre-tool hook cleared runs on (no ACP request needed)', JSON.stringify([o5.done, took]));
  const o6 = await run('noask', {}, { takeHookAllow: () => false });
  ok(o6.done?.code === 1 && /acted without asking/i.test(o6.done.error), 'strict: with no hook OK for it, the same tool still aborts the run', JSON.stringify(o6.done));
  const kept = [];
  const o7 = await run('main', {}, { takeHookAllow: (kind, file, o = {}) => { if (file) kept.push(!!o.keep); return kind === 'edit' && !!file && file.endsWith('a.txt'); } });
  ok(!o7.gated.some(g => g.tool === 'Edit') && o7.gated.some(g => g.tool === 'Bash'), 'an ACP edit request for a file the hook already cleared is answered from that OK (the owner is never asked twice); other calls still reach the gate', JSON.stringify(o7.gated.map(g => g.tool)));
  ok(kept.length > 0 && kept.every(Boolean), 'the edit request only checks the hook OK (keep): the tool, under its own id, uses it up', JSON.stringify(kept));
  const o4 = await run('readfree');
  ok(o4.done?.code === 0 && o4.gated.length === 0 && o4.done.resultText === 'read it', 'read/search/think tools need no permission request');
}
// ── 5. the process exits mid-run ──
{
  const o = await run('exit');
  ok(o.done?.code === 1 && /stopped \(exit 3\)/.test(o.done.error), 'a process exit mid-run fails the run', JSON.stringify(o.done));
}
// ── 6. fs / terminal requests and a malformed permission request ──
{
  const o = await run('fs');
  const a = o.msgs.find(m => m.dir === 'fs-answers')?.msg;
  ok(a?.a?.error?.code === -32601 && a?.b?.error?.code === -32601, 'fs/* and terminal/* requests are refused (method not found)', JSON.stringify(a));
  const o2 = await run('malformed');
  const m = o2.msgs.find(x => x.dir === 'malformed-answer')?.msg;
  ok(m?.result?.outcome?.outcome === 'cancelled', 'a permission request with no toolCall is answered cancelled', JSON.stringify(m));
}
// ── 7. stop() cancels ──
{
  const o = await run('hang', {}, { afterStart: out => setTimeout(() => out.handle.stop(), 300) });
  ok(o.sent('session/cancel').length === 1 && o.done?.status === 'interrupted', 'stop() sends session/cancel and the run ends interrupted', JSON.stringify(o.done));
}
// ── 8. resume ──
{
  const a = await run('readfree', { resumeSessionId: 'sess_old' }, { cfg: { loadSession: true } });
  ok(a.sent('session/load')[0]?.params.sessionId === 'sess_old' && a.sent('session/new').length === 0 && a.started.threadId === 'sess_old', 'session/load is used when the agent advertises loadSession');
  const b = await run('readfree', { resumeSessionId: 'sess_old' }, { cfg: { loadSession: false } });
  ok(b.sent('session/load').length === 0 && b.sent('session/new').length === 1 && b.records.some(r => r.kind === 'system' && /fresh/.test(r.text)), 'without loadSession it starts fresh and says so');
  const c = await run('readfree', { resumeSessionId: 'sess_old' }, { cfg: { loadSession: true, loadFails: true } });
  ok(c.sent('session/new').length === 1 && c.records.some(r => r.kind === 'system' && /fresh/.test(r.text)) && c.done.code === 0, 'a session/load that fails starts fresh and says so');
}
// ── 9. a binary that is not there ──
{
  const o = await run('main', { bin: path.join(TMP, 'no-such-binary') });
  ok(o.done?.code === 1 && /stopped/i.test(o.done.error), 'a missing binary fails the run');
}

// ── Hermes: the generated config forces manual approvals, no yolo, no allowlist ──
{
  const fresh = buildHermesConfigYaml('');
  ok(hermesConfigLooksSafe(fresh), 'hermes: the generated config is safe');
  ok(/mode: manual/.test(fresh) && /unattended_mode: deny/.test(fresh) && /single_query_mode: deny/.test(fresh) && /cron_mode: deny/.test(fresh), 'hermes: manual approvals, unattended / single-query / cron denied');
  ok(!/yolo/i.test(fresh.replace(/^#.*$/gm, '')) && !/mode: (off|smart)/.test(fresh) && /command_allowlist: \[\]/.test(fresh), 'hermes: no yolo, never off/smart, an empty allowlist');
  const hostile = buildHermesConfigYaml('model: x/y\napprovals:\n  mode: off\n  unattended_mode: approve\n  deny:\n    - "git push --force*"\ncommand_allowlist:\n  - rm\nyolo: true\n');
  ok(hermesConfigLooksSafe(hostile) && /model: x\/y/.test(hostile) && /git push --force/.test(hostile) && !/- rm/.test(hostile), 'hermes: an owner config that loosened approvals is overridden; model and deny globs are kept');
  ok(!hermesConfigLooksSafe('approvals:\n  mode: off\n') && !hermesConfigLooksSafe('approvals:\n  mode: manual\n  unattended_mode: deny\n  single_query_mode: deny\n  cron_mode: deny\ncommand_allowlist:\n  - rm\n'), 'hermes: the safety check rejects off mode and an allowlist');
  ok(HERMES_APPROVALS.mode === 'manual', 'hermes: constant is manual');
  ok(hermesArgs().join(' ') === 'acp' && !hermesArgs().some(a => /yolo/i.test(a)), 'hermes: runs `hermes acp`, never --yolo');
  const env = hermesEnv('/p/prof', { PATH: '/bin', HERMES_YOLO_MODE: '1', HERMES_HOME: '/other', OPENAI_API_KEY: 'k', FOO: '1' });
  ok(env.HERMES_HOME.replace(/\\/g, '/').endsWith('/p/prof') && env.HERMES_YOLO_MODE === undefined && env.OPENAI_API_KEY === undefined && env.FOO === '1' && env.HERMES_ACP_SKIP_CONFIGURED_MCP === '1', 'hermes: env points at the profile, drops HERMES_YOLO_MODE and the PC\'s keys, skips the global MCP servers');
  ok(hermes.capabilities.gated === true && hermes.accountModel === 'profile', 'hermes: gated (its pre_tool_call hook), profile account model');
  const HOOK = hermesHookCommand({ script: 'C:/Orchy Folder/orchestrator/mcp/tool-hook.mjs', credsFile: 'C:/Orchy Folder/orchestrator/data/tool-hook.json' }, 'C:/Program Files/nodejs/node.exe');
  ok(HOOK === '"C:/Program Files/nodejs/node.exe" "C:/Orchy Folder/orchestrator/mcp/tool-hook.mjs" "hermes" "C:/Orchy Folder/orchestrator/data/tool-hook.json"', 'hermes: the hook command quotes every path (spaces are fine)', HOOK);
  const hooked = buildHermesConfigYaml('model: x/y\nhooks:\n  pre_tool_call:\n    - command: rewrite-args.sh\n  post_tool_call:\n    - command: audit.sh\nhooks_auto_accept: false\n', { hookCommand: HOOK });
  ok(hermesConfigLooksSafe(hooked, { hookCommand: HOOK }) && !/rewrite-args/.test(hooked) && /audit\.sh/.test(hooked) && /fail_closed: true/.test(hooked) && /hooks_auto_accept: true/.test(hooked) && /model: x\/y/.test(hooked), 'hermes: Orchy’s hook is the only pre_tool_call hook (fail_closed, auto-accepted); the owner’s other hooks and model stay', hooked);
  ok(!hermesConfigLooksSafe(buildHermesConfigYaml(''), { hookCommand: HOOK }) && !hermesConfigLooksSafe(hooked.replace('fail_closed: true', 'fail_closed: false'), { hookCommand: HOOK }) && !hermesConfigLooksSafe(hooked.replace('pre_tool_call:', 'pre_tool_call:\n    - command: other.sh'), { hookCommand: HOOK }), 'hermes: the safety check rejects a config without the hook, a fail-open hook, or a second pre_tool_call hook');
  ok(hermesEnv('/p', { PATH: '/bin', HERMES_SAFE_MODE: '1' }).HERMES_SAFE_MODE === undefined, 'hermes: HERMES_SAFE_MODE (which skips every hook) never reaches it');
  // what Hermes's hook sends → the gate's calls (the payload shape Hermes 0.21 sends)
  const hc = (tool_name, tool_input) => hermesHookCalls({ hook_event_name: 'pre_tool_call', tool_name, tool_input, session_id: 's1', cwd: CWD }).calls;
  ok(hermesHookCalls({ session_id: 's1', tool_name: 'todo', tool_input: {} }).sessionId === 's1', 'hermes hook: the run is found by its ACP session id');
  ok(hc('write_file', { path: 'note.txt', content: 'hi' })[0].tool === 'Write' && hc('write_file', { path: 'note.txt' })[0].input.file_path === path.join(CWD, 'note.txt'), 'hermes hook: write_file → Write, its path resolved in the run folder');
  ok(hc('patch', { path: 'a.txt' })[0].tool === 'Edit' && hc('read_file', { path: 'a.txt' })[0].tool === 'Read', 'hermes hook: patch → Edit, read_file → Read');
  ok(hc('terminal', { command: 'rm deleteme.txt' })[0].tool === 'Bash' && hc('terminal', { command: 'rm deleteme.txt' })[0].input.command === 'rm deleteme.txt', 'hermes hook: terminal → Bash with its command');
  ok(hc('execute_code', { code: 'print(1)' })[0].tool === 'Bash', 'hermes hook: execute_code is judged as the script it runs');
  ok(hc('web_extract', { urls: ['https://a.example', 'https://b.example'] }).map(c => c.input.url).join() === 'https://a.example,https://b.example', 'hermes hook: web_extract → one WebFetch per URL (all must pass)');
  ok(hc('mcp__testmcp__touch_marker', {})[0].tool === 'mcp__testmcp__touch_marker' && hc('tool_describe', {})[0].tool === 'TodoWrite' && hc('send_message', { to: 'x' })[0].tool === 'hermes:send_message', 'hermes hook: MCP tools keep their name, its own bookkeeping passes, anything unknown asks the owner');
  ok(actionKind('Write') === 'edit' && actionKind('Bash') === 'execute' && actionKind('mcp__a__b') === 'mcp__a__b' && actionKind('hermes:x') === 'other', 'hook kinds match the ACP kinds the safety net sees');
  ok(parseHermesStatus('Model: nous/hermes-4\nProvider: openrouter\n').providers.join() === 'openrouter' && parseHermesStatus('garbage').providers.length === 0 && parseHermesStatus('Provider: none').providers.length === 0, 'hermes: status parsing is defensive');
}

// ── Hermes sign-in: a profile uses its own sign-ins, else the computer's (Hermes 0.21 profile mode), never .env keys ──
{
  const NATIVE = path.join(TMP, 'hermes-home');
  const put = (dir, file, body) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, file), typeof body === 'string' ? body : JSON.stringify(body)); };
  put(NATIVE, 'auth.json', {
    active_provider: 'nous',
    providers: { nous: { access_token: 'pc-token', account_tier: 'plus' } },
    credential_pool: { deepseek: [{ id: 'a', auth_type: 'api_key', access_token: 'sk-pc' }], openrouter: [{ id: 'b', source: 'env:OPENROUTER_API_KEY' }] },
  });
  put(NATIVE, '.env', 'FOO_API_KEY=pc-env-key\n');
  put(NATIVE, 'config.yaml', 'model:\n  default: hermes-4\n  provider: nous\n  api_key: never-copied\n');
  put(NATIVE, 'provider_models_cache.json', { nous: { models: ['hermes-4', 'hermes-4-mini'] } });

  ok(hermesRootFor(path.join(NATIVE, 'profiles', 'orchy-a'), NATIVE) === path.resolve(NATIVE) && hermesRootFor(path.join(TMP, 'elsewhere', 'profiles', 'p'), NATIVE) === path.join(TMP, 'elsewhere')
    && hermesRootFor(path.join(TMP, 'loose'), NATIVE) === null && hermesRootFor(NATIVE, NATIVE) === null, 'hermes: a profile falls back to the home it sits in, as Hermes resolves it');

  const empty = path.join(NATIVE, 'profiles', 'orchy-empty');
  fs.mkdirSync(empty, { recursive: true });
  const a = inspectHermesAccount(empty, { native: NATIVE });
  ok(a.loggedIn && a.providers.includes('nous') && a.providers.includes('deepseek') && !a.providers.includes('openrouter') && !a.providers.includes('foo'), 'hermes: an empty profile is signed in with the computer’s stored sign-ins, not env-sourced rows or .env keys', JSON.stringify(a.providers));
  ok(/this computer's sign-in/.test(a.label) && a.computerProviders.length === 2 && a.configuredModel === 'hermes-4' && a.models.includes('hermes-4-mini') && a.plan === 'Nous Portal · Plus', 'hermes: it says the sign-in is the computer’s, and takes the computer’s model, list and plan', a.label);
  ok(a.computerModel?.model?.default === 'hermes-4' && !('api_key' in a.computerModel.model), 'hermes: the computer’s model block carries over without its key', JSON.stringify(a.computerModel));

  const own = path.join(NATIVE, 'profiles', 'orchy-own');
  put(own, 'auth.json', { active_provider: 'nous', providers: { nous: { access_token: 'ws-token', account_tier: 'free' } } });
  const b = inspectHermesAccount(own, { native: NATIVE });
  ok(b.loggedIn && b.computerProviders.join() === 'deepseek' && /deepseek from this computer's sign-in/.test(b.label) && b.tier === 'free', 'hermes: a profile’s own sign-in wins; only the providers it lacks come from the computer', b.label);

  const loose = path.join(TMP, 'loose-profile');
  fs.mkdirSync(loose, { recursive: true });
  ok(!inspectHermesAccount(loose, { native: NATIVE }).loggedIn, 'hermes: a profile outside any Hermes home borrows nothing');
  ok(!inspectHermesAccount(null).computerProviders.length, 'hermes: the PC’s own home reports no borrowed sign-ins');

  const custom = path.join(TMP, 'custom-home');
  put(custom, 'auth.json', { providers: { nous: { access_token: 't' } } });
  put(custom, 'config.yaml', 'model:\n  default: kimi\n  provider: custom\n  base_url: https://x.example\n');
  const c = inspectHermesAccount(path.join(custom, 'profiles', 'p'), { native: NATIVE });
  ok(c.loggedIn && c.computerModel === null && c.configuredModel === null, 'hermes: the computer’s model isn’t taken when its provider’s key isn’t one a profile can borrow');

  const HOOK = '"node" "hook.mjs" "hermes" "creds.json"';
  const filled = buildHermesConfigYaml('', { hookCommand: HOOK, fallbackModel: a.computerModel });
  ok(hermesConfigLooksSafe(filled, { hookCommand: HOOK }) && /default: hermes-4/.test(filled) && !/never-copied/.test(filled), 'hermes: a profile without a model gets the computer’s, still safe', filled);
  const kept = buildHermesConfigYaml('model: mine/x\n', { hookCommand: HOOK, fallbackModel: a.computerModel });
  ok(/model: mine\/x/.test(kept) && !/hermes-4/.test(kept), 'hermes: a profile’s own model is never replaced');
}

console.log(fail ? `\n${fail} ACP check(s) FAILED` : '\nall ACP checks passed');
process.exit(fail ? 1 : 0);
