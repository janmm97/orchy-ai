# Harnesses

A harness is the coding-agent CLI that does the work inside a workspace. Orchy starts it in the workspace folder, gives it the Orchy bridge (ask, approve, report) and answers its approval requests through the approval gate (`orchestrator/lib/gate.mjs`).

Nothing here is marked as tested against a real install yet. Every status below is "pending" or "implemented, unverified" until the maintainer updates this file after testing. "Unverified" means the adapter is covered only by tests with a fake harness (`npm test`) and by reading the harness's public docs; nobody has run it against the real binary.

## Status

| Harness | Gated (every risky action asks Orchy first) | Status |
|---|---|---|
| Claude Code | yes (permission-prompt MCP tool) | pending real-install test |
| Codex | yes (`untrusted` policy, every approval request) | pending real-install test |
| OpenCode | yes, by its own config: every tool set to `ask` | implemented, unverified against the real binary (fake-server tests only) |
| Hermes | **no** | implemented, unverified against the real binary. Refused unless the workspace sets `allowUngated` |
| DeepSeek Harness | **no** | implemented, unverified against the real binary. Refused unless the workspace sets `allowUngated` |
| Antigravity | **no** (it can't ask mid-run; the owner approves each whole run first) | implemented, unverified against the real binary in this repo (fake-binary tests only). Off by default (`ORCHY_ANTIGRAVITY=1` in `.env`), refused unless the workspace sets `allowUngated` |

"Gated: no" means Orchy cannot prove that the harness asks before every file change, command or tool call, so `startRun` refuses the workspace unless the owner sets `allowUngated: true` for it in `orchestrator/config.json` (Workspaces, the workspace, "allow it to run without approvals"). Hermes, DeepSeek and Antigravity ship in that state on purpose. A workspace on any ungated harness also needs its own One login (`startRun` refuses it otherwise, code `ONE_SCOPE`): Orchy doesn't see every command such a harness runs, so the One CLI could fall back to another account. The README table carries the same statuses.

## Which instructions a run reads

Workspaces live in `workspaces/` inside this repo, whose root CLAUDE.md and AGENTS.md are for coding agents working on Orchy, not for agent runs.

- **Claude Code:** the run's settings file lists them in `claudeMdExcludes` (`runner.mjs#setupSettingsFile`).
- **Codex:** Codex joins every AGENTS.md from the project root (the nearest folder with a `project_root_markers` entry, `.git` by default) down to the run's folder. Orchy starts `codex -c project_root_markers=[] app-server` and repeats `project_root_markers: []` in each thread's config; an empty list disables the parent walk, so only the workspace's own AGENTS.md is read (checked against Codex's source, `codex-rs/core/src/agents_md.rs`; unverified against a real install here).
- **OpenCode:** it takes the first AGENTS.md (else CLAUDE.md) walking up from the run's folder (opencode.ai/docs/rules), so the workspace's own wins as long as the workspace has one (new workspaces get both; a workspace switched to OpenCode gets AGENTS.md copied from its CLAUDE.md). Orchy sets `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1`, so the owner's personal `~/.claude/CLAUDE.md` isn't read either. Unverified against a real install.
- **Hermes, DeepSeek Harness, Antigravity:** how they discover instruction files above the working folder is unconfirmed. Orchy passes each run's instructions itself (ACP session prompt, or agy's stdin). If you run one of them, check whether the repo-root AGENTS.md shows up in a run, and report it.

Ori Harness (`ori`) is a launcher, not a separate harness. See the end of this file.

## Claude Code

| | |
|---|---|
| Install | `npm install -g @anthropic-ai/claude-code` |
| Headless command Orchy uses | `claude -p --output-format stream-json --verbose --model <model> --mcp-config <file> --strict-mcp-config --permission-prompt-tool mcp__jos__approval --append-system-prompt-file <file> --session-id <id>` (plus `--resume`, `--agent <slug>`, `--settings`) |
| Approvals | Every permission request goes to the MCP tool `mcp__jos__approval`, which calls the Orchy gate |
| MCP | Orchy writes a per-run MCP config with the `jos` bridge and the workspace's allowed servers (`<workspace>/.jos/mcp.json`) |
| Config and account | `CLAUDE_CONFIG_DIR` per workspace (`claudeAccount` / `claudeConfigDir` in `orchestrator/config.json`); the default is `~/.claude` |

## Codex

