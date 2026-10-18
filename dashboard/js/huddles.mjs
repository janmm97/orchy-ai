// Huddle windows (server: huddle.mjs): two or more agents of one workspace talk a task through, turn by turn,
// challenging each other's proposals from their roles, with Orchy reading along and now and then stepping in
// (huddlecoach.mjs). The owner reads along, jumps in, stops it, and goes through the proposal they write (View
// proposal: the plan, their questions one at a time, Orchy's answers from the standing rules) to approve it or send
// it back. Also the form that starts one (Workspaces window, and the Huddles window in the top bar with every huddle
// listed, the standing rules and Orchy's huddle settings).
import { openWindow, getWindow } from './windows.mjs';
import { icon, createEl, orchySVG } from './pixel.mjs';
import { esc, api, md, wsName, wsClass, timeShort, dateTime, nameRole, agentName } from './util.mjs';
import { spriteFor } from './sheets.mjs';
import { openViewer } from './viewer.mjs';

let ctx = null; // { state, toast, openRun, activeSession }
export function initHuddles(c) { ctx = c; }

const TALKING = new Set(['talking', 'wrapping']);
const STATUS = {
  talking: 'Talking', wrapping: 'Writing the agreement', agreed: 'Agreed · waiting for you', approved: 'Approved · at work',
  stopped: 'Stopped', failed: 'Stopped early', closed: 'Closed',
};
const isOwnerLine = t => t.by === 'owner' || t.by === 'jan'; // 'jan': huddles stored by older builds
const used = h => h.turns.filter(t => !isOwnerLine(t) && t.by !== 'orchy' && !t.wrap).length; // the agreement isn't a turn, nor Orchy's lines

/** Live updates: the window follows the huddle, and the dashboard's list too. */
export function huddleUpdated(h) {
  ctx.state.huddles.set(h.id, h);
  getWindow(`huddle-${h.id}`)?.render(h);
  getWindow('huddles')?.renderList?.();
}

/** One line of the talk (other views, e.g. a Live view, can draw a huddle with these too). */
export function turnHTML(h, t) {
  if (isOwnerLine(t)) return `<div class="hmsg owner"><div class="who"><span class="plate decide">You</span><time>${timeShort(t.at)}</time></div><div class="body">${esc(t.text)}</div></div>`;
  // Orchy stepping in (huddlecoach.mjs): a challenge, a suggestion, or a point he withdraws
  if (t.by === 'orchy' && t.kind === 'coach') return coachHTML(h, t);
  // Orchy: someone joined (or couldn't)
  if (t.by === 'orchy') return `<div class="hjoin" role="note">${t.joined ? `<span class="hsprite">${spriteFor(h.workspace, t.joined)}</span>` : ''}<span>${esc(t.text)}</span><time>${timeShort(t.at)}</time></div>`;
  const side = h.agents[0].slug === t.by ? 'a' : 'b';
  const a = h.agents.find(x => x.slug === t.by);
  return `<div class="hmsg ${side}">
    <div class="who"><span class="hsprite">${spriteFor(h.workspace, t.by)}</span><b>${esc(a?.name || t.name)}</b>${t.ready ? '<span class="plate">ready to agree</span>' : ''}<time>${timeShort(t.at)}</time>${t.runId ? `<button class="linkish" data-run="${esc(t.runId)}" title="What ${esc(a?.name || '')} looked at this turn">steps</button>` : ''}</div>
    <div class="body md">${md(t.text)}</div>
    ${t.challenge ? `<div class="hpush"><span class="label">Pushes back</span><div class="md">${md(t.challenge)}</div></div>` : ''}
    ${t.questions?.length ? `<div class="hq"><span class="label">For you, later</span>${t.questions.map(q => `<div>${esc(q)}</div>`).join('')}</div>` : ''}
  </div>`;
}

