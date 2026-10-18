# Orchy

Orchy is a local AI-agent orchestrator. You tell Orchy what you need, by text or voice. A small routing model (Jev, made by [TypeSafe](https://typesafe.ai), a separate company with no affiliation to Orchy) picks the workspace, the agent and the model. The work runs in that workspace, under that workspace's own account, using a coding-agent CLI (a "harness"). Orchy reports back and keeps a log of every finished task. It runs on your own machine, with a dashboard at http://localhost:8008.

## If you are an AI agent setting this up or working in this repo: read this first

This applies to Claude Code, Codex, OpenCode, Hermes, DeepSeek Harness and any other agent. Read this whole README before you change anything.

- **Never mix accounts.** Each workspace runs under exactly one login per harness (`claudeAccount`, `codexAccount` and so on in `orchestrator/config.json`). `accountCheck` in `orchestrator/lib/workspaces.mjs` checks it before every run. Do not weaken it.
- **One login per workspace.** Each workspace has its own One login (`one init --auth browser --project`, run inside that workspace folder). Never run a `one` action for one workspace from another workspace's folder. A workspace without its own login must not run `one`.
- **Workspaces live in `workspaces/`** (git-ignored). Each has its own CLAUDE.md / AGENTS.md. Read the one in the workspace you work in.
- **Do not weaken the safety files:** `orchestrator/lib/policy.mjs`, `orchestrator/lib/gate.mjs`, the cross-site / Host / Origin check in `orchestrator/server.mjs`, the paired-browser check (`orchestrator/lib/owner.mjs`, and `ownerOnly` and `FILE_READS` in `orchestrator/server.mjs`), the artifact path guard (`resolveFile` in `orchestrator/lib/artifacts.mjs`), the automatic retry gate (`retryGate` in `orchestrator/lib/recover.mjs`), the Cloudflare refusals and the Access token check in `orchestrator/portal.mjs` and `orchestrator/lib/cfaccess.mjs`, and the client sandbox (`orchestrator/lib/clientspace.mjs`, `orchestrator/lib/clients.mjs`).
- **Never commit secrets or machine state:** `.env`, `orchestrator/config.json`, `orchestrator/voice-agents.json`, `orchestrator/data/`.
- **The dashboard API has no password login.** It only answers its own origin on 127.0.0.1, and changes are only taken from a browser the owner paired. Keep it that way. Never bind it to another interface or put it behind a tunnel.
- **Ask the owner before anything outward-facing:** sending, posting, deleting, charging, sharing.
- **One task, one folder.** Files a task makes go in their own folder under the `Tasks/` of the agent's home (`<Department>/<call name>/Tasks/`), or the workspace's `Tasks/` in a workspace without departments.

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
- Optional: ffmpeg (with ffprobe), for thumbnails, video posters and playable copies in the file viewer. Without it every file still opens as is. Orchy finds it on your PATH, in the usual install folders (Homebrew, winget), or at `FFMPEG_PATH` in `.env`.

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

- **Workspaces.** A workspace is a folder in `workspaces/` for one business or client, with its own harness account, its own One login, its own agents and its own CLAUDE.md / AGENTS.md. Each shows as "<Name> Workspace". Add, switch off and retire them in the Workspaces window (top bar). A workspace whose config lists `departments` shows its roster grouped by department. A switched-off workspace is ignored by routing and scheduling.
- **Departments, agent homes and Resources.** A workspace is laid out like a company: department folders (a new one starts with `Operations` and `I.T. Department`, in `config.json` `workspaces[].departments`), and inside each, one home per agent (`Marketing/Avery/`) with its `reference/` files and a `Tasks/` folder that keeps every task it did. Huddles and missions keep theirs in the department's `Tasks/`; the generalist lives in `generalistHome` (`Operations/Generalist`). An agent's home is its frontmatter `home`, else `<department>/<call name>`; the builder must give every agent (and every helper sub-agent a skill drops in) a `department` and `home`, and Orchy's check fails the build otherwise. Orchy makes the homes and their `Tasks/` by itself, and a department an agent names joins the list. Files you attach to a task land in the workspace's `Uploads/`. `Resources/` holds every skill (`Resources/Skills/<name>/`, linked into `.claude/skills/` and `.agents/skills/`: a junction on Windows, a folder symlink on macOS and Linux, a marked copy where links can't be made), a copy of each MCP server with every secret blanked, a note per CLI, and an `INDEX.md` of who uses what. A skill installed straight into either skills folder is filed there on its own (only while nothing runs in that workspace; an older copy goes to `.archive/`, nothing is deleted). Only builders write in `Resources/`. A workspace that grew up flat can be organised with `node orchestrator/scripts/organize.mjs plan|apply|rollback <file>` (a map you write → a dry-run manifest → apply with Orchy stopped, every step journalled, old paths kept working through hidden links; see the comment at the top of that script). Orchy's check also warns when a run saved files outside its home, its task folder and its department.
- **Agents.** An agent is a Markdown file in the workspace (`.claude/agents/<name>.md`). Each has a name, a role, instructions and the apps it may use. You can give one a task from its card, or let Jev pick it.
- **AI Agent Builder.** Every workspace has one, in `I.T. Department/Builder`. It researches the role first and confirms the framework with you, writes new agents (lean: about 20,000 characters at most, playbooks in the agent's `reference/`), asks which connections each gets (Read or Full), and gives each a voice agent when ElevenLabs is set up. Changes need your approval.
- **MCP sign-in.** A remote MCP server that signs in with an account instead of an API key gets a Sign in button in Connections: Orchy finds how the service signs people in, registers itself, and opens the sign-in in your browser (PKCE, with a callback on its own one-off 127.0.0.1 port, never the dashboard's). The token lives in `orchestrator/data/mcp-auth.json` (readable only by you), never in a workspace, refreshes itself, and reaches runs and Test as an `Authorization` header only for the server it was made for; a header you typed always wins. A service that only lets approved apps register signs in through Claude Code's own `claude mcp login` for that workspace's Claude Code account instead, so Orchy never holds that token.
- **Department heads and delegation.** An agent with a `team:` list can hand parts of a task to its team. Each hand-off is its own logged run, one level deep, at most three at once. Every outward action in a handed-over run asks you.
- **Huddles.** Two or more agents of one workspace (no cap; any of them can bring another in) talk a task through, turn by turn. Each must push back on the others from its own role before its "ready" counts, and a fresh challenge reopens the talk; the turn budget grows with the number of agents. Orchy reads along and, now and then, challenges or suggests himself (at most 3 points per huddle by default, 0 to 6 or off in the Huddles window), with a cheap Jev check first and a tool-less Claude call under that workspace's own Claude Code account; a workspace without one gets no coaching. They write an agreement with what they still dispute and at most five merged questions for you. View proposal walks you through the plan and the questions one at a time; Orchy fills in what your standing rules already answer (tick "Remember this" on an answer to add a rule; rules never approve anything for you). Nothing is built until you approve it, or send it back with your answers.
- **Missions.** One ask that needs two or more different agents of one workspace in a row ("research X, then have the designer make a short PDF report from it"). Jev only calls it a mission when it is fairly sure and the words read as work in a row; most asks stay one agent's task. Orchy plans the steps with one tool-less Claude call under that workspace's own Claude Code account (a workspace without one gets a plain task card instead, never another account's plan), checks the plan (this workspace's agents only, no builder or client-shared agent, 2 to 6 steps, each step only waits on earlier ones), and shows the steps on a card. You can change a step's words, swap its agent or drop it, then press Go; a plan Jev is sure of starts after a short countdown you can stop (Settings `missionAutoStart`). Every step is an ordinary run (same account check, approval gate and policy), at most two at once, in one shared task folder; each step gets the earlier steps' summaries and file lists, never their transcripts. Orchy checks each finished step against the files it promised; a step that did nothing outward gets one automatic "fix only that" follow-up (two per mission at most), anything else asks you: accept, follow up, retry, give it to another agent, skip, replan the rest, or stop. A mission pauses at its cost ceiling ($15 by default, `missionCeiling`) and after a restart waits for Resume. At the end Orchy reports once, with one LOGS.md entry and a TASK.md in the shared folder.
- **Approval gate and policy.** Every harness approval request goes to `orchestrator/lib/gate.mjs`, which applies `orchestrator/lib/policy.mjs`. By default agents do routine work alone and stop for decisions: money, sending, calendar changes, deleting, sharing. With Settings → Scripts and commands on (the default), commands, scripts and One CLI calls in your own runs run on their own unless they visibly do one of those decisions: `curl …/v1/refunds`, a script that sends mail, a One flow whose actions send. Deleting scratch files in its folder or the temp folder runs; deleting elsewhere is the Deleting decision. The One CLI is judged the same however it is started (`npx @withone/cli …` like `one …`, its account check included), and One calls that could change the account or connections (`one init`, `one add`, relays) ask. Still asking every time: Orchy's own dashboard API (curl or a script to `localhost:8008/api/…`), system changes (stopping processes, scheduled tasks, the registry, installers), the harness's own settings, setup files, sign-ins, Orchy's files and other workspaces' folders. Runs a department head handed over, client runs and Orchy fixing himself never get this mode: there, network tools, programs and work outside the folder ask. Switch it off to be asked before every script, network tool and delete outside the folder. MCP tools named for a read (`list_posts`, `get_message`) count as reads. Reaching into another workspace's folder always asks. You can switch to "Every change", and "Always allow" an exact action. Claude Code tells Orchy which folder each shell command really runs in (`orchestrator/mcp/cwd-hook.mjs`), so a `cd` into the setup folder followed by a relative write still asks. A run that reads image after image (frame by frame) asks you after 60 image reads, and your OK allows 60 more. Agent runs never load Orchy's own CLAUDE.md or AGENTS.md.
- **Run queue and usage limits.** Each account (a harness login, or a profile folder for harnesses without one) runs at most three agents at once (Settings → Concurrency, 1 to 10). More wait in a queue and start as slots free up; "Run now" on a queued run starts it at once. Work approved after a huddle starts one run after another. When a run hits its account's session or usage limit, it pauses instead of failing, the account's other runs wait with it, and they start again by themselves when the limit resets (the time the harness names, else 30 minutes). Orchy tells you once.
- **Live run events.** Every step a run takes is streamed to the dashboard and kept in `orchestrator/data/runs/<id>.jsonl`: numbered, with its tool call id, a `tool_done` with a count-only summary ("42 lines", "3 files", never the output), and secrets (tokens, API keys, passwords) blanked before anything is written or sent. Each run carries what it is doing right now (reading files, searching the web, using an app, waiting on you…), taken only from real events. The stream is replayable: a dashboard that lost its connection gets exactly what it missed, or reloads when it can't.
- **Usage and cost.** Each run records its tokens and cost (where the harness reports them), and Orchy's own model calls go to `orchestrator/data/orchy-costs.jsonl`. `GET /api/usage?period=week|month|all` breaks it down by workspace, agent, model and kind, with follow-up chains and the costliest runs; each workspace also gets `.jos/costs.jsonl` for its own agents. Once a week (Friday 15:00 by default; `usageReviewDay` and `usageReviewHour` in Settings, or `off`) Orchy reviews the week with a small model and suggests 3 to 5 savings in chat. When agents spend well above a usual week, Jev leans to the lighter model on close calls ("Lean cheaper" in Settings). An agent with a model in its frontmatter always runs on that model.
- **Artifacts.** Every file an agent writes or changes is registered, so you can open it in the dashboard: images, video and audio (with byte-range seeking), PDFs, Markdown, text and code, CSV and Excel as tables, Word as laid-out text, PowerPoint slide text. Files stay where the agent wrote them; Orchy only remembers where, which runs touched them and their version (draft, final, failed or missing). They are found from the run's own file tools, its task folder, the files its report names, and the files changed in its workspace while it ran (a client's run: only its sandbox). Every request re-checks the path (inside the workspace, no setup files, secrets, hidden folders or another client's sandbox, links resolved first), and file contents only open in a paired browser. With ffmpeg installed, Orchy also makes thumbnails, video posters, previews of HEIC/TIFF and huge images, and a playable copy of video the browser can't play (HEVC or ProRes, say), in `orchestrator/data/previews/`. The research sources a run used (the pages it fetched, the searches it ran) come from its recorded steps.
- **Orchy checks the result.** When a run of yours finishes, Orchy checks it before he reports ("Orchy is checking"): did it report, does "done" hold up against its last steps, do the files it names exist, and does it say it sent or changed something in an app with no step to show for it. It flags only; it never re-runs anything on its own. "Ask it to fix" sends the agent a follow-up with what was off. A Jev read of each report can be added (off by default). Settings: `validateRuns`, `validateJev`.
- **Recovery.** When a run fails, Orchy names why (the API was busy, the network dropped, the account isn't signed in, the run was cut off by a restart…). A run that only read and failed on the engine, the API or the network is retried by itself, at most twice, 20 to 120 seconds later, through the same account check and approval gate as any run; anything that could have changed or sent something never is. Everything else becomes a card in Orchy's chat: Resume (continues its conversation), Start over, or Leave it. A run with no new step for 20 minutes is flagged (never stopped), and an optional cap stops runs after a set time. Settings: `autoRetry`, `stallMin`, `stopAfterMin`.
- **Live view.** LIVE in the top bar swaps the page for three ruled columns: Activity (every live run, huddle and mission by workspace, what waits on you first, hand-offs indented under their head, then what finished today), Work (the selected run's phase, task, Jev's plan, each step turning done or failed in place, Orchy's check and any recovery card, with Answer, Stop, Run now and Follow up; or a huddle's talk and agreement) and Output (a gallery of the deliverables it made: video, images, PDFs, Word, slides, sheets and audio; notes, data and scripts stay in the task folder). Drag or arrow-key the splitters; on a phone the columns become tabs. Exit, the phone's back cell or Esc goes back to the chat. The work view is Orchy's chat alone: RUNNING and a dispatch's "View live" open the Live view on that run. Everything comes from recorded state and the event stream, so a refresh draws the same picture.
- **File viewer.** Files open in one viewer window instead of a new tab: from a run window's Files, the Live gallery, a chat file chip (Ctrl-click still opens a tab) or a huddle's transcript. Images (fit, 1:1, zoom, pan, a gallery strip), video and audio in the browser's own player (never autoplay, with "Rendering…" and "Making a playable copy… 42%" while ffmpeg works), PDFs through a vendored pdf.js with scripting off, Markdown, text and code with line numbers, CSV and Excel as tables, Word as sanitised HTML, slide text, HTML in a sandboxed frame with scripts off, and click-to-load YouTube, Vimeo, Loom and Drive players. Every failure has Retry; prev/next and arrow keys walk the list.
- **One window at a time.** The top-bar pages share one window and items (a run, an agent, a huddle) share another: opening one takes the place of the one that's up. Opened from inside a window, the new one stands in for it with a Back arrow. Decisions are never swapped away.
- **Scheduling.** An agent with `schedule: weekdays 9:00` in its frontmatter runs by itself while Orchy is running. A missed slot runs once, late, within three hours. Slots wait while two or more runs are working.
- **Sessions.** Each conversation with Orchy is its own session with its own thread and memory, and the runs it started.
- **Client pages (optional).** You can share chosen agents with a client on their own page (second server, port 8009, `/c/<link>` only). Clients work in their own sandbox, approve app decisions, and never see the rest of Orchy. Anything touching your machine still asks you. To put it online, use a Cloudflare Tunnel plus Cloudflare Access, and give Orchy the Access team and the application's AUD tag (Workspaces → Client access, or `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` in `.env`): Orchy checks the token Cloudflare signs on every visit, and keeps the page closed online until both are set. Other tunnels are refused. Never tunnel port 8008: the dashboard refuses Cloudflare traffic. Clients open the files their own tasks made in the same viewer as your dashboard (images, PDFs, documents, tables, web pages), and only those. Video and audio never go through the tunnel (Cloudflare's terms): they play from a private Cloudflare R2 bucket through links that last 15 minutes at most. To switch that on, turn on R2 in Cloudflare, make a private bucket with a lifecycle rule that deletes objects after 30 days and an R2 API token with Object Read & Write for that bucket only, then put `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET` in `.env` (no restart needed, no CORS rule needed). Without them clients see a video's poster and "Video playback isn't switched on yet".
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
| Antigravity | Google's `agy` CLI (see antigravity.google); off until `ORCHY_ANTIGRAVITY=1` in `.env` | `agy -p` with stream-json; it can't ask mid-run, so you approve each whole run first, then it runs inside deny rules Orchy writes (`--gemini_dir`) | gated: NO (commands aren't checked). Implemented, unverified against the real binary in this repo; off by default, refused unless the workspace sets `allowUngated` and has its own One login (see docs/HARNESSES.md) |
<!-- HARNESS-STATUS:END -->

Every harness that can't hold every action behind the gate (gated: NO) also needs the workspace's own One login: Orchy can't see all of its commands, so it could otherwise reach another account's apps.

Agent runs read only the workspace's own instructions, never the CLAUDE.md / AGENTS.md at the root of this repo (they are for coding agents working on Orchy): Claude Code runs exclude them (`claudeMdExcludes`), Codex starts with `project_root_markers=[]` so it reads AGENTS.md only in the workspace folder, and OpenCode stops at the first AGENTS.md (or CLAUDE.md) it finds walking up, the workspace's own (keep one in every workspace; new ones get both), and doesn't read your personal `~/.claude/CLAUDE.md`. Hermes, DeepSeek Harness and Antigravity are unverified on this point (docs/HARNESSES.md).

Ori Harness (`ori`) is a launcher, not a harness, and is not supported yet. Details, headless commands, config locations, the evidence behind each "gated" answer and manual verification checklists are in [docs/HARNESSES.md](docs/HARNESSES.md).

Platforms: Windows, macOS and Linux. Windows is the most tested; on macOS and Linux, report what breaks.

## Troubleshooting

```
npm run check
```

This health check tests each workspace's accounts, the One CLI, Jev, voice, agents and client pages, and says what to fix. If Orchy will not start, read the error in the terminal window it was started from (after Orchy restarted himself, it is in `orchestrator/data/server.err.log`). If the dashboard says it can't make changes, the browser isn't paired: see Pairing under First run. If a workspace says it is not signed in to One, use Workspaces, the workspace, "Sign in to One". If a run is refused for an account mismatch, the harness profile for that workspace is logged into the wrong account: sign in again with the right one. Do not remove the check.

## Where the code lives

| Path | What it is |
|---|---|
| `orchestrator/server.mjs` | HTTP and SSE API on 127.0.0.1:8008, origin checks, hot-reloaded `.env` |
| `orchestrator/portal.mjs` | Client pages server (port 8009) |
| `orchestrator/lib/router.mjs`, `jev.mjs`, `livejev.mjs` | Jev routing, live reading as you type |
| `orchestrator/lib/runner.mjs`, `claude.mjs`, `codex.mjs` | Starting runs on each harness, the per-account queue, usage-limit pauses |
| `orchestrator/lib/engines/` | One adapter per harness (`index.mjs` is the registry: capabilities, opt-in engines); `antigravity.mjs` is Google's agy CLI (off by default, every run approved first) |
| `orchestrator/lib/bus.mjs`, `activity.mjs` | The replayable event stream; what each run is doing, redaction, safe step summaries |
| `orchestrator/lib/logs.mjs`, `usagereview.mjs` | LOGS.md, usage and cost, the weekly usage review |
| `orchestrator/lib/artifacts.mjs`, `media.mjs` | The file registry and its path guard, previews (Office, CSV, JSON), research sources; ffmpeg thumbnails, posters and playable copies |
| `orchestrator/lib/validate.mjs`, `recover.mjs` | Orchy's check of a finished run; failure classes, the safe automatic retry, recovery cards, stuck runs |
| `orchestrator/mcp/cwd-hook.mjs` | Tells the gate where each Claude Code shell command runs |
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
| `orchestrator/lib/backend.mjs` | Orchy fixing himself, guarded files |
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
| `workspaces/` | Your workspaces (git-ignored) |
| `orchestrator/data/` | Runtime state and transcripts (git-ignored) |

## Contributing

See [CONTRIBUTING.md](docs/CONTRIBUTING.md). Run `npm test` first, and keep personal data out. Report security problems privately: see [SECURITY.md](docs/SECURITY.md).

## License

Apache-2.0. See [LICENSE](docs/LICENSE) and [NOTICE](docs/NOTICE).