| | |
|---|---|
| Install | `npm install -g @openai/codex` |
| Headless command Orchy uses | `codex app-server` (JSON-RPC over stdio), approval policy `untrusted`, sandbox `workspace-write` |
| Approvals | Every approval request is answered by the Orchy gate |
| MCP | Through the Codex config in the run's `CODEX_HOME` |
| Config and account | `CODEX_HOME` per workspace (`codexAccount` / `codexHome` in `orchestrator/config.json`); the default is `~/.codex`. Set `CODEX_CLI_PATH` in `.env` if the binary is somewhere unusual |

## OpenCode

**Status: implemented, unverified against the real binary.** The adapter (`orchestrator/lib/engines/opencode*.mjs`) is tested only against a fake `opencode serve` (`npm test`: `test-engine-opencode.mjs`).

| | |
|---|---|
| Install | `curl -fsSL https://opencode.ai/v2/install \| bash` (also available through npm `opencode-ai` and brew). Set `OPENCODE_CLI_PATH` in `.env` if the binary is somewhere unusual. Orchy never installs it for you. |
| How Orchy runs it | Per run: `opencode serve --port <free port> --hostname 127.0.0.1` in the workspace folder, a random `OPENCODE_SERVER_PASSWORD` (HTTP basic auth, user `opencode`), the `/event` SSE stream, one session, the prompt sent with `prompt_async`. Never `--auto`; nothing secret is on the command line |
| Approvals | The per-run `opencode.json` sets `"permission": { "*": "ask", ... }` (reads, edits, shell, web, MCP tools and `external_directory` all ask; `task`, `question` and `doom_loop` are denied; `.env` reads are denied). Each ask goes to the Orchy gate and is answered through the permission endpoint with `once` (allowed) or `reject` (denied, or the gate failed). Orchy never sends `always` or `remember`. The same permission block is also passed in `OPENCODE_CONFIG_CONTENT` so a `opencode.json` in the workspace cannot loosen it |
| Fails closed | The run fails (and the server is stopped) if: `/doc` is JSON but lists no permission-response route, `/config` shows an `allow`, the server dies, the event stream drops, or Orchy cannot answer an ask |
| MCP | The Orchy bridge and the workspace's allowed servers are written under `mcp` in the generated config (`type: "local"` with `command` and `environment`, or `type: "remote"`) |
| Config and account | One profile folder per workspace (`opencodeProfile` in `orchestrator/config.json`): `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CONFIG_HOME` and `OPENCODE_CONFIG_DIR` all point inside it. Credentials are expected in `<profile>/data/opencode/auth.json`. OpenCode has no account email, so Orchy's account check requires a profile folder of its own, shared with no other OpenCode workspace, with at least one provider logged in. The PC's own provider API keys are removed from the child's environment |
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
8. When all of that holds, change the status above and copy it into the README table.

## ACP (Agent Client Protocol) engines