const COACH_PLATE = { challenge: 'Orchy · challenges', advise: 'Orchy · suggests', withdraw: 'Orchy · withdraws' };
const FIVE = [['observation', 'Observation'], ['concern', 'Concern'], ['alternative', 'Alternative'], ['tradeoff', 'Trade-off'], ['recommendation', 'Recommendation']];
// Orchy's own lines for the huddle: what he sees, why it matters, what else, its cost, what he'd do
function coachHTML(h, t) {
  const tile = `<span class="hsprite">${orchySVG('idle', 0, { label: 'Orchy' })}</span>`;
  const time = `<time>${timeShort(t.at)}</time>`;
  if (t.mode === 'withdraw') return `<div class="hcoach withdraw" role="note"><div class="who">${tile}<span class="plate line">${COACH_PLATE.withdraw}</span>${time}</div><div>${esc(t.text)}</div></div>`;
  const i = (h.coach?.issues || []).find(x => x.i === h.turns.indexOf(t));
  const nameOf = slug => h.agents.find(a => a.slug === slug)?.name || slug;
  const state = !i ? '' : i.status === 'answered' ? `<span class="plate line">answered${i.answeredBy ? ` · ${esc(i.answeredBy)}` : ''}</span>`
    : i.status === 'withdrawn' ? '<span class="plate line">withdrawn</span>'
    : i.pushback ? `<span class="plate line">${esc(i.pushback.name)} pushes back</span>` : '';
  const p = t.parts || {};
  const rows = FIVE.filter(([k]) => p[k]);
  return `<div class="hcoach ${t.mode === 'challenge' ? 'challenge' : 'advise'}" role="note" aria-label="${esc(COACH_PLATE[t.mode] || 'Orchy')}">
    <div class="who">${tile}<span class="plate ${t.mode === 'challenge' ? '' : 'line'}">${COACH_PLATE[t.mode] || 'Orchy'}</span>${t.to ? `<span class="hint">to ${esc(nameOf(t.to))}</span>` : ''}${state}${time}</div>
    <p class="habout">${esc(t.about || '')}</p>
    ${rows.length ? `<dl class="hfive">${rows.map(([k, l]) => `<dt>${l}</dt><dd>${esc(p[k])}</dd>`).join('')}</dl>` : `<div class="md">${md(t.text)}</div>`}
    ${t.basis ? `<div class="hint">Going by: ${esc(t.basis)}</div>` : ''}
  </div>`;
}
const coachMax = s => (s.huddleCoachMax != null && Number.isFinite(Number(s.huddleCoachMax)) ? Number(s.huddleCoachMax) : 3);
/** Orchy's part in a huddle, for the window's facts: points made of the budget, spend, or why he stays out. */
function coachFacts(h) {
  const c = h.coach;
  const s = ctx.state.settings || {};
  if (s.huddleCoach === false && !c?.count) return 'Off in Settings';
  if (c?.off && !c.count) return `Stays out: ${c.off}`;
  if (!c) return TALKING.has(h.status) ? 'Reading along' : '';
  const by = m => (c.issues || []).filter(i => i.mode === m).length;
  const parts = [`${c.count || 0} of ${coachMax(s)} points`, by('challenge') ? `${by('challenge')} challenged` : '', by('advise') ? `${by('advise')} suggested` : '', (c.issues || []).some(i => i.status === 'withdrawn') ? 'withdrew one' : ''].filter(Boolean);
  return `${parts.join(' · ')}${c.cost ? ` · $${c.cost.toFixed(2)}` : ''}`;
}

// an agreement's questions as { id, q, why, options, recommended, covers, orchy, answer }; older agreements only have text
const questionsOf = g => (g?.questions?.length ? g.questions : (g?.questions_for_owner || g?.questions_for_jan || []).map((q, i) => ({ id: `q${i + 1}`, q })));
const openQuestions = g => g?.questions_for_owner || g?.questions_for_jan || [];

export function agreementHTML(h) {
  const g = h.agreement;
  if (!g) return '';
  const nameOf = slug => h.agents.find(a => a.slug === slug)?.name || slug;
  const qs = questionsOf(g);
  return `<div class="hagree">
    <div class="hh"><span>${icon('check')} ${g.dissent?.length ? 'What they agreed, and didn’t' : 'What they agreed'}</span>${h.status === 'approved' ? '<span class="plate">approved</span>' : ''}</div>
    <div class="md">${md(g.summary)}</div>
    ${g.decisions?.length ? `<span class="label">Decisions</span><div class="list">${g.decisions.map(d => `<div>${esc(d)}</div>`).join('')}</div>` : ''}
    <span class="label">Once you approve</span>
    <div class="list">${g.work?.length ? g.work.map(w => `<div><b>${esc(nameOf(w.agent))}</b>: ${esc(w.task)}</div>`).join('') : '<div>Nobody has work. Keep them talking, or close it.</div>'}</div>
    ${takeHTML(g)}
    ${g.dissent?.length ? `<div class="hq big"><span class="label">Still contested · your call</span>${g.dissent.map(d => `<div>${esc(d)}</div>`).join('')}</div>` : ''}
    ${qs.length ? `<div class="hq ${h.status === 'agreed' && openQuestions(g).length ? 'big' : ''}"><span class="label">Questions for you${h.status === 'agreed' ? ' · answer them in View proposal' : ''}</span>${qs.map(q => `<div>${esc(q.q)}${q.orchy ? ` <span class="hint">· Orchy answered: ${esc(q.orchy.answer)}</span>` : ''}${q.answer ? ` <span class="hint">· you: ${esc(q.answer)}</span>` : ''}</div>`).join('')}</div>` : ''}
  </div>`;
}

// Orchy's take on what they still contest (advice only: the owner decides), set above the dissent it's about
const takeHTML = g => (g?.orchyTake?.take && g.dissent?.length ? `<div class="htake"><span class="label">${orchySVG('idle', 0, { label: 'Orchy' })}Orchy’s take · advice, your call</span><div><b>${esc(g.orchyTake.take)}</b>${g.orchyTake.why ? ` ${esc(g.orchyTake.why)}` : ''}</div></div>` : '');

// ── View proposal: the plan, then the owner's questions one at a time, then the answers to check and send ──
const drafts = new Map(); // huddle id -> { step, answers: { [qid]: { answer, remember } }, note }: survives closing the window

