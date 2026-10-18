# Where the code lives

The full file map of Orchy. The [README](../README.md#project-structure) has the short tree; how each part behaves is in [CONCEPTS.md](CONCEPTS.md), and each harness's wiring is in [HARNESSES.md](HARNESSES.md).

| Path | What it is |
|---|---|
| `orchestrator/server.mjs` | HTTP and SSE API on 127.0.0.1:8008, origin checks, hot-reloaded `.env` |
| `orchestrator/portal.mjs` | Client pages server (port 8009) |
| `orchestrator/lib/router.mjs`, `jev.mjs`, `livejev.mjs` | Jev routing, live reading as you type |
| `orchestrator/lib/runner.mjs`, `claude.mjs`, `codex.mjs` | Starting runs on each harness, the per-account queue, usage-limit pauses |
| `orchestrator/lib/engines/` | One adapter per harness (`index.mjs` is the registry: capabilities, opt-in engines); `antigravity.mjs` is Google's agy CLI (off by default) |
| `orchestrator/lib/engines/hookmap.mjs` | What a pre-tool hook sends, in the gate's words (Hermes and Antigravity) |
| `orchestrator/lib/bus.mjs`, `activity.mjs` | The replayable event stream; what each run is doing, redaction, safe step summaries |
| `orchestrator/lib/logs.mjs`, `usagereview.mjs` | LOGS.md, usage and cost, the weekly usage review |
| `orchestrator/lib/artifacts.mjs`, `media.mjs` | The file registry and its path guard, previews (Office, CSV, JSON), research sources; ffmpeg thumbnails, posters and playable copies |
| `orchestrator/lib/validate.mjs`, `recover.mjs` | Orchy's check of a finished run; failure classes, the safe automatic retry, recovery cards, stuck runs |
| `orchestrator/mcp/cwd-hook.mjs` | Tells the gate where each Claude Code shell command runs |
| `orchestrator/mcp/tool-hook.mjs` | The pre-tool hook Hermes and Antigravity run before every tool call: it asks the gate and answers allow or deny |
| `orchestrator/lib/gate.mjs`, `policy.mjs` | Approval gate and rules |
| `orchestrator/lib/owner.mjs` | Paired browsers: only they can make changes |
| `orchestrator/lib/cfaccess.mjs` | Cloudflare Access token check for client pages |
| `orchestrator/lib/workspaces.mjs`, `scaffold.mjs` | Workspaces, accounts, One scope, "<Name> Workspace" names; what a new workspace starts with |
| `orchestrator/lib/agents.mjs`, `tasks.mjs`, `resources.mjs` | Agent files, departments and homes (`homeOf`, `departmentOf`); task folders (`taskRootFor`); `Resources/` (skills linked, MCP copies without secrets, INDEX.md, homes made) |
| `orchestrator/lib/mcpauth.mjs` | OAuth sign-in for remote MCP servers (tokens in `orchestrator/data/mcp-auth.json`) |
| `orchestrator/lib/delegation.mjs`, `huddle.mjs` | Department heads, huddles |
| `orchestrator/lib/huddlecoach.mjs`, `rules.mjs` | Orchy in huddles; your standing rules (what Orchy answers for you in a proposal) |
| `orchestrator/lib/missions.mjs` | Missions: the plan under the workspace's own account and its checks, the card, the step supervisor, the ceiling, restarts |
| `orchestrator/lib/scheduler.mjs`, `sessions.mjs` | Schedules, sessions |
| `orchestrator/lib/backend.mjs` | Orchy fixing itself, guarded files |
| `orchestrator/lib/clients.mjs`, `clientspace.mjs` | Client pages and sandbox |
| `orchestrator/lib/clientview.mjs`, `r2.mjs` | What a client's page may open (their own files only, scrubbed); client video through short-lived Cloudflare R2 links |
| `orchestrator/mcp/bridge.mjs` | MCP bridge given to each run |
| `orchestrator/templates/` | What new workspaces and the Builder start from |
| `orchestrator/scripts/` | `doctor.mjs` (npm run check), `organize.mjs` (lay an existing workspace out by department: plan, apply, rollback), test scripts |
| `dashboard/` | The UI, plain ES modules, no build step |
| `dashboard/js/windows.mjs` | Windows: one page and one item window at a time, Back, pop-outs |
| `dashboard/js/live.mjs`, `live/` | The Live view: `model.mjs` (state and derivations), `activity.mjs`, `work.mjs`, `output.mjs`, `fixtures.mjs` (`?preview=live` samples) |
| `dashboard/js/viewer.mjs`, `viewers/` | The file viewer; `media.mjs` (images, video, audio), `pdf.mjs` (pdf.js in `dashboard/vendor/pdfjs-6.3.289/`) |
| `dashboard/js/missions.mjs` | Mission cards and steps (draw nothing until the server sends missions) |
| `scripts/setup.mjs` | `npm run setup` |
| `launchers/` | Double-click launchers for Windows, macOS and Linux |
| `workspaces/` | Your workspaces (git-ignored) |
| `orchestrator/data/` | Runtime state and transcripts (git-ignored) |
