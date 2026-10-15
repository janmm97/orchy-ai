# Contributing to Orchy

## Set up

```
git clone https://github.com/janmm97/orchy-ai
cd orchy-ai
npm install
cp .env.example .env     # optional: every key is optional
npm start                # http://localhost:8008
```

Needs Node 20 or newer. No build step: the dashboard is plain ES modules.

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

Some files hold Orchy's safety rules: the approval policy, the gate, account checks, the dashboard's origin lock and paired browsers, the client portal, its Access check and sandbox. They are listed in `GUARDED_GLOBS` in `orchestrator/lib/backend.mjs`. When Orchy fixes itself, any edit to those files asks the owner every time, with the diff. An edit that removes text naming a lock (`LOCK_MARKERS`: `accountCheck`, `crossSite`, `cf-ray` and others) asks too.

For contributors: do not weaken these files. A change that touches them needs a clear reason in the pull request and a test in `test-policy.mjs` where it applies. If you add a new safety file, add it to `GUARDED_GLOBS`.

## Security

Report security problems privately, not in a public issue: see [SECURITY.md](SECURITY.md).

## Style

Plain code, no new dependencies without a reason, no emojis in docs, short sentences.