export async function openProposal(id, { from } = {}) {
  let h = ctx.state.huddles.get(id);
  try { h = await api(`/api/huddles/${encodeURIComponent(id)}`); } catch (e) { if (!h) return ctx.toast(e.message, 'warn'); }
  if (h.status !== 'agreed' || !h.agreement) return openHuddle(id, { from });
  const wid = `proposal-${id}`;
  if (getWindow(wid)) return getWindow(wid).restore();
  const g = h.agreement;
  const qs = questionsOf(g);
  const mine = qs.filter(q => !q.orchy);    // the steps
  const orchy = qs.filter(q => q.orchy);    // answered from the standing rules: shown, changeable, not steps
  const d = drafts.get(id) || { step: 0, answers: {}, note: '' };
  drafts.set(id, d);
  const steps = ['plan', ...mine.map(q => q.id), 'review'];
  const nameOf = slug => h.agents.find(a => a.slug === slug)?.name || slug;
  const body = createEl('<div class="prop"></div>');
  const w = openWindow({ id: wid, title: `Proposal · ${h.agents.map(a => a.name).join(' + ')}`, kind: 'decision', closable: true, body, from, dockLabel: 'Proposal' });
  const ans = q => d.answers[q.id]?.answer?.trim() || '';
  const final = q => ans(q) || q.orchy?.answer || q.recommended || ''; // what goes to them if the owner leaves it
  const pips = () => `<span class="hturns" aria-hidden="true"><span class="cd">${steps.map((_, i) => `<i class="${i <= d.step ? 'spent' : ''}"></i>`).join('')}</span></span>`;

  const planHTML = () => `
    <div class="btnrow" style="justify-content:space-between"><span class="plate ${wsClass(h.workspace)}">${esc(wsName(h.workspace))}</span>${pips()}</div>
    <span class="label">What they propose</span>
    <div class="md">${md(g.summary)}</div>
    ${takeHTML(g)}
    ${g.dissent?.length ? `<div class="hq big"><span class="label">Still contested · your call</span>${g.dissent.map(x => `<div>${esc(x)}</div>`).join('')}</div>` : ''}
    ${g.decisions?.length ? `<details><summary class="label">Decisions · ${g.decisions.length}</summary><div class="list">${g.decisions.map(x => `<div>${esc(x)}</div>`).join('')}</div></details>` : ''}
    <details><summary class="label">Who does what once you approve · ${g.work?.length || 0}</summary><div class="list">${(g.work || []).map(x => `<div><b>${esc(nameOf(x.agent))}</b>: ${esc(x.task)}</div>`).join('') || '<div>Nobody has work.</div>'}</div></details>
    ${orchy.length ? `<div class="porchy"><span class="label">Orchy answered ${orchy.length} from your rules</span>${orchy.map(q => `<div><b>${esc(q.q)}</b><span>→ ${esc(ans(q) || q.orchy.answer)}</span><span class="hint">${esc(q.orchy.source)}. You can change it on the last page.</span></div>`).join('')}</div>` : ''}
    <div class="btnrow end"><button class="btn primary" data-p="next">${mine.length ? `${icon('chat')}Answer ${mine.length} question${mine.length === 1 ? '' : 's'}` : `${icon('check')}Review and approve`}</button></div>`;

  const qHTML = q => {
    const n = mine.indexOf(q) + 1;
    const a = d.answers[q.id] || {};
    const covers = q.covers?.length ? q.covers.map(nameOf).join(', ') : null;
    return `
    <div class="btnrow" style="justify-content:space-between"><span class="label">Question ${n} of ${mine.length}${covers ? ` · for ${esc(covers)}` : ''}</span>${pips()}</div>
    <p class="ask">${esc(q.q)}</p>
    ${q.why ? `<div class="ctx">${esc(q.why)}</div>` : ''}
    ${q.options?.length ? `<div class="opts" role="group" aria-label="Their options">${q.options.map((o, i) => `<button type="button" data-opt="${i}" aria-pressed="${a.answer === o}">${esc(o)}${o === q.recommended ? ' · recommended' : ''}</button>`).join('')}</div>` : ''}
    <div class="field"><label for="pa-${esc(q.id)}">Your answer</label><textarea class="textarea" id="pa-${esc(q.id)}" data-ans style="min-height:72px" placeholder="${q.recommended ? `Leave it empty to go with their recommendation: ${esc(q.recommended)}` : 'Pick an option or write your own.'}">${esc(a.answer || '')}</textarea></div>
    <label class="pmem"><input type="checkbox" data-mem ${a.remember ? 'checked' : ''}> Remember this: Orchy answers it for you next time</label>
    <div class="btnrow" style="justify-content:space-between"><button class="btn" data-p="back">${icon('back')}Back</button><span class="btnrow"><span class="hint">Ctrl+Enter: next</span><button class="btn primary" data-p="next">${n === mine.length ? `${icon('check')}Review answers` : 'Next'}</button></span></div>`;
  };

  const reviewHTML = () => {
    const missing = qs.filter(q => !final(q));
    const row = q => `<div class="prow"><b>${esc(q.q)}</b>
      <span>${final(q) ? `→ ${esc(final(q))}` : '<em>Not answered yet</em>'}${!ans(q) && q.orchy ? ' <span class="hint">· Orchy, from your rules</span>' : !ans(q) && q.recommended ? ' <span class="hint">· their recommendation</span>' : ''}${d.answers[q.id]?.remember && ans(q) ? ' <span class="hint">· remembered</span>' : ''}</span>
      ${q.orchy ? `<textarea class="textarea" data-orchy="${esc(q.id)}" style="min-height:40px" aria-label="Change Orchy's answer" placeholder="Change Orchy's answer (optional)">${esc(ans(q))}</textarea>` : `<button class="linkish" data-goto="${esc(q.id)}">Change</button>`}</div>`;
    return `
    <div class="btnrow" style="justify-content:space-between"><span class="label">Your answers · check them, then send</span>${pips()}</div>
    ${qs.length ? `<div class="list">${[...mine, ...orchy].map(row).join('')}</div>` : '<p class="hint" style="margin:0">They have no questions for you.</p>'}
    <div class="field"><label for="pn-${esc(id)}">Anything else they should know (optional)</label><textarea class="textarea" id="pn-${esc(id)}" data-note style="min-height:48px">${esc(d.note)}</textarea></div>
    ${missing.length ? `<p class="hint" style="margin:0">${missing.length} still need${missing.length === 1 ? 's' : ''} an answer before you can approve. You can still send it back.</p>` : ''}
    <div class="btnrow" style="justify-content:space-between"><button class="btn" data-p="back">${icon('back')}Back</button>
      <span class="btnrow"><button class="btn" data-p="send" title="They talk it over again with your answers and come back with a new proposal">${icon('refresh')}Send back</button><button class="btn primary" data-p="approve" ${missing.length || !g.work?.length ? 'disabled' : ''}>${icon('check')}Submit and approve</button></span></div>`;
  };

  const payload = () => qs.map(q => ({ id: q.id, answer: ans(q) || (q.orchy ? '' : q.recommended || ''), remember: !!d.answers[q.id]?.remember })).filter(a => a.answer);
  const keep = () => { // what's on screen into the draft
    const t = body.querySelector('[data-ans]');
    const cur = mine.find(q => q.id === steps[d.step]);
    if (t && cur) d.answers[cur.id] = { ...d.answers[cur.id], answer: t.value, remember: !!body.querySelector('[data-mem]')?.checked };
    body.querySelectorAll('[data-orchy]').forEach(x => { d.answers[x.dataset.orchy] = { ...d.answers[x.dataset.orchy], answer: x.value }; });
    const n = body.querySelector('[data-note]');
    if (n) d.note = n.value;
  };
  const go = i => { keep(); d.step = Math.max(0, Math.min(steps.length - 1, i)); draw(); };
  async function send(what, btn) {
    keep();
    btn.disabled = true;
    try {
      const res = what === 'approve'
        ? await api(`/api/huddles/${encodeURIComponent(id)}/approve`, { method: 'POST', body: { answers: payload(), note: d.note.trim() } })
        : await api(`/api/huddles/${encodeURIComponent(id)}/continue`, { method: 'POST', body: { answers: payload(), text: d.note.trim() } });
      drafts.delete(id);
      const hh = res.huddle || res;
      if (hh?.id) huddleUpdated(hh);
      ctx.toast(what === 'approve' ? (res.errors?.length ? `Started, but: ${res.errors.join(' · ')}` : 'Approved with your answers. They’re on it.') : 'Sent back with your answers. They’ll come back with a new proposal.', res.errors?.length ? 'warn' : '');
      w.close();
      if (what === 'send') openHuddle(id);
    } catch (e) { ctx.toast(e.message, 'warn'); btn.disabled = false; }
  }
  function draw() {
    const s = steps[d.step];
    body.innerHTML = s === 'plan' ? planHTML() : s === 'review' ? reviewHTML() : qHTML(mine.find(q => q.id === s));
    const q = mine.find(x => x.id === s);
    const ta = body.querySelector('[data-ans]');
    body.querySelectorAll('[data-opt]').forEach(b => b.addEventListener('click', () => {
      body.querySelectorAll('[data-opt]').forEach(x => x.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
      ta.value = q.options[Number(b.dataset.opt)];
      ta.focus();
    }));
    ta?.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) go(d.step + 1); });
    body.querySelector('[data-p="next"]')?.addEventListener('click', () => go(d.step + 1));
    body.querySelector('[data-p="back"]')?.addEventListener('click', () => go(d.step - 1));
    body.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => go(steps.indexOf(b.dataset.goto))));
    body.querySelectorAll('[data-p="approve"],[data-p="send"]').forEach(b => b.addEventListener('click', () => send(b.dataset.p, b)));
    (ta || body.querySelector('.btn.primary'))?.focus({ preventScroll: true });
  }
  // on the last page, changing Orchy's answer or the note keeps Approve in step
  body.addEventListener('input', () => {
    if (steps[d.step] !== 'review') return;
    keep();
    const b = body.querySelector('[data-p="approve"]');
    if (b) b.disabled = qs.some(x => !final(x)) || !g.work?.length;
  });
  draw();
  return w;
}

