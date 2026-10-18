# Harnesses

A harness is the coding-agent CLI that does the work inside a workspace. Orchy starts it in the workspace folder, gives it the Orchy bridge (ask, approve, report) and answers its approval requests through the approval gate (`orchestrator/lib/gate.mjs`).

Hermes and Antigravity were run against their real binaries (Windows, 2026-10-19); the others are still "pending" or "implemented, unverified" until the maintainer updates this file after testing. "Unverified" means the adapter is covered only by tests with a fake harness (`npm test`) and by reading the harness's public docs; nobody has run it against the real binary.

## Status

| Harness | Gated (every risky action asks Orchy first) | Status |
|---|---|---|
| Claude Code | yes (permission-prompt MCP tool) | pending real-install test |
| Codex | yes (`untrusted` policy, every approval request) | pending real-install test |
| OpenCode | yes, by its own config: every tool set to `ask` | implemented, unverified against the real binary (fake-server tests only) |
| Hermes | yes, through its `pre_tool_call` hook (every tool call asks Orchy first) | checked against the real binary (Hermes 0.21.7, Windows) |
| Antigravity | yes, through its `PreToolUse` hook (every tool call asks Orchy first) | checked against the real binary (agy 1.4.2, Windows). Off by default (`ORCHY_ANTIGRAVITY=1` in `.env`) |

Every harness shipped here is gated. An engine registered as not gated (one Orchy cannot prove asks before every file change, command or tool call) would be refused: `startRun` refuses the workspace unless the owner sets `allowUngated: true` for it in `orchestrator/config.json` (Workspaces, the workspace, "allow it to run without approvals"). A workspace on any ungated harness also needs its own One login (`startRun` refuses it otherwise, code `ONE_SCOPE`): Orchy doesn't see every command such a harness runs, so the One CLI could fall back to another account. The README's simple table carries the same gated answers.

## Which instructions an agent run reads

Agent runs read only the workspace's own instructions, never the CLAUDE.md / AGENTS.md at the root of this repo. Workspaces live in `workspaces/` inside this repo, whose root CLAUDE.md and AGENTS.md are for coding agents working on Orchy, not for agent runs. Keep a CLAUDE.md or AGENTS.md in every workspace (new ones get both).

- **Claude Code:** the run's settings file lists them in `claudeMdExcludes` (`runner.mjs#setupSettingsFile`).
- **Codex:** Codex joins every AGENTS.md from the project root (the nearest folder with a `project_root_markers` entry, `.git` by default) down to the run's folder. Orchy starts `codex -c project_root_markers=[] app-server` and repeats `project_root_markers: []` in each thread's config; an empty list disables the parent walk, so only the workspace's own AGENTS.md is read (checked against Codex's source, `codex-rs/core/src/agents_md.rs`; unverified against a real install here).
- **OpenCode:** it takes the first AGENTS.md (else CLAUDE.md) walking up from the run's folder (opencode.ai/docs/rules), so the workspace's own wins as long as the workspace has one (new workspaces get both; a workspace switched to OpenCode gets AGENTS.md copied from its CLAUDE.md). Orchy sets `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1`, so the owner's personal `~/.claude/CLAUDE.md` isn't read either. Unverified against a real install.
- **Hermes, Antigravity:** how they discover instruction files above the working folder is unconfirmed. Orchy passes each run's instructions itself (ACP session prompt, or agy's stdin). If you run one of them, check whether the repo-root AGENTS.md shows up in a run, and report it.

Ori Harness (`ori`) is a launcher, not a separate harness. See the end of this file.

## Claude Code

