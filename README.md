# Orchy

Orchy is a local AI-agent orchestrator. You tell Orchy what you need, by text or voice. A small routing model (Jev, made by [TypeSafe](https://typesafe.ai), a separate company with no affiliation to Orchy) picks the workspace, the agent and the model. The work runs in that workspace, under that workspace's own account, using a coding-agent CLI (a "harness"). Orchy reports back and keeps a log of every finished task. It runs on your own machine, with a dashboard at http://localhost:8008.

## If you are an AI agent setting this up or working in this repo: read this first

This applies to Claude Code, Codex, OpenCode, Hermes, DeepSeek Harness and any other agent. Read this whole README before you change anything.

- **Never mix accounts.** Each workspace runs under exactly one login per harness (`claudeAccount`, `codexAccount` and so on in `orchestrator/config.json`). `accountCheck` in `orchestrator/lib/workspaces.mjs` checks it before every run. Do not weaken it.
- **One login per workspace.** Each workspace has its own One login (`one init --auth browser --project`, run inside that workspace folder). Never run a `one` action for one workspace from another workspace's folder. A workspace without its own login must not run `one`.
- **Workspaces live in `workspaces/`** (git-ignored). Each has its own CLAUDE.md / AGENTS.md. Read the one in the workspace you work in.
- **Do not weaken the safety files:** `orchestrator/lib/policy.mjs`, `orchestrator/lib/gate.mjs`, the cross-site / Host / Origin check in `orchestrator/server.mjs`, the paired-browser check (`orchestrator/lib/owner.mjs` and `ownerOnly` in `orchestrator/server.mjs`), the Cloudflare refusals and the Access token check in `orchestrator/portal.mjs` and `orchestrator/lib/cfaccess.mjs`, and the client sandbox (`orchestrator/lib/clientspace.mjs`, `orchestrator/lib/clients.mjs`).
- **Never commit secrets or machine state:** `.env`, `orchestrator/config.json`, `orchestrator/voice-agents.json`, `orchestrator/data/`.
- **The dashboard API has no password login.** It only answers its own origin on 127.0.0.1, and changes are only taken from a browser the owner paired. Keep it that way. Never bind it to another interface or put it behind a tunnel.
- **Ask the owner before anything outward-facing:** sending, posting, deleting, charging, sharing.
- **One task, one folder.** Files a task makes go in their own folder under the workspace's `Tasks/`.

## How it works

```
You --text/voice--> Orchy (orchestrator/server.mjs, :8008)
                     | Jev: intent, workspace, agent, model
                     v
        a harness CLI, started in the workspace folder
        with that workspace's own account / config dir
                     | MCP bridge "jos": ask_user, approval, report_done, note
                     |   (+ delegate for department heads;
                     |    request_connections, jev_pick_tools, voice_agent for the Builder)
                     v
        dashboard pop-ups <-- wait for you --> your answer goes back to the agent
                     |
        report_done --> LOGS.md + Orchy tells you (text, or voice)
```

## Quick start

```
git clone https://github.com/janmm97/orchy-ai
cd orchy-ai
npm run setup
```

Setup checks your tools, then asks three things:

1. **Voice?** Talk to Orchy and call your agents. If yes, pick the service you have (ElevenLabs, Deepgram or both) and paste its key. If no, Orchy is chat only.
2. **Jev?** The routing model that picks the workspace, agent and model for each message. If yes, use a TypeSafe key, or another provider: OpenRouter, OpenCode Zen or Vercel AI Gateway. If no, Orchy matches each message by its words and the agent picks its own tools.
3. **Scripts?** Let agents run scripts on their own unless a script looks like a decision (recommended), or ask before every script.

Each key is checked once with its service and saved in `.env` on your PC. Keys are hidden as you type. Then Orchy starts and your browser opens the dashboard, where the setup guide walks you through adding a workspace, connecting apps and making your first agent. Run `npm run setup` again any time to change your answers, and `npm start` to start Orchy after that.

Setup also puts one launcher in the Orchy folder, the one for your computer: `Start Orchy.cmd` on Windows, `Start Orchy.command` on macOS, `Start Orchy.sh` on Linux. From then on, double-click it to start Orchy. Rather not use a terminal the first time? Open the `launchers` folder and double-click the one for your computer instead: it runs setup too.

### Prerequisites

- Node.js 20 or newer.
- Git, to clone the repository. The repository is private for now: the owner invites you on GitHub, and the first clone asks you to sign in.
- At least one harness CLI installed and signed in. Claude Code is recommended (see "Supported harnesses").
- The One CLI (`one`), so agents can use your apps. Setup offers to install it. See [docs/ONE.md](docs/ONE.md).

### Keys

`npm run setup` asks for these. You can also put them in `.env` (see `.env.example`) or in Settings in the dashboard. All of them are optional.

| Key | What it unlocks | Without it |
|---|---|---|
| `TYPESAFE_API_KEY` | Jev from TypeSafe, the native model | Another Jev provider if one is set, else keyword matching |
| `OPENROUTER_API_KEY` | Jev through OpenRouter, as `~typesafe/jev-latest` (a chat model answering Jev's questions) | As above |
| `AI_GATEWAY_API_KEY` | Jev through Vercel AI Gateway, as `typesafe-ai/jev` (native) | As above |
| `OPENCODE_API_KEY` | Jev through OpenCode Zen, as `jev-1.13` (a chat model). OpenCode's free tier only works inside the OpenCode app | As above |
| `ELEVENLABS_API_KEY` | Orchy's spoken replies and voice calls with agents | The browser's voice |
| `DEEPGRAM_API_KEY` | A backup voice for Orchy's spoken replies | The browser's voice |

`JEV_PROVIDER` picks one provider when several keys are set (`typesafe`, `openrouter`, `vercel`, `opencode`, or `off`). `VOICE_ENABLED=0` switches voice off: nothing speaks, nothing rings, and nothing goes to ElevenLabs or Deepgram.

## What leaves your machine

Orchy runs on your PC, but these services see some of your data when you use them:

- **The Jev provider** (TypeSafe, OpenRouter, Vercel AI Gateway or OpenCode Zen): each instruction you type, plus the names and descriptions of your workspaces and agents, so Jev can route it. Without a Jev key, routing stays on your PC.
- **Your harness** (Claude Code, Codex and so on): everything the agent works on, under that workspace's own account, as it would if you ran the harness yourself.
- **One**: the app actions your agents run, under that workspace's One login.
- **ElevenLabs** (only with voice on): your agents' names, roles and instructions (each gets a voice agent), what Orchy says aloud, and the audio of voice calls.
- **Deepgram** (only with voice on): what Orchy says aloud, when it is the voice in use.
- **Cloudflare**: client pages, if you put them online.

Orchy does not send anything to its authors.

## First run

The dashboard's setup guide has seven steps:

1. **You.** Tell Orchy your name and time zone.
2. **Tools.** Orchy checks that Node, a harness CLI and the One CLI are installed.
3. **Keys.** Add the optional keys above, or skip them.
4. **First workspace.** Workspace, then Add. Name it, say what it is for, pick its harness and account. Orchy creates the folder under `workspaces/`.
5. **Sign in to One.** Workspace, open the workspace, "Sign in to One". See [docs/ONE.md](docs/ONE.md).
6. **First app.** Connections, the workspace, "Add app".
7. **First agent.** Ask the AI Agent Builder for an agent and choose which apps it gets.

**Pairing.** Only a paired browser can make changes in Orchy (send tasks, answer approvals, change settings). Orchy pairs the browser it opens for you. Another browser shows a "Pair this browser" window: type the code from the terminal where Orchy is running, or make one on a paired browser in Settings → This browser. This keeps the agents running on your PC from making changes in your name.

Then type a task on the home screen. Jev shows a routing card (workspace, agent, model) and sends it after a short countdown, or waits for you when it is unsure.

## Getting started with One

Orchy works with [One](https://withone.ai).

One connects agents to third-party apps. Orchy uses its CLI for every app connection. The short version is in [docs/ONE.md](docs/ONE.md). The same text is shown in the terminal and the dashboard.

1. Create a One account at https://app.withone.ai/sign-in.
2. Use one One organization per business or client. The organization switcher is at the top left of the One dashboard.
3. In Orchy: Workspace, open the workspace, "Sign in to One". It runs `one init --auth browser --project` in that workspace folder. Choose the organization this workspace should use when One asks. The login is saved for that folder only.
4. Connected apps are listed on the "Connected Apps" page in the One dashboard (left sidebar). "Add new app" connects one.
5. In Orchy: Connections, the workspace, "Add app". It runs `one connection add <app>` and opens the app's sign-in page.
6. If an app is not available, switch it on in the One dashboard: Developers (bottom left), "Embeddable Auth" tab, search the tool, turn on "Visible". Full steps are in [docs/ONE.md](docs/ONE.md).
7. The AI Agent Builder asks which connections each agent gets, Read or Full. Changes to agents need your approval.

## Core ideas

- **Workspaces.** A workspace is a folder in `workspaces/` for one business or client, with its own harness account, its own One login, its own agents and its own CLAUDE.md / AGENTS.md. Add, switch off and retire them in the Workspace window. A switched-off workspace is ignored by routing and scheduling.
- **Agents.** An agent is a Markdown file in the workspace (`.claude/agents/<name>.md`). Each has a name, a role, instructions and the apps it may use. You can give one a task from its card, or let Jev pick it.
- **AI Agent Builder.** Every workspace has one. It writes new agents, asks which connections each gets (Read or Full), and gives each a voice agent when ElevenLabs is set up. Changes need your approval.
- **Department heads and delegation.** An agent with a `team:` list can hand parts of a task to its team. Each hand-off is its own logged run, one level deep, at most three at once. Every outward action in a handed-over run asks you.
- **Huddles.** Two to four agents of one workspace talk a task through, turn by turn, with Orchy moderating. They write an agreement. Nothing is built until you approve it.
- **Approval gate and policy.** Every harness approval request goes to `orchestrator/lib/gate.mjs`, which applies `orchestrator/lib/policy.mjs`. By default agents do routine work alone and stop for decisions: money, sending, calendar changes, deleting, sharing. Scripts run on their own unless they look like one of those decisions (Settings → Scripts; switch it off to be asked before every script). Deleting files inside an agent's own folder runs on its own; setup files, whole top folders and anything outside ask. MCP tools named for a read (`list_posts`, `get_message`) count as reads. Reaching into another workspace's folder always asks. You can switch to "Every change", and "Always allow" an exact action.
- **Scheduling.** An agent with `schedule: weekdays 9:00` in its frontmatter runs by itself while Orchy is running. A missed slot runs once, late, within three hours.
- **Sessions.** Each conversation with Orchy is its own session with its own thread and memory, and the runs it started.
- **Impact window.** An estimate of what the agents finished against what people would cost, using a rate and a speed-up you can change. It lists its assumptions. It can write a monthly HTML report.
- **Client pages (optional).** You can share chosen agents with a client on their own page (second server, port 8009, `/c/<link>` only). Clients work in their own sandbox, approve app decisions, and never see the rest of Orchy. Anything touching your machine still asks you. To put it online, use a Cloudflare Tunnel plus Cloudflare Access, and give Orchy the Access team and the application's AUD tag (Workspace → Client access, or `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` in `.env`): Orchy checks the token Cloudflare signs on every visit, and keeps the page closed online until both are set. Other tunnels are refused. Never tunnel port 8008: the dashboard refuses Cloudflare traffic.
- **Orchy fixing itself.** Tell Orchy what is broken. Jev makes a "Fix Orchy" card that always waits for your OK. A run then edits Orchy's own code after a snapshot. The guarded files (`GUARDED_GLOBS` in `orchestrator/lib/backend.mjs`) and any edit that removes a lock ask you every time, with the diff. It cannot touch workspace folders. If server code changed, Orchy restarts himself and rolls back if the new code does not start. The report has an Undo.

## Supported harnesses

<!-- HARNESS-STATUS:START -->
| Harness | Install command | How Orchy gates its approvals | Status |
|---|---|---|---|
| Claude Code | `npm install -g @anthropic-ai/claude-code` | MCP permission tool `mcp__jos__approval` | gated: yes. Pending real-install test (see docs/HARNESSES.md) |
| Codex | `npm install -g @openai/codex` | `codex app-server`, policy `untrusted`, every request to the gate | gated: yes. Pending real-install test (see docs/HARNESSES.md) |
| OpenCode | `curl -fsSL https://opencode.ai/v2/install \| bash` | `opencode serve`, every tool set to `ask`, answered through its permissions endpoint | gated: yes. Implemented, unverified against the real binary (see docs/HARNESSES.md) |
| Hermes | `curl -fsSL https://hermes-agent.nousresearch.com/install.sh \| bash` | `hermes acp` over ACP with manual approvals forced, but it only asks about dangerous shell commands | gated: NO (file edits and MCP tools never ask). Implemented, unverified; refused unless the workspace sets `allowUngated` (see docs/HARNESSES.md) |
| DeepSeek Harness | `npx @deepseek-ai/dsh web` | `dsh --profile acp` over ACP, `workspace-write` preset, no auto approval; in-workspace writes are sandboxed, not asked | gated: NO. Implemented, unverified (public preview); refused unless the workspace sets `allowUngated` (see docs/HARNESSES.md) |
<!-- HARNESS-STATUS:END -->

Ori Harness (`ori`) is a launcher, not a harness, and is not supported yet. Details, headless commands, config locations, the evidence behind each "gated" answer and manual verification checklists are in [docs/HARNESSES.md](docs/HARNESSES.md).

Platforms: Windows, macOS and Linux. Windows is the most tested; on macOS and Linux, report what breaks.

## Troubleshooting

```
npm run check
```

This health check tests each workspace's accounts, the One CLI, Jev, voice, agents and client pages, and says what to fix. If Orchy will not start, read the error in the terminal window it was started from (after Orchy restarted himself, it is in `orchestrator/data/server.err.log`). If the dashboard says it can't make changes, the browser isn't paired: see Pairing under First run. If a workspace says it is not signed in to One, use Workspace, the workspace, "Sign in to One". If a run is refused for an account mismatch, the harness profile for that workspace is logged into the wrong account: sign in again with the right one. Do not remove the check.

## Where the code lives

| Path | What it is |
|---|---|
| `orchestrator/server.mjs` | HTTP and SSE API on 127.0.0.1:8008, origin checks, hot-reloaded `.env` |
| `orchestrator/portal.mjs` | Client pages server (port 8009) |
| `orchestrator/lib/router.mjs`, `jev.mjs`, `livejev.mjs` | Jev routing, live reading as you type |
| `orchestrator/lib/runner.mjs`, `claude.mjs`, `codex.mjs` | Starting runs on each harness |
| `orchestrator/lib/gate.mjs`, `policy.mjs` | Approval gate and rules |
| `orchestrator/lib/owner.mjs` | Paired browsers: only they can make changes |
| `orchestrator/lib/cfaccess.mjs` | Cloudflare Access token check for client pages |
| `orchestrator/lib/workspaces.mjs`, `scaffold.mjs` | Workspaces, accounts, One scope |
| `orchestrator/lib/delegation.mjs`, `huddle.mjs` | Department heads, huddles |
| `orchestrator/lib/scheduler.mjs`, `sessions.mjs`, `impact.mjs` | Schedules, sessions, Impact |
| `orchestrator/lib/backend.mjs` | Orchy fixing himself, guarded files |
| `orchestrator/lib/clients.mjs`, `clientspace.mjs` | Client pages and sandbox |
| `orchestrator/mcp/bridge.mjs` | MCP bridge given to each run |
| `orchestrator/templates/` | What new workspaces and the Builder start from |
| `orchestrator/scripts/` | `doctor.mjs` (npm run check), test scripts |
| `dashboard/` | The UI, plain ES modules, no build step |
| `workspaces/` | Your workspaces (git-ignored) |
| `orchestrator/data/` | Runtime state and transcripts (git-ignored) |

## Contributing

See [CONTRIBUTING.md](docs/CONTRIBUTING.md). Run `npm test` first, and keep personal data out. Report security problems privately: see [SECURITY.md](docs/SECURITY.md).

## License

Apache-2.0. See [LICENSE](docs/LICENSE) and [NOTICE](docs/NOTICE).