export async function openHuddle(id, { from } = {}) {
  if (getWindow(`huddle-${id}`)) return getWindow(`huddle-${id}`).restore();
  let h = ctx.state.huddles.get(id);
  try { h = await api(`/api/huddles/${encodeURIComponent(id)}`); } catch (e) { if (!h) return ctx.toast(e.message, 'warn'); }
  const body = createEl(`<div class="huddle" style="display:grid;grid-template-columns:minmax(0,1fr);gap:var(--s4)"></div>`);
  const title = hh => `Huddle · ${hh.agents.map(a => a.name).join(' + ')}`;
  const w = openWindow({ id: `huddle-${id}`, title: title(h), size: 'wide', body, from, dockLabel: 'Huddle' });
  let draft = ''; // what the owner is typing survives live updates
  body.addEventListener('input', e => { if (e.target.matches('[data-h-text]')) draft = e.target.value; });
  w.render = hh => {
    h = hh;
    const talking = TALKING.has(h.status);
    const speaker = h.speaking === 'orchy' ? { name: 'Orchy' } : h.agents.find(a => a.slug === h.speaking);
    const n = used(h);
    const many = h.agents.length > 2; // three or more: a row of everyone instead of the pair
    const facts = coachFacts(h);
    const open = openQuestions(h.agreement);
    if (w.title !== title(h)) w.setTitle(title(h));
    body.innerHTML = `
      <div class="hpair ${many ? 'many' : ''}">
        ${h.agents.map((a, i) => `<div class="hagent ${i && !many ? 'b' : 'a'} ${h.speaking === a.slug ? 'on' : ''}"${a.joinedBy ? ` title="${esc(a.joinedBy.name)} brought ${esc(a.name)} in${a.joinedBy.why ? `: ${esc(a.joinedBy.why)}` : ''}"` : ''}><span class="sprite">${spriteFor(h.workspace, a.slug)}</span><span class="t"><b>${esc(a.name)}</b><span>${esc(a.role)}</span></span></div>`).join(many ? '' : '<span class="hx" aria-hidden="true">⇄</span>')}
      </div>
      <div class="btnrow" style="justify-content:space-between"><span class="btnrow"><span class="plate ${wsClass(h.workspace)}">${esc(wsName(h.workspace))}</span><span class="plate ${h.status === 'agreed' ? 'decide' : ''}">${esc(STATUS[h.status] || h.status)}</span></span>
        <span class="hturns" title="Turns used of the ${h.maxTurns} allowed">${n}/${h.maxTurns} turns<span class="cd">${Array.from({ length: Math.min(h.maxTurns, 40) }, (_, i) => `<i class="${i < n ? 'spent' : ''}"></i>`).join('')}</span></span></div>
      <dl class="kv">${h.startedBy ? `<dt>Started by</dt><dd>${esc(h.startedBy.name)}, from a task${h.startedBy.runId ? ` <button class="linkish" data-run="${esc(h.startedBy.runId)}">open it</button>` : ''}</dd>` : ''}<dt>${h.startedBy ? `${esc(h.startedBy.name)} asked` : 'You asked'}</dt><dd>${esc(h.topic)}</dd>${h.note ? `<dt>Note</dt><dd>${esc(h.note)}</dd>` : ''}${facts ? `<dt>Orchy</dt><dd>${esc(facts)}</dd>` : ''}${h.taskDir ? `<dt>Transcript</dt><dd><button class="linkish" data-transcript title="Open it in the viewer">Tasks/${esc(h.taskDir)}/HUDDLE.md</button></dd>` : ''}</dl>
      <div class="hchat" data-hchat>${h.turns.map(t => turnHTML(h, t)).join('') || ''}
        ${talking ? `<div class="hmsg ${h.speaking === 'orchy' ? 'orchy' : h.agents[0].slug === h.speaking ? 'a' : 'b'} typing"><div class="who"><b>${esc(speaker?.name || 'Next up')}</b>${h.speaking === 'orchy' ? ' is weighing in' : h.status === 'wrapping' ? ' is writing the agreement' : ' is thinking'}<span class="dots"><i></i><i></i><i></i></span>${h.currentRunId ? `<button class="linkish" data-run="${esc(h.currentRunId)}">watch</button>` : ''}</div></div>` : ''}
      </div>
      ${agreementHTML(h)}
      ${h.workRunIds?.length ? `<div class="btnrow">${h.workRunIds.map(rid => { const r = ctx.state.runs.get(rid); return `<button class="btn sm" data-run="${esc(rid)}">${icon('eye')}${esc(r ? agentName(r.workspace, r.isBuilder ? 'agent-builder' : r.agentSlug, r.agentName) : 'Their work')}</button>`; }).join('')}</div>` : ''}
      ${talking ? `<div class="field"><label for="hj-${h.id}">Jump in</label><textarea class="textarea" id="hj-${h.id}" data-h-text style="min-height:56px" placeholder="${h.agents.length > 2 ? 'They all read' : 'Both of them read'} it on their next turn.">${esc(draft)}</textarea>
          <div class="btnrow end"><button class="btn" data-h="stop">${icon('stop')}Stop the huddle</button><button class="btn primary" data-h="say">${icon('send')}Say it</button></div></div>`
        : h.status === 'agreed' ? `<div class="btnrow end"><button class="btn" data-h="close">${icon('x')}Close it</button><button class="btn" data-h="more">${icon('refresh')}Keep talking</button><button class="btn primary" data-h="proposal">${icon('check')}View proposal${open.length ? ` · ${open.length} question${open.length === 1 ? '' : 's'}` : ''}</button></div>`
        : h.status === 'stopped' || h.status === 'failed' ? `<div class="field"><label for="hj-${h.id}">Pick it up again</label><textarea class="textarea" id="hj-${h.id}" data-h-text style="min-height:56px" placeholder="Optional: steer them.">${esc(draft)}</textarea>
          <div class="btnrow end"><button class="btn primary" data-h="more">${icon('refresh')}Keep talking</button></div></div>` : ''}`;
    // follow the talk while it goes on; an agreement waiting for the owner is what they came for
    if (talking) body.querySelector('[data-hchat]')?.lastElementChild?.scrollIntoView({ block: 'nearest' });
    else if (h.status === 'agreed' && !w.shown) { w.shown = true; requestAnimationFrame(() => body.querySelector('.hagree')?.scrollIntoView({ block: 'start' })); }
    body.querySelectorAll('[data-run]').forEach(b => b.addEventListener('click', () => ctx.openRun(b.dataset.run)));
    body.querySelectorAll('[data-h]').forEach(b => b.addEventListener('click', () => act(b.dataset.h, b)));
    // HUDDLE.md (and anything else in the huddle's folder) in the viewer
    body.querySelector('[data-transcript]')?.addEventListener('click', async e => {
      const btn = e.currentTarget;
      try {
        const { artifacts } = await api(`/api/artifacts?huddle=${encodeURIComponent(h.id)}`);
        const doc = artifacts.find(a => a.name.toLowerCase() === 'huddle.md') || artifacts[0];
        if (!doc) return ctx.toast('The transcript isn’t written yet.');
        openViewer({ artifact: doc, list: artifacts, from: btn });
      } catch (err) { ctx.toast(err.message, 'warn'); }
    });
  };

  async function act(what, btn) {
    const text = body.querySelector('[data-h-text]')?.value.trim() || '';
    if (what === 'say' && !text) return body.querySelector('[data-h-text]').focus();
    if (what === 'proposal') return openProposal(h.id, { from: btn });
    btn.disabled = true;
    try {
      const path = { say: 'say', stop: 'stop', more: 'continue', close: 'close' }[what];
      const res = await api(`/api/huddles/${encodeURIComponent(h.id)}/${path}`, { method: 'POST', body: { text } });
      if (['say', 'more'].includes(what)) draft = '';
      const hh = res.huddle || res;
      if (hh?.id) huddleUpdated(hh);
    } catch (e) { ctx.toast(e.message, 'warn'); btn.disabled = false; }
  }
  w.render(h);
  return w;
}

