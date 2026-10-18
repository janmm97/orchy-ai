# Contributing to Orchy

## Set up

```
git clone https://github.com/janmm97/orchy-ai
cd orchy-ai
npm install
cp .env.example .env     # optional: every key is optional
npm start                # http://localhost:8008
```

Needs Node 20 or newer. No build step: the dashboard is plain ES modules. Where each part of the code lives is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Checks

Run this before opening a pull request. It runs every test script; they fake the model, the runner and the network, so no keys or harness are needed.

```
npm test
```

`npm run check` is a different thing: a health check of your own machine's setup (accounts, the One CLI, keys).

Do not use `--live` options in tests you submit.

## No personal data

Do not commit real email addresses, client names, keys, tunnel domains or transcripts. Use placeholders. These paths are git-ignored and must stay that way: `.env`, `orchestrator/config.json`, `orchestrator/voice-agents.json`, `orchestrator/data/`, `workspaces/`.

## Guard files

Some files hold Orchy's safety rules: the approval policy, the gate (and `orchestrator/mcp/cwd-hook.mjs`, which tells it where each shell command really runs), account checks, the dashboard's origin lock and paired browsers, the client portal, its Access check and sandbox, the client file viewer's fence (`orchestrator/lib/clientview.mjs#guard`: a client only ever opens files from their own sandbox, made by their own runs) and its video links (`orchestrator/lib/r2.mjs`: short-lived Cloudflare R2 links, `MAX_EXPIRES` 15 minutes, so video never streams through the tunnel), the artifact path guard (`orchestrator/lib/artifacts.mjs#resolveFile`, which decides which workspace files the dashboard's viewer may open), the automatic retry gate (`orchestrator/lib/recover.mjs#retryGate`, which never repeats a run that could have changed or sent something), Orchy's huddle coach (`orchestrator/lib/huddlecoach.mjs#coachAccount`, which only ever speaks in a huddle under that workspace's own Claude Code account) and missions (`orchestrator/lib/missions.mjs#planAccount` and `validatePlan`, which plan only under the workspace's own Claude Code account and only with that workspace's own agents), every engine adapter (`orchestrator/lib/engines/**`: each one's `gated` flag, account model and approval wiring, Antigravity's per-run approval and deny rules, `offeredRefusal` for opt-in engines; plus `orchestrator/lib/codex.mjs` and `orchestrator/lib/claude.mjs`, which read who a harness is signed in as, and Codex's `project_root_markers=[]`), MCP sign-ins (`orchestrator/lib/mcpauth.mjs`: tokens only in `orchestrator/data/mcp-auth.json`, never a workspace) and Resources (`orchestrator/lib/resources.mjs`: it moves skill folders, never touches `.clients/` or links out of the workspace, and blanks every secret in its MCP copies). They are listed in `GUARDED_GLOBS` in `orchestrator/lib/backend.mjs`. When Orchy fixes itself, any edit to those files asks the owner every time, with the diff. An edit that removes text naming a lock (`LOCK_MARKERS`: `accountCheck`, `crossSite`, `cf-ray` and others) asks too.

For contributors: do not weaken these files. A change that touches them needs a clear reason in the pull request and a test in `test-policy.mjs` (or `test-artifacts.mjs`, `test-validate.mjs`, `test-clientviewer.mjs`, `test-engines.mjs`, `test-antigravity.mjs`, `test-mcpauth.mjs`, `test-resources.mjs` for those) where it applies. If you add a new safety file, add it to `GUARDED_GLOBS`.

## Security

Report security problems privately, not in a public issue: see [SECURITY.md](SECURITY.md).

## Style

Plain code, no new dependencies without a reason, no emojis in docs, short sentences.
