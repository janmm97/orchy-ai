// The first-run setup guide ("Set up Orchy") and the "How One works" panel.
// Seven skippable steps, each revisitable. What is done comes from the server (GET /api/setup), so it stays true
// after a restart: name and timezone in config, keys in .env, workspaces and One logins on disk.
import { openWindow, getWindow } from './windows.mjs';
import { icon, createEl } from './pixel.mjs';
import { esc, api, setWorkspaces, oneSignIn } from './util.mjs';
import { openAddWorkspace, openConnections } from './panels.mjs';
import { openBuild } from './sheets.mjs';

let ctx = { state: {}, toast: () => {}, reload: async () => {} };
export function initSetup(c) { ctx = { ...ctx, ...c }; }

export const ONE_SIGN_IN = 'https://app.withone.ai/sign-in';
const openOneSite = () => window.open(ONE_SIGN_IN, '_blank', 'noopener');

const copy = async text => {
  try { await navigator.clipboard.writeText(text); ctx.toast('Copied. Paste it into a terminal.'); }
  catch { ctx.toast('Copy failed: select the text instead.', 'warn'); }
};

/** An install command with a Copy button. */
export const cmdHTML = cmd => `<span class="setup-cmd"><code class="data">${esc(cmd)}</code><button class="btn sm" type="button" data-copy="${esc(cmd)}" aria-label="Copy command">${icon('clip')}Copy</button></span>`;
/** One is installed but won't run on this Node (GET /api/workspaces → oneBlocked): why, and the command that fixes it. */
export const oneBlockedHTML = b => `<div class="empty"><strong>One can’t run on Node ${esc(b.node)}</strong>${esc(b.message)}${b.fix ? cmdHTML(b.fix) : ''}</div>`;
export const wireCopy = root => root.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => copy(b.dataset.copy)));

// Steps that make the One dashboard show an app (docs/ONE.md, step 6)
const EMBED_STEPS = [
  'In the One dashboard, click <b>Developers</b> at the bottom left.',
  'Open the <b>Embeddable Auth</b> tab (next to Connect, Webhooks, Relay, Logs and API keys).',
  'Type the tool’s name in <b>Search integrations…</b>',
  'Turn on its <b>Visible</b> toggle.',
  'Check the environment indicator at the top right: it should say <b>Production</b>, or the environment you mean to use.',
  'Come back to Orchy and add the app. An integration with a <b>Setup required</b> badge needs its OAuth settings filled in before it can be switched on.',
];

// ── How One works (docs/ONE.md, condensed) ──
export function openOneGuide({ from } = {}) {
  const body = createEl(`<div class="setup-doc">
    <p>One gives your agents access to hundreds of apps (Gmail, Slack, Notion, Stripe and more) through a single command-line tool. Each Orchy workspace signs in to One on its own, so apps never leak between businesses or clients.</p>
    <ol>
      <li><b>Create a One account</b> at <a href="${ONE_SIGN_IN}" target="_blank" rel="noopener noreferrer">app.withone.ai</a>.</li>
      <li><b>Make one organization per business or client</b> (the switcher is at the top left of the One dashboard). Their apps stay separate.</li>
      <li><b>Link each workspace.</b> Workspaces → the workspace → <i>Sign in to One</i>. Your browser opens; pick the organization this workspace should use. A workspace that isn’t signed in can’t use One at all.</li>
      <li><b>Add an app.</b> Connections → <i>Add app</i>. Your browser opens the app’s own sign-in page; when you finish, it appears in that workspace.</li>
      <li><b>App missing from the list?</b> Switch it on in Embeddable Auth:
        <ol>${EMBED_STEPS.map(s => `<li>${s}</li>`).join('')}</ol></li>
      <li><b>Give agents access.</b> The AI Agent Builder asks which connections a new agent gets, and whether each is Read or Full. Every change to an agent needs your OK.</li>
    </ol>
    <p class="hint">The workspace folder is the only scope One uses: an action for one workspace never runs from another’s folder.</p>
    <div class="btnrow end"><button class="btn" type="button" data-act="site">${icon('plug')}Open the One site</button></div>
  </div>`);
  const w = openWindow({ id: 'one-guide', title: 'How One works', body, from });
  body.querySelector('[data-act="site"]').addEventListener('click', openOneSite);
  return w;
}