/** Agents of a workspace that can join a huddle (the server checks the rest: engine, client sharing). */
const huddlers = wsId => ctx.state.agents.filter(a => a.workspace === wsId && !a.error);
const liveWorkspaces = () => ctx.state.workspaces.filter(x => x.enabled !== false);

let formSeq = 0;
/**
 * The start form: two or more agents of one workspace and what they should work out. One opens (and writes the
 * agreement); the owner toggles on everyone else they want in the room. `pickWs` adds a workspace picker (the
 * Huddles window); the Workspaces window passes its own workspace instead. `lead` fixes the opener (a C-suite agent's
 * own window): the owner only picks who it huddles with, its team first.
 */
function huddleForm(root, { wsId, pickWs = false, session = null, pre = [], lead = null, onStarted }) {
  let ws = wsId;
  let topic = '';
  let opener = lead || pre[0] || null;
  let picked = new Set(lead ? pre : pre.slice(1)); // who else is in the room
  const u = `hn${++formSeq}`; // ids unique per form: the Huddles window and an agent window can be open together
  const draw = () => {
    const agents = huddlers(ws);
    const label = a => `${esc(nameRole(agentName(a.workspace, a.slug, a.displayName), a.displayName))}${a.executive ? ' · C-suite' : ''}`;
    if (!agents.some(a => a.slug === opener)) opener = agents[0]?.slug || null;
    picked = new Set([...picked].filter(s => s !== opener && agents.some(a => a.slug === s)));
    if (!picked.size && !lead && agents[1]) picked.add(agents.find(a => a.slug !== opener).slug);
    const wsPick = pickWs ? `<div class="btnrow"><label class="label" for="${u}-ws">Where</label><select class="select" id="${u}-ws" style="width:auto">${liveWorkspaces().map(x => `<option value="${esc(x.id)}" ${x.id === ws ? 'selected' : ''}>${esc(wsName(x.id))}</option>`).join('')}</select></div>` : '';
    const me = lead && agents.find(a => a.slug === lead);
    const team = new Set(me?.team || []);
    const others = agents.filter(a => a.slug !== opener).sort((a, b) => team.has(b.slug) - team.has(a.slug));
    const chip = a => `<button type="button" class="btn sm" data-pick="${esc(a.slug)}" aria-pressed="${picked.has(a.slug)}">${label(a)}</button>`;
    const chips = list => `<div class="hpick" role="group" aria-label="Who else is in the huddle">${list.map(chip).join('')}</div>`;
    const withRow = team.size && others.some(a => !team.has(a.slug))
      ? `<span class="label">Team</span>${chips(others.filter(a => team.has(a.slug)))}<span class="label">Others</span>${chips(others.filter(a => !team.has(a.slug)))}`
      : chips(others);
    const who = `${me ? '' : `<div class="btnrow"><label class="label" for="${u}-a">Who opens</label><select class="select" id="${u}-a" style="width:auto;max-width:100%">${agents.map(a => `<option value="${esc(a.slug)}" ${opener === a.slug ? 'selected' : ''}>${label(a)}</option>`).join('')}</select></div>`}
      <div style="display:grid;grid-template-columns:minmax(0,1fr);gap:var(--s2)"><span class="btnrow" style="justify-content:space-between"><span class="label">${me ? 'Huddle with' : 'With'} · ${picked.size} picked</span>${others.length > 1 ? `<button type="button" class="linkish" data-all>${picked.size === others.length ? 'Clear' : 'Everyone'}</button>` : ''}</span>${withRow}</div>`;
    const name = me ? agentName(me.workspace, me.slug, me.displayName) : '';
    root.innerHTML = `${wsPick}${agents.length < 2
      ? `<p class="hint" style="margin:0">${esc(wsName(ws))} needs two agents for a huddle. It has ${agents.length}.</p>`
      : `${who}
        <div class="field"><label for="${u}-t">${me ? `What should ${esc(name)} work out with them?` : 'What should they work out?'}</label><textarea class="textarea" id="${u}-t" placeholder="${me ? `e.g. ${esc(name)}, agree with them on next month's content plan: what they need from you and who does what.` : 'e.g. Sam, ask Riley what they need to prep faster, then update them.'}">${esc(topic)}</textarea></div>
        <div class="btnrow end"><button class="btn primary" data-act="go" ${picked.size ? '' : 'disabled'}>${icon('send')}Start the huddle${picked.size > 1 ? ` · ${picked.size + 1} agents` : ''}</button></div>`}`;
    root.querySelector(`#${u}-ws`)?.addEventListener('change', e => { ws = e.target.value; opener = null; picked = new Set(); draw(); });
    root.querySelector(`#${u}-a`)?.addEventListener('change', e => { opener = e.target.value; draw(); });
    root.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => { const s = b.dataset.pick; picked.has(s) ? picked.delete(s) : picked.add(s); draw(); }));
    root.querySelector('[data-all]')?.addEventListener('click', () => { picked = picked.size === others.length ? new Set() : new Set(others.map(a => a.slug)); draw(); });
    root.querySelector(`#${u}-t`)?.addEventListener('input', e => { topic = e.target.value; });
    root.querySelector('[data-act="go"]')?.addEventListener('click', async e => {
      const text = root.querySelector(`#${u}-t`).value.trim();
      if (!picked.size) return ctx.toast('Pick at least one agent to huddle with.', 'warn');
      if (!text) return root.querySelector(`#${u}-t`).focus();
      e.currentTarget.disabled = true;
      try {
        const h = await api('/api/huddles', { method: 'POST', body: { workspace: ws, agents: [opener, ...picked], topic: text, session: typeof session === 'function' ? session() : session } });
        huddleUpdated(h);
        topic = '';
        onStarted(h);
      } catch (err) { ctx.toast(err.message, 'warn'); e.currentTarget.disabled = false; }
    });
  };
  draw();
}

