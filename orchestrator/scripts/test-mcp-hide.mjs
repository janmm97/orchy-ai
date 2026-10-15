// What a browser the owner hasn't paired sees of a workspace's MCP servers, with no network:
//   node orchestrator/scripts/test-mcp-hide.mjs
// Nothing is guessed from names or shapes (lib/workspaces.mjs hideMcp): every env and header value, every argument,
// whatever follows the program, a URL past its host and every field the panel doesn't draw with is hidden. The
// owner's paired browser (lib/owner.mjs) gets every value, and a form sent back as it was shown keeps the saved ones.
// Works in a throwaway temp folder; reads (never writes) orchestrator/data/ on import.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as owner from '../lib/owner.mjs';
import { readMcp, upsertMcp, hideMcp, shownMcp, unhideMcp, mcpListing, allConnections, HIDDEN } from '../lib/workspaces.mjs';

let fail = 0;
const ok = (cond, label, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : `  ${extra}`}`); if (!cond) fail++; };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orchy-mcp-'));
const PORT = 8008;
owner.useFile(path.join(TMP, 'owner-browsers.json'));

// the shapes the old name-and-shape guessing let through, and some it never saw
const saved = {
  mysql: { type: 'stdio', description: 'Orders database', enabled: true, command: 'docker', args: ['run', '-i', '--rm', 'mysql-mcp', 'mysql', '-pSecret', '-uroot'], env: { MYSQL_HOST: 'db.internal' } },
  nested: { type: 'stdio', command: 'node', args: ['server.js'], env: { OPTS: { auth: { password: 'nestedVal1' } } }, options: { auth: { clientSecret: 'nestedVal2' } }, oauth: [{ refresh: 'nestedVal3' }] },
  odd: { type: 'stdio', command: 'uvx', args: ['odd-mcp'], sekrit: 'oddVal1', 'x-k': 'oddVal2', toString: 'oddVal3', constructor: 'oddVal4', cwd: '/home/oddVal5', enabled: 'oddVal6' },
  line: { type: 'stdio', command: 'API_KEY=lineVal1 node server.js --db postgres://u:lineVal2@h/db', args: [] },
  quoted: { type: 'stdio', command: String.raw`"C:\Program Files\nodejs\node.exe" server.js lineVal3`, args: [] },
  web: { type: 'http', description: '', enabled: true, url: 'https://urlVal0:urlVal1@mcp.example.com:8443/s/urlVal2/mcp?team=urlVal3#urlVal4', headers: { Authorization: 'Bearer hdrVal1', 'X-Team': 'hdrVal2' } },
  slash: { type: 'http', url: String.raw`https://u:urlVal5@host.example.com\urlVal6`, headers: {} },
  noscheme: { type: 'http', url: 'mcp.example.com/sse?key=urlVal7', headers: {} },
  str: 'npx odd-server --token strVal1',
  plain: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', String.raw`C:\Users\me\plainVal1`], env: { DEBUG: '1' } },
};
const LEAKS = ['-pSecret', 'db.internal', 'nestedVal', 'oddVal', 'lineVal', 'urlVal', 'hdrVal', 'strVal', 'server-filesystem', 'plainVal', 'Bearer'];
const leaksIn = o => { const t = JSON.stringify(o); return LEAKS.filter(v => t.includes(v)); };