// ── the guide ──
const STEPS = [
  { id: 'you', label: 'You' },
  { id: 'tools', label: 'Tools' },
  { id: 'keys', label: 'Keys' },
  { id: 'workspace', label: 'First workspace' },
  { id: 'signin', label: 'Sign in to One' },
  { id: 'app', label: 'First app' },
  { id: 'agent', label: 'First agent' },
];

const STARTER = 'Make me an assistant that reads my inbox every morning, labels what is urgent, and drafts replies to routine emails for me to approve.';

export async function openSetup({ step, from } = {}) {
  const existing = getWindow('setup');
  if (existing) { existing.restore(); if (step != null) existing.go?.(step); return existing; }
  const body = createEl(`<div class="setup"></div>`);
  const w = openWindow({ id: 'setup', title: 'Set up Orchy', size: 'wide', body, from });
  // no step asked for: the first one not done and not skipped, once the server says which those are
  let data = null, cur = step == null ? null : Math.max(0, Math.min(STEPS.length - 1, Number(step) || 0)), loadErr = null;
  const skipped = new Set(); // the steps skipped, kept by the server (POST /api/setup/skip), so they stay skipped
  const draft = { name: null, tz: null, keys: {}, ws: null, prompt: STARTER };
  let seq = 0;
  // harnesses Orchy is installing (Tools step): looked for every few seconds until found, 15 minutes at most
  const installing = new Set();
  const watchInstall = id => {
    installing.add(id);
    draw();
    const until = Date.now() + 15 * 60_000;
    const t = setInterval(async () => {
      const found = data?.tools?.find(x => x.id === id)?.found;
      if (found || !body.isConnected || Date.now() > until) {
        clearInterval(t); installing.delete(id);
        if (found) ctx.toast(`${data.tools.find(x => x.id === id)?.label || id} is installed.`);
        if (body.isConnected) draw();
        return;
      }
      await load(true);
    }, 5000);
  };

  const load = async (force = false) => {
    const mine = ++seq;
    try { const d = await api(`/api/setup${force ? '?force=1' : ''}`); if (mine === seq) { data = d; loadErr = null; (d.skippedSteps || []).forEach(s => skipped.add(s)); } }
    catch (e) { loadErr = e.message; }
    if (mine === seq) draw();
  };
  w.refresh = () => load();
  w.go = i => { cur = Math.max(0, Math.min(STEPS.length - 1, Number(i) || 0)); draw(); };

  // each step is done when the server says so
  const done = () => {
    if (!data) return {};
    const ws = data.workspaces.list;
    return {
      you: data.owner.set,
      tools: data.harness,
      // every optional feature answered (on, off or later), here or in npm run setup
      keys: data.features ? Object.values(data.features).every(f => f.state !== 'needs-key') : data.keys.some(k => k.set),
      workspace: data.workspaces.count > 0,
      signin: ws.some(x => x.oneSignedIn),
      app: false, // One's connections are per workspace and need a live call; the owner marks this one by hand
      agent: ws.some(x => x.hasAgents),
    };
  };
  const wsPick = () => {
    const list = data?.workspaces.list || [];
    if (!draft.ws || !list.some(x => x.id === draft.ws)) draft.ws = list[0]?.id || null;
    return draft.ws;
  };
  const wsSelect = () => {
    const list = data.workspaces.list;
    if (list.length < 2) return list[0] ? `<p class="hint">Workspace: <b>${esc(list[0].name)}</b></p>` : '';
    return `<div class="field"><label for="su-ws">Which workspace?</label><select class="select" id="su-ws">${list.map(x => `<option value="${esc(x.id)}" ${x.id === wsPick() ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>`;
  };
  const noWorkspace = () => `<div class="empty"><strong>No workspace yet</strong>This step needs one. Add your first workspace (step 4), then come back.</div><div class="btnrow"><button class="btn" type="button" data-go="3">Go to step 4</button></div>`;

  const screens = {
    you() {
      const tzs = (() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return []; } })();
      const browserTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } })();
      const name = draft.name ?? data.owner.name;
      const tz = draft.tz ?? (data.owner.set ? data.timezone : browserTz || data.timezone);
      return {
        html: `<h3 class="px caps">You</h3>
          <p>Orchy greets you by name and uses your timezone for the clock, schedules and daily reports. Both can be changed later.</p>
          <div class="field"><label for="su-name">Your name</label><input class="input" id="su-name" maxlength="60" autocomplete="given-name" value="${esc(name)}" placeholder="What should Orchy call you?" autofocus></div>
          <div class="field"><label for="su-tz">Timezone</label><input class="input data" id="su-tz" list="su-tzs" value="${esc(tz)}" autocomplete="off"><datalist id="su-tzs">${tzs.map(z => `<option value="${esc(z)}">`).join('')}</datalist>
            <span class="hint">${browserTz ? `Your browser says ${esc(browserTz)}. ` : ''}Use a name like America/New_York or Europe/Berlin.</span></div>
          <div class="btnrow"><button class="btn primary" type="button" data-act="save-you">${icon('check')}Save</button></div>`,
        bind(root) {
          root.querySelector('#su-name').addEventListener('input', e => { draft.name = e.target.value; });
          root.querySelector('#su-tz').addEventListener('input', e => { draft.tz = e.target.value; });
          root.querySelector('[data-act="save-you"]').addEventListener('click', async e => {
            e.currentTarget.disabled = true;
            try {
              await api('/api/setup/owner', { method: 'POST', body: { name: root.querySelector('#su-name').value, timezone: root.querySelector('#su-tz').value } });
              draft.name = draft.tz = null;
              ctx.toast('Saved.');
              await ctx.reload?.();
              await load();
              next();
            } catch (err) { ctx.toast(err.message, 'warn'); e.currentTarget.disabled = false; }
          });
        },
      };
    },

    tools() {
      const rows = data.tools;
      const missingHarness = !data.harness;
      // "Fix Orchy": the account Orchy works on his own code under (a fresh install has none)
      const fixAcct = () => {
        const a = data.backend?.account;
        if (!a || !rows.some(t => t.found)) return '';
        const rt = a.runtimeLabel || 'Claude Code';
        if (a.expected) return `<p class="hint">${icon('check')} “Fix Orchy” (Orchy working on his own code) runs as <b>${esc(a.expected)}</b> on ${esc(rt)}. Settings → Accounts changes it.</p>`;
        return `<section class="setup-card"><h4>Fix Orchy</h4>
          <p class="hint">Tell Orchy what’s broken and, after your OK, he works on his own code with ${esc(rt)}. Which account should he use?</p>
          ${a.suggested ? `<div class="btnrow"><button class="btn sm primary" type="button" data-backend-use="${esc(a.suggested)}">${icon('check')}Use ${esc(a.suggested)}</button><span class="hint">this computer’s ${esc(rt)} sign-in. Another harness or account: Settings → Accounts.</span></div>`
            : `<p class="hint">Sign in to ${esc(rt)} first, press Re-check, or pick another harness in Settings → Accounts.</p>`}</section>`;
      };
      return {
        html: `<h3 class="px caps">Tools</h3>
          <p>Orchy drives command-line tools on this computer. It needs at least one <b>agent harness</b> to run agents (Claude Code is the usual choice). <b>One</b> is how agents reach your apps.</p>
          ${missingHarness ? `<div class="ctx"><span class="plate decide">needed</span> No agent harness found yet. Install one below, then press Re-check.</div>` : ''}
          <div class="tablewrap"><table class="setup-table"><thead><tr><th>Tool</th><th>Status</th><th>Install</th></tr></thead><tbody>
          ${rows.map(t => `<tr>
            <td data-l="Tool"><b>${esc(t.label)}</b><br><span class="hint">${esc(t.note)}</span></td>
            <td data-l="Status">${t.found && t.refusal ? `<span class="plate decide">can’t run here</span><br><span class="hint data">${esc(t.version || '')}</span>` : t.found ? `<span class="plate">${icon('check')}found</span><br><span class="hint data">${esc(t.version || '')}</span>` : t.broken ? '<span class="plate decide">won’t start</span><br><span class="hint">Its install didn’t finish.</span>' : `<span class="plate ${t.required || (t.id === 'claude' && missingHarness) || t.id === 'one' ? 'decide' : ''}">${t.recommended ? 'recommended' : t.required ? 'required' : 'not found'}</span>`}</td>
            <td data-l="Install" ${t.found && !t.refusal ? 'class="none"' : ''}>${t.found && t.refusal ? `<span class="hint">${esc(t.refusal)}</span>${t.fixCmd ? cmdHTML(t.fixCmd) : ''}` : t.found ? '<span class="hint">Nothing to do.</span>' : t.kind === 'harness' && t.installCmd
              ? `${t.broken && t.repairCmd ? `<span class="hint">Run this in a terminal to finish it, then Re-check. Or press Install: it installs again and finishes it for you.</span>${cmdHTML(t.repairCmd)}` : ''}<span class="btnrow"><button class="btn sm primary" type="button" data-install="${esc(t.id)}" ${installing.has(t.id) ? 'disabled' : ''}>${icon(installing.has(t.id) ? 'refresh' : 'plus')}${installing.has(t.id) ? 'Installing…' : 'Install'}</button></span><details><summary class="hint">Or run it yourself</summary>${cmdHTML(t.installCmd)}</details>`
              : t.installCmd ? cmdHTML(t.installCmd) : '<span class="hint">No installer here: get it as the note says, then press Re-check.</span>'}</td></tr>`).join('')}
          </tbody></table></div>
          <p class="hint"><b>Install</b> opens a terminal window that runs the harness’s official installer for this computer, then its sign-in. Orchy notices when it’s done. Installed it yourself? Press Re-check.</p>
          ${fixAcct()}
          <div class="btnrow"><button class="btn" type="button" data-act="recheck">${icon('refresh')}Re-check</button></div>`,
        bind(root) {
          root.querySelector('[data-act="recheck"]').addEventListener('click', async e => { e.currentTarget.disabled = true; await load(true); });
          root.querySelector('[data-backend-use]')?.addEventListener('click', async e => {
            const b = e.currentTarget;
            b.disabled = true;
            try {
              const back = await api('/api/backend/account', { method: 'POST', body: { account: b.dataset.backendUse } });
              setWorkspaces(null, null, back);
              data.backend = back;
              ctx.toast(back.account?.ok ? `“Fix Orchy” runs as ${back.account.expected}.` : back.account?.error || 'Saved.', back.account?.ok ? '' : 'warn');
              draw();
            } catch (err) { ctx.toast(err.message, 'warn'); b.disabled = false; }
          });
          root.querySelectorAll('[data-install]').forEach(b => b.addEventListener('click', async () => {
            const id = b.dataset.install;
            b.disabled = true;
            try {
              const r = await api(`/api/runtimes/${encodeURIComponent(id)}/install`, { method: 'POST' });
              if (r.already) return load(true);
              ctx.toast('A terminal window opened. Answer the installer’s prompts there, then sign in.');
              watchInstall(id);
            } catch (err) { ctx.toast(err.message, 'warn'); b.disabled = false; }
          }));
        },
      };
    },

    keys() {
      // where the owner stands on each feature (lib/features.mjs): an answer (on, off, later) is shown as one line,
      // never asked again; only a feature with no answer shows its key fields
      const f = data.features || {};
      const about = id => data.keys.find(k => k.id === id) || {};
      const has = key => !!ctx.state.envStatus?.[key];
      const field = (key, label) => `<div class="field"><label for="su-k-${key}">${label} ${has(key) ? '<span class="plate">set</span>' : ''}</label>
        <div class="btnrow"><input class="input data" id="su-k-${key}" type="password" autocomplete="off" placeholder="${has(key) ? 'Paste a new key to replace it' : 'Paste key'}" value="${esc(draft.keys[key] || '')}" style="flex:1;min-width:200px"><button class="btn" type="button" data-save="${key}">Save</button></div></div>`;
      const card = (title, body) => `<section class="setup-card"><h4>${title}</h4>${body}</section>`;
      const answered = (word, text) => `<p>${icon('check')} <b>${word}.</b> ${text}</p>`;
      const tucked = (summary, fields) => `<details><summary class="hint">${summary}</summary><div class="setup-fields">${fields}</div></details>`;
      const asks = (id, offLabel) => `<div class="btnrow"><button class="btn sm" type="button" data-feat-later="${id}">Not now</button><button class="btn sm ghost" type="button" data-feat-off="${id}">${offLabel}</button></div>`;

      // Jev: TypeSafe first; the other providers behind "another provider"
      const JEV = [['TYPESAFE_API_KEY', 'TypeSafe key (best)', 'typesafe', 'TypeSafe'], ['OPENROUTER_API_KEY', 'OpenRouter key', 'openrouter', 'OpenRouter'],
        ['AI_GATEWAY_API_KEY', 'Vercel AI Gateway key', 'vercel', 'Vercel AI Gateway'], ['OPENCODE_API_KEY', 'OpenCode Zen key', 'opencode', 'OpenCode Zen']];
      const jev = f.jev?.state || (about('jev').set ? 'on' : 'needs-key');
      const jevNow = JEV.find(([key, , id]) => id === f.jev?.provider && has(key)) || JEV.find(([key]) => has(key));
      const jevFields = list => list.map(([key, label]) => field(key, label)).join('');
      const jevHint = '<span class="hint">One is enough. TypeSafe and Vercel run the native Jev; OpenRouter and OpenCode Zen run it as a chat model, an approximation.</span>';
      const jevCard = card('Jev: routing', {
        off: `${answered('Off', `You turned Jev off. ${esc(about('jev').withoutIt)}`)}<div class="btnrow"><button class="btn sm" type="button" data-feat-on="jev">Turn Jev on</button></div>`,
        on: `${answered('On', `Through ${esc(jevNow?.[3] || 'your key')}.`)}${tucked('Replace the key, or use another provider', jevFields(JEV) + jevHint)}`,
        skipped: `${answered('Later', `You’re adding a key later, so Orchy won’t ask again. Until then: ${esc(about('jev').withoutIt)}`)}${tucked('Add a key now', jevFields(JEV) + jevHint)}`,
        'needs-key': `<p class="hint"><b>You get:</b> ${esc(about('jev').unlocks)}<br><b>Without it:</b> ${esc(about('jev').withoutIt)}</p>
          ${jevFields(JEV.slice(0, 1))}${tucked('Or use another provider', jevFields(JEV.slice(1)) + jevHint)}${asks('jev', 'I don’t want Jev')}`,
      }[jev]);

      // Voice: only the key for the service picked in setup (both when none was)
      const voice = f.voice?.state || 'needs-key';
      const needs = f.voice?.needs || ['ELEVENLABS_API_KEY', 'DEEPGRAM_API_KEY'];
      const VOICE = { ELEVENLABS_API_KEY: 'ElevenLabs API key', DEEPGRAM_API_KEY: needs.length > 1 ? 'Deepgram API key (a backup voice, optional)' : 'Deepgram API key' };
      const voiceFields = needs.map(key => field(key, VOICE[key])).join('');
      const speaking = f.voice?.provider === 'deepgram' || !has('ELEVENLABS_API_KEY') ? 'Deepgram' : has('DEEPGRAM_API_KEY') && !f.voice?.provider ? 'ElevenLabs, with Deepgram as the backup' : 'ElevenLabs';
      const voiceCard = card('Voice', {
        off: `${answered('Off', 'Orchy is chat only, and nothing is sent to ElevenLabs or Deepgram.')}<div class="btnrow"><button class="btn sm" type="button" data-feat-on="voice">Turn voice on</button></div>`,
        on: `${answered('On', `Speaking with ${speaking}.`)}${tucked('Replace a key', voiceFields)}`,
        skipped: `${answered('Later', 'Orchy speaks with your browser’s voice until you add a key, and won’t ask again.')}${tucked('Add a key now', voiceFields)}`,
        'needs-key': `<p class="hint"><b>You get:</b> ${esc(about('elevenlabs').unlocks)}<br><b>Without it:</b> ${esc(about('elevenlabs').withoutIt)}</p>${voiceFields}${asks('voice', 'Chat only, no voice')}`,
      }[voice]);

      return {
        html: `<h3 class="px caps">Keys</h3>
          <p>Both are optional. Keys are saved in Orchy’s <code class="data">.env</code> file on this computer and never shown again. Whatever you answer here, or answered in <code class="data">npm run setup</code>, Orchy won’t ask again. Settings changes it any time.</p>
          ${jevCard}${voiceCard}`,
        bind(root) {
          root.addEventListener('input', e => { if (e.target.id?.startsWith('su-k-')) draft.keys[e.target.id.slice(5)] = e.target.value; });
          root.querySelectorAll('[data-save]').forEach(b => b.addEventListener('click', async () => {
            const key = b.dataset.save, input = root.querySelector(`#su-k-${key}`);
            if (!input.value.trim()) return input.focus();
            b.disabled = true;
            try { await api('/api/settings/env', { method: 'POST', body: { key, value: input.value.trim() } }); delete draft.keys[key]; ctx.toast('Saved.'); await ctx.reload?.(); await load(); }
            catch (err) { ctx.toast(err.message, 'warn'); b.disabled = false; }
          }));
          // an answer: on, off (.env, as Settings writes it), or later (the server's settings)
          const answer = async (b, body, said) => {
            b.disabled = true;
            try { await api(body.key ? '/api/settings/env' : '/api/settings', { method: 'POST', body }); ctx.toast(said); await ctx.reload?.(); await load(); }
            catch (err) { ctx.toast(err.message, 'warn'); b.disabled = false; }
          };
          root.querySelectorAll('[data-feat-on]').forEach(b => b.addEventListener('click', () => answer(b, b.dataset.featOn === 'jev' ? { key: 'JEV_PROVIDER', value: '' } : { key: 'VOICE_ENABLED', value: '1' }, b.dataset.featOn === 'jev' ? 'Jev is on: add a key to use it.' : 'Voice is on.')));
          root.querySelectorAll('[data-feat-off]').forEach(b => b.addEventListener('click', () => answer(b, b.dataset.featOff === 'jev' ? { key: 'JEV_PROVIDER', value: 'off' } : { key: 'VOICE_ENABLED', value: '0' }, b.dataset.featOff === 'jev' ? 'Jev is off.' : 'Voice is off: chat only.')));
          root.querySelectorAll('[data-feat-later]').forEach(b => b.addEventListener('click', () => answer(b, { skip: { [b.dataset.featLater]: true } }, 'Later, then. Orchy won’t ask again.')));
        },
      };
    },

    workspace() {
      const list = data.workspaces.list;
      return {
        html: `<h3 class="px caps">First workspace</h3>
          <p>A <b>workspace</b> is one business or one client: a folder with its own agents, its own memory, its own accounts and its own One login. Keeping them apart is the point: an agent working for one business can never touch another’s email or files.</p>
          ${list.length ? `<div class="list">${list.map(x => `<div><b>${esc(x.name)}</b> ${x.hasAgents ? '<span class="chip">has agents</span>' : '<span class="chip">no agents yet</span>'}</div>`).join('')}</div>` : '<div class="empty"><strong>No workspaces yet</strong>Add your first one to continue.</div>'}
          <div class="btnrow"><button class="btn primary" type="button" data-act="add">${icon('plus')}${list.length ? 'Add another workspace' : 'Add your first workspace'}</button><button class="btn" type="button" data-act="recheck">${icon('refresh')}Re-check</button></div>`,
        bind(root) {
          root.querySelector('[data-act="add"]').addEventListener('click', e => openAddWorkspace({ from: e.currentTarget }));
          root.querySelector('[data-act="recheck"]').addEventListener('click', () => load());
        },
      };
    },

    signin() {
      const list = data.workspaces.list;
      if (!list.length) return { html: `<h3 class="px caps">Sign in to One</h3>${noWorkspace()}`, bind() {} };
      const sel = list.find(x => x.id === wsPick());
      return {
        html: `<h3 class="px caps">Sign in to One</h3>
          <p>Orchy works with One. One connects your agents to Gmail, Slack, Notion and hundreds of other apps. Create your One account, and make <b>an organization per business or client</b>, so each workspace only ever sees its own apps.</p>
          ${wsSelect()}
          <p>${sel.oneSignedIn ? `${icon('check')} <b>${esc(sel.name)}</b> is signed in to One.` : `<span class="plate decide">not signed in</span> <b>${esc(sel.name)}</b> has no One login yet.`}</p>
          <ol class="setup-list"><li><button class="btn" type="button" data-act="site">${icon('plug')}Create a One account</button> <span class="hint">Opens app.withone.ai in a new tab.</span></li>
            <li><button class="btn primary" type="button" data-act="login">${icon('key')}Sign in to One</button> <span class="hint">Opens your browser; pick the organization for ${esc(sel.name)}.</span></li>
            <li><button class="btn" type="button" data-act="recheck">${icon('refresh')}Re-check</button></li></ol>`,
        bind(root) {
          root.querySelector('#su-ws')?.addEventListener('change', e => { draft.ws = e.target.value; draw(); });
          root.querySelector('[data-act="site"]').addEventListener('click', openOneSite);
          root.querySelector('[data-act="recheck"]').addEventListener('click', () => load());
          root.querySelector('[data-act="login"]').addEventListener('click', async e => {
            const btn = e.currentTarget; btn.disabled = true;
            await oneSignIn(wsPick(), ctx.toast);
            btn.disabled = false;
          });
        },
      };
    },

    app() {
      const list = data.workspaces.list;
      return {
        html: `<h3 class="px caps">First app</h3>
          <p>Connect an app (Gmail, Slack, Notion…) to a workspace. If the app you want isn’t in the list, switch it on in the One dashboard first:</p>
          <ol class="setup-list">${EMBED_STEPS.map(s => `<li>${s}</li>`).join('')}</ol>
          <div class="btnrow">${list.length ? `<button class="btn primary" type="button" data-act="conn">${icon('plug')}Open Connections to add an app</button>` : ''}<button class="btn" type="button" data-act="guide">${icon('doc')}How One works</button></div>
          ${list.length ? '' : noWorkspace()}`,
        bind(root) {
          root.querySelector('[data-act="conn"]')?.addEventListener('click', e => openConnections(list.find(x => x.oneSignedIn)?.id || list[0].id, { from: e.currentTarget }));
          root.querySelector('[data-act="guide"]').addEventListener('click', e => openOneGuide({ from: e.currentTarget }));
        },
      };
    },

    agent() {
      const list = data.workspaces.list;
      if (!list.length) return { html: `<h3 class="px caps">First agent</h3>${noWorkspace()}`, bind() {} };
      return {
        html: `<h3 class="px caps">First agent</h3>
          <p>You don’t write agents by hand. Describe the job to the <b>AI Agent Builder</b>, Orchy’s chief of agents, and it writes the agent for you: a name, a role, its instructions, and which apps it may use (read-only or full). It asks you before connecting anything, and every change to an agent needs your OK.</p>
          ${wsSelect()}
          <div class="field"><label for="su-prompt">What should your first agent do?</label><textarea class="textarea" id="su-prompt" rows="4">${esc(draft.prompt)}</textarea><span class="hint">This is a starting point. Change it to whatever you’d hand to a new assistant.</span></div>
          <div class="btnrow"><button class="btn primary" type="button" data-act="build">${icon('spark')}Open the Builder</button></div>`,
        bind(root) {
          root.querySelector('#su-ws')?.addEventListener('change', e => { draft.ws = e.target.value; });
          root.querySelector('#su-prompt').addEventListener('input', e => { draft.prompt = e.target.value; });
          root.querySelector('[data-act="build"]').addEventListener('click', e => openBuild(wsPick(), { from: e.currentTarget, prompt: draft.prompt }));
        },
      };
    },
  };

  const next = () => { if (cur < STEPS.length - 1) { cur++; draw(); } else finish(); };
  const finish = async () => {
    try { await api('/api/setup/done', { method: 'POST', body: { done: true } }); ctx.state.settings && (ctx.state.settings.setupDone = true); } catch {}
    w.close();
    ctx.toast('You’re set. You can reopen this guide from Settings any time.');
  };

  function draw() {
    if (!data) { body.innerHTML = `<div class="empty">${loadErr ? esc(loadErr) : 'Looking around this computer…'}</div>${loadErr ? `<div class="btnrow"><button class="btn" type="button" data-act="retry">${icon('refresh')}Try again</button></div>` : ''}`; body.querySelector('[data-act="retry"]')?.addEventListener('click', () => load()); return; }
    const ok = done();
    if (cur == null) cur = Math.max(0, STEPS.findIndex(st => !ok[st.id] && !skipped.has(st.id)));
    const s = screens[STEPS[cur].id]();
    body.innerHTML = `
      <nav class="setup-steps" aria-label="Setup steps"><ol>${STEPS.map((st, i) => `<li><button type="button" data-step="${i}" ${i === cur ? 'aria-current="step"' : ''}>
        <span class="n">${ok[st.id] ? icon('check') : i + 1}</span><span class="t">${esc(st.label)}</span>${!ok[st.id] && skipped.has(st.id) ? '<span class="hint">skipped</span>' : ''}</button></li>`).join('')}</ol></nav>
      <div class="setup-main"><div class="setup-screen" data-screen>${s.html}</div>
        <div class="setup-foot btnrow"><button class="btn" type="button" data-act="back" ${cur === 0 ? 'disabled' : ''}>${icon('left')}Back</button>
          <span class="grow"></span>
          ${cur < STEPS.length - 1 ? `<button class="btn ghost" type="button" data-act="skip">Skip</button><button class="btn" type="button" data-act="next">Next${icon('right')}</button>` : `<button class="btn primary" type="button" data-act="finish">${icon('check')}Finish setup</button>`}</div></div>`;
    body.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => w.go(b.dataset.step)));
    body.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => w.go(b.dataset.go)));
    body.querySelector('[data-act="back"]').addEventListener('click', () => w.go(cur - 1));
    body.querySelector('[data-act="skip"]')?.addEventListener('click', () => {
      const id = STEPS[cur].id;
      skipped.add(id);
      api('/api/setup/skip', { method: 'POST', body: { step: id } }).catch(() => {});
      // skipping Keys answers "later" for each feature still unanswered, so nothing nags about them
      const later = id === 'keys' ? Object.entries(data.features || {}).filter(([, f]) => f.state === 'needs-key').map(([k]) => k) : [];
      if (later.length) api('/api/settings', { method: 'POST', body: { skip: Object.fromEntries(later.map(k => [k, true])) } }).catch(() => {});
      next();
    });
    body.querySelector('[data-act="next"]')?.addEventListener('click', next);
    body.querySelector('[data-act="finish"]')?.addEventListener('click', finish);
    const screen = body.querySelector('[data-screen]');
    wireCopy(screen);
    s.bind(screen);
  }

  draw();
  load();
  return w;
}

/** Re-read the guide's data when something it shows changes (a workspace added, a login done). */
export function refreshSetup() { getWindow('setup')?.refresh?.(); }

/** First load: no workspaces and the guide never marked done → open it once. */
export async function maybeAutoOpenSetup(state) {
  if (state.workspaces?.length || state.settings?.setupDone) return;
  try { if (localStorage.getItem('orchy-setup-shown')) return; localStorage.setItem('orchy-setup-shown', '1'); } catch {}
  openSetup();
}
