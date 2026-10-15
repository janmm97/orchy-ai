# Security

## Reporting a problem

Please report security problems privately, not in a public issue. Use GitHub's private reporting: the repository's **Security** tab, then **Report a vulnerability**. Include what you found, how to reproduce it, and what it lets someone do.

While the repository is private, GitHub doesn't offer private reporting: tell the maintainer directly, through the contact you were given when you were invited, not in an issue.

You should get a first answer within a week. Fixes go to the `main` branch; there are no separate release branches yet.

## How Orchy is meant to be safe

Orchy runs AI agents on your own PC, with your accounts. These are the protections, and their limits.

- **The dashboard is local.** It listens on 127.0.0.1 only and refuses requests from other websites (Host, Origin and Sec-Fetch-Site checks) and from Cloudflare. Never put port 8008 behind a tunnel.
- **Only a paired browser can make changes.** Agents run on the same PC, so the dashboard API takes changes (sending tasks, answering approvals, settings) only from a browser holding a pairing cookie. The cookie alone is not enough: other servers on localhost get it too, so a change also needs the key the page keeps in its own storage for Orchy's port (sent as `X-Orchy-Key`). A browser paired before this check is asked to pair once more. Orchy stores only hashes of the cookie and the key. Reads stay open to programs on the PC: they show what is already on disk.
- **The approval gate is a filter, not a sandbox.** Every approval request from a gated harness goes through `orchestrator/lib/policy.mjs`. By default it stops agents for decisions (money, sending, calendar changes, deleting, sharing) and lets routine work run. It reads commands and scripts to decide, so it can be fooled by code written to hide what it does. Settings → Scripts set to Off asks before every script; "Every change" asks before everything.
- **Some harnesses are not gated.** Hermes and DeepSeek Harness don't ask before file edits or tool calls. Orchy refuses to run them unless a workspace sets `allowUngated`. See docs/HARNESSES.md.
- **Accounts stay apart.** Each workspace runs under its own harness account and its own One login, checked before every run.
- **Client pages** go online only through a Cloudflare Tunnel with Cloudflare Access. Orchy checks the token Cloudflare signs on each visit, and each link opens only for the email it belongs to.
- **Orchy fixing itself** asks before any edit to the files that hold these rules (`GUARDED_GLOBS` in `orchestrator/lib/backend.mjs`).

Things Orchy does not protect against: a harness or One account that is already compromised, other software on your PC running as you, and agents you allow to run ungated.
