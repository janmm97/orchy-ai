# Harnesses

A harness is the coding-agent CLI that does the work inside a workspace. Orchy starts it in the workspace folder, gives it the Orchy bridge (ask, approve, report) and answers its approval requests through the approval gate (`orchestrator/lib/gate.mjs`).

Hermes, Antigravity and Cursor were run against their real binaries (Windows, 2026-10-19); the others are still "pending" or "implemented, unverified" until the maintainer updates this file after testing. "Unverified" means the adapter is covered only by tests with a fake harness (`npm test`) and by reading the harness's public docs; nobody has run it against the real binary.

## Status

| Harness | Gated (every risky action asks Orchy first) | Status |
|---|---|---|
| Claude Code | yes (permission-prompt MCP tool) | pending real-install test |
| Codex | yes (`untrusted` policy, every approval request) | pending real-install test |
| Hermes | yes, through its `pre_tool_call` hook (every tool call asks Orchy first) | checked against the real binary (Hermes 0.21.7, Windows) |
| Antigravity | yes, through its `PreToolUse` hook (every tool call asks Orchy first) | checked against the real binary (agy 1.4.2, Windows). Off by default (`ORCHY_ANTIGRAVITY=1` in `.env`) |
| Cursor | yes, through two hooks in a plugin Orchy writes for each run (`preToolUse` for every tool, `beforeMCPExecution` for every MCP call); it has no web search or fetch in Orchy | checked against the real binary (Cursor CLI 2026.10.16, Windows) |

OpenCode was removed on 2026-10-19: OpenCode 2 (`@opencode/cli`) has a code-mode `execute` tool that runs code the model writes and can reach the internet without asking, and nothing switches it off (tested on 2.0.28 and 2.0.32). A workspace still set to OpenCode is refused (no adapter); switch it to another harness in Workspaces → Edit.

Every harness shipped here is gated. An engine registered as not gated (one Orchy cannot prove asks before every file change, command or tool call) would be refused: `startRun` refuses the workspace unless the owner sets `allowUngated: true` for it in `orchestrator/config.json` (Workspaces, the workspace, "allow it to run without approvals"). A workspace on any ungated harness also needs its own One login (`startRun` refuses it otherwise, code `ONE_SCOPE`): Orchy doesn't see every command such a harness runs, so the One CLI could fall back to another account. The README's simple table carries the same gated answers.

## Which instructions an agent run reads

Agent runs read only the workspace's own instructions, never the CLAUDE.md / AGENTS.md at the root of this repo. Workspaces live in `workspaces/` inside this repo, whose root CLAUDE.md and AGENTS.md are for coding agents working on Orchy, not for agent runs. Keep a CLAUDE.md or AGENTS.md in every workspace (new ones get both).

