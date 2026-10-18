// Checks that Orchy recognises the names the owner uses for workspaces ("for Alpha", "314", "Main")
// without confusing everyday words ("build one agent", "the main problem"). Run: node orchestrator/scripts/test-routing.mjs
import { namedTargets, offTarget, route, missionShape } from '../lib/router.mjs';

const wss = [
  { id: 'alpha', name: 'Alpha Studio', client: 'Alpha Studio Ltd', blurb: 'Support inbox and invoices.', aliases: ['Alp'] },
  { id: 'beta', name: 'Beta Labs', client: 'Beta Labs Inc', blurb: 'Lab notebooks and sample orders.', aliases: ['314'] },
  { id: 'main', name: 'Main', client: 'Main Street Bakery', blurb: 'Wholesale bread orders.', aliases: [] },
];

const cases = [
  ['Check the support inbox for Alpha', ['alpha']],
  ['for Alpha: summarise yesterday\'s payouts', ['alpha']],
  ['Alpha: check the inbox', ['alpha']],
  ['Alpha Studio, please draft a reply to Maria', ['alpha']],
  ['Can you look at Alpha\'s Slack?', ['alpha']],
  ['@alpha triage the inbox', ['alpha']],
  ['Pull the Alp invoices', ['alpha']],
  ['314 — log the new sample', ['beta']],
  ['send the cover letter for 314', ['beta']],
  ['@314 book the call', ['beta']],
  ['Beta Labs: draft my service offering page', ['beta']],
  ['add this to beta', ['beta']],
  ['Draft the newsletter for Main', ['main']],
  ['Main: check the inbox', ['main']],
  ['do this in main.', ['main']],
  ['Main Agent, please check the orders', ['main']],
  ['The main problem is the invoice', []],
  ['Our main goal is growth', []],
  ['Build one agent that triages email', []],
  ['One of the emails needs a reply', []],
  ['Do it in one go', []],
  ['I need this for one client', []],
  ['Pay the $314 invoice', []],
  ['Remind me in 2314 about it', []],
  ['Copy the Alpha report into 314', ['alpha', 'beta']],
  ['Text 314-555-0199', []],
  ['Archive the 2,314 old emails', []],
  ['Pay 314.50', []],
  ['Sales are up 314% this year', []],
  ['314: file the lab reports', ['beta']],
  ['Beta Labs needs the cover', ['beta']],
  ['Anything new in 314\'s inbox?', ['beta']],
  ['Do it for 314.', ['beta']],
];

let fail = 0;
for (const [text, want] of cases) {
  const got = namedTargets(text, wss);
  const ok = got.length === want.length && want.every(w => got.includes(w));
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${JSON.stringify(text)} → [${got.join(', ')}]${ok ? '' : ` (want [${want.join(', ')}])`}`);
}

// a switched-off workspace the owner names is left alone, but everyday words aren't its name
const off = [{ ...wss[0], enabled: false }, { id: 'acme', name: 'Acme Agent', client: 'Acme Corp', aliases: [], enabled: false }];
const offCases = [
  ['Build one agent that triages email', null],
  ['Alpha Studio: check the inbox', 'alpha'],
  ['ask acme agent for the report', 'acme'],
  ['Send the invoice to Acme Corp', 'acme'],
  ['Do it in one go', null],
];
for (const [text, want] of offCases) {
  const got = offTarget(text, off)?.id || null;
  if (got !== want) fail++;
  console.log(`${got === want ? 'ok  ' : 'FAIL'} switched off: ${JSON.stringify(text)} → ${got}${got === want ? '' : ` (want ${want})`}`);
}

// Jev down: the offline fallback picks a workspace from its client, name, aliases and blurb words
const down = async () => { throw new Error('Jev down'); };
const heuristicCases = [
  ['send the invoices to the customer', 'alpha'],
  ['review the lab notebooks', 'beta'],
  ['reorder the flour for Main Street Bakery', 'main'],
  ['authorize the typical Facebook notebook sync', null],
];
for (const [text, want] of heuristicCases) {
  const got = (await route(text, { recent: [], ask: down, workspaces: wss.map(w => ({ ...w, runtime: 'claude', enabled: true })), agents: [] })).workspace;
  if (got !== want) fail++;
  console.log(`${got === want ? 'ok  ' : 'FAIL'} offline: ${JSON.stringify(text)} → ${got}${got === want ? '' : ` (want ${want})`}`);
}
// missions (router.mjs#missionShape): Jev's "mission" only stands when the words read as work in a row; one piece
// of work (or chat) never does, so ordinary messages can't become missions
const shapeCases = [
  ['Research the latest on AI agents and make a short PDF report', true],
  ['For Alpha: research the latest on AI agents this week, then have Ada turn it into a short designed PDF report', true],
  ['Find 10 podcasts, then have the designer make a one-pager pitching our studio', true],
  ['Research our three competitors and turn the findings into a slide deck', true],
  ['Pull last week’s signups, then write a summary for the newsletter', true],
  ['Scrape the pricing pages and, based on that, draft a comparison table', true],
  ['check the support inbox for Alpha', false],
  ['draft a reply to the supplier and send it', false],
  ['write a blog post about agents', false],
  ['summarise yesterday\'s payouts', false],
  ['check the inbox and reply to the supplier', false],
  ['make a PDF of the report', false],
  ['how are you doing today?', false],
  ['Then what happened with the invoice?', false],
];
for (const [text, want] of shapeCases) {
  const got = missionShape(text);
  if (got !== want) fail++;
  console.log(`${got === want ? 'ok  ' : 'FAIL'} mission shape: ${JSON.stringify(text)} → ${got}${got === want ? '' : ` (want ${want})`}`);
}
console.log(fail ? `\n${fail} failing` : `\nall ${cases.length + offCases.length + heuristicCases.length + shapeCases.length} pass`);
process.exit(fail ? 1 : 0);