Hermes and DeepSeek Harness run through one shared ACP client, `orchestrator/lib/engines/acp.mjs` (JSON-RPC 2.0 over stdio, one message per line, https://agentclientprotocol.com). What the client does:

- `initialize` with `clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }`: Orchy gives the agent no file or terminal powers; any `fs/*` or `terminal/*` request that arrives anyway is answered "method not found".
- The Orchy bridge (and the workspace's allowed stdio MCP servers) go in `session/new` `mcpServers` (stdio form: `name`, `command`, `args`, `env` as a list of `{ name, value }`). Remote MCP servers are not passed.
- Every `session/request_permission` goes to the Orchy gate with the tool mapped to the names `policy.mjs` knows (`execute` to Bash, `edit`/`delete`/`move` to Edit with each path, `fetch` to WebFetch, `read` to Read, MCP names to `mcp__server__tool`; `other`, `switch_mode` and unknown kinds are an unrecognised tool, which always asks the owner). The answer is the agent's own `allow_once` or `reject_once` option, never an `*_always` option. A gate error, a timeout, a malformed request, a missing `*_once` option or a stop all answer `cancelled`.
- Safety net: a tool of a kind other than `read`/`search`/`think` that starts running without a permission request for it, or that runs after Orchy refused it, aborts the run as failed ("agent acted without asking"). This is on for any engine registered as gated. For the two ungated engines below it is switched off (the owner opted in) and the fact is written to the run feed instead.
- Resume uses `session/load` only when the agent advertised `loadSession`; otherwise the run starts fresh and says so. `session/cancel` is sent on Stop; the process tree is killed if it does not finish.
- The client never decides an engine is gated. An engine is gated only if its docs show every action reaches `session/request_permission` and a real-binary test confirms it.

Tests: `orchestrator/scripts/test-engine-acp.mjs` (a fake ACP agent in `orchestrator/scripts/fake-acp-agent.mjs`, plus the Hermes and DeepSeek generated configs).

## Hermes

**Status: implemented, unverified against the real binary. Gated: NO.** Refused unless the workspace sets `allowUngated`.

| | |
|---|---|
| Install | `curl -fsSL https://hermes-agent.nousresearch.com/install.sh \| bash` (run in WSL or Git Bash on Windows). Set `HERMES_CLI_PATH` in `.env` if the binary is somewhere unusual. Orchy never installs it |
| How Orchy runs it | `hermes acp` through the ACP client, `cwd` = the workspace folder, `HERMES_HOME` = the workspace's profile folder, `HERMES_ACP_SKIP_CONFIGURED_MCP=1` (so servers in the profile's `config.yaml` do not start beside Orchy's bridge). Never `--yolo`, never `HERMES_YOLO_MODE` (removed from the child's environment) |
| Forced config | Before every run Orchy rewrites the profile's `config.yaml` keeping the owner's keys (model, provider) and forcing `approvals.mode: manual`, `unattended_mode: deny`, `single_query_mode: deny`, `cron_mode: deny`, `command_allowlist: []`, any `yolo` key removed. Existing `approvals.deny` globs are kept |
| MCP | Through ACP `session/new` `mcpServers` |
| Account | `accountModel: 'profile'`: `hermesProfile` (a folder of its own, shared with no other Hermes workspace) is the profile. `account().label` comes from `hermes status` (providers with credentials, model), parsed defensively; a profile `auth.json` also counts as logged in. The PC's `*_API_KEY` style variables are removed from the child's environment. Hermes shares OAuth logins (Anthropic, OpenAI Codex, xAI) from `~/.hermes/auth.json` between profiles, so use an API-key provider per workspace |
| Models | All `default`: Hermes uses the model its own config picks. An agent that names a `provider/model` gets it through the session's model config option, else `session/set_model`; if Hermes refuses, the run notes it and keeps its own pick |

### Why it is not gated (evidence)

- The Hermes ACP docs say dangerous **terminal** approvals can be sent to the editor as permission prompts, with allow once / allow for session / allow always / deny options, and that timeouts and bridge failures deny.
- The ACP internals page says "Only terminal approvals are bridged. File writes are not gated by the permission bridge": `write_file` and `patch` are only rendered as diffs.
- The security page says `write_file` / `patch` have no approval prompt (protected paths are blocked, `~/.ssh/config` is the one exception), web tools rely on SSRF checks, and MCP tool calls have no per-call approval. The deny globs and the hardline blocklist are a shell-command policy, "not a sandbox".
- The docs name the `allow_once` / `allow_always` / reject mapping but never the `session/request_permission` method itself, and the docs mention hosts (Buzz) that auto-answer allow once.

So in `hermes acp` a file edit, a web fetch or an MCP call can happen without Orchy ever being asked. Orchy's file-edit rules (stay in the folder), the reads of other clients' folders and every MCP decision cannot be enforced.

**What would flip it to gated:** a real-binary test showing every non-read tool kind (edit, delete, move, fetch, MCP, execute) produces a `session/request_permission` before it runs, or a documented Hermes setting that makes `write_file`, `patch`, web and MCP tools ask (and the ACP bridge forward it). Then set `capabilities.gated: true` and `strict` on in `hermes.mjs`, so the safety net applies.

### Still unconfirmed

- That `HERMES_HOME` can be set to an arbitrary folder (the docs show only the profile alias setting it to `~/.hermes/profiles/<name>`) and that `hermes acp` honours it.
- The format of `hermes status` (the parser is defensive; the label may be empty). `hermes acp` flags, `session/load` support and the exact `mcpServers` handling are not documented.
- That `HERMES_ACP_SKIP_CONFIGURED_MCP=1` is honoured by the installed version.

### Manual verification checklist (not done yet)

1. Install Hermes; confirm `hermes --version` and `hermes acp --check`.
2. Add a workspace on Hermes with its own profile folder, run the login command Orchy shows (`hermes setup`), confirm `hermes status` shows a provider and Orchy's check goes green.
3. Allow the workspace to run without approvals (`allowUngated`), run a task: "create a file, then run `git push`". Confirm whether the file write produced an approval (expected: no) and the `git push` did (expected: yes, and denied by the gate).
4. Look at `<profile>/config.yaml` after a run: manual approvals, no allowlist, no yolo.
5. Try an MCP call and a web fetch; note whether any permission request reached Orchy.
6. If every kind asked, update the "Why it is not gated" section and flip the flag.

## DeepSeek Harness

**Status: implemented, unverified against the real binary (public preview, APIs change). Gated: NO.** Refused unless the workspace sets `allowUngated`.

| | |
|---|---|
| Install | `npx @deepseek-ai/dsh web` runs it, but Orchy needs the `dsh` command on the PATH (or `DSH_CLI_PATH` in `.env`). Orchy never installs it |
| How Orchy runs it | `dsh --profile acp` through the ACP client, `cwd` = the workspace folder, `DSH_HOME` = the workspace's folder, `DSH_PERMISSION_MODE=workspace-write`. No `--patch` overlays, no mode flags |
| Forced config | Before every run Orchy writes `$DSH_HOME/profiles/acp/cordis.patch.yml`, keeping the owner's provider and model entries, removing any auto-approval / "Auto review" plugin and any permission-presets entry, and adding `@deepseek-ai/dsh-permission-presets` with `defaultPreset: workspace-write` (sandbox `workspace-write`, approval `ask`). It never writes `danger-full-access` / `never`, and never enables auto approval |
| MCP | Through ACP `session/new` `mcpServers` (support in `dsh` unconfirmed) |
| Account | `accountModel: 'profile'`: `deepseekProfile` is the `DSH_HOME` folder (its own, shared with no other workspace). Logged in = the API key is saved in `$DSH_HOME/.credentials.yaml` (set in the Web UI: `DSH_HOME=<folder> dsh web`, Settings, Models). `account().label` is the provider(s) and model from `dsh --profile acp --dump-config`, parsed defensively |
| Models | All `default`; resume starts a fresh session each time (loading Web UI sessions is not wired) |

### Why it is not gated (evidence)

- The permission docs describe presets that pair a sandbox mode with an approval policy (`ask` or `never` only). The default `workspace-write` confines writes to the workspace and temp folders by sandbox: writes inside the workspace do not ask, and reads and network are not confined. Approvals appear for escalation out of the sandbox and `ask_user_question`. One doc page says outright that this is not a sandbox against everything.
- The ACP page says permission presets are exposed as ACP session modes (`read-only`, `workspace-write`, `danger-full-access`) and that tool calls report kinds, titles, locations and diffs. It does not say a permission request is sent as `session/request_permission`, and it does not mention `mcpServers`.
- The third-party sources that describe the default sandbox disagree (read-only versus workspace-write).

So in `dsh --profile acp` an in-workspace file change, a read of any file and network calls can happen without Orchy being asked.

**What would flip it to gated:** a real-binary test that, with the generated patch, every tool kind outside `read`/`search`/`think` sends `session/request_permission` (including in-workspace edits, which would mean the `read-only` preset with approvals, or a documented policy that asks for them), plus a way to keep reads inside the folder. Then set `capabilities.gated: true` and `strict` on in `deepseek.mjs`.

### Still unconfirmed

- The `cordis.patch.yml` format for the permission plugin beyond `defaultPreset` (the plugin README lists a `presets` map but its schema is not fully shown), that a patch under `profiles/acp/` is read by `dsh --profile acp`, the `.credentials.yaml` location for CLI use, `dsh --dump-config` output, `DSH_PERMISSION_MODE` semantics, and whether `dsh` has any setting to make in-workspace writes ask.
- The `dsh` documentation at the repo (`apps/cli/README.md`, `docs/subsystems/approval.md`, `SAFETY.md`) could not be fetched during this work (404 on the paths tried); the evidence above comes from the docs site, the permission-presets README and third-party summaries.

### Manual verification checklist (not done yet)

1. Install `dsh`; confirm `dsh --version`; read `SAFETY.md` and `docs/subsystems/approval.md` in the repo.
2. Run `DSH_HOME=<folder> dsh web`, save the API key in Settings, Models. Add the workspace in Orchy with that folder as the DeepSeek profile.
3. Run `dsh --profile acp --dump-config` with `DSH_HOME` set, after one Orchy run: confirm the permission preset is `workspace-write`/`ask` and no auto-approval plugin appears.
4. Allow the workspace (`allowUngated`) and run: "create a file, read a file outside the folder, run `git push`". Note which of the three produced a `session/request_permission` (see the feed's "asks through ACP" line) and which did not.
5. Update the evidence above and decide whether the gate can be flipped.

## Antigravity

| | |
|---|---|
| Install | Google's Antigravity CLI (`agy`); Orchy looks on PATH, in `~/.gemini/bin` and `~/.local/bin`, or at `AGY_CLI_PATH` |
| Switched on | Off by default. Set `ORCHY_ANTIGRAVITY=1` in `.env` to offer it in the Add window; until then no run starts on it (`offeredRefusal`, code `ENGINE_OFF`) |
| Headless command Orchy uses | `agy --gemini_dir <agent folder> --output-format stream-json --input-format stream-json --disable-slash-commands [--model <id>] [--effort <e>] [--conversation <id>] --log-file <file> -p=`, the prompt as one stream-json line on stdin |
| Approvals | None mid-run: headless agy can't ask and its hooks can only block. Every run waits for the owner's OK on an approval card first (never remembered), then agy runs `always-proceed` inside deny rules Orchy writes into the agent's own agy folder (`antigravity-cli/settings.json` `permissions.deny`): no writes to the workspace's setup (`.claude/`, `.agents/`, `Resources/`, CLAUDE.md, AGENTS.md, GEMINI.md…), no reads of other workspaces, their profile folders, Retired/, Orchy's own code and data, `.env`, Uploads, Reports, LOGS.md, the harnesses' and One's sign-in folders, or other workspaces' agy folders. Its shell commands are not checked |
| MCP | `config/mcp_config.json` in the agent folder: the `jos` bridge (its run id and token ride in agy's environment, never the file) plus the agent's allowed servers, each with the bridge's variables blanked |
| Config and account | One Google sign-in per computer, so every Antigravity workspace names the same account (`antigravityAccount`; Orchy refuses a second, different one, and `accountCheck` compares it with the email agy's `models` log says it signed in as before every run). Agent folders: `antigravityHome`, default `~/.antigravity-orchy/<workspace id>/<agent>` |
| Not offered | Client pages, huddles (`clientSafe: false`, `huddles: false`), and any workspace without its own One login |

### Still unconfirmed

- Event shapes (`init`, `step_update` with tool `ACTIVE`/`DONE`/`ERROR`, `result` with `denied_actions`) and flag names come from the agy builds the adapter was written against; nobody has run this repo's adapter against a real agy.
- That the sign-in check works on macOS and Linux (where agy may keep its sign-in somewhere else than on Windows).
- That deny rules use forward-slash absolute paths on every platform.
- Google's terms for consumer plans may not allow wrapping agy in another app; check yours before switching it on.

### Manual verification checklist (not done yet)

1. Set `ORCHY_ANTIGRAVITY=1`, add a test workspace on Antigravity with its own One login and `allowUngated`.
2. Run a task that writes `.claude/x.md` and reads another workspace's folder: both should come back as refused (the feed shows "denied"), the run's own task folder should work.
3. Confirm the approval card appears before agy starts, and that Stop ends the agy process tree.
4. Sign agy in as another Google account: the next run must be refused (`ACCOUNT_MISMATCH`).

## Ori Harness (launcher)

**Not supported yet.** `ori` is a launcher, not an engine: `ori <agent> --model <id>` starts a named agent through OpenRouter credentials (`ori login` signs in), so the process that runs the work is chosen and configured by `ori`, not by Orchy. Orchy cannot yet show that `ori` passes Orchy's gating settings (the per-run permission config, `HERMES_HOME`-style profile variables, the ACP bridge) through to the harness it starts, or that it adds no `--yolo` / `--full-auto` style flag, so a per-workspace `launcher: 'ori'` setting is not offered. If you want OpenRouter models today: OpenCode and Hermes both support OpenRouter as a provider with their own login inside the workspace's profile. Install, for reference: `curl -fsSL https://openrouter.ai/labs/ori/install.sh | bash` (Windows: `irm https://openrouter.ai/labs/ori/install.ps1 | iex`).

## Adding a harness (engine adapters)

Every harness is an engine module in `orchestrator/lib/engines/` registered in `index.mjs` (the interface is documented at the top of that file): binary lookup, `install`, `account()`, `profileEnv()`, `mcpConfig()`, `launch()` and `capabilities`. The setup script, the dashboard's setup guide (Tools step) and `npm run check` list every registered engine with found / version / install command / gated. An engine with `capabilities.gated: false` is refused by `startRun` unless the workspace has `allowUngated: true` in `config.json`. An ACP harness can reuse `engines/acp.mjs`. Optional fields: `optIn: 'ENV_NAME'` keeps an engine off until the owner sets that variable to 1 in `.env`; `sharedLogin: true` means one sign-in per computer (every workspace on it must name the same account); `openModels: true` lets an agent name any model id the harness lists. An engine that can't ask mid-run can call `rt.hooks(run, ws).approveRun({ title, message })` to get the owner's OK for the whole run first (Antigravity does).

## Updating this file

After testing a harness, change its row in the status table and copy the same status into the table in README.md between the `HARNESS-STATUS` markers. Never write "supported" for an engine whose gating is not confirmed by tests plus docs.
