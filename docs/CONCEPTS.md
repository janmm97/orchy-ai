# Core ideas

The full reference for how Orchy works. The [README](../README.md#core-ideas) has the short version; this page keeps every detail.

## Workspaces

A workspace is a folder in `workspaces/` for one business or client, with its own harness account, its own One login, its own agents and its own CLAUDE.md / AGENTS.md. Each shows as "<Name> Workspace". Add, switch off and retire them in the Workspaces window (top bar). A workspace whose config lists `departments` shows its roster grouped by department. A switched-off workspace is ignored by routing and scheduling.

## Departments, agent homes and Resources

A workspace is laid out like a company: department folders (a new one starts with `Operations` and `I.T. Department`, in `config.json` `workspaces[].departments`), and inside each, one home per agent (`Marketing/Avery/`) with its `reference/` files and a `Tasks/` folder that keeps every task it did. Huddles and missions keep theirs in the department's `Tasks/`; the generalist lives in `generalistHome` (`Operations/Generalist`). An agent's home is its frontmatter `home`, else `<department>/<call name>`; the builder must give every agent (and every helper sub-agent a skill drops in) a `department` and `home`, and Orchy's check fails the build otherwise. Orchy makes the homes and their `Tasks/` by itself, and a department an agent names joins the list. Files you attach to a task land in the workspace's `Uploads/`. `Resources/` holds every skill (`Resources/Skills/<name>/`, linked into `.claude/skills/` and `.agents/skills/`: a junction on Windows, a folder symlink on macOS and Linux, a marked copy where links can't be made), a copy of each MCP server with every secret blanked, a note per CLI, and an `INDEX.md` of who uses what. A skill installed straight into either skills folder is filed there on its own (only while nothing runs in that workspace; an older copy goes to `.archive/`, nothing is deleted). Only builders write in `Resources/`. A workspace that grew up flat can be organised with `node orchestrator/scripts/organize.mjs plan|apply|rollback <file>` (a map you write → a dry-run manifest → apply with Orchy stopped, every step journalled, old paths kept working through hidden links; see the comment at the top of that script). Orchy's check also warns when a run saved files outside its home, its task folder and its department.

## Agents

An agent is a Markdown file in the workspace (`.claude/agents/<name>.md`). Each has a name, a role, instructions and the apps it may use. You can give one a task from its card, or let Jev pick it.

## AI Agent Builder

Every workspace has one, in `I.T. Department/Builder`. It researches the role first and confirms the framework with you, writes new agents (lean: about 20,000 characters at most, playbooks in the agent's `reference/`), asks which connections each gets (Read or Full), and gives each a voice agent when ElevenLabs is set up. Changes need your approval.

## MCP sign-in

A remote MCP server that signs in with an account instead of an API key gets a Sign in button in Connections: Orchy finds how the service signs people in, registers itself, and opens the sign-in in your browser (PKCE, with a callback on its own one-off 127.0.0.1 port, never the dashboard's). The token lives in `orchestrator/data/mcp-auth.json` (readable only by you), never in a workspace, refreshes itself, and reaches runs and Test as an `Authorization` header only for the server it was made for; a header you typed always wins. A service that only lets approved apps register signs in through Claude Code's own `claude mcp login` for that workspace's Claude Code account instead, so Orchy never holds that token.

## Department heads and delegation

An agent with a `team:` list can hand parts of a task to its team. Each hand-off is its own logged run, one level deep, at most three at once. Every outward action in a handed-over run asks you.

## Huddles

Two or more agents of one workspace (no cap; any of them can bring another in) talk a task through, turn by turn. Each must push back on the others from its own role before its "ready" counts, and a fresh challenge reopens the talk; the turn budget grows with the number of agents. Orchy reads along and, now and then, challenges or suggests himself (at most 3 points per huddle by default, 0 to 6 or off in the Huddles window), with a cheap Jev check first and a tool-less Claude call under that workspace's own Claude Code account; a workspace without one gets no coaching. They write an agreement with what they still dispute and at most five merged questions for you. View proposal walks you through the plan and the questions one at a time; Orchy fills in what your standing rules already answer (tick "Remember this" on an answer to add a rule; rules never approve anything for you). Nothing is built until you approve it, or send it back with your answers.

## Missions

One ask that needs two or more different agents of one workspace in a row ("research X, then have the designer make a short PDF report from it"). Jev only calls it a mission when it is fairly sure and the words read as work in a row; most asks stay one agent's task. Orchy plans the steps with one tool-less Claude call under that workspace's own Claude Code account (a workspace without one gets a plain task card instead, never another account's plan), checks the plan (this workspace's agents only, no builder or client-shared agent, 2 to 6 steps, each step only waits on earlier ones), and shows the steps on a card. You can change a step's words, swap its agent or drop it, then press Go; a plan Jev is sure of starts after a short countdown you can stop (Settings `missionAutoStart`). Every step is an ordinary run (same account check, approval gate and policy), at most two at once, in one shared task folder; each step gets the earlier steps' summaries and file lists, never their transcripts. Orchy checks each finished step against the files it promised; a step that did nothing outward gets one automatic "fix only that" follow-up (two per mission at most), anything else asks you: accept, follow up, retry, give it to another agent, skip, replan the rest, or stop. A mission pauses at its cost ceiling ($15 by default, `missionCeiling`) and after a restart waits for Resume. At the end Orchy reports once, with one LOGS.md entry and a TASK.md in the shared folder.

## Approval gate and policy

Every harness approval request goes to `orchestrator/lib/gate.mjs`, which applies `orchestrator/lib/policy.mjs`. By default agents do routine work alone and stop for decisions: money, sending, calendar changes, deleting, sharing. With Settings → Scripts and commands on (the default), commands, scripts and One CLI calls in your own runs run on their own unless they visibly do one of those decisions: `curl …/v1/refunds`, a script that sends mail, a One flow whose actions send. Deleting scratch files in its folder or the temp folder runs; deleting elsewhere is the Deleting decision. The One CLI is judged the same however it is started (`npx @withone/cli …` like `one …`, its account check included), and One calls that could change the account or connections (`one init`, `one add`, relays) ask. Still asking every time: Orchy's own dashboard API (curl or a script to `localhost:8008/api/…`), system changes (stopping processes, scheduled tasks, the registry, installers), the harness's own settings, setup files, sign-ins, Orchy's files and other workspaces' folders. Runs a department head handed over, client runs and Orchy fixing himself never get this mode: there, network tools, programs and work outside the folder ask. Switch it off to be asked before every script, network tool and delete outside the folder. MCP tools named for a read (`list_posts`, `get_message`) count as reads. Reaching into another workspace's folder always asks. You can switch to "Every change", and "Always allow" an exact action. Claude Code tells Orchy which folder each shell command really runs in (`orchestrator/mcp/cwd-hook.mjs`), so a `cd` into the setup folder followed by a relative write still asks. A run that reads image after image (frame by frame) asks you after 60 image reads, and your OK allows 60 more. Agent runs never load Orchy's own CLAUDE.md or AGENTS.md.

## Run queue and usage limits

Each account (a harness login, or a profile folder for harnesses without one) runs at most three agents at once (Settings → Concurrency, 1 to 10). More wait in a queue and start as slots free up; "Run now" on a queued run starts it at once. Work approved after a huddle starts one run after another. When a run hits its account's session or usage limit, it pauses instead of failing, the account's other runs wait with it, and they start again by themselves when the limit resets (the time the harness names, else 30 minutes). Orchy tells you once.

## Live run events

Every step a run takes is streamed to the dashboard and kept in `orchestrator/data/runs/<id>.jsonl`: numbered, with its tool call id, a `tool_done` with a count-only summary ("42 lines", "3 files", never the output), and secrets (tokens, API keys, passwords) blanked before anything is written or sent. Each run carries what it is doing right now (reading files, searching the web, using an app, waiting on you…), taken only from real events. The stream is replayable: a dashboard that lost its connection gets exactly what it missed, or reloads when it can't.

## Usage and cost

Each run records its tokens and cost (where the harness reports them), and Orchy's own model calls go to `orchestrator/data/orchy-costs.jsonl`. `GET /api/usage?period=week|month|all` breaks it down by workspace, agent, model and kind, with follow-up chains and the costliest runs; each workspace also gets `.jos/costs.jsonl` for its own agents. Once a week (Friday 15:00 by default; `usageReviewDay` and `usageReviewHour` in Settings, or `off`) Orchy reviews the week with a small model and suggests 3 to 5 savings in chat. When agents spend well above a usual week, Jev leans to the lighter model on close calls ("Lean cheaper" in Settings). An agent with a model in its frontmatter always runs on that model.

## Artifacts

Every file an agent writes or changes is registered, so you can open it in the dashboard: images, video and audio (with byte-range seeking), PDFs, Markdown, text and code, CSV and Excel as tables, Word as laid-out text, PowerPoint slide text. Files stay where the agent wrote them; Orchy only remembers where, which runs touched them and their version (draft, final, failed or missing). They are found from the run's own file tools, its task folder, the files its report names, and the files changed in its workspace while it ran (a client's run: only its sandbox). Every request re-checks the path (inside the workspace, no setup files, secrets, hidden folders or another client's sandbox, links resolved first), and file contents only open in a paired browser. With ffmpeg installed, Orchy also makes thumbnails, video posters, previews of HEIC/TIFF and huge images, and a playable copy of video the browser can't play (HEVC or ProRes, say), in `orchestrator/data/previews/`. The research sources a run used (the pages it fetched, the searches it ran) come from its recorded steps.

## Orchy checks the result

When a run of yours finishes, Orchy checks it before he reports ("Orchy is checking"): did it report, does "done" hold up against its last steps, do the files it names exist, and does it say it sent or changed something in an app with no step to show for it. It flags only; it never re-runs anything on its own. "Ask it to fix" sends the agent a follow-up with what was off. A Jev read of each report can be added (off by default). Settings: `validateRuns`, `validateJev`.

## Recovery

When a run fails, Orchy names why (the API was busy, the network dropped, the account isn't signed in, the run was cut off by a restart…). A run that only read and failed on the engine, the API or the network is retried by itself, at most twice, 20 to 120 seconds later, through the same account check and approval gate as any run; anything that could have changed or sent something never is. Everything else becomes a card in Orchy's chat: Resume (continues its conversation), Start over, or Leave it. A run with no new step for 20 minutes is flagged (never stopped), and an optional cap stops runs after a set time. Settings: `autoRetry`, `stallMin`, `stopAfterMin`.

## Live view

LIVE in the top bar swaps the page for three ruled columns: Activity (every live run, huddle and mission by workspace, what waits on you first, hand-offs indented under their head, then what finished today), Work (the selected run's phase, task, Jev's plan, each step turning done or failed in place, Orchy's check and any recovery card, with Answer, Stop, Run now and Follow up; or a huddle's talk and agreement) and Output (a gallery of the deliverables it made: video, images, PDFs, Word, slides, sheets and audio; notes, data and scripts stay in the task folder). Drag or arrow-key the splitters; on a phone the columns become tabs. Exit, the phone's back cell or Esc goes back to the chat. The work view is Orchy's chat alone: RUNNING and a dispatch's "View live" open the Live view on that run. Everything comes from recorded state and the event stream, so a refresh draws the same picture.

## File viewer

Files open in one viewer window instead of a new tab: from a run window's Files, the Live gallery, a chat file chip (Ctrl-click still opens a tab) or a huddle's transcript. Images (fit, 1:1, zoom, pan, a gallery strip), video and audio in the browser's own player (never autoplay, with "Rendering…" and "Making a playable copy… 42%" while ffmpeg works), PDFs through a vendored pdf.js with scripting off, Markdown, text and code with line numbers, CSV and Excel as tables, Word as sanitised HTML, slide text, HTML in a sandboxed frame with scripts off, and click-to-load YouTube, Vimeo, Loom and Drive players. Every failure has Retry; prev/next and arrow keys walk the list.

## One window at a time

The top-bar pages share one window and items (a run, an agent, a huddle) share another: opening one takes the place of the one that's up. Opened from inside a window, the new one stands in for it with a Back arrow. Decisions are never swapped away.

## Scheduling

An agent with `schedule: weekdays 9:00` in its frontmatter runs by itself while Orchy is running. A missed slot runs once, late, within three hours. Slots wait while two or more runs are working.

## Sessions

Each conversation with Orchy is its own session with its own thread and memory, and the runs it started.

## Client pages (optional)

You can share chosen agents with a client on their own page (second server, port 8009, `/c/<link>` only). Clients work in their own sandbox, approve app decisions, and never see the rest of Orchy. Anything touching your machine still asks you. To put it online, use a Cloudflare Tunnel plus Cloudflare Access, and give Orchy the Access team and the application's AUD tag (Workspaces → Client access, or `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` in `.env`): Orchy checks the token Cloudflare signs on every visit, and keeps the page closed online until both are set. Other tunnels are refused. Never tunnel port 8008: the dashboard refuses Cloudflare traffic. Clients open the files their own tasks made in the same viewer as your dashboard (images, PDFs, documents, tables, web pages), and only those. Video and audio never go through the tunnel (Cloudflare's terms): they play from a private Cloudflare R2 bucket through links that last 15 minutes at most. To switch that on, turn on R2 in Cloudflare, make a private bucket with a lifecycle rule that deletes objects after 30 days and an R2 API token with Object Read & Write for that bucket only, then put `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET` in `.env` (no restart needed, no CORS rule needed). Without them clients see a video's poster and "Video playback isn't switched on yet".

## Orchy fixing itself

Tell Orchy what is broken. Jev makes a "Fix Orchy" card that always waits for your OK. A run then edits Orchy's own code after a snapshot.

Fixes run on Claude Code, under an account you pick once: `npm run setup` offers the account this computer's Claude Code is signed in as, and so do the Fix Orchy card ("Use …") and Settings → Accounts (where you can also give Orchy another account, in a Claude Code profile folder of his own). It is checked before every fix like any workspace's account. The guarded files (`GUARDED_GLOBS` in `orchestrator/lib/backend.mjs`) and any edit that removes a lock ask you every time, with the diff. It cannot touch workspace folders. If server code changed, Orchy restarts himself and rolls back if the new code does not start. The report has an Undo.