| | |
|---|---|
| Install | macOS/Linux: `curl -fsSL https://claude.ai/install.sh \| bash`; Windows (PowerShell): `irm https://claude.ai/install.ps1 \| iex` (both put `claude` in `~/.local/bin`; code.claude.com/docs/en/quickstart). Sign in: `claude auth login`. In Orchy, **Install** (the Add window, or Set up Orchy → Tools) runs this in a terminal window, then the sign-in. |
| Headless command Orchy uses | `claude -p --output-format stream-json --verbose --model <model> --mcp-config <file> --strict-mcp-config --permission-prompt-tool mcp__jos__approval --append-system-prompt-file <file> --session-id <id>` (plus `--resume`, `--agent <slug>`, `--settings`) |
| Approvals | Every permission request goes to the MCP tool `mcp__jos__approval`, which calls the Orchy gate |
| MCP | Orchy writes a per-run MCP config with the `jos` bridge and the workspace's allowed servers (`<workspace>/.jos/mcp.json`) |
| Config and account | `CLAUDE_CONFIG_DIR` per workspace (`claudeAccount` / `claudeConfigDir` in `orchestrator/config.json`); the default is `~/.claude` |

## Codex

| | |
|---|---|
| Install | macOS/Linux: `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` (into `~/.local/bin`); Windows: `powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 \| iex"` (into `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`; learn.chatgpt.com/docs/codex/cli). Sign in: `codex login`. In Orchy, **Install** (the Add window, or Set up Orchy → Tools) runs this in a terminal window, then the sign-in. |
| Headless command Orchy uses | `codex app-server` (JSON-RPC over stdio), approval policy `untrusted`, sandbox `workspace-write` |
| Approvals | Every approval request is answered by the Orchy gate |
| MCP | Through the Codex config in the run's `CODEX_HOME` |
| Config and account | `CODEX_HOME` per workspace (`codexAccount` / `codexHome` in `orchestrator/config.json`); the default is `~/.codex`. Set `CODEX_CLI_PATH` in `.env` if the binary is somewhere unusual |

## OpenCode

**Status: implemented, unverified against the real binary.** The adapter (`orchestrator/lib/engines/opencode*.mjs`) is tested only against a fake `opencode serve` (`npm test`: `test-engine-opencode.mjs`).

