# Getting started with One in Orchy

Orchy works with One.

One gives your agents access to hundreds of apps (Gmail, Slack, Notion, Stripe and more) through one CLI. Orchy uses it for every app an agent touches. Each Orchy workspace signs in to One on its own, so apps never leak between businesses or clients.

1. **Create a One account.** Go to https://app.withone.ai/sign-in and sign up.

2. **Make one organization per business or client.** The organization switcher is at the top left of the One dashboard. Use one organization for each business or client, so their connected apps stay separate.

3. **Link each Orchy workspace to One.** In Orchy, open Workspace, open the workspace, and press "Sign in to One". Orchy runs `one init --auth browser --project` in that workspace folder and opens your browser. When One asks, choose the organization this workspace should use. The login is saved for that folder only. A workspace that is not signed in cannot use One at all.

4. **Know where your apps are listed.** In the One dashboard, the "Connected Apps" page (left sidebar) lists connected tools. "Add new app" on that page connects one. Agents then use the apps through One's CLI or MCP.

5. **Add an app from Orchy.** Open Orchy, go to Connections, pick the workspace, and press "Add app". Orchy runs `one connection add <app>`. Your browser opens the app's sign-in page. When you finish, the app appears in that workspace.

6. **If an app is not available to connect**, switch it on in Embeddable Auth:
   1. In the One dashboard, click "Developers" at the bottom left.
   2. Open the "Embeddable Auth" tab. It sits next to Connect, Webhooks, Relay, Logs and API keys.
   3. Type the tool's name in "Search integrations...".
   4. Turn on its "Visible" toggle.
   5. Check the environment indicator at the top right (it shows "Production"). Make sure it is the environment you want.
   6. Add the app from Orchy, as in step 5.

   An integration with a "Setup required" badge needs OAuth settings before it can be switched on.

7. **Give agents access.** When you ask the AI Agent Builder for a new agent, it asks which connections that agent gets, and whether each is Read or Full. Any change to an agent needs your approval.

The workspace folder is the only scope One uses. Never run a `one` action for one workspace from another workspace's folder.
