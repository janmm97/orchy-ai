**What this changes and why**


**Checks**

- [ ] `npm test` passes
- [ ] No personal data: no real emails, names, keys, tunnel domains or transcripts
- [ ] No new dependencies, or the reason is given above
- [ ] Touches a guard file (`GUARDED_GLOBS` in `orchestrator/lib/backend.mjs`)? Then the reason is given above, and `test-policy.mjs` has a test where it applies

Tested on: <!-- Windows / macOS / Linux -->
