# Release v0.2.0: Interactive CLI Setup & 3rd-Party Router Support

Orchy v0.2.0 introduces interactive CLI engine selection during initial setup, native support for 3rd-party LLM routers (such as OpenRouter and Orca Router), in-terminal API key verification, and streamlined One CLI onboarding.

---

## What's New

### 1. Interactive CLI Setup Wizard (`npm run setup`)
When cloning or setting up Orchy, `npm run setup` now begins by asking:
```text
  Coding CLI
  Orchy coordinates coding agents. Which CLI harness would you like to use?
  Pick a CLI:
    [1] Claude Code (Anthropic’s coding harness)
    [2] Codex (OpenAI’s coding harness)
    [3] Hermes (Open-source agent for open models and ACP)
    [4] Antigravity (Google Gemini coding harness)
    [5] Cursor (Cursor editor harness)
    [6] Aider (Git-integrated coding agent; works with OpenRouter, Orca, OpenAI, Anthropic, etc.)
    [7] OpenCode (OpenCode AI terminal agent with Zen or custom keys)
    [8] Custom CLI (Run your own command or agent binary)
```
- **Guided Setup for API-Driven CLIs**: Choosing an engine that requires credentials (such as Aider, OpenCode, or Hermes) prompts you directly in the terminal, validates the key against live provider endpoints, and saves it into `.env`.
- **In-Terminal Model & Provider Selection for OpenCode, Hermes & Aider**: 
  - **OpenCode**: Choose between OpenCode Zen, OpenRouter, Orca Router/Custom Gateways, Anthropic, OpenAI, or browser OAuth, then pick from tailored model menus (e.g. Claude 3.5 Sonnet, GPT-4o, DeepSeek V3, Gemini 2.0 Flash, or custom).
  - **Hermes**: Choose between OpenRouter, Anthropic, or local ACP, and pick Hermes 3 (70B/405B), Claude, or custom models.
  - **Aider**: Choose between OpenRouter, Orca Router, custom gateways, or direct providers, and select your preferred model tiers.
- **Pre-Configures "Fix Orchy"**: Orchy's self-repair and development capabilities automatically align with your chosen CLI and account.

### 2. First-Class Support for 3rd-Party Routers & Gateways
You can now drive Aider and other engines through 3rd-party routers without manual configuration headaches:
- **OpenRouter**: Full support via `OPENROUTER_API_KEY`. Setup offers to configure Claude 3 Opus or Claude 3.5 Sonnet as default model tiers.
- **Orca Router & Custom OpenAI Gateways**: Setup prompts for your router Base URL (`OPENAI_API_BASE`, e.g. `https://api.orcarouter.com/v1`) and API key, automatically passing them down to agent child processes.
- **Direct Providers & Local Models**: Direct support for Anthropic, OpenAI, Google Gemini (`GEMINI_API_KEY`), DeepSeek, Groq, and local Ollama instances (`OLLAMA_API_BASE`).

### 3. Environment & Profile Propagation for Aider
- Workspace runs in child directories now inherit root `.env` router and API key definitions, preventing missing credentials during git-integrated tasks.
- Supports whole-run approval gating before Aider applies edits to your workspace repository.

### 4. Seamless One CLI Onboarding
- Automatically detects and installs `@withone/cli` globally during setup.
- Verifies PATH updates so your agents can connect to external services (Gmail, Slack, Notion, Stripe) without terminal restarts or configuration errors.

---

## Upgrade Instructions

If you have already cloned Orchy, pull the latest changes and run setup:
```bash
git pull
npm run setup
```
Answer the interactive prompts to configure your preferred CLI and router in under a minute.

