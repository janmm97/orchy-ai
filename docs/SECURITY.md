# Security

## Reporting a problem

Please report security problems privately, not in a public issue. Use GitHub's private reporting: the repository's **Security** tab, then **Report a vulnerability**. Include what you found, how to reproduce it, and what it lets someone do.

While the repository is private, GitHub doesn't offer private reporting: tell the maintainer directly, through the contact you were given when you were invited, not in an issue.

You should get a first answer within a week. Fixes go to the `main` branch; there are no separate release branches yet.

## How Orchy is meant to be safe

Orchy runs AI agents on your own PC, with your accounts. These are the protections, and their limits.

- **The dashboard is local.** It listens on 127.0.0.1 only and refuses requests from other websites (Host, Origin and Sec-Fetch-Site checks) and from Cloudflare. Never put port 8008 behind a tunnel.
- **Only a paired browser can make changes.** Agents run on the same PC, so the dashboard API takes changes (sending tasks, answering approvals, settings) only from a browser holding a pairing cookie. The cookie alone is not enough: other servers on localhost get it too, so a change also needs the key the page keeps in its own storage for Orchy's port (sent as `X-Orchy-Key`). A browser paired before this check is asked to pair once more. Orchy stores only hashes of the cookie and the key. Reads stay open to programs on the PC: they show what is already on disk.
- **The approval gate is a filter, not a sandbox.** Every approval request from a gated harness goes through `orchestrator/lib/policy.mjs`. By default it stops agents for decisions (money, sending, calendar changes, deleting, sharing) and lets routine work run. It reads commands and scripts to decide, so it can be fooled by code written to hide what it does. Settings → Scripts and commands (on by default) lets commands, scripts and One CLI calls in your own runs go on their own unless they visibly do one of those decisions; that is a convenience, and a command written to hide a send or a delete gets through. The One CLI is judged action by action however it is started (`npx @withone/cli` too). Even in that mode, Orchy's own dashboard API, system changes, the harness's own settings, setup files, sign-ins, Orchy's files and other workspaces ask, and a department head's hand-offs, client runs and Orchy fixing himself never get this mode. Switch it off to be asked before every script, network tool and delete outside the folder; "Every change" asks before everything.
- **Every harness asks first.** Claude Code, Codex and OpenCode send their own approval requests to Orchy's gate. Hermes and Antigravity can't ask a client before every action on their own, so Orchy writes a pre-tool hook into each run's config: every tool call (files, commands, web, apps) waits for the gate, and the harness blocks the call when the hook denies, fails or times out. Antigravity is off by default. An engine that could not be gated would be refused unless a workspace sets `allowUngated`, and never run in a workspace without its own One login. See docs/HARNESSES.md.
- **MCP sign-in tokens** (OAuth for remote MCP servers) stay in `orchestrator/data/mcp-auth.json`, written readable only by you, never in a workspace folder; a run gets one only as a header for the server it was made for. `Resources/MCPs/` in a workspace holds copies of its MCP servers with every header, environment value, URL query and secret-looking argument blanked.
- **Accounts stay apart.** Each workspace runs under its own harness account and its own One login, checked before every run.
- **Client pages** go online only through a Cloudflare Tunnel with Cloudflare Access. Orchy checks the token Cloudflare signs on each visit, and each link opens only for the email it belongs to. A client's page opens only files their own runs made inside their own sandbox (`orchestrator/lib/clientview.mjs#guard`; anything else, a guessed id included, is the same 404), with no paths from your PC in what it gets. Their video and audio never stream from your PC: they play from your Cloudflare R2 bucket through signed links that expire within 15 minutes, and only while the four `R2_*` keys are set.
- **Orchy fixing itself** asks before any edit to the files that hold these rules (`GUARDED_GLOBS` in `orchestrator/lib/backend.mjs`).

Things Orchy does not protect against: a harness or One account that is already compromised, other software on your PC running as you, and agents you allow to run ungated.
