// Monthly impact report: the Impact numbers for one calendar month as a single self-contained HTML
// page (fonts inside, no scripts) in Reports/impact-YYYY-MM.html. Drawn in 1-Bit Orchy (DESIGN.md):
// ink and paper, dither for greys, a client ink per workspace, the pixel face at 16/32px only.
// Orchy writes last month's on the 1st (`startMonthly`), and the owner can ask for any month from the Impact window.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './env.mjs';
import { impact, dayOf } from './impact.mjs';
import { workspace } from './workspaces.mjs';

export const REPORTS_DIR = path.join(ROOT, 'Reports');
const FONTS = path.join(ROOT, 'dashboard', 'fonts');
const TINTS = ['cobalt', 'tomato', 'jade', 'violet', 'magenta', 'teal', 'olive', 'brown'];

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = n => `$${Math.round(n).toLocaleString('en-US')}`;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = m => `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;
const prevMonth = m => { const [y, n] = m.split('-').map(Number); return n === 1 ? `${y - 1}-12` : `${y}-${String(n - 1).padStart(2, '0')}`; };
const thisMonth = () => dayOf(new Date().toISOString()).slice(0, 7);
const day = d => `${MONTHS[Number(d.slice(5, 7)) - 1].slice(0, 3)} ${Number(d.slice(8))}`;

/** The client ink a workspace wears (its `color` in config.json: a named tint, or a generated hue), or plain ink. */
function ink(id) {
  let color = null;
  try { color = workspace(id).color; } catch { /* a retired workspace keeps its name only */ }
  if (TINTS.includes(color)) return [`var(--tint-${color})`, `var(--on-tint-${color})`];
  if (/^h[0-9]+$/.test(color || '')) return [`hsl(${color.slice(1)} 62% 38%)`, '#fff']; // a generated hue past the named tints
  return ['var(--ink)', 'var(--paper)'];
}

const font = (name, family, weight) => `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${fs.readFileSync(path.join(FONTS, name)).toString('base64')}) format("woff2");font-weight:${weight};font-display:swap}`;

const CSS = `
:root{--ink:#0a0a0a;--paper:#fff;--decide:#ffd23f;
--tint-cobalt:#2f5bff;--on-tint-cobalt:#fff;--tint-tomato:#ff5a36;--on-tint-tomato:#0a0a0a;--tint-jade:#0a7d50;--on-tint-jade:#fff;--tint-violet:#6d3ae0;--on-tint-violet:#fff;--tint-magenta:#b8177a;--on-tint-magenta:#fff;--tint-teal:#00747d;--on-tint-teal:#fff;--tint-olive:#5a6e00;--on-tint-olive:#fff;--tint-brown:#7a4a1e;--on-tint-brown:#fff;
--d50:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='4' shape-rendering='crispEdges'%3E%3Crect width='2' height='2'/%3E%3Crect x='2' y='2' width='2' height='2'/%3E%3C/svg%3E");
--d25:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='4' shape-rendering='crispEdges'%3E%3Crect width='2' height='2'/%3E%3C/svg%3E");
--d12:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8' shape-rendering='crispEdges'%3E%3Crect width='2' height='2'/%3E%3Crect x='4' y='4' width='2' height='2'/%3E%3C/svg%3E");
--px:16px;--px2:32px}
@media (prefers-color-scheme:dark){:root{--ink:#f4f4ef;--paper:#0b0b0c;--tint-cobalt:#7d97ff;--on-tint-cobalt:#0a0a0a;--tint-tomato:#ff7650;--on-tint-tomato:#0a0a0a;
--tint-jade:#4fd18f;--tint-violet:#b49aff;--tint-magenta:#ff7ac8;--tint-teal:#3ccfd6;--tint-olive:#b3d64a;--tint-brown:#d29a62;
--on-tint-jade:#0a0a0a;--on-tint-violet:#0a0a0a;--on-tint-magenta:#0a0a0a;--on-tint-teal:#0a0a0a;--on-tint-olive:#0a0a0a;--on-tint-brown:#0a0a0a}}
*{box-sizing:border-box;border-radius:0}
html{background:var(--paper);color:var(--ink)}
body{margin:0;font:400 15px/1.5 "Atkinson Hyperlegible Next",system-ui,sans-serif;-webkit-font-smoothing:none}
.px{font:400 var(--px)/1 Silkscreen,ui-monospace,monospace;text-transform:uppercase}
.px2{font:400 var(--px2)/1 Silkscreen,ui-monospace,monospace;text-transform:uppercase}
.data{font-family:"Atkinson Hyperlegible Mono",ui-monospace,Consolas,monospace}
.shell{background:#0a0a0a;color:#f4f4ef}
.wrap{max-width:1080px;margin:0 auto;padding:0 24px}
header.shell .wrap{padding-top:24px;padding-bottom:32px;display:grid;gap:16px}
header .top{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
header h1{margin:0;font-size:var(--px2);word-break:break-word}
header p{margin:0;max-width:62ch;color:#f4f4ef}
.plate{display:inline-block;padding:3px 6px;background:var(--ink);color:var(--paper);white-space:nowrap}
header .plate{background:#f4f4ef;color:#0a0a0a}
.plate.decide{background:var(--decide);color:#0a0a0a}
main{display:grid;gap:48px;padding:32px 0 48px}
section{display:grid;gap:16px}
h2{margin:0;font-size:var(--px);display:flex;align-items:center;gap:8px}
h2::after{content:"";flex:1;height:2px;background:var(--ink)}
.hero{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:24px;align-items:stretch}
.big{border:2px solid var(--ink);padding:24px;display:grid;gap:12px;align-content:start}
.big .num{font-size:var(--px2);line-height:1.1;word-break:break-word}
.big .num b{font-weight:400;font-size:64px;display:block;line-height:1}
.big p{margin:0;max-width:44ch}
.cmp{display:grid;gap:12px;border:2px solid var(--ink);padding:24px;align-content:center}
.bar{display:grid;gap:6px}
.bar .lab{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
.track{height:28px;position:relative}
.track i{position:absolute;inset:0 auto 0 0;display:block;background:var(--ink)}
.track.dith i{-webkit-mask-image:var(--d50);mask-image:var(--d50);-webkit-mask-size:4px 4px;mask-size:4px 4px;image-rendering:pixelated}
.track::before{content:"";position:absolute;inset:0;background:var(--ink);-webkit-mask-image:var(--d12);mask-image:var(--d12);-webkit-mask-size:8px 8px;mask-size:8px 8px}
.track i{z-index:1}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;border:2px solid var(--ink)}
.stat{padding:16px;display:grid;gap:8px;border-left:2px solid var(--ink)}
.stat:first-child{border-left:0}
.stat .v{font-size:var(--px2)}
.stat .l{font-size:13px;line-height:1.35}
.chart{border:2px solid var(--ink);padding:16px 16px 8px}
svg{display:block;width:100%;height:auto;overflow:visible}
svg text{font:400 12px "Atkinson Hyperlegible Mono",monospace;fill:var(--ink)}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:start}
.cols>div{display:grid;gap:16px}
.ws{display:grid;gap:12px}
.ws .row{display:grid;gap:6px}
.ws .row .name{display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap}
.ws .row .name .plate{background:var(--c);color:var(--on)}
.ws .track i{background:var(--c)}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font:400 var(--px)/1 Silkscreen,monospace;text-transform:uppercase;padding:8px;background:var(--ink);color:var(--paper);white-space:nowrap}
td{padding:8px;border-bottom:1px solid var(--ink);vertical-align:top}
td.n,th.n{text-align:right;font-family:"Atkinson Hyperlegible Mono",monospace}
td .sw{display:inline-block;width:12px;height:12px;background:var(--c);margin-right:6px;vertical-align:-1px}
.wins{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.win{border:2px solid var(--ink);display:grid;align-content:start}
.win .hd{display:flex;justify-content:space-between;gap:8px;padding:8px 12px;background:var(--c);color:var(--on);flex-wrap:wrap}
.win .bd{padding:12px;display:grid;gap:8px}
.win .bd .t{font-weight:600}
.win .bd .s{font-size:13px;line-height:1.45;margin:0}
.ctx{border:1px solid var(--ink);padding:12px;font-size:13px;line-height:1.5}
.ctx ul{margin:0;padding-left:20px;display:grid;gap:4px}
footer{border-top:2px solid var(--ink);padding:16px 0 32px}
footer p{margin:0;font-size:13px}
.empty{border:2px dashed var(--ink);padding:24px}
@media (max-width:820px){.hero,.cols,.wins{grid-template-columns:1fr}.stats{grid-template-columns:1fr 1fr}.stat:nth-child(3){border-left:0}.stat:nth-child(n+3){border-top:2px solid var(--ink)}.big .num b{font-size:48px}}
@media print{header.shell{-webkit-print-color-adjust:exact;print-color-adjust:exact}.win,.chart,.big,.cmp,.stats{break-inside:avoid}}
`;

function dailyChart(d, month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  const byDay = new Map(d.daily.map(x => [x.date, x]));
  const days = Array.from({ length: last }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
  const max = Math.max(1, ...d.daily.map(x => x.humanHours));
  const W = 1000, H = 220, pad = { l: 0, r: 0, t: 22, b: 24 }, bw = (W - pad.l - pad.r) / days.length;
  const today = dayOf(new Date().toISOString());
  const peak = d.daily.reduce((a, b) => (b.humanHours > a.humanHours ? b : a), d.daily[0] || { humanHours: 0 });
  const bars = days.map((date, i) => {
    const v = byDay.get(date)?.humanHours || 0, h = (H - pad.t - pad.b) * v / max, x = pad.l + i * bw;
    const future = date > today;
    return `<g><title>${esc(day(date))}: ${v} h of people work, ${byDay.get(date)?.tasks || 0} tasks</title>`
      + (future ? '' : `<rect x="${x + 2}" y="${H - pad.b - Math.max(h, v ? 2 : 0)}" width="${Math.max(bw - 4, 2)}" height="${Math.max(h, v ? 2 : 0)}" fill="var(--ink)"/>`
      + (v ? '' : `<rect x="${x + 2}" y="${H - pad.b - 2}" width="${Math.max(bw - 4, 2)}" height="2" fill="var(--ink)" opacity=".35"/>`))
      + ((i + 1) % 5 === 0 || i === 0 || i === days.length - 1 ? `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${i + 1}</text>` : '') + '</g>';
  }).join('');
  const pk = peak.humanHours ? (() => { const i = days.indexOf(peak.date), x = pad.l + i * bw + bw / 2; return `<text x="${Math.min(Math.max(x, 60), W - 60)}" y="12" text-anchor="middle" font-weight="700">${esc(day(peak.date))} · ${peak.humanHours} h</text>`; })() : '';
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="People-hours of work done per day in ${esc(monthName(month))}">`
    + `<line x1="0" x2="${W}" y1="${H - pad.b}" y2="${H - pad.b}" stroke="var(--ink)" stroke-width="2"/>${bars}${pk}</svg>`;
}

/** Each agent's work against a VA doing it: two bars per role (what a person would cost, what the agent cost). */
function vsVa(d) {
  if (!d.agents.length) return '';
  const max = Math.max(1, ...d.agents.map(a => a.humanCost), ...d.agents.map(a => a.apiCost));
  return `<section><h2 class="px">Each agent vs hiring a VA</h2>${d.agents.map(a => { const [c] = ink(a.ws); return `<div class="bar" style="--c:${c};margin-bottom:14px"><div class="lab"><span><b>${esc(a.name)}</b> <span class="data">${esc(a.workspace)} · ${a.tasks} task${a.tasks === 1 ? '' : 's'}</span></span></div>`
    + `<div class="lab"><span class="data">A VA would cost</span><b class="data">${money(a.humanCost)}</b></div><div class="track dith"><i style="width:${Math.max(a.humanCost / max * 100, a.humanCost ? 0.8 : 0)}%"></i></div>`
    + `<div class="lab"><span class="data">The agent cost</span><b class="data">${money(a.apiCost)}</b></div><div class="track"><i style="width:${Math.max(a.apiCost / max * 100, a.apiCost ? 0.8 : 0)}%"></i></div></div>`; }).join('')}</section>`;
}

/** The report for a month as HTML. `compare` is the month before it, when it had work. */
export function renderMonthly(month, d, prev) {
  const t = d.totals, name = monthName(month), partial = month === thisMonth();
  const upTo = d.daily.length ? day(d.daily[d.daily.length - 1].date) : null;
  const span = partial ? `Month to date${upTo ? `, up to ${upTo}` : ''}` : `${day(month + '-01')} – ${day(`${month}-${String(new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate()).padStart(2, '0')}`)}`;
  const maxCost = Math.max(t.humanCost, t.apiCost, 1);
  const delta = prev && prev.totals.tasks ? (cur, old, fmt) => { const p = old ? Math.round((cur - old) / old * 100) : null; return p === null ? '' : `${p >= 0 ? '▲' : '▼'} ${Math.abs(p)}% on ${monthName(prevMonth(month)).split(' ')[0]} (${fmt(old)})`; } : () => '';
  const stat = (v, l, extra) => `<div class="stat"><div class="px2 v">${v}</div><div class="l">${l}${extra ? `<br><span class="data">${extra}</span>` : ''}</div></div>`;
  const spaceMax = Math.max(1, ...d.workspaces.map(w => w.humanHours));

  const body = !t.tasks ? `<div class="empty"><div class="px">Nothing finished</div><p>No agent finished a task in ${esc(name)}.</p></div>` : `
  <section aria-label="The month in one line"><div class="hero">
    <div class="big"><span class="px">Saved this ${partial ? 'month so far' : 'month'}</span>
      <div class="num"><b>${money(t.saved)}</b></div>
      <p>The agents did about <b>${t.humanHours} hours</b> of work (${t.fteWeeks} full-time weeks) that people would bill at ${money(t.humanCost)}. They cost ${money(t.apiCost)} in Claude use${t.times ? `, ${t.times}x cheaper` : ''}.</p>
      ${delta(t.saved, prev?.totals.saved, money) ? `<span class="plate px">${esc(delta(t.saved, prev?.totals.saved, money))}</span>` : ''}</div>
    <div class="cmp" role="img" aria-label="People would cost ${money(t.humanCost)}; the agents cost ${money(t.apiCost)}">
      <div class="bar"><div class="lab"><span class="px">People would cost</span><b class="data">${money(t.humanCost)}</b></div><div class="track dith"><i style="width:${t.humanCost / maxCost * 100}%"></i></div></div>
      <div class="bar"><div class="lab"><span class="px">Agents cost</span><b class="data">${money(t.apiCost)}</b></div><div class="track"><i style="width:${Math.max(t.apiCost / maxCost * 100, 0.8)}%"></i></div></div>
      <span class="data" style="font-size:12.5px">Agents worked ${t.agentHours} h by the clock.</span></div>
  </div>
  <div class="stats">
    ${stat(t.tasks, 'tasks finished', delta(t.tasks, prev?.totals.tasks, String))}
    ${stat(t.done, `done in full${t.partial ? `, ${t.partial} partly` : ''}${t.notDone ? `, ${t.notDone} not done` : ''}`, `${Math.round(t.done / t.tasks * 100)}% done in full`)}
    ${stat(t.humanHours + ' h', 'of people-work covered', delta(t.humanHours, prev?.totals.humanHours, v => v + ' h'))}
    ${stat(t.times ? t.times + 'x' : '–', 'cheaper than people', `$${(t.apiCost / t.tasks).toFixed(2)} per task`)}
  </div></section>

  <section><h2 class="px">Day by day</h2><div class="chart">${dailyChart(d, month)}</div>
    <span class="data" style="font-size:12.5px">Hours of people-work covered by the tasks that finished each day.</span></section>

  <section class="cols">
    <div class="ws"><h2 class="px">By client workspace</h2>${d.workspaces.map(w => { const [c, on] = ink(w.ws); return `<div class="row" style="--c:${c};--on:${on}"><div class="name"><span class="plate px">${esc(w.name)}</span><span class="data">${w.humanHours} h · ${money(w.humanCost)}</span></div><div class="track"><i style="width:${w.humanHours / spaceMax * 100}%"></i></div><span class="data" style="font-size:12.5px">${w.done}/${w.tasks} done · agents cost ${money(w.apiCost)}</span></div>`; }).join('')}</div>
    <div><h2 class="px">By role</h2><table><thead><tr><th>Role</th><th class="n">Done</th><th class="n">Hours</th><th class="n">Worth</th></tr></thead><tbody>${d.agents.slice(0, 8).map(a => { const [c] = ink(a.ws); return `<tr style="--c:${c}"><td><span class="sw"></span><b>${esc(a.name)}</b><br><span style="font-size:12px">${esc(a.workspace)}</span></td><td class="n">${a.done}/${a.tasks}</td><td class="n">${a.humanHours}</td><td class="n">${money(a.humanCost)}</td></tr>`; }).join('')}</tbody></table></div>
  </section>

  ${vsVa(d)}`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Orchy · Impact · ${esc(name)}</title><style>${font('Silkscreen-400.woff2', 'Silkscreen', 400)}${font('AtkinsonHyperlegibleNext.woff2', 'Atkinson Hyperlegible Next', '200 800')}${font('AtkinsonHyperlegibleMono.woff2', 'Atkinson Hyperlegible Mono', '200 800')}${CSS}</style></head><body>
<header class="shell"><div class="wrap"><div class="top"><span class="plate px">Orchy · Monthly impact</span><span class="plate px ${partial ? 'decide' : ''}">${partial ? 'Sample · month to date' : 'Final'}</span></div>
<h1 class="px2">${esc(name)}</h1><p>${esc(span)}. What the agents finished, and what the same work would have cost with people doing it.</p></div></header>
<main class="wrap">${body}
<section><h2 class="px">How this is worked out</h2><div class="ctx"><ul>${d.assumptions.map(a => `<li>${esc(a)}</li>`).join('')}</ul></div></section></main>
<footer class="wrap"><p class="data">Written by Orchy on ${esc(dayOf(new Date().toISOString()))}. An estimate, not an invoice. Change the hourly cost and speed-up in Orchy's Impact window and ask for this month again.</p></footer>
</body></html>`;
}

/** Write (or rewrite) a month's report. `month` is YYYY-MM; the default is last month. */
export function writeMonthly(month = prevMonth(thisMonth()), opts = {}) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw Object.assign(new Error('Month should look like 2026-10'), { status: 400 });
  const d = impact({ month, ...opts }), prev = impact({ month: prevMonth(month), ...opts });
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const file = `impact-${month}.html`;
  fs.writeFileSync(path.join(REPORTS_DIR, file), renderMonthly(month, d, prev));
  return { month, file, url: `/reports/${file}`, partial: month === thisMonth(), totals: d.totals };
}

/** The reports written so far, newest first. */
export function listMonthly() {
  if (!fs.existsSync(REPORTS_DIR)) return [];
  return fs.readdirSync(REPORTS_DIR).map(f => f.match(/^impact-(\d{4}-\d{2})\.html$/)).filter(Boolean)
    .map(m => ({ month: m[1], file: m[0], url: `/reports/${m[0]}`, written: fs.statSync(path.join(REPORTS_DIR, m[0])).mtime.toISOString() }))
    .sort((a, b) => (a.month < b.month ? 1 : -1));
}

/** On the 1st (or whenever Orchy wakes up and last month has none) write last month's report and say so. */
export function startMonthly({ onWritten, onError }) {
  const tick = () => {
    try {
      const month = prevMonth(thisMonth());
      if (fs.existsSync(path.join(REPORTS_DIR, `impact-${month}.html`)) || !impact({ month }).totals.tasks) return;
      onWritten?.(writeMonthly(month));
    } catch (e) { onError?.(e); }
  };
  setInterval(tick, 6 * 3600_000).unref();
  setTimeout(tick, 30_000).unref();
}
