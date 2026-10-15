// This browser and Orchy (orchestrator/lib/owner.mjs). Only a paired browser can make changes; any other can look.
// Orchy opens the dashboard with a one-time code (?pair=…), traded here for an HttpOnly cookie plus a key this page
// keeps in its own storage and sends with each request (util.mjs). Otherwise the owner types the code from Orchy's
// terminal, or makes one on a paired browser (Settings → This browser).
import { openWindow, getWindow } from './windows.mjs';
import { icon, createEl } from './pixel.mjs';
import { esc, api, setOwnerKey } from './util.mjs';
import { cmdHTML, wireCopy } from './setup.mjs';

let ctx = { toast: () => {}, reload: async () => {} };
let linkError = null; // a ?pair= code that didn't work, shown in the window
let stale = false; // the cookie is known but this page has no key: paired before keys, or its storage was cleared

const pairWith = async code => setOwnerKey((await api('/api/pair', { method: 'POST', body: { code } })).key);

/** Trade a ?pair= code in the address for this browser's cookie, then take it out of the address. */
export async function pairFromLink(params) {
  const code = params.get('pair');
  if (!code) return;
  params.delete('pair');
  history.replaceState(null, '', location.pathname + (params.size ? `?${params}` : '') + location.hash);
  try { await pairWith(code); }
  catch (e) { linkError = e.message; }
}

/** Show the pairing window now if this browser isn't paired, and whenever a change is refused for it. */
export async function watchPairing(c) {
  ctx = { ...ctx, ...c };
  window.addEventListener('orchy:unpaired', e => { if (e.detail?.stale) stale = true; openPair(); });
  try { const o = await api('/api/owner'); stale = !!o.stale; if (!o.paired) openPair(); } catch {}
}

export function openPair({ from } = {}) {
  const existing = getWindow('pair');
  if (existing) { existing.restore(); return existing; }
  const body = createEl(`<div style="display:grid;gap:var(--s4)">
    <p style="margin:0">${stale ? 'This browser was paired, but Orchy now also keeps a key in the page itself, and this page doesn’t have one. Pair it once more with a new code.' : 'This browser isn’t paired with Orchy yet.'} You can look around, but changes (sending a task, answering an approval, settings) need a paired browser. It keeps agents on this PC from making changes in your name.</p>
    ${linkError ? `<div class="ctx">${esc(linkError)}</div>` : ''}
    <div class="field"><label for="pair-code">Pairing code</label>
      <div class="btnrow"><input class="input data" id="pair-code" autocomplete="off" spellcheck="false" placeholder="ABCDE-FGHJK" style="flex:1;min-width:160px;text-transform:uppercase">
      <button class="btn primary" type="button" data-act="pair">${icon('check')}Pair</button></div>
      <span class="hint">Find it in the terminal window where Orchy is running (“Pair a browser”), or on a paired browser: Settings → This browser → Pair another browser. Closed that terminal? Start Orchy again and it opens a paired page.</span></div>
  </div>`);
  const w = openWindow({ id: 'pair', title: 'Pair this browser', body, from });
  const input = body.querySelector('#pair-code');
  const go = async () => {
    try {
      await pairWith(input.value);
      linkError = null;
      stale = false;
      w.close?.();
      ctx.toast('This browser is paired. You can make changes now.');
      await ctx.reload();
    } catch (e) { ctx.toast(e.message, 'warn'); }
  };
  body.querySelector('[data-act="pair"]').addEventListener('click', go);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  setTimeout(() => input.focus(), 0);
  return w;
}

/** Settings → This browser. */
export const browserSectionHTML = () => `<section style="display:grid;gap:var(--s3)"><h3 class="px caps" style="margin:0">This browser</h3>
  <p class="hint" style="margin:0">Only paired browsers can make changes in Orchy. Pair another (a second browser, a laptop on this PC) with a one-time code.</p>
  <div data-pairout></div>
  <div class="btnrow"><button class="btn sm" type="button" data-act="pair-new">${icon('plus')}Pair another browser</button>
    <button class="btn sm" type="button" data-act="unpair-others">${icon('close')}Unpair every other browser</button></div>
</section>`;

export function wireBrowserSection(body, toast) {
  body.querySelector('[data-act="pair-new"]')?.addEventListener('click', async () => {
    try {
      const r = await api('/api/pair/new', { method: 'POST' });
      const out = body.querySelector('[data-pairout]');
      out.innerHTML = `<div style="display:grid;gap:var(--s2)"><span class="hint">Open this link in the other browser, or type the code there. It works once, for ${esc(r.minutes)} minutes.</span>${cmdHTML(r.url)}${cmdHTML(r.code)}</div>`;
      wireCopy(out);
    } catch (e) { toast(e.message, 'warn'); }
  });
  body.querySelector('[data-act="unpair-others"]')?.addEventListener('click', async () => {
    if (!confirm('Unpair every other browser? They will need a new code to make changes.')) return;
    try { const r = await api('/api/pair/unpair-others', { method: 'POST' }); toast(r.removed ? `Unpaired ${r.removed} other browser${r.removed === 1 ? '' : 's'}.` : 'No other browser was paired.'); }
    catch (e) { toast(e.message, 'warn'); }
  });
}
