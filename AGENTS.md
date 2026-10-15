# Orchy: instructions for coding agents

Read README.md first, especially the section "If you are an AI agent setting this up or working in this repo". This file repeats the hard rules.

## Hard rules

- Never mix accounts. Each workspace runs under exactly one login per harness (`claudeAccount`, `codexAccount` and so on in `orchestrator/config.json`). `accountCheck` in `orchestrator/lib/workspaces.mjs` enforces it before every run. Do not weaken it.
- Each workspace has its own One login (`one init --auth browser --project`, run inside that workspace folder). Never run a `one` action for one workspace from another workspace's folder.
- Do not weaken `orchestrator/lib/policy.mjs`, `orchestrator/lib/gate.mjs`, the cross-site/Host/Origin check in `orchestrator/server.mjs`, the paired-browser check (`orchestrator/lib/owner.mjs`, `ownerOnly` in `orchestrator/server.mjs`), the Cloudflare refusals in `orchestrator/portal.mjs` and the Access token check in `orchestrator/lib/cfaccess.mjs`, or the client sandbox.
- The dashboard API has no password login. It answers only its own origin on 127.0.0.1, and takes changes only from a browser the owner paired. Keep it that way.
- Never commit `.env`, `orchestrator/config.json`, `orchestrator/voice-agents.json` or `orchestrator/data/`. Put no real emails, names or keys in code or docs.
- Ask the owner before anything outward-facing: sending, posting, deleting, charging.
- Workspaces live in `workspaces/` (git-ignored), each with its own CLAUDE.md / AGENTS.md. Work for a workspace goes in its own folder under `Tasks/`, one folder per task.

## Checks

```
npm test          # every test script: no network, no keys, no harness needed
npm run check     # health check of this machine's setup (accounts, One CLI, keys)
```

See CONTRIBUTING.md for the guard files.