/** A C-suite agent's window (Huddle tab): the owner starts a huddle it opens, with colleagues they pick. */
export function mountLeadHuddle(root, { wsId, slug, onStarted }) {
  huddleForm(root, { wsId, lead: slug, session: () => ctx.activeSession?.() || null, onStarted: h => { onStarted?.(h); openHuddle(h.id); } });
}

/** Start a huddle by hand from the Workspaces window: two or more agents of this workspace and what they should work out. */
export function openNewHuddle(wsId, { from, session = null, agents: pre = [] } = {}) {
  const body = createEl(`<div style="display:grid;grid-template-columns:minmax(0,1fr);gap:var(--s4)"></div>`);
  const w = openWindow({ id: `huddle-new-${wsId}`, title: `New huddle · ${wsName(wsId)}`, body, from });
  body.innerHTML = `<p class="hint" style="margin:0">Pick as many agents as the question needs. They talk it through turn by turn, push back on each other from their own roles, and write up what they agree and what they still dispute. They only talk: nothing changes until you approve. Questions only you can answer wait for the agreement.</p><div data-form style="display:grid;grid-template-columns:minmax(0,1fr);gap:var(--s4)"></div>`;
  huddleForm(body.querySelector('[data-form]'), { wsId, session, pre, onStarted: h => { w.close(); openHuddle(h.id); } });
  return w;
}

