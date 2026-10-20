# Subscriber Email Announcement: Orchy v0.2.0

> **Note for sending**: Copy and paste the content below into your email platform (Substack, Mailchimp, ConvertKit, etc.). This announcement focuses solely on product updates and features for users and omits internal git PR merge noise.

---

**Subject**: Orchy v0.2.0: Pick your CLI in setup, 3rd-party router support, and faster onboarding 🚀  
**Preview text**: Setup now guides you through selecting your preferred coding CLI (Claude Code, Aider, Codex, OpenCode, or custom) and setting up your API keys in seconds.

---

Hey everyone,

We’ve just shipped **Orchy v0.2.0**, making it easier than ever to clone and run autonomous coding agents with whatever CLI or AI provider you prefer.

Here is a quick overview of what’s new:

### 🎯 1. Interactive CLI Setup Wizard
When you run `npm run setup`, Orchy now asks which coding harness you want to use right from the start:
- **Claude Code**
- **Codex**
- **Hermes**
- **Antigravity**
- **Cursor**
- **Aider**
- **OpenCode**
- **Custom CLI**

No more guessing where configuration files live or manually editing `.env`. If your chosen CLI requires an API key or model selection (such as Hermes, OpenCode, or Aider), setup lets you choose your model right from the terminal, validates keys live with the provider, and writes everything directly to your configuration.

### 🌐 2. 3rd-Party Router Support (OpenRouter, Orca Router & Custom Gateways)
For those using multi-model routers or proxies, Orchy now supports:
- **OpenRouter**: Set your key and drive models like Claude 3 Opus or Sonnet directly.
- **Orca Router & Custom OpenAI-Compatible Gateways**: Enter your router base URL and API key during setup, and Orchy forwards them to your agent processes.
- **Direct Providers & Local Models**: Anthropic, OpenAI, Google Gemini, DeepSeek, Groq, and local Ollama.

### ⚡ 3. Friction-Free One CLI Onboarding
Connecting your agents to your everyday apps (Gmail, Slack, Notion, Stripe) is now completely seamless. Orchy automatically installs and configures the One CLI during setup and verifies system paths so you can connect accounts right away.

---

### Ready to try it?

If you already have Orchy cloned:
```bash
git pull
npm run setup
```

Or clone fresh:
```bash
git clone https://github.com/janmm97/Orchy-OSS.git
cd Orchy-OSS
npm run setup
```

As always, thank you for building with Orchy. Let us know what you build or what CLI engine you’re running!

Best regards,  
The Orchy Team