- **Claude Code:** the run's settings file lists them in `claudeMdExcludes` (`runner.mjs#setupSettingsFile`).
- **Codex:** Codex joins every AGENTS.md from the project root (the nearest folder with a `project_root_markers` entry, `.git` by default) down to the run's folder. Orchy starts `codex -c project_root_markers=[] app-server` and repeats `project_root_markers: []` in each thread's config; an empty list disables the parent walk, so only the workspace's own AGENTS.md is read (checked against Codex's source, `codex-rs/core/src/agents_md.rs`; unverified against a real install here).
- **Cursor:** it reads every AGENTS.md (and CLAUDE.md, CLAUDE.local.md) in the folder it runs in and in each parent folder up to the drive root, and inside a git repo it treats the repo's top as its project. Checked on the real CLI with a line in this repo's root AGENTS.md and CLAUDE.md asking for a code word: Cursor repeated both. So this repo has a `.cursorignore` that hides `/AGENTS.md`, `/CLAUDE.md` and `/CLAUDE.local.md` (and Orchy's private files) from Cursor; with it, only the workspace's own AGENTS.md came through. Orchy refuses to start Cursor in a workspace inside this folder if those lines are missing (`engines/cursor.mjs#instructionsFenceProblem`). An AGENTS.md or CLAUDE.md in a folder above this repo (your home folder, for example) would still be read.
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

## ACP (Agent Client Protocol) engines

Hermes runs through Orchy's ACP client, `orchestrator/lib/engines/acp.mjs` (JSON-RPC 2.0 over stdio, one message per line, https://agentclientprotocol.com). What the client does:

- `initialize` with `clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }`: Orchy gives the agent no file or terminal powers; any `fs/*` or `terminal/*` request that arrives anyway is answered "method not found".
- The Orchy bridge (and the workspace's allowed stdio MCP servers) go in `session/new` `mcpServers` (stdio form: `name`, `command`, `args`, `env` as a list of `{ name, value }`). Remote MCP servers are not passed.
- Every `session/request_permission` goes to the Orchy gate with the tool mapped to the names `policy.mjs` knows (`execute` to Bash, `edit`/`delete`/`move` to Edit with each path, `fetch` to WebFetch, `read` to Read, MCP names to `mcp__server__tool`; `other`, `switch_mode` and unknown kinds are an unrecognised tool, which always asks the owner). The answer is the agent's own `allow_once` or `reject_once` option, never an `*_always` option. A gate error, a timeout, a malformed request, a missing `*_once` option or a stop all answer `cancelled`.
- Safety net (`strict`): a tool of a kind other than `read`/`search`/`think` that starts running without having asked, or that runs after Orchy refused it, aborts the run as failed ("agent acted without asking"). "Asked" means a `session/request_permission` for it, or, for an engine with Orchy's pre-tool hook (below), an OK the hook got from the gate for the same kind of action (each OK counts once). An ACP edit request for a file the hook already cleared is answered from that OK, so the owner is never asked twice.
- Resume uses `session/load` only when the agent advertised `loadSession`; otherwise the run starts fresh and says so. `session/cancel` is sent on Stop; the process tree is killed if it does not finish.

Tests: `orchestrator/scripts/test-engine-acp.mjs` (a fake ACP agent in `orchestrator/scripts/fake-acp-agent.mjs`, the hook OK cases, and the Hermes generated config).

## Pre-tool hooks (Hermes, Antigravity, Cursor)

None of these harnesses asks a client before every action on its own, but each runs a hook before every tool call and obeys its answer. Orchy uses that hook as its gate:

- Before every run Orchy writes the hook into the harness's own config: Hermes's profile `config.yaml` (`hooks.pre_tool_call`, the only one, `fail_closed: true`, `hooks_auto_accept: true`) the agent's agy folder (`config/hooks.json`, a `PreToolUse` hook on `*`), and a plugin in the agent's Cursor folder that Cursor loads with `--plugin-dir` (`hooks/hooks.json`: `preToolUse` and `beforeMCPExecution`, both `failClosed`). The hook is `orchestrator/mcp/tool-hook.mjs`.
- For each tool call the hook maps what the harness sent to the gate's words (`orchestrator/lib/engines/hookmap.mjs`) and asks Orchy (`POST /api/bridge/tool-hook`, `runner.mjs#toolHook`), which runs the same `gate()` as every other harness: routine work passes, decisions become the owner's pop-up, and the hook waits for the answer.
- The run is found by the session id the harness puts in every hook call (Hermes's ACP session, agy's conversation id, Cursor's chat id), so two runs sharing a profile or an agy folder never answer for each other. A session with no live hooked run gets a deny.
- Fail closed everywhere: the hook denies (and exits non-zero) when Orchy can't be reached, the token is wrong, the credentials file is missing or the payload is unreadable, and every one of these harnesses blocks a call whose hook fails, crashes or times out.
- The hook finds Orchy through `orchestrator/data/tool-hook.json` (Orchy's address and bridge token), in Orchy's data folder, which agents are never allowed to read. Nothing secret is written into the harness's config.
- Hermes stops a hook after 5 minutes. When the owner takes longer, the hook answers "still waiting" a little before that, the agent is told to try the same call again, and the same call asked again waits on the same pop-up (never a second one) until it is answered. agy and Cursor wait as long as the hook takes (Orchy sets 6 hours).

## Hermes

**Status: gated through its `pre_tool_call` hook. Checked against the real Hermes 0.21.7 on Windows (2026-10-19).**

| | |
|---|---|
| Install | macOS/Linux/WSL2: `curl -fsSL https://hermes-agent.nousresearch.com/install.sh \| bash`; Windows (PowerShell): `iex (irm https://hermes-agent.nousresearch.com/install.ps1)` (native, into `%LOCALAPPDATA%\hermes\bin`). Sign in: `hermes portal`. Set `HERMES_CLI_PATH` in `.env` if the binary is somewhere unusual. In Orchy, **Install** (the Add window, or Set up Orchy → Tools) runs this in a terminal window, then the sign-in. |
| How Orchy runs it | `hermes acp` through the ACP client (strict), `cwd` = the workspace folder, `HERMES_HOME` = the workspace's profile, `HERMES_ACP_SKIP_CONFIGURED_MCP=1` (so servers in the profile's `config.yaml` do not start beside Orchy's bridge). Never `--yolo`; `HERMES_YOLO_MODE`, `HERMES_ACCEPT_HOOKS` and `HERMES_SAFE_MODE` (which skips every hook) are removed from the child's environment |
| Forced config | Before every run Orchy rewrites the profile's `config.yaml` keeping the owner's keys (model, provider, other hooks) and forcing `approvals.mode: manual`, `unattended_mode: deny`, `single_query_mode: deny`, `cron_mode: deny`, `command_allowlist: []`, any `yolo` key removed, and Orchy's hook as the only `pre_tool_call` hook (`fail_closed: true`, 300 s, auto-accepted). Another `pre_tool_call` hook is removed: one could rewrite a call's arguments after Orchy approved it. Existing `approvals.deny` globs are kept |
| Profile | New Hermes workspaces get one of Hermes's own profiles: `%LOCALAPPDATA%\hermes\profiles\orchy-<id>` on Windows, `~/.hermes/profiles/orchy-<id>` elsewhere. Hermes 0.21 tries to rebuild its runtime for a `HERMES_HOME` outside its own data folder (and on Windows that failed), so an older workspace on `~/.hermes-<id>` should move its profile there |
| MCP | Through ACP `session/new` `mcpServers` |
| Account | `accountModel: 'profile'`: `hermesProfile` (its own, shared with no other Hermes workspace) is the profile. The owner picks, per workspace (Add window, or Edit), what it signs in with; `hermesComputerLogin` in `orchestrator/config.json` records it:<br>**This computer's sign-in** (`true`, the default, and what a workspace without the key gets): signed in = credentials in the profile's `auth.json` or provider keys in its `.env`, or the computer's sign-in. Hermes 0.21 itself reads the home a profile sits in (`%LOCALAPPDATA%hermes`, `~/.hermes`) for any provider the profile has no sign-in of its own for (`hermes_cli/auth.py`, profile mode; checked on 0.21.7 with an empty profile). Orchy reads it the same way, so signing Hermes in once on the computer (the installer's `hermes portal`) gets every such workspace going, shown as "this computer's sign-in". They all use, and bill, that one account, so they share one account queue and one limit pause (`runner.mjs#accountKey`). Only `auth.json` sign-ins are shared: keys in the computer's `.env`, and pool rows Hermes re-reads from an environment variable or the gh CLI, are not. **Log in** signs the computer in. A profile without a model gets the computer's `model` block before its first run (never its `api_key`), when the profile can sign in to that model's provider.<br>**Its own sign-in** (`false`): only the profile's own `auth.json` and `.env` count, and **Log in** signs in the profile (`HERMES_HOME`) with a Nous token store of its own (`HERMES_SHARED_AUTH_DIR` inside the profile; otherwise Hermes one-tap imports the computer's Nous login). Hermes still falls back to the computer's `auth.json` for any provider the profile lacks, and no setting turns that off while the profile sits in Hermes's own folder (it has to on Windows). So a run is refused unless the profile's `model.provider` is one it signed in to itself (or an endpoint its own config holds) and no `fallback_providers` or `auxiliary.<task>.provider` names another; checked by `accountCheck` and again at launch (`tier-catalog.mjs#ownLoginProblem`). With a main provider set, Hermes 0.21 doesn't guess another signed-in provider for side tasks (`agent/auxiliary_client.py#_discovery_chain_allowed`).<br>Either way, the PC's `*_API_KEY` style variables are removed from the child's environment |
| Models | All `default`: Hermes uses the model its own config picks. The routing card and an agent's **Give a task** offer a dropdown of the active provider's models from Hermes's own cache (`provider_models_cache.json`, filled once Hermes has listed them; a free tier shows only its free models), plus a box to type any model id. A run, or an agent that names a `provider/model`, gets it through the session's model config option, else `session/set_model`; if Hermes refuses, the run notes it and keeps its own pick |
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
| Install | macOS/Linux: `curl -fsSL https://antigravity.google/cli/install.sh \| bash` (into `~/.local/bin`); Windows (PowerShell): `irm https://antigravity.google/cli/install.ps1 \| iex` (into `%LOCALAPPDATA%agyin`; antigravity.google/docs/getting-started, CLI tab). Sign in: start `agy` once and follow its Google sign-in (`/exit` closes it). Orchy looks on PATH, in `%LOCALAPPDATA%agyin`, `~/.gemini/bin` and `~/.local/bin`, or at `AGY_CLI_PATH`. In Orchy, **Install** (the Add window, or Set up Orchy → Tools) runs this in a terminal window, then the sign-in |
| Switched on | Off by default. Set `ORCHY_ANTIGRAVITY=1` in `.env` to offer it in the Add window; until then no run starts on it (`offeredRefusal`, code `ENGINE_OFF`) |
| Headless command Orchy uses | `agy --gemini_dir <agent folder> --output-format stream-json --input-format stream-json --disable-slash-commands [--model <id>] [--effort <e>] [--conversation <id>] --log-file <file> -p=`, the prompt as one stream-json line on stdin |
| Approvals | Every tool call goes through Orchy's hook (`config/hooks.json` in the agent's agy folder, `PreToolUse` on `*`, 6-hour timeout), which waits for the gate and the owner's pop-up. agy runs its own permissions as `always-proceed` (headless, it can't ask anyone) inside deny rules Orchy also writes (`antigravity-cli/settings.json` `permissions.deny`) as a second fence: no writes to the workspace's setup (`.claude/`, `.agents/`, `Resources/`, CLAUDE.md, AGENTS.md, GEMINI.md…) or to the agent's own hook and settings, no reads of other workspaces, their profile folders, Retired/, Orchy's own code and data, `.env`, Uploads, Reports, LOGS.md, the harnesses' and One's sign-in folders, or other workspaces' agy folders |
| Hook command | agy splits a hook's command on spaces, keeps quotes, and runs it in the `hooks.json` folder, so the command is `node orchy-tool-hook.mjs`: a launcher Orchy writes next to `hooks.json` that loads Orchy's hook wherever Orchy lives |
| MCP | `config/mcp_config.json` in the agent folder: the `jos` bridge (its run id and token ride in agy's environment, never the file) plus the agent's allowed servers, each with the bridge's variables blanked |
| Config and account | One Google sign-in per computer, so every Antigravity workspace names the same account (`antigravityAccount`; Orchy refuses a second, different one, and `accountCheck` compares it with the signed-in Google account before every run). Who is signed in comes from agy itself (`agy models` logs "authenticated successfully as …", about 3 seconds, cached for a minute), never from `~/.gemini/google_accounts.json`: that file is Gemini CLI's, which can be signed in as someone else (agy keeps its sign-in in the OS keyring). Agent folders: `antigravityHome`, default `~/.antigravity-orchy/<workspace id>/<agent>` |
| Not offered | Client pages and huddles (`clientSafe: false`, `huddles: false`): not checked with clients' sandboxes yet |

### Evidence (real binary, agy 1.4.2, Windows)

- The hook fired before every tool tried, even in `always-proceed` mode: `write_to_file`, `view_file`, `replace_file_content`, `run_command`, `read_url_content` and `call_mcp_tool`, each with its full arguments (path and content, command line, URL, MCP server, tool and arguments).
- `deny` was honoured every time (nothing written, run, fetched or called) and `allow` let the call run. agy waited for the hook for 20 seconds and for 5½ minutes alike. A hook that crashed, and one past its timeout, blocked the call.
- Through Orchy end to end (real server, runner and adapter, approvals on "Every change"): a shell command and a write into the workspace's `.claude/` each produced the owner's pop-up through the hook and, refused, never happened; allowed work ran; the run finished with its report.
- Headless agy (`-p`) soft-denies a tool that would need a confirmation instead of approving it (agy changelog), so nothing slips through unasked.

### Still unconfirmed

- macOS and Linux (only Windows was run), including where agy keeps its sign-in and that deny rules use forward-slash absolute paths there.
- Tool calls of agy subagents and browser tools (an unrecognised tool asks the owner, so they aren't silent, but they weren't exercised).
- Google's terms. The Antigravity terms (antigravity.google/terms, section 6) forbid "using third party software, tools, or services to access the Service" with Antigravity's OAuth (their example is OpenClaw), which is about other programs reusing agy's sign-in; Orchy runs Google's own `agy`. But the FAQ (antigravity.google/docs/faq) says headless `agy -p` "is intended for direct scripting and CI workflows" and that "wrapping `agy` inside third-party coding agents or applications ... is not supported under consumer plans". So on a personal Google plan, running agy from Orchy is outside what Google supports, and Google suspended accounts that reused Antigravity sign-ins in early 2026. That is why it stays off by default; check your plan before switching it on.
- A workspace's own agy hooks (`.agents/hooks.json`, plugin hooks) would run beside Orchy's; Orchy's deny still wins for a call, but their commands run. Orchy's deny rules keep agents from writing `.agents/`, so only hooks the owner put there could run.

## Cursor

**Status: gated through two hooks in a plugin Orchy writes for each run. Checked against the real Cursor CLI 2026.10.16 on Windows (2026-10-19).**

| | |
|---|---|
| Install | macOS/Linux/WSL: `curl https://cursor.com/install -fsS \| bash` (into `~/.local/bin`: `agent` and `cursor-agent`); Windows (PowerShell): `irm 'https://cursor.com/install?win32=true' \| iex` (into `%LOCALAPPDATA%\cursor-agent`, with each version under `versions\`; cursor.com/docs/cli/installation). Sign in: `agent login` (a browser sign-in with your Cursor account; no API key). On Windows Orchy starts the newest `versions\<version>\node.exe index.js` itself, never through the `.cmd`/`.ps1` launchers; elsewhere `cursor-agent` or `~/.local/bin/agent`; or `CURSOR_CLI_PATH` in `.env`. In Orchy, **Install** (the Add window, or Set up Orchy → Tools) runs this in a terminal window, then the sign-in |
| Headless command Orchy uses | `agent -p --output-format stream-json --trust --workspace <workspace folder> --plugin-dir <agent folder>/orchy [--model <id>] [--resume <chat id>]`, the prompt (the run's instructions, then the task) on stdin, and `CURSOR_CONFIG_DIR=<agent folder>/config`. Never `--force` (`--yolo`), `--approve-mcps`, `--auto-review` or `--sandbox` |
| Approvals | Orchy's plugin (`.cursor-plugin/plugin.json`, `hooks/hooks.json`) has two hooks, both `failClosed: true` with a 6-hour timeout: `preToolUse`, before every built-in tool (shell, file reads, writes and deletes, search, subagents), and `beforeMCPExecution`, before every MCP call. Each runs `orchestrator/mcp/tool-hook.mjs`, which waits for the gate and the owner's pop-up. MCP calls are judged in `beforeMCPExecution` because only it names the server (`preToolUse` names the tool alone). A delete is judged as `rm -f "<path>"`, so the Deleting decision applies as for any harness. Cursor's spill files for long tool output (`~/.cursor/projects/<workspace>/agent-tools/*.txt`) pass as its own bookkeeping. When several hooks answer, Cursor lets a deny win |
| Config Orchy forces | `<agent folder>/config/cli-config.json`, rewritten before every run: `approvalMode: allowlist` with `Shell(*)`, `Read(**)`, `Write(**)` and `Mcp(*:*)` allowlisted (headless Cursor refuses a tool its allowlist doesn't cover, so the hooks are the gate), `autoAcceptWebSearch: false`, `sandbox.mode: disabled`. Without its own config folder Cursor would read the owner's `~/.cursor/cli-config.json`, where web search could be set to auto-accept |
| Web | **None.** Headless, Cursor asks before web search and web fetch and, with nobody to answer, refuses them. With `--force` it approves both itself and neither reaches any hook, which is why Orchy never passes it. Cursor runs in Orchy have no web tools (the run's protocol notes say so) |
| MCP | The plugin's `mcp.json`: the `jos` bridge (its run id and token ride in Cursor's environment, never the file) plus the agent's allowed servers, each with the bridge's variables blanked. Plugin servers load headless without `--approve-mcps`; Cursor names them `plugin-orchy-<server>`, and Orchy maps that back to `mcp__<server>__<tool>` |
| Config and account | One Cursor sign-in per computer (`%APPDATA%\Cursor\auth.json` on Windows, `~/.config/cursor/auth.json` on Linux, the keychain on macOS), so every Cursor workspace names the same account (`cursorAccount`; Orchy refuses a second, different one, and `accountCheck` compares it with `agent status --format json` before every run). Agent folders: `cursorHome`, default `~/.cursor-orchy/<workspace id>/<agent>`. Cursor also keeps every workspace's chats and spill files in `~/.cursor` whatever the config folder, so Orchy's gate treats `~/.cursor`, Cursor's sign-in file and other workspaces' Cursor folders as sign-in areas, and a workspace's `.cursor/` folder (project hooks, MCP servers, allowlists) as its setup |
| Windows | Cursor writes its hook commands in PowerShell syntax but runs them through Git Bash whenever `MSYSTEM` is set (Orchy started from a Git Bash terminal); every hook then fails, which blocks every tool. Orchy drops the MSYS variables from Cursor's environment |
| Models | Every tier is `auto` (Cursor's own pick). The model dropdown lists `agent models` for the signed-in account; any id from it can be typed, or named in an agent file |
| Not offered | Client pages and huddles (`clientSafe: false`, `huddles: false`): not checked with clients' sandboxes yet |

### Evidence (real binary, Cursor CLI 2026.10.16, Windows)

With a test gate in Orchy's plugin layout:
- `preToolUse` fired before shell commands, file reads (inside and outside the workspace), file writes and the `Task` subagent tool, and before every tool the subagent then ran; `beforeMCPExecution` fired before every MCP call, with the server.
- A deny was honoured every time (nothing written, run, read or called), and an allow let the call run.
- A hook that couldn't start, one that crashed and one past its timeout each blocked the call, in `preToolUse` and `beforeMCPExecution` alike.
- A workspace's own `.cursor/cli.json` allowing web tools and shell, its `.cursor/hooks.json` and a `.claude/settings.json` hook answering allow loosened nothing: Orchy's deny still won and web stayed refused. Their commands do run: Cursor executes a workspace's hooks.
- Headless without `--force`, web search and fetch were refused before any hook; with `--force` both ran and no hook was called.

Through Orchy end to end (its real runner, adapter, hook process and gate, approvals on "Only decisions", the owner's pop-ups answered "deny"):
- A shell command and a file write in the workspace ran on their own, as routine work.
- Deleting a file in the workspace, writing `.cursor/hooks.json` (setup) and reading another workspace's file each became the owner's pop-up; refused, none of them happened.
- Web search was refused, shown as "web search is off in Orchy"; the `jos` bridge tools worked through the plugin's MCP server.
- Started from a Git Bash terminal (`MSYSTEM` set), the hooks still ran: the adapter drops the MSYS variables.
- In a copy of this repo (a git repo, like a clone), Cursor first repeated code words planted in the root AGENTS.md and CLAUDE.md; with the root `.cursorignore` it repeated only the one in the workspace's own AGENTS.md.

### Still unconfirmed

- macOS and Linux (only Windows was run): the keychain sign-in on macOS, the folder name Cursor gives a workspace under `~/.cursor/projects`, and hook commands run through sh.
- Cursor updates itself. A new version could change its hooks, so re-run these checks after an update.
- Tools that weren't exercised: `ComputerUse`, `RecordScreen` and `WriteShellStdin` (each reaches the gate under its own name or as a command, and an unknown one asks the owner).
- Inside a git repo Cursor's project is the repo's top (this repo, for a workspace in `workspaces/`). A search it runs with no folder covers that, so Orchy judges it there and it asks; Cursor skips git-ignored files, which include `.env`, `config.json`, `data/` and `workspaces/`. Its spill folder (`~/.cursor/projects/<repo>/agent-tools`) is then shared by every Cursor workspace in the repo: one workspace could read another's spill file only by its random name, and finding those names asks the owner (`~/.cursor` is a sign-in area).
- Cursor also runs hooks from a workspace's `.cursor/hooks.json` and `.claude/settings.json` and imports `~/.claude/settings.json` hooks. They can't override Orchy's deny, but their commands run. Orchy's gate treats `.cursor/` and `.claude/` as setup, so an agent can't add them without the owner.

## Ori Harness (launcher)

**Not supported yet.** `ori` is a launcher, not an engine: `ori <agent> --model <id>` starts a named agent through OpenRouter credentials (`ori login` signs in), so the process that runs the work is chosen and configured by `ori`, not by Orchy. Orchy cannot yet show that `ori` passes Orchy's gating settings (the per-run permission config, `HERMES_HOME`-style profile variables, the ACP bridge) through to the harness it starts, or that it adds no `--yolo` / `--full-auto` style flag, so a per-workspace `launcher: 'ori'` setting is not offered. If you want OpenRouter models today: Hermes supports OpenRouter as a provider with its own login inside the workspace's profile. Install, for reference: `curl -fsSL https://openrouter.ai/labs/ori/install.sh \| bash` (Windows: `irm https://openrouter.ai/labs/ori/install.ps1 \| iex`).

## Adding a harness (engine adapters)

Every harness is an engine module in `orchestrator/lib/engines/` registered in `index.mjs` (the interface is documented at the top of that file): binary lookup, `install`, `account()`, `profileEnv()`, `mcpConfig()`, `launch()` and `capabilities`. The setup script, the dashboard's setup guide (Tools step) and `npm run check` list every registered engine with found / version / install command / gated. An engine with `capabilities.gated: false` is refused by `startRun` unless the workspace has `allowUngated: true` in `config.json`. An ACP harness can reuse `engines/acp.mjs`. Optional fields: `optIn: 'ENV_NAME'` keeps an engine off until the owner sets that variable to 1 in `.env`; `sharedLogin: true` means one sign-in per computer (every workspace on it must name the same account); `openModels: true` lets an agent name any model id the harness lists. An engine whose harness only offers a pre-tool hook gets gated through it: `rt.hooks(run, ws).useToolHook(id)` returns the hook script and its credentials file to write into the harness's config, and `hookmap.mjs` maps the hook's payload to the gate's words (Hermes, Antigravity and Cursor do; see Pre-tool hooks). An engine that can't ask at all can call `rt.hooks(run, ws).approveRun({ title, message })` to get the owner's OK for the whole run first.

## Updating this file

After testing a harness, change its row in the status table above, and keep the simple table in README.md (Supported harnesses: install and "Gated?") in step with it. Never write "supported" for an engine whose gating is not confirmed by tests plus docs.