// ── Orchy in huddles (server: huddlecoach.mjs; settings huddleCoach + huddleCoachMax) ──
/** The two controls: Orchy joins huddles (on/off) and his points per huddle (0–6). Settings can mount these too. */
export function coachSettingsHTML(s = ctx.state.settings || {}) {
  const max = coachMax(s);
  return `<div class="btnrow"><label style="display:grid;grid-template-columns:auto 1fr;gap:var(--s3);align-items:center"><span class="switch"><input type="checkbox" role="switch" data-coach-on ${s.huddleCoach !== false ? 'checked' : ''}><span class="track"><span class="knob"></span></span></span><span><b>Orchy joins huddles</b><br><span class="hint">He reads along and, when it changes the outcome, challenges or suggests (under the workspace's own Claude Code account; never approves or assigns work).</span></span></label></div>
    <div class="btnrow"><label class="hint">at most <select class="select" data-coach-max aria-label="Orchy's points per huddle" style="width:auto;padding:2px 6px">${[0, 1, 2, 3, 4, 5, 6].map(n => `<option value="${n}" ${max === n ? 'selected' : ''}>${n}</option>`).join('')}</select> points per huddle</label></div>`;
}
/** Wire the controls coachSettingsHTML drew inside `root`. */
export function wireCoachSettings(root) {
  const save = async body => {
    try { ctx.state.settings = await api('/api/settings', { method: 'POST', body }); }
    catch (err) { ctx.toast(err.message, 'warn'); }
  };
  root.querySelector('[data-coach-on]')?.addEventListener('change', e => save({ huddleCoach: e.target.checked }));
  root.querySelector('[data-coach-max]')?.addEventListener('change', e => save({ huddleCoachMax: Number(e.target.value) }));
}

// ── the Huddles window (top bar): start one in any workspace, and every huddle going or waiting on the owner ──
const ORDER = { agreed: 0, talking: 1, wrapping: 1, failed: 2, stopped: 2, approved: 3, closed: 4 };
function rowHTML(h) {
  const who = h.agents.map(a => esc(a.name)).join(' ⇄ ');
  const by = h.startedBy ? `${esc(h.startedBy.name)} started it` : 'you started it';
  return `<button class="runrow" data-huddle-open="${esc(h.id)}">
    <span class="l1"><b>${who}</b><span class="hint">${esc(dateTime(h.createdAt))}</span></span>
    <span class="l2">${esc(h.topic)}</span>
    <span class="l3"><span class="plate ${wsClass(h.workspace)}">${esc(wsName(h.workspace))}</span><span class="plate ${h.status === 'agreed' ? 'decide' : ''}${TALKING.has(h.status) ? ' blink' : ''}">${esc(STATUS[h.status] || h.status)}</span><span class="hint">${by} · ${used(h)}/${h.maxTurns} turns</span></span>
  </button>`;
}

