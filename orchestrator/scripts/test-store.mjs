// Files Orchy reads from disk, and what the dashboard API hands out of them, with no network:
//   node orchestrator/scripts/test-store.mjs
// A byte-order mark (Notepad) is fine, a corrupt file is kept aside instead of wiped, MCP keys stay hidden from
// a browser the owner hasn't paired, and One's app list is asked in each workspace's own folder.
// Works in a throwaway temp folder; reads (never writes) orchestrator/data/state.json on import.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, parseEnv } from '../lib/env.mjs';
import { loadState } from '../lib/store.mjs';
import { listPlatforms, platformBlurbs } from '../lib/one.mjs';
import { readMcp, upsertMcp, removeMcp, hideMcp, unhideMcp, HIDDEN } from '../lib/workspaces.mjs';

let fail = 0;
const ok = (cond, label, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : `  ${extra}`}`); if (!cond) fail++; };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orchy-store-'));
const BOM = '\uFEFF';
const quiet = fn => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

// ── a leading BOM ──
{
  const f = path.join(TMP, 'config.json');
  fs.writeFileSync(f, `${BOM}{"owner":{"name":"Sam"},"workspaces":[]}`);
  ok(readJson(f).owner.name === 'Sam', 'a JSON file saved with a BOM parses');
  ok(parseEnv(`${BOM}PORT=8010\r\nNAME="x"\r\n`).PORT === '8010', 'a .env saved with a BOM keeps its first key');
}

// ── state.json: missing, BOM, corrupt ──
{
  const f = path.join(TMP, 'state.json');
  ok(Array.isArray(loadState(f).chat) && !fs.existsSync(f), 'no state.json: a fresh start, nothing written');
  fs.writeFileSync(f, `${BOM}${JSON.stringify({ chat: [{ id: 'm1' }] })}`);
  const s = loadState(f);
  ok(s.chat[0]?.id === 'm1' && s.runs && s.settings, 'state.json with a BOM loads, missing parts filled in');
  const bad = '{"runs": {"r1": {"id": "r1"}}, "chat": [';
  fs.writeFileSync(f, bad);
  const fresh = quiet(() => loadState(f));
  const kept = fs.readdirSync(TMP).filter(n => n.startsWith('state.json.corrupt-'));
  ok(fresh.chat.length === 0 && Object.keys(fresh.runs).length === 0, 'a corrupt state.json: Orchy starts fresh');
  ok(!fs.existsSync(f), 'the corrupt file is moved out of the way, so a save writes a new one');
  ok(kept.length === 1 && fs.readFileSync(path.join(TMP, kept[0]), 'utf8') === bad, 'the corrupt file is kept, unchanged', kept.join(','));
  fs.writeFileSync(f, '[1,2]');
  quiet(() => loadState(f));
  ok(!fs.existsSync(f) && fs.readdirSync(TMP).filter(n => n.startsWith('state.json.corrupt-')).length >= 1, 'JSON that isn’t an object is set aside too');
  let warned = '';
  const w = console.warn; console.warn = m => { warned += m; };
  fs.writeFileSync(f, 'not json');
  loadState(f);
  console.warn = w;
  ok(/state\.json couldn't be read/.test(warned) && /corrupt-/.test(warned), 'the terminal says what happened and where the file went', warned);
}

// ── MCP servers: BOM, corrupt file, hidden keys ──
{
  const ws = { id: 't', name: 'Test', dir: path.join(TMP, 'ws') };
  const file = path.join(ws.dir, '.jos', 'mcp.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const saved = {
    gh: { type: 'stdio', description: 'GitHub', enabled: true, command: 'npx', args: ['-y', '@modelcontextprotocol/server-github', '--api-key', 'abc', '--token=xyz', 'sk-live-0123456789abcdef', 'API_SECRET=s3'], env: { GITHUB_TOKEN: 'ghp_aaaaaaaaaaaaaaaaaaaa', MODE: 'prod' } },
    web: { type: 'http', description: '', enabled: true, url: 'https://user:pw@mcp.example.com/v1/a1b2c3d4e5f6a7b8c9d0e1f2a3b4/mcp?api_key=k123&team=blue', headers: { Authorization: 'Bearer hdrval9' } },
  };
  fs.writeFileSync(file, `${BOM}${JSON.stringify({ servers: saved })}`);
  ok(readMcp(ws).gh?.command === 'npx', 'mcp.json saved with a BOM is read');

  const shown = hideMcp(readMcp(ws));
  const text = JSON.stringify(shown);
  const leaks = ['abc', 'xyz', 'sk-live-0123456789abcdef', 's3', 'ghp_aaaaaaaaaaaaaaaaaaaa', 'prod', ':pw@', 'k123', 'hdrval9', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4'].filter(v => text.includes(v));
  ok(!leaks.length, 'nothing secret shows to an unpaired browser', leaks.join(', '));
  ok(shown.gh.command === 'npx' && shown.gh.args.length === saved.gh.args.length && shown.gh.args.every(a => a === HIDDEN), 'the program shows, every argument is hidden (test-mcp-hide.mjs has the rest)');
  ok(Object.keys(shown.gh.env).join() === 'GITHUB_TOKEN,MODE' && shown.web.headers.Authorization === HIDDEN, 'env and header names show, their values don’t');
  ok(shown.web.url === `https://${HIDDEN}@mcp.example.com/${HIDDEN}`, 'the URL keeps its scheme and host only', shown.web.url);

  // keys in the shapes people paste: a header after --header, short keys after any flag, JSON, a whole command line
  const more = {
    remote: { type: 'stdio', command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.example.com/sse', '--header', 'Authorization: Bearer abc123SECRETtokenvalue'] },
    remote2: { type: 'stdio', command: 'npx', args: ['mcp-remote', 'https://x.io', '--header=Authorization:Bearer sk_live_zzzzzzzzzzzz', '--header', 'X-Api-Key:plainkey77'] },
    short: { type: 'stdio', command: 'node', args: ['server.js', '-p', 'Sup3rS3cretPw!', '-k', 'f3a9c2d81b7e4', '--headers', '{"X-API-Key":"plainsecretvalue"}'] },
    cmd: { type: 'stdio', command: 'node server.js --api-key "sk-live-12345678abcdef" -s hunter2pw', args: [] },
    urls: { type: 'stdio', command: 'x', args: ['https://api.example.com/mcp/u/abcd1234efgh5678', 'https://api.example.com/mcp#token=abcdef', 'https://h.io/x#access_token=zz9&s=1'] },
    plain: { type: 'stdio', command: 'C:\\Program Files\\nodejs\\node.exe', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\me\\Documents', '--port', '3000', '--transport', 'stdio', '-e', 'GITHUB_TOKEN', '--config', 'mcp.json'] },
  };
  const hid = hideMcp(more), htext = JSON.stringify(hid);
  const leaked = ['abc123SECRETtokenvalue', 'sk_live_zzzzzzzzzzzz', 'plainkey77', 'Sup3rS3cretPw!', 'f3a9c2d81b7e4', 'plainsecretvalue', 'sk-live-12345678abcdef', 'hunter2pw', 'abcd1234efgh5678', 'abcdef', 'zz9'].filter(v => htext.includes(v));
  ok(!leaked.length, 'headers, short keys after a flag, JSON, a typed command line and URL ids/fragments are hidden', leaked.join(', '));
  ok(hid.cmd.command === `node ${HIDDEN}`, 'a command typed as one line shows its program only', hid.cmd.command);
  ok(hid.plain.command === `C:\\Program ${HIDDEN}` && hid.plain.args.length === more.plain.args.length && hid.plain.args.every(a => a === HIDDEN), 'paths, packages, ports and plain words are hidden too, and a path with a space shows up to it unless quoted: nothing is guessed', JSON.stringify(hid.plain));
  ok(Object.entries(more).every(([n, s]) => JSON.stringify(unhideMcp(hid[n], s)) === JSON.stringify(s)), 'each of them sent back as shown keeps the saved values');
  ok(throws(() => unhideMcp(hid.cmd, more.short), /hidden/), 'a hidden command with nothing saved behind it is refused');

  // keys with a marker the name heuristics used to miss: short query names, Bearer <value>, a connection string, -t
  const marked = {
    q: { type: 'http', url: 'https://mcp.example.com/sse?pass=hunter2&p=hunter22&sig=abc&mode=fast&port=8080', headers: {} },
    bare: { type: 'http', url: 'https://mcp.example.com/u/hunter3xyz/sse?zq9secret1', headers: {} },
    bearer: { type: 'stdio', command: 'node', args: ['server.js', 'Bearer abc123', 'token', 'tok456'] },
    conn: { type: 'stdio', command: 'node', args: ['server.js', 'Server=db1;User Id=sa;Password=hunter4', 'a=1&pw=hunter5'] },
    tflag: { type: 'stdio', command: 'node', args: ['server.js', '-t', 'abc789'], token: 'topleveltok', apiKey: 'k1' },
    line: { type: 'stdio', command: 'node server.js Bearer xyz321', args: [] },
  };
  const mh = hideMcp(marked), mtext = JSON.stringify(mh);
  const mleaked = ['hunter2', 'hunter22', 'sig=abc', 'hunter3xyz', 'zq9secret1', 'abc123', 'tok456', 'hunter4', 'hunter5', 'abc789', 'topleveltok', '"k1"', 'xyz321'].filter(v => mtext.includes(v));
  ok(!mleaked.length, 'pass=/p=/sig= in a URL, Bearer <value>, token <value>, Password= in a connection string, -t <value> and stray key fields are hidden', mleaked.join(', '));
  ok(mh.q.url === `https://mcp.example.com/${HIDDEN}` && mh.tflag.token === HIDDEN && mh.tflag.apiKey === HIDDEN && mh.line.command === `node ${HIDDEN}`, 'a URL past its host, stray key fields and a command line past its program are hidden', mtext);
  ok(['q', 'bare', 'bearer', 'conn', 'line'].every(n => JSON.stringify(unhideMcp(mh[n], marked[n])) === JSON.stringify(marked[n])), 'each of them sent back as shown keeps the saved values');

  // the form sent back as it was shown keeps the saved values
  ok(JSON.stringify(unhideMcp(shown.gh, saved.gh)) === JSON.stringify(saved.gh), 'saving the hidden form unchanged keeps every saved value');
  ok(unhideMcp({ ...shown.web, headers: { Authorization: 'Bearer new' } }, saved.web).url === saved.web.url, 'a changed header saves, the hidden URL stays the saved one');
  ok(throws(() => unhideMcp({ type: 'stdio', command: 'x', env: { NEW_KEY: HIDDEN } }, saved.gh), /hidden/), 'a hidden value with nothing saved behind it is refused, never written');
  upsertMcp(ws, 'gh', { ...shown.gh, description: 'GitHub (edited)' });
  ok(readMcp(ws).gh.env.GITHUB_TOKEN === saved.gh.env.GITHUB_TOKEN && readMcp(ws).gh.description === 'GitHub (edited)', 'upsert through the hidden form writes the real key back, not the dots');

  // a corrupt mcp.json is kept aside before a change, not overwritten with just the new server
  fs.writeFileSync(file, '{"servers": {"gh": ');
  quiet(() => upsertMcp(ws, 'new', { type: 'stdio', command: 'node', args: ['x.js'] }));
  const aside = fs.readdirSync(path.dirname(file)).filter(n => n.startsWith('mcp.json.corrupt-'));
  ok(aside.length === 1 && readMcp(ws).new?.command === 'node', 'a corrupt mcp.json is kept aside, then the change is saved');
  fs.writeFileSync(file, 'garbage');
  quiet(() => removeMcp(ws, 'new'));
  ok(fs.readdirSync(path.dirname(file)).filter(n => n.startsWith('mcp.json.corrupt-')).length === 2, 'removing a server keeps a corrupt file aside too');
}

// ── One's app list: asked in the workspace's own folder, kept per folder ──
{
  const a = path.join(TMP, 'Alpha'), b = path.join(TMP, 'Beta');
  const calls = [];
  const fake = (args, { cwd }) => { calls.push({ args, cwd }); return Promise.resolve({ platforms: [{ platform: cwd === a ? 'gmail' : 'slack', title: cwd === a ? 'Gmail' : 'Slack', description: 'Does things. More.', active: true }] }); };
  const la = await listPlatforms(a, { oneFn: fake, persist: false });
  ok(calls.length === 1 && calls[0].cwd === a && calls[0].args[0] === 'platforms', 'the list is asked in that workspace’s folder', JSON.stringify(calls));
  ok(la[0]?.platform === 'gmail' && la[0].about === 'Does things.', 'the list comes back trimmed to what the dashboard needs');
  const lb = await listPlatforms(b, { oneFn: fake, persist: false });
  ok(calls.length === 2 && calls[1].cwd === b && lb[0]?.platform === 'slack', 'another workspace gets its own list from its own folder, never the first one’s copy');
  await listPlatforms(a, { oneFn: fake, persist: false });
  ok(calls.length === 2, 'a workspace’s list is kept for a day');
  ok(platformBlurbs(a).gmail === 'Does things.' && !platformBlurbs(a).slack, 'blurbs for a workspace come from its own list only');
  let err = '';
  try { await listPlatforms(undefined, { oneFn: fake, persist: false }); } catch (e) { err = e.message; }
  ok(/workspace folder/.test(err) && calls.length === 2, 'no folder: One isn’t asked at all (it would fall back to Orchy’s own login)');

  // One exiting 0 with an error, with text, or with an empty list: an error to show, never an empty list kept for a day
  const c = path.join(TMP, 'Gamma');
  let n = 0;
  const replies = [{ error: { message: 'Not signed in' } }, { raw: 'Something went wrong' }, { platforms: [] }, { platforms: [{ platform: 'notion', title: 'Notion' }] }];
  const flaky = () => Promise.resolve(replies[n++]);
  const errs = [];
  for (let i = 0; i < 3; i++) { try { await listPlatforms(c, { oneFn: flaky, persist: false }); errs.push(''); } catch (e) { errs.push(e.message); } }
  ok(/Not signed in/.test(errs[0]) && /Something went wrong/.test(errs[1]) && /empty/.test(errs[2]), 'an error, text or an empty list from One comes back as an error', JSON.stringify(errs));
  const lc = await listPlatforms(c, { oneFn: flaky, persist: false });
  ok(n === 4 && lc[0]?.platform === 'notion', 'none of them was kept: the next ask goes to One again');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(fail ? `\n${fail} failed` : '\nall store checks passed');
process.exit(fail ? 1 : 0);