| | |
|---|---|
| Install | macOS/Linux: `curl -fsSL https://opencode.ai/install \| bash` (into `~/.opencode/bin`); Windows: `npm install -g opencode-ai` (the bash installer run in WSL puts it inside Linux, where Orchy can't find it; opencode.ai/docs). Sign in: `opencode auth login`. Set `OPENCODE_CLI_PATH` in `.env` if the binary is somewhere unusual. In Orchy, **Install** (the Add window, or Set up Orchy → Tools) runs this in a terminal window, then the sign-in. |
| How Orchy runs it | Per run: `opencode serve --port <free port> --hostname 127.0.0.1` in the workspace folder, a random `OPENCODE_SERVER_PASSWORD` (HTTP basic auth, user `opencode`), the `/event` SSE stream, one session, the prompt sent with `prompt_async`. Never `--auto`; nothing secret is on the command line |
| Approvals | The per-run `opencode.json` sets `"permission": { "*": "ask", ... }` (reads, edits, shell, web, MCP tools and `external_directory` all ask; `task`, `question` and `doom_loop` are denied; `.env` reads are denied). Each ask goes to the Orchy gate and is answered through the permission endpoint with `once` (allowed) or `reject` (denied, or the gate failed). Orchy never sends `always` or `remember`. The same permission block is also passed in `OPENCODE_CONFIG_CONTENT` so a `opencode.json` in the workspace cannot loosen it |
| Fails closed | The run fails (and the server is stopped) if: `/doc` is JSON but lists no permission-response route, `/config` shows an `allow`, the server dies, the event stream drops, or Orchy cannot answer an ask |
| MCP | The Orchy bridge and the workspace's allowed servers are written under `mcp` in the generated config (`type: "local"` with `command` and `environment`, or `type: "remote"`) |
| Config and account | One profile folder per workspace (`opencodeProfile` in `orchestrator/config.json`): `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CONFIG_HOME` and `OPENCODE_CONFIG_DIR` all point inside it. Credentials are expected in `<profile>/data/opencode/auth.json`. OpenCode has no account email, so Orchy's account check requires a profile folder of its own, shared with no other OpenCode workspace, with at least one provider logged in. OpenCode has no way to lend a profile the computer's sign-in (unlike Hermes), so each OpenCode workspace signs in once with **Log in**; when the computer is signed in and the workspace isn't, Orchy says exactly that instead of a bare "not logged in". The PC's own provider API keys are removed from the child's environment |
| Models | The three tiers are all `default`: no model is sent and OpenCode uses what its config picks. A `provider/model` typed in the model box (or in an agent file) is passed through |
| Limits today | Not for client pages, huddles or delegation (not verified); resume uses the stored OpenCode session id |

### Checked against the docs (opencode.ai/docs, this revision)

Confirmed in the docs: `GET /event` (first event `server.connected`), `GET /doc`, `GET /config`, `POST /session`, `POST /session/:id/prompt_async` (204), `POST /session/:id/abort`, `POST /session/:id/permissions/:permissionID` with body `{ response, remember? }`; `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME`; `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT` (highest of the user-level sources, so it wins over the project's `opencode.json`); permission values `allow` / `ask` / `deny`, the `*` catch-all (put first, last match wins), ask answers `once` / `always` / `reject`; event names `permission.asked`, `permission.replied`, `message.part.updated`, `message.updated`, `session.idle`, `session.status`, `session.error` (plugins page); MCP `type: "local"` with `command` (array), `environment`, `enabled`, `timeout` (ms, **for fetching tools**, default 5000); MCP tools are prefixed with the server name (`<server>_<tool>`); `share` and `autoupdate` keys; credentials in `~/.local/share/opencode/auth.json` after `/connect`.

Changed because of the docs: `experimental.mcp_timeout` was removed (the docs do not list it) and `codesearch` was dropped from the permission list (not listed; `*` covers it). The `/doc` page is described as HTML: if it is not JSON, Orchy now uses the documented permission route instead of failing; a JSON `/doc` without a permission route still fails the run.

### Still unconfirmed (assumptions in the adapter)

- The field names inside permission events (`id`, `sessionID`, `permission` or `type`, `patterns` or `pattern`, `metadata`, `callID`) and the older event name `permission.updated`: the docs list the events but not their payloads.
- That the prompt body accepts a `system` field (the SDK docs list `parts`, `model`, `noReply`, `format`).
- That `XDG_DATA_HOME` moves `auth.json` (the providers page names only the default path) and that `opencode auth login` / `opencode auth list` write and read that file.
- That `GET /config` returns the effective merged `permission` block (used for the "no `allow`" self-check; a missing answer only logs a note).
- That a long wait on `jos_ask_user` (hours) does not hit an OpenCode MCP tool timeout: there is no documented key to raise it. If it does, the tool call fails and the agent can ask again.

### Manual verification checklist (not done yet)

1. Install OpenCode and confirm `opencode --version` runs.
2. Add a workspace on OpenCode in Orchy (Workspace, Add). Copy the login command it shows (it sets the profile variables) and run it: `opencode auth login`. Then run `opencode auth list` the same way and confirm the provider shows up, and that Orchy's account check goes green.
3. Run a task that tries a shell command (for example "run `ls` and then `git push`"). Confirm the approval pop-up appears for the outward one and the run feed shows the denied or approved step.
4. While a run is going, check the `opencode serve` command line in Task Manager or `ps`: it must be exactly `serve --port N --hostname 127.0.0.1` (no `--auto`).
5. Start `opencode serve` by hand with your own `OPENCODE_SERVER_PASSWORD` and read `GET /doc` and `GET /event` during an ask: confirm the permission route, the event name and the payload field names listed above.
6. Put `"permission": {"*": "allow"}` in an `opencode.json` inside the workspace and confirm a run still asks (the `OPENCODE_CONFIG_CONTENT` guard wins).
7. Leave a `jos_ask_user` unanswered for longer than five minutes and confirm the run waits.
8. When all of that holds, change the status above and keep the README's simple harness table in step.

## ACP (Agent Client Protocol) engines

Hermes runs through Orchy's ACP client, `orchestrator/lib/engines/acp.mjs` (JSON-RPC 2.0 over stdio, one message per line, https://agentclientprotocol.com). What the client does:

- `initialize` with `clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }`: Orchy gives the agent no file or terminal powers; any `fs/*` or `terminal/*` request that arrives anyway is answered "method not found".
- The Orchy bridge (and the workspace's allowed stdio MCP servers) go in `session/new` `mcpServers` (stdio form: `name`, `command`, `args`, `env` as a list of `{ name, value }`). Remote MCP servers are not passed.
- Every `session/request_permission` goes to the Orchy gate with the tool mapped to the names `policy.mjs` knows (`execute` to Bash, `edit`/`delete`/`move` to Edit with each path, `fetch` to WebFetch, `read` to Read, MCP names to `mcp__server__tool`; `other`, `switch_mode` and unknown kinds are an unrecognised tool, which always asks the owner). The answer is the agent's own `allow_once` or `reject_once` option, never an `*_always` option. A gate error, a timeout, a malformed request, a missing `*_once` option or a stop all answer `cancelled`.
- Safety net (`strict`): a tool of a kind other than `read`/`search`/`think` that starts running without having asked, or that runs after Orchy refused it, aborts the run as failed ("agent acted without asking"). "Asked" means a `session/request_permission` for it, or, for an engine with Orchy's pre-tool hook (below), an OK the hook got from the gate for the same kind of action (each OK counts once). An ACP edit request for a file the hook already cleared is answered from that OK, so the owner is never asked twice.
- Resume uses `session/load` only when the agent advertised `loadSession`; otherwise the run starts fresh and says so. `session/cancel` is sent on Stop; the process tree is killed if it does not finish.

Tests: `orchestrator/scripts/test-engine-acp.mjs` (a fake ACP agent in `orchestrator/scripts/fake-acp-agent.mjs`, the hook OK cases, and the Hermes generated config).

## Pre-tool hooks (Hermes, Antigravity)

Neither harness asks a client before every action on its own, but both run a hook before every tool call and obey its answer. Orchy uses that hook as its gate:

- Before every run Orchy writes the hook into the harness's own config: Hermes's profile `config.yaml` (`hooks.pre_tool_call`, the only one, `fail_closed: true`, `hooks_auto_accept: true`) and the agent's agy folder (`config/hooks.json`, a `PreToolUse` hook on `*`). The hook is `orchestrator/mcp/tool-hook.mjs`.
- For each tool call the hook maps what the harness sent to the gate's words (`orchestrator/lib/engines/hookmap.mjs`) and asks Orchy (`POST /api/bridge/tool-hook`, `runner.mjs#toolHook`), which runs the same `gate()` as every other harness: routine work passes, decisions become the owner's pop-up, and the hook waits for the answer.
- The run is found by the session id the harness puts in every hook call (Hermes's ACP session, agy's conversation id), so two runs sharing a profile or an agy folder never answer for each other. A session with no live hooked run gets a deny.
- Fail closed everywhere: the hook denies (and exits non-zero) when Orchy can't be reached, the token is wrong, the credentials file is missing or the payload is unreadable, and both harnesses block a call whose hook fails, crashes or times out.
- The hook finds Orchy through `orchestrator/data/tool-hook.json` (Orchy's address and bridge token), in Orchy's data folder, which agents are never allowed to read. Nothing secret is written into the harness's config.
- Hermes stops a hook after 5 minutes. When the owner takes longer, the hook answers "still waiting" a little before that, the agent is told to try the same call again, and the same call asked again waits on the same pop-up (never a second one) until it is answered. agy waits as long as the hook takes (Orchy sets 6 hours).

## Hermes

**Status: gated through its `pre_tool_call` hook. Checked against the real Hermes 0.21.7 on Windows (2026-10-19).**

| | |
|---|---|
| Install | macOS/Linux/WSL2: `curl -fsSL https://hermes-agent.nousresearch.com/install.sh \| bash`; Windows (PowerShell): `iex (irm https://hermes-agent.nousresearch.com/install.ps1)` (native, into `%LOCALAPPDATA%\hermes\bin`). Sign in: `hermes portal`. Set `HERMES_CLI_PATH` in `.env` if the binary is somewhere unusual. In Orchy, **Install** (the Add window, or Set up Orchy → Tools) runs this in a terminal window, then the sign-in. |
| How Orchy runs it | `hermes acp` through the ACP client (strict), `cwd` = the workspace folder, `HERMES_HOME` = the workspace's profile, `HERMES_ACP_SKIP_CONFIGURED_MCP=1` (so servers in the profile's `config.yaml` do not start beside Orchy's bridge). Never `--yolo`; `HERMES_YOLO_MODE`, `HERMES_ACCEPT_HOOKS` and `HERMES_SAFE_MODE` (which skips every hook) are removed from the child's environment |
| Forced config | Before every run Orchy rewrites the profile's `config.yaml` keeping the owner's keys (model, provider, other hooks) and forcing `approvals.mode: manual`, `unattended_mode: deny`, `single_query_mode: deny`, `cron_mode: deny`, `command_allowlist: []`, any `yolo` key removed, and Orchy's hook as the only `pre_tool_call` hook (`fail_closed: true`, 300 s, auto-accepted). Another `pre_tool_call` hook is removed: one could rewrite a call's arguments after Orchy approved it. Existing `approvals.deny` globs are kept |
| Profile | New Hermes workspaces get one of Hermes's own profiles: `%LOCALAPPDATA%\hermes\profiles\orchy-<id>` on Windows, `~/.hermes/profiles/orchy-<id>` elsewhere. Hermes 0.21 tries to rebuild its runtime for a `HERMES_HOME` outside its own data folder (and on Windows that failed), so an older workspace on `~/.hermes-<id>` should move its profile there |
| MCP | Through ACP `session/new` `mcpServers` |
| Account | `accountModel: 'profile'`: `hermesProfile` (its own, shared with no other Hermes workspace) is the profile. Signed in = credentials in the profile's `auth.json` or provider keys in its `.env`, **or the computer's sign-in**: Hermes 0.21 itself reads the home a profile sits in (`%LOCALAPPDATA%\hermes`, `~/.hermes`) for any provider the profile has no sign-in of its own for (`hermes_cli/auth.py`, profile mode; checked on 0.21.7 with an empty profile). Orchy reads it the same way, so signing Hermes in once on the computer (the installer's `hermes portal`) gets every Hermes workspace going, shown as "this computer's sign-in". Only `auth.json` sign-ins are shared: keys in the computer's `.env`, and pool rows Hermes re-reads from an environment variable or the gh CLI, are not. **Log in** on a workspace signs in its own profile, which then wins for that provider. A profile without a model gets the computer's `model` block before its first run (never its `api_key`), when the profile can sign in to that model's provider. The PC's `*_API_KEY` style variables are removed from the child's environment |
| Models | All `default`: Hermes uses the model its own config picks. An agent that names a `provider/model` gets it through the session's model config option, else `session/set_model`; if Hermes refuses, the run notes it and keeps its own pick |
| Not offered | Client pages and huddles (`clientSafe: false`, `huddles: false`): not checked with clients' sandboxes yet |

### Evidence (real binary, Hermes 0.21.7, Windows)

- Without the hook, Orchy's forced config alone: over ACP Hermes asked before `write_file` and `patch` (refused → file unchanged), but ran a terminal command, a shell `rm`, a web fetch and an MCP call without asking. Not enough on its own.
- With Orchy's `pre_tool_call` hook (`fail_closed`): every tool call reached the hook first, with its name and arguments: `write_file`, `read_file`, `patch`, `terminal` (including `rm`), `web_extract`, `tool_describe` and an MCP tool. A block was honoured every time (nothing written, run, fetched or called); an allow let the call run; a hook that crashed, and one past its timeout, blocked the call.
- Through Orchy end to end (real server, runner and adapter, approvals on "Every change"): a terminal command produced the owner's pop-up through the hook and, refused, never ran; the strict safety net accepted every hooked call; an owner who answered after the hook's wait got "still waiting", the agent retried the same call, the retry waited on the same pop-up and ran once it was approved.
- Source (Hermes 0.21.7, `agent/shell_hooks.py`, `model_tools.py`): `pre_tool_call` runs before every tool dispatch, `fail_closed` blocks on a spawn error, a timeout, a non-zero exit without a directive or unreadable output; the hook timeout is capped at 300 s.

### Still unconfirmed

- macOS and Linux (only Windows was run).
- Tool calls a subagent (`delegate_task`) or `execute_code`'s own tool calls make: the source fires the hook once per dispatch, but this wasn't exercised. `delegate_task` itself is an unrecognised tool to the gate, so it asks the owner.
- A Hermes plugin that registers its own `pre_tool_call` hook is not removed by the forced config (only `config.yaml` hooks are). If the dispatcher itself raised an error, Hermes's source logs it and carries on; that path was not seen.

## Antigravity

**Status: gated through its `PreToolUse` hook. Checked against the real agy 1.4.2 on Windows (2026-10-19). Off by default.**

| | |
|---|---|
| Install | Google's Antigravity CLI (`agy`); Orchy looks on PATH, in `~/.gemini/bin` and `~/.local/bin`, or at `AGY_CLI_PATH` |
| Switched on | Off by default. Set `ORCHY_ANTIGRAVITY=1` in `.env` to offer it in the Add window; until then no run starts on it (`offeredRefusal`, code `ENGINE_OFF`) |
| Headless command Orchy uses | `agy --gemini_dir <agent folder> --output-format stream-json --input-format stream-json --disable-slash-commands [--model <id>] [--effort <e>] [--conversation <id>] --log-file <file> -p=`, the prompt as one stream-json line on stdin |
| Approvals | Every tool call goes through Orchy's hook (`config/hooks.json` in the agent's agy folder, `PreToolUse` on `*`, 6-hour timeout), which waits for the gate and the owner's pop-up. agy runs its own permissions as `always-proceed` (headless, it can't ask anyone) inside deny rules Orchy also writes (`antigravity-cli/settings.json` `permissions.deny`) as a second fence: no writes to the workspace's setup (`.claude/`, `.agents/`, `Resources/`, CLAUDE.md, AGENTS.md, GEMINI.md…) or to the agent's own hook and settings, no reads of other workspaces, their profile folders, Retired/, Orchy's own code and data, `.env`, Uploads, Reports, LOGS.md, the harnesses' and One's sign-in folders, or other workspaces' agy folders |
| Hook command | agy splits a hook's command on spaces, keeps quotes, and runs it in the `hooks.json` folder, so the command is `node orchy-tool-hook.mjs`: a launcher Orchy writes next to `hooks.json` that loads Orchy's hook wherever Orchy lives |
| MCP | `config/mcp_config.json` in the agent folder: the `jos` bridge (its run id and token ride in agy's environment, never the file) plus the agent's allowed servers, each with the bridge's variables blanked |
| Config and account | One Google sign-in per computer, so every Antigravity workspace names the same account (`antigravityAccount`; Orchy refuses a second, different one, and `accountCheck` compares it with the signed-in Google account before every run). Agent folders: `antigravityHome`, default `~/.antigravity-orchy/<workspace id>/<agent>` |
| Not offered | Client pages and huddles (`clientSafe: false`, `huddles: false`): not checked with clients' sandboxes yet |

### Evidence (real binary, agy 1.4.2, Windows)

- The hook fired before every tool tried, even in `always-proceed` mode: `write_to_file`, `view_file`, `replace_file_content`, `run_command`, `read_url_content` and `call_mcp_tool`, each with its full arguments (path and content, command line, URL, MCP server, tool and arguments).
- `deny` was honoured every time (nothing written, run, fetched or called) and `allow` let the call run. agy waited for the hook for 20 seconds and for 5½ minutes alike. A hook that crashed, and one past its timeout, blocked the call.
- Through Orchy end to end (real server, runner and adapter, approvals on "Every change"): a shell command and a write into the workspace's `.claude/` each produced the owner's pop-up through the hook and, refused, never happened; allowed work ran; the run finished with its report.
- Headless agy (`-p`) soft-denies a tool that would need a confirmation instead of approving it (agy changelog), so nothing slips through unasked.

### Still unconfirmed

- macOS and Linux (only Windows was run), including where agy keeps its sign-in and that deny rules use forward-slash absolute paths there.
- Tool calls of agy subagents and browser tools (an unrecognised tool asks the owner, so they aren't silent, but they weren't exercised).
- Google's terms for consumer plans may not allow wrapping agy in another app; check yours before switching it on.

## Ori Harness (launcher)

**Not supported yet.** `ori` is a launcher, not an engine: `ori <agent> --model <id>` starts a named agent through OpenRouter credentials (`ori login` signs in), so the process that runs the work is chosen and configured by `ori`, not by Orchy. Orchy cannot yet show that `ori` passes Orchy's gating settings (the per-run permission config, `HERMES_HOME`-style profile variables, the ACP bridge) through to the harness it starts, or that it adds no `--yolo` / `--full-auto` style flag, so a per-workspace `launcher: 'ori'` setting is not offered. If you want OpenRouter models today: OpenCode and Hermes both support OpenRouter as a provider with their own login inside the workspace's profile. Install, for reference: `curl -fsSL https://openrouter.ai/labs/ori/install.sh | bash` (Windows: `irm https://openrouter.ai/labs/ori/install.ps1 | iex`).

## Adding a harness (engine adapters)

Every harness is an engine module in `orchestrator/lib/engines/` registered in `index.mjs` (the interface is documented at the top of that file): binary lookup, `install`, `account()`, `profileEnv()`, `mcpConfig()`, `launch()` and `capabilities`. The setup script, the dashboard's setup guide (Tools step) and `npm run check` list every registered engine with found / version / install command / gated. An engine with `capabilities.gated: false` is refused by `startRun` unless the workspace has `allowUngated: true` in `config.json`. An ACP harness can reuse `engines/acp.mjs`. Optional fields: `optIn: 'ENV_NAME'` keeps an engine off until the owner sets that variable to 1 in `.env`; `sharedLogin: true` means one sign-in per computer (every workspace on it must name the same account); `openModels: true` lets an agent name any model id the harness lists. An engine whose harness only offers a pre-tool hook gets gated through it: `rt.hooks(run, ws).useToolHook(id)` returns the hook script and its credentials file to write into the harness's config, and `hookmap.mjs` maps the hook's payload to the gate's words (Hermes and Antigravity do; see Pre-tool hooks). An engine that can't ask at all can call `rt.hooks(run, ws).approveRun({ title, message })` to get the owner's OK for the whole run first.

## Updating this file

After testing a harness, change its row in the status table above, and keep the simple table in README.md (Supported harnesses: install and "Gated?") in step with it. Never write "supported" for an engine whose gating is not confirmed by tests plus docs.