const rulesUrl = (wsId, rid) => `/api/standing-rules/${encodeURIComponent(wsId)}${rid ? `/${encodeURIComponent(rid)}` : ''}`;
/**
 * The owner's standing rules (server: rules.mjs), per workspace: what Orchy answers for them in a proposal. They add
 * one here or by ticking "Remember this", and remove them here. These never clear an approval.
 */
async function drawRules(root) {
  const all = liveWorkspaces();
  const lists = await Promise.all(all.map(x => api(rulesUrl(x.id)).then(r => [x.id, r.rules || []]).catch(() => [x.id, []])));
  const withRules = lists.filter(([, rs]) => rs.length);
  const u = `hr${++formSeq}`;
  root.innerHTML = `<div class="section-h"><h3>Your standing rules <span class="count">${withRules.reduce((n, [, rs]) => n + rs.length, 0)}</span></h3></div>
    <p class="hint" style="margin:0 0 var(--s2)">Answers you told Orchy to remember. When agents in a huddle ask one of these again, Orchy answers for you, and you can still change it in the proposal. They never approve anything for you.</p>
    ${withRules.length ? withRules.map(([ws, rs]) => `<span class="label">${esc(wsName(ws))}</span><div class="list">${rs.map(r => `<div class="hrule"><span>${esc(r.text)}</span><button class="linkish" data-rule-rm="${esc(r.id)}" data-ws="${esc(ws)}">Remove</button></div>`).join('')}</div>`).join('')
      : '<div class="empty"><strong>No rules yet</strong>Tick "Remember this" when you answer a proposal, or write one below.</div>'}
    ${all.length ? `<div class="btnrow" style="margin-top:var(--s2)"><select class="select" data-rule-ws aria-label="Workspace" style="width:auto">${all.map(x => `<option value="${esc(x.id)}">${esc(wsName(x.id))}</option>`).join('')}</select><input class="input" id="${u}" data-rule-text maxlength="600" placeholder="e.g. Drafts always go to review before anything is published." aria-label="New standing rule" style="flex:1;min-width:12ch"><button class="btn sm" data-rule-add>${icon('plus')}Add</button></div>` : ''}`;
  root.querySelectorAll('[data-rule-rm]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await api(rulesUrl(b.dataset.ws, b.dataset.ruleRm), { method: 'DELETE' }); drawRules(root); }
    catch (e) { ctx.toast(e.message, 'warn'); b.disabled = false; }
  }));
  const add = async () => {
    const t = root.querySelector('[data-rule-text]');
    const text = t.value.trim();
    if (!text) return t.focus();
    try { await api(rulesUrl(root.querySelector('[data-rule-ws]').value), { method: 'POST', body: { text } }); drawRules(root); }
    catch (e) { ctx.toast(e.message, 'warn'); }
  };
  root.querySelector('[data-rule-add]')?.addEventListener('click', add);
  root.querySelector('[data-rule-text]')?.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
}

export function openHuddles({ from, wsId = null, session = null } = {}) {
  const existing = getWindow('huddles');
  if (existing) { existing.restore(); existing.renderList(); return existing; }
  const body = createEl(`<div style="display:grid;grid-template-columns:minmax(0,1fr);gap:var(--s4)"></div>`);
  const w = openWindow({ id: 'huddles', title: 'Huddles', size: 'wide', body, from });
  const first = liveWorkspaces().find(x => x.id === wsId) || liveWorkspaces()[0];
  body.innerHTML = `
    <p class="hint" style="margin:0">Any number of agents of one workspace talk a task through, turn by turn. Each pushes back on the others from its own role, so nobody agrees just to agree, and they write up what they agree and what they still dispute. They only talk: nothing changes until you approve. C-suite agents (a Chief, a CxO or a department head) can also start one from their own tasks.</p>
    ${first ? '<div data-form style="display:grid;grid-template-columns:minmax(0,1fr);gap:var(--s4)"></div>' : '<div class="empty"><strong>No agents switched on</strong>Switch a workspace on in Workspaces to start a huddle.</div>'}
    <div class="section-h"><h3>Huddles <span class="count" data-count>0</span></h3></div>
    <div data-list></div>
    <div data-coach style="display:grid;gap:var(--s2)"><div class="section-h"><h3>Orchy in huddles</h3></div>${coachSettingsHTML()}</div>
    <div data-rules></div>`;
  wireCoachSettings(body.querySelector('[data-coach]'));
  drawRules(body.querySelector('[data-rules]'));
  if (first) huddleForm(body.querySelector('[data-form]'), { wsId: first.id, pickWs: true, session, onStarted: h => { openHuddle(h.id); w.renderList(); } });
  w.renderList = () => {
    const list = [...ctx.state.huddles.values()].sort((a, b) => (ORDER[a.status] ?? 5) - (ORDER[b.status] ?? 5) || b.createdAt.localeCompare(a.createdAt)).slice(0, 30);
    body.querySelector('[data-count]').textContent = list.length;
    body.querySelector('[data-list]').innerHTML = list.length ? `<div class="runs">${list.map(rowHTML).join('')}</div>`
      : '<div class="empty"><strong>No huddles yet</strong>Start one above, or ask Orchy ("get Sam and Riley to talk through the launch").</div>';
    body.querySelectorAll('[data-huddle-open]').forEach(b => b.addEventListener('click', () => openHuddle(b.dataset.huddleOpen, { from: b })));
  };
  w.renderList();
  return w;
}