const ws = { id: 't', name: 'Test', dir: path.join(TMP, 'ws') };
const file = path.join(ws.dir, '.jos', 'mcp.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify({ servers: saved }));

// ── an unpaired browser: names and shape, no value ──
{
  const shown = hideMcp(readMcp(ws));
  ok(!leaksIn(shown).length, 'no value reaches an unpaired browser', leaksIn(shown).join(', '));
  ok(same(Object.keys(shown), Object.keys(saved)), 'every server name shows');
  const m = shown.mysql;
  ok(m.type === 'stdio' && m.command === 'docker' && m.description === 'Orders database' && m.enabled === true, 'the type, the program, the description and on/off show', JSON.stringify(m));
  ok(m.args.length === saved.mysql.args.length && m.args.every(a => a === HIDDEN), 'every argument is hidden: mysql -pSecret, and a plain -i too', JSON.stringify(m.args));
  ok(same(m.env, { MYSQL_HOST: HIDDEN }), 'env names show, their values don’t');
  ok(shown.nested.env.OPTS === HIDDEN && shown.nested.options === HIDDEN && shown.nested.oauth === HIDDEN, 'a nested object is hidden whole, keys and all', JSON.stringify(shown.nested));
  ok(['sekrit', 'x-k', 'toString', 'constructor', 'cwd', 'enabled'].every(k => shown.odd[k] === HIDDEN), 'any other field is hidden whatever its name, and on/off that isn’t true or false', JSON.stringify(shown.odd));
  ok(shown.line.command === `${HIDDEN} ${HIDDEN}`, 'a command line that starts with KEY=value shows nothing', shown.line.command);
  ok(shown.quoted.command === String.raw`"C:\Program Files\nodejs\node.exe" ` + HIDDEN, 'a command line shows its program, quotes kept, and hides the rest', shown.quoted.command);
  const bare = hideMcp({ w: { type: 'stdio', command: String.raw`C:\Program Files\nodejs\node.exe`, args: [] } }).w.command;
  ok(bare === String.raw`C:\Program ` + HIDDEN, 'an unquoted path with a space reads like a command line: it shows up to the space', bare);
  ok(shown.web.url === `https://${HIDDEN}@mcp.example.com:8443/${HIDDEN}` && same(shown.web.headers, { Authorization: HIDDEN, 'X-Team': HIDDEN }), 'a URL keeps its scheme, host and port; header names show', shown.web.url);
  ok(shown.slash.url === `https://${HIDDEN}@host.example.com/${HIDDEN}`, 'a backslash ends the host too', shown.slash.url);
  ok(shown.noscheme.url === HIDDEN && shown.str === HIDDEN, 'a URL with no scheme and a server that is just a string are hidden whole');
  ok(same(shown.plain.args, [HIDDEN, HIDDEN, HIDDEN]) && same(shown.plain.env, { DEBUG: HIDDEN }), 'nothing shows just because it looks harmless');
  ok(same(hideMcp({ a: { type: 'stdio', command: 'npx' }, b: { type: 'http', url: 'https://mcp.example.com/' } }), { a: { type: 'stdio', command: 'npx' }, b: { type: 'http', url: 'https://mcp.example.com/' } }), 'a server with nothing to hide shows as it is');
}

// ── a whole command line in quotes is not a program: only a path with spaces in its folder names shows ──
{
  const cmd = c => hideMcp({ s: { type: 'stdio', command: c, args: [] } }).s.command;
  const lines = {
    '"node server.js --api-key cmdVal1"': HIDDEN,
    "'python -m mcp_server --token cmdVal2'": HIDDEN,
    '"npx -y mcp --token cmdVal3" x': `${HIDDEN} ${HIDDEN}`,
    '"node --api-key=cmdVal4"': HIDDEN,
    '"/usr/bin/env node cmdVal5"': HIDDEN,
    [String.raw`"C:\Program Files\nodejs\node.exe --key cmdVal6"`]: HIDDEN,
    '"/usr/bin/node cmdVal7 /srv/server.js"': HIDDEN,
    '"node cmdVal8 C:/srv/server.js"': HIDDEN,
    '-pcmdVal9': HIDDEN,
    "'--token' cmdVal10": `${HIDDEN} ${HIDDEN}`,
  };
  for (const [c, want] of Object.entries(lines)) ok(cmd(c) === want, `${c} shows as ${want}`, cmd(c));
  const paths = [String.raw`"C:\Program Files (x86)\Tools\run.exe"`, "'/Applications/My App.app/Contents/MacOS/run'", '"~/my tools/bin/server"', String.raw`"\\host\share\Mcp Servers\srv.cmd"`];
  for (const p of paths) ok(cmd(`${p} --key pathVal1`) === `${p} ${HIDDEN}`, `${p} is a path: it shows, what follows doesn't`, cmd(`${p} --key pathVal1`));
  const all = Object.fromEntries([...Object.keys(lines), ...paths].map((c, i) => [`c${i}`, { type: 'stdio', command: c, args: [] }]));
  const hidden = hideMcp(all);
  ok(Object.entries(all).every(([n, s]) => same(unhideMcp(hidden[n], s), s)), 'each of them sent back as shown keeps the saved command');
}

// ── the connection lists any browser reads (GET /api/workspaces/:ws, …/connections, the inbox): the same fields, hidden the same way ──
{
  const lws = { id: 'l', name: 'List', dir: path.join(TMP, 'list') };
  fs.mkdirSync(path.join(lws.dir, '.jos'), { recursive: true });
  const servers = {
    mysql: saved.mysql,
    odd: { type: { t: 'listVal1' }, command: 'node', enabled: 'listVal2', description: { k: 'listVal3' }, token: 'listVal4' },
    long: { type: 'fake_key_listVal5abcdefghijklmnopqrstuvwxyz', url: 'https://u:listVal6@h.example.com/', enabled: 0 },
    bare: { command: 'node' },
    str: 'npx odd-server --token listVal7',
    nul: null,
  };
  fs.writeFileSync(path.join(lws.dir, '.jos', 'mcp.json'), JSON.stringify({ servers }));
  const { mcp } = await allConnections(lws);
  const text = JSON.stringify(mcp);
  ok(!/listVal|-pSecret|db\.internal/.test(text), 'no value reaches the connection lists', text);
  ok(mcp.every(c => same(Object.keys(c), ['key', 'platform', 'name', 'description', 'type', 'enabled', 'source'])), 'each entry carries the listed fields only');
  const by = Object.fromEntries(mcp.map(c => [c.name, c]));
  ok(same(by.mysql, mcpListing('mysql', saved.mysql)) && by.mysql.description === 'Orders database' && by.mysql.type === 'stdio' && by.mysql.enabled === true, 'a normal server lists with its description, type and on/off', JSON.stringify(by.mysql));
  ok(by.odd.type === HIDDEN && by.odd.description === HIDDEN && by.long.type === HIDDEN, 'a type or description hideMcpServer hides is hidden here too', JSON.stringify([by.odd, by.long]));
  ok(by.odd.enabled === true && by.long.enabled === false && by.bare.enabled === false, 'on/off is true or false, as the engines read it', JSON.stringify(mcp.map(c => c.enabled)));
  ok(by.str.type === undefined && by.nul.enabled === false, 'a server that is a string or null lists by name only, and doesn’t break the list');
}

// ── who gets what: GET /api/workspaces/:ws/mcp answers shownMcp(servers, owner.isOwner(req)) ──
{
  const req = ({ cookie, key } = {}) => ({ headers: { 'user-agent': 'test', ...(cookie && { cookie }), ...(key !== undefined && { [owner.KEY_HEADER]: key }) } });
  const paired = owner.pair(owner.newPairCode(), req(), PORT);
  const cookie = paired.cookie.split(';')[0];
  const seenBy = r => shownMcp(readMcp(ws), owner.isOwner(r, PORT));
  ok(same(seenBy(req({ cookie, key: paired.key })), saved), 'the paired browser gets every value, so its edit form has the real ones');
  const others = { 'no cookie or key': req(), 'the cookie alone (any server on localhost gets it)': req({ cookie }), 'the key alone': req({ key: paired.key }), 'a wrong key': req({ cookie, key: `${paired.key}x` }) };
  for (const [who, r] of Object.entries(others)) ok(!leaksIn(seenBy(r)).length && same(seenBy(r), hideMcp(saved)), `${who}: values hidden`, leaksIn(seenBy(r)).join(', '));
}

// ── a form sent back as it was shown keeps the saved values; nothing hidden is ever written ──
{
  const shown = hideMcp(saved);
  for (const n of ['mysql', 'line', 'quoted', 'web', 'slash', 'noscheme', 'plain']) ok(same(unhideMcp(shown[n], saved[n]), saved[n]), `${n} sent back as shown keeps the saved values`, JSON.stringify(unhideMcp(shown[n], saved[n])));
  ok(same(unhideMcp(shown.nested, saved.nested).env, saved.nested.env), 'a hidden nested env value comes back as the saved one');
  const dropped = { ...shown.mysql, args: shown.mysql.args.slice(1) };
  const added = { ...shown.mysql, args: ['--verbose', ...shown.mysql.args] };
  ok(throws(() => unhideMcp(dropped, saved.mysql), /hidden/) && throws(() => unhideMcp(added, saved.mysql), /hidden/), 'hidden arguments with a line taken out or added are refused: which saved value goes where is unknown');
  ok(throws(() => unhideMcp({ ...shown.mysql, env: { NEW_KEY: HIDDEN } }, saved.mysql), /hidden/) && throws(() => unhideMcp(shown.mysql, undefined), /hidden/), 'a hidden value with nothing saved behind it is refused');
  const mine = unhideMcp({ type: 'stdio', command: 'node', args: ['other.js', '-pNew'], env: { MYSQL_HOST: 'db2' } }, saved.mysql);
  ok(mine.command === 'node' && same(mine.args, ['other.js', '-pNew']) && mine.env.MYSQL_HOST === 'db2', 'the owner’s own values are never swapped back for the saved ones', JSON.stringify(mine));
  ok(unhideMcp({ type: 'stdio', command: 'node' }, { type: 'stdio', command: String.raw`C:\tools\node.exe` }).command === 'node', 'a program changed to another is kept');

  upsertMcp(ws, 'mysql', { ...shown.mysql, description: 'Orders (edited)' });
  upsertMcp(ws, 'web', { ...shown.web, headers: { ...shown.web.headers, 'X-Team': 'blue' } });
  const after = readMcp(ws);
  ok(same(after.mysql.args, saved.mysql.args) && after.mysql.env.MYSQL_HOST === 'db.internal' && after.mysql.description === 'Orders (edited)', 'upsert through the hidden form writes the real arguments and env back, not the dots');
  ok(after.web.url === saved.web.url && after.web.headers.Authorization === saved.web.headers.Authorization && after.web.headers['X-Team'] === 'blue', 'the hidden URL and header stay the saved ones, the changed header saves');
  const before = fs.readFileSync(file, 'utf8');
  ok(throws(() => upsertMcp(ws, 'mysql', dropped), /hidden/) && fs.readFileSync(file, 'utf8') === before && !before.includes(HIDDEN), 'a refused save writes nothing, and no dots are ever on disk');
}

// ── changing, removing and testing a server are owner-only like every non-GET (server.mjs ownerOnly) ──
{
  const src = fs.readFileSync(fileURLToPath(new URL('../server.mjs', import.meta.url)), 'utf8');
  const lit = src.match(/^const OWNERLESS = \/(.+)\/;$/m)?.[1];
  const OWNERLESS = lit && new RegExp(lit);
  ok(!!OWNERLESS && /req\.method !== 'GET' && req\.method !== 'HEAD' && !OWNERLESS\.test\(pathname\)/.test(src), 'every request but GET and HEAD needs the paired browser, outside a short list');
  ok(OWNERLESS && !['/api/workspaces/acme/mcp/gh', '/api/workspaces/acme/mcp-test', '/api/workspaces/acme/mcp'].some(p => OWNERLESS.test(p)), 'no MCP route is on that list');
  const routes = [...src.matchAll(/^on\('(\w+)', '(\/api\/workspaces\/:ws\/mcp[^']*)'/gm)].map(m => `${m[1]} ${m[2]}`);
  ok(same(routes, ['GET /api/workspaces/:ws/mcp', 'PUT /api/workspaces/:ws/mcp/:name', 'DELETE /api/workspaces/:ws/mcp/:name', 'POST /api/workspaces/:ws/mcp-test']), 'the only GET is the list, which hides values from an unpaired browser', routes.join(', '));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(fail ? `\n${fail} failed` : '\nall MCP hiding checks passed');
process.exit(fail ? 1 : 0);
