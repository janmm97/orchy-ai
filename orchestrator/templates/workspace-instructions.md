# {{NAME}}

Workspace for **{{CLIENT}}**. {{BLURB}}

## One CLI — Platform Integrations

The One CLI (`one`) is installed on this machine. This folder gets its **own** One login
(`one init --auth browser --project`, done from Orchy's Workspace window → {{NAME}} → Sign in to One), so it only sees
{{CLIENT}}'s connections. Until then, don't use `one` here: it would fall back to another account.

**Whenever you need anything involving a third-party app or external service, use the One CLI.**
Workflow every time:

1. **Search** for the right action: `one --agent actions find <platform> "<intent>" [<platform> "<intent>" ...] --task "<the job>"`
2. **Read its docs** (always, before executing): `one --agent actions load <actionId> --section <name>` (or `--full`) for anything a digest left out
3. **Run it**: `one --agent actions execute <platform> <actionId> <connectionKey> -d '{...}'`

**Always confirm with the user before anything destructive or outward-facing**
(sending emails/messages, creating/updating/deleting records, charges, posting, etc.).
Read-only lookups don't need confirmation.

### IMPORTANT: Always use the --agent flag
The `--agent` flag gives structured JSON output. Always put it right after `one`:
  one --agent <command>

### IMPORTANT: Learn before you use
Before using any feature (actions, flows, relay), read the corresponding skill documentation
first (`one --agent guide`). Never guess — read, then act.

### Quick reference
- `one --agent list` — Connected platforms and connection keys
- `one --agent actions find <platform> "<intent>" ...` — Find actions with docs
- `one --agent actions load <actionId> --section <name>` — More of a doc, or `--full`
- `one --agent actions execute <platform> <actionId> <connectionKey>` — Execute an action
- `one --agent guide` — Full documentation
- `one connection add <platform>` — Connect a new platform (interactive, no --agent)

## Orchy — how this workspace is used
This folder is one of the workspaces driven by {{OWNER}}'s orchestrator, Orchy, in `../`. Orchy runs
{{RUNTIME}} here headless, as {{ACCOUNT}}. Set up by Orchy on {{TODAY}}.
- Agents live in `.claude/agents/*.md`; `agent-builder.md` is the Chief of AI Agents and holds the Orchy Agent Spec.
- When run by Orchy you get the `jos` MCP tools (`mcp__jos__*`): `ask_user` when unsure (never guess), `report_done` once at the end (it's logged to `../LOGS.md`), `note` for progress worth showing {{OWNER}}, `call_owner` only when something is truly urgent (it rings {{OWNER}} in the dashboard; never in a client's task), and `delegate` for department heads with a `team:`. The AI Agent Builder also gets `request_connections`, `jev_pick_tools` and `voice_agent`. Routine work runs on its own; decisions (money, sending, calendar, deleting, sharing) and risky steps on this PC pop an approval window for {{OWNER}} automatically.
- External MCP servers for this workspace are registered in `.jos/mcp.json` (managed from the dashboard's Connections window).
- `Tasks/` keeps every task this workspace's generalist has done: one folder per task (`<date>-<first words>`) with `TASK.md` (the request, what was done, outputs, follow-ups) and the files made for it. When {{OWNER}} mentions an earlier task, look there first. Only this workspace's `Tasks/` is yours.
- `Uploads/` holds files {{OWNER}} attached to a task (from Give a task or Follow up).
- Never touch another workspace's folder, accounts or data.
