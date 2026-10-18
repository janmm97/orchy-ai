// Client pages get the file viewer and client video via Cloudflare R2, on temp folders:
// the fence (client A never reaches client B's files or the owner's workspace by id, path, "..", a junction, or guessing;
// a record whose run isn't theirs; a file swapped for a junction after it was registered), the scrubbed record
// (no workspace, absolute path, agent internals or R2 key), live events filtered per client, the R2-off state,
// the SigV4 signer against AWS's published S3 examples, presign expiry (≤ 15 min), the upload under the client's
// own prefix, and prefix/key guards. The real state.json is never touched (deps are swapped) and no network is used.
// Run: node orchestrator/scripts/test-clientviewer.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as A from '../lib/artifacts.mjs';
import * as CV from '../lib/clientview.mjs';
import * as R2 from '../lib/r2.mjs';
import { taskRootRel, taskRoot } from '../lib/clientspace.mjs';

let fail = 0;
const ok = (cond, label, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : `  ${extra}`}`); if (!cond) fail++; };
const status = fn => { try { fn(); return 200; } catch (e) { return e.status || 500; } };

// ── 1. the signer: AWS's published S3 SigV4 examples (docs: sig-v4-header-based-auth, sigv4-query-string-auth) ──
{
  const K = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', date: new Date('2013-05-24T00:00:00Z'), host: 'examplebucket.s3.amazonaws.com' };
  const p = R2.presign({ ...K, path: '/test.txt', expires: 86400 });
  ok(p.signature === 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404', 'presigned GET matches AWS example', p.signature);
  ok(p.url === 'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404', 'presigned URL is AWS example URL', p.url);
  const g = R2.signRequest({ ...K, path: '/test.txt', headers: { Range: 'bytes=0-9' }, payloadHash: R2.EMPTY_SHA256 });
  ok(g.signature === 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41', 'header-signed GET Object matches AWS example', g.signature);
  ok(g.headers.authorization === 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41', 'Authorization header as AWS example');
  const l = R2.signRequest({ ...K, path: '/', query: { 'max-keys': '2', prefix: 'J' }, payloadHash: R2.EMPTY_SHA256 });
  ok(l.signature === '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7', 'GET Bucket (list) matches AWS example', l.signature);
  const lc = R2.signRequest({ ...K, path: '/', query: { lifecycle: '' }, payloadHash: R2.EMPTY_SHA256 });
  ok(lc.signature === 'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543', 'GET Bucket lifecycle (empty query value) matches AWS example', lc.signature);
  ok(R2.enc("a b!'()*~") === 'a%20b%21%27%28%29%2A~', 'RFC 3986 encoding');
  ok(status(() => R2.presign({ ...K, path: '/x', expires: 0 })) === 500 && status(() => R2.presign({ ...K, path: '/x', expires: 604801 })) === 500, 'presign refuses expiry outside 1 s … 7 days');
}

// ── 2. presign expiry for clients: ≤ 15 minutes, whatever is asked ──
{
  const cfg = { host: '0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com', bucket: 'orchy-clients', accessKeyId: 'AK', secretAccessKey: 'SK', region: 'auto' };
  const now = new Date();
  const g = R2.presignGet(cfg, 'clients/northwind/art_0123456789abcdef/v1/play.mp4', { expires: 86400, date: now });
  const u = new URL(g.url);
  ok(Number(u.searchParams.get('X-Amz-Expires')) === R2.MAX_EXPIRES && R2.MAX_EXPIRES <= 900, 'a long expiry is cut to 15 min', u.searchParams.get('X-Amz-Expires'));
  ok(Date.parse(g.expiresAt) - now.getTime() <= 900_000, 'expiresAt within 15 min');
  const d = R2.presignGet(cfg, 'clients/northwind/art_0123456789abcdef/v1/play.mp4', { date: now });
  ok(Number(new URL(d.url).searchParams.get('X-Amz-Expires')) === R2.PLAY_EXPIRES && R2.PLAY_EXPIRES <= 900, 'default play link lives 10 min');
  ok(u.host === cfg.host && u.pathname === '/orchy-clients/clients/northwind/art_0123456789abcdef/v1/play.mp4', 'path-style R2 URL', u.href);
  ok(u.searchParams.get('X-Amz-Credential') === `AK/${R2.amzDate(now).slice(0, 8)}/auto/s3/aws4_request` && !g.url.includes('SK'), 'credential scope auto/s3; the secret never in the URL');
  const dl = R2.presignGet(cfg, 'clients/northwind/art_0123456789abcdef/v1/play.mp4', { download: 'Launch cut.mp4', date: now });
  ok(new URL(dl.url).searchParams.get('response-content-disposition') === "attachment; filename*=UTF-8''Launch%20cut.mp4", 'download link sets attachment');
  // an expired link is just an expired link: the signed date + expiry is in the past
  const old = R2.presignGet(cfg, 'clients/northwind/art_0123456789abcdef/v1/play.mp4', { date: new Date(Date.now() - 16 * 60_000) });
  ok(Date.parse(old.expiresAt) < Date.now(), 'a link signed 16 min ago has expired');
  ok(status(() => R2.keyFor('northwind', 'art_0123456789abcdef', 1, '../x')) === 500 && status(() => R2.keyFor('../b', 'art_0123456789abcdef', 1, 'x.mp4')) === 500 && status(() => R2.keyFor('northwind', 'art_x', 1, 'x.mp4')) === 500, 'keyFor refuses bad parts');
  ok(R2.clientPrefix('northwind') === 'clients/northwind/' && R2.clientPrefix('northwind', 'art_0123456789abcdef') === 'clients/northwind/art_0123456789abcdef/' && status(() => R2.clientPrefix('Northwind/..')) === 500, 'clientPrefix');
  let threw = 0;
  for (const p of ['', 'clients/', 'other/', 'clients/northwind', 'clients/northwind/../b/', 'clients/northwind/x/']) { try { await R2.deletePrefix(cfg, p); } catch { threw++; } }
  ok(threw === 6, 'deletePrefix only ever takes clients/<id>/[art_…/]', String(threw));
}

// ── fixtures: one workspace, two clients' sandboxes, the owner's own files ──
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orchy-clientviewer-test-')));
const W = path.join(tmp, 'wsA');
const put = (p, s = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); return p; };
const nwHome = path.join(W, '.clients', 'wsa-northwind'), fabHome = path.join(W, '.clients', 'wsa-fabrikam');
put(path.join(nwHome, 'Tasks', 'c1', 'TASK.md'), '# task');
put(path.join(nwHome, 'Tasks', 'c1', 'report.md'), '# Report\n![chart](chart.png)\n');
put(path.join(nwHome, 'Tasks', 'c1', 'chart.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
put(path.join(nwHome, 'Tasks', 'c1', 'files', 'brief.pdf'), '%PDF-1.4');
const nwVideo = put(path.join(nwHome, 'Tasks', 'c1', 'cut.mp4'), 'not really an mp4');
put(path.join(fabHome, 'Tasks', 'o1', 'secret.txt'), 'other client only');
const fabVideo = put(path.join(fabHome, 'Tasks', 'o1', 'theirs.mp4'), 'other video');
put(path.join(W, 'Tasks', 'j1', 'owner-plan.md'), 'owner only');
put(path.join(W, '.env'), 'SECRET=1');
put(path.join(W, 'CLAUDE.md'), 'map');
put(path.join(tmp, 'outside.txt'), 'outside');

const WS = { id: 'wsa', dir: W, name: 'WS A' };
const state = { runs: {}, artifacts: {} };
const events = [];
A.configure({ db: () => state, save: () => {}, emit: (type, data) => events.push({ type, ...data }), workspace: id => { if (id !== 'wsa') throw new Error('no ws'); return WS; }, workspaces: () => [WS], previewsDir: path.join(tmp, 'previews'), onRegistered: null, onDropped: null });
const playable = new Map(); // artifact id → file media.mjs would hand out for `play`
CV.configureClientView({ db: () => state, workspace: id => { if (id !== 'wsa') throw new Error('no ws'); return WS; }, mediaFile: (id, what) => (what === 'play' ? playable.get(id) || null : null) });

const t0 = new Date(Date.now() - 60_000).toISOString(), t1 = new Date().toISOString();
const run = (id, extra) => (state.runs[id] = { id, workspace: 'wsa', agentSlug: 'writer', agentName: 'Writer', startedAt: t0, endedAt: t1, outcome: 'completed', status: 'done', ...extra });
const rA = run('run_northwind', { client: 'wsa-northwind', taskDir: 'c1' });
const rB = run('run_fabrikam', { client: 'wsa-fabrikam', taskDir: 'o1' });
const rO = run('run_owner', { taskDir: 'j1' });
const NORTHWIND = { id: 'wsa-northwind', workspace: 'wsa', name: 'Northwind' }, FABRIKAM = { id: 'wsa-fabrikam', workspace: 'wsa', name: 'Fabrikam' };

// ── 3. what client A sees ──
const listA = CV.listFor(NORTHWIND, rA, { ended: true });
const names = listA.artifacts.map(a => a.name).sort();
ok(JSON.stringify(names) === JSON.stringify(['TASK.md', 'brief.pdf', 'chart.png', 'cut.mp4', 'report.md']), 'client A lists their own task files only', names.join(','));
const listB = CV.listFor(FABRIKAM, rB, { ended: true });
const idOf = (list, n) => list.artifacts.find(a => a.name === n)?.id;
const chartId = idOf(listA, 'chart.png'), videoId = idOf(listA, 'cut.mp4'), secretId = idOf(listB, 'secret.txt'), theirVideo = idOf(listB, 'theirs.mp4');
A.syncRun(rO, { ended: true });
const ownerId = Object.values(state.artifacts).find(a => a.name === 'owner-plan.md')?.id;
ok(chartId && secretId && ownerId && theirVideo, 'fixtures registered (northwind, fabrikam, owner)');
ok(status(() => CV.listFor(NORTHWIND, rB)) === 404 && status(() => CV.listFor(NORTHWIND, rO)) === 404, 'client A can’t list client B’s or the owner’s run');

// the record: scrubbed
const rec = listA.artifacts.find(a => a.name === 'report.md');
const blob = JSON.stringify(listA);
ok(rec.rel === 'Tasks/c1/report.md', 'rel is relative to their own folder', rec.rel);
ok(!blob.includes(tmp) && !blob.includes(tmp.replace(/\\/g, '/')) && !/[A-Za-z]:[\\/]/.test(blob), 'no absolute path anywhere');
ok(!blob.includes('.clients') && !blob.includes('wsa-fabrikam'), 'no sandbox layout or other client');
ok(['workspace', 'source', 'runIds', 'huddleId', 'agentSlug', 'mtime', 'stamp', 'client', 'mime'].every(k => !(k in rec)), 'no workspace, source, runIds, huddle, slug, stamps, mime');
ok(rec.runId === 'run_northwind' && rec.agentName === 'Writer' && rec.kind === 'markdown' && rec.version === 1 && rec.status === 'final', 'name, kind, version, status, own run');

// ── 4. the fence, by id ──
ok(status(() => CV.guard(NORTHWIND, chartId)) === 200, 'client A opens their own file');
ok(status(() => CV.guard(NORTHWIND, secretId)) === 404, 'client B’s artifact id → 404');
ok(status(() => CV.guard(NORTHWIND, theirVideo)) === 404 && status(() => CV.playFor(NORTHWIND, theirVideo)) === 404, 'client B’s video: no record, no play link');
ok(status(() => CV.guard(NORTHWIND, ownerId)) === 404, 'an artifact from an owner run in the same workspace → 404');
for (const g of ['art_0000000000000000', 'art_ffffffffffffffff', chartId.toUpperCase(), `${chartId}/..`, '../art_x', '', null, 'art_' + 'a'.repeat(15), `${chartId}%00`]) ok(status(() => CV.guard(NORTHWIND, g)) === 404, `guessed id ${JSON.stringify(g)} → 404`);

// records tampered into the registry (the fence doesn't trust them)
let forged = 0;
const forge = (rel, extra = {}) => { const id = A.idFor('wsa', `${rel}#forged${++forged}`); state.artifacts[id] = { id, workspace: 'wsa', client: 'wsa-northwind', runId: 'run_northwind', runIds: ['run_northwind'], rel, name: path.posix.basename(rel), ext: 'txt', kind: 'text', size: 1, version: 1, status: 'final', stamp: 'x', updatedAt: t1, createdAt: t1, ...extra }; return id; };
ok(status(() => CV.guard(NORTHWIND, forge('.clients/wsa-fabrikam/Tasks/o1/secret.txt'))) === 404, 'record claiming northwind but pointing into client B’s sandbox → 404');
ok(status(() => CV.guard(NORTHWIND, forge('.clients/wsa-northwind/../wsa-fabrikam/Tasks/o1/secret.txt'))) === 404, '“..” in a record → 404');
ok(status(() => CV.guard(NORTHWIND, forge('Tasks/j1/owner-plan.md'))) === 404, 'record pointing at the owner’s workspace file → 404');
ok(status(() => CV.guard(NORTHWIND, forge('.env'))) === 404 && status(() => CV.guard(NORTHWIND, forge('CLAUDE.md'))) === 404, 'setup and secret files → 404');
ok(status(() => CV.guard(NORTHWIND, forge('.clients/wsa-northwind/Tasks/c1/report.md', { runIds: ['run_owner'], runId: 'run_owner' }))) === 404, 'record whose runs aren’t the client’s → 404');
ok(status(() => CV.guard(NORTHWIND, forge('.clients/wsa-northwind/Tasks/c1/report.md', { workspace: 'wsb' }))) === 404, 'record in another workspace → 404');
ok(status(() => CV.guard(NORTHWIND, forge(`.clients/wsa-northwind/${path.relative(nwHome, path.join(tmp, 'outside.txt')).split(path.sep).join('/')}`))) === 404, 'climbing out of the workspace → 404');
ok(status(() => CV.guard(NORTHWIND, forge('.clients/WSA-NORTHWIND/../../outside.txt'))) === 404, 'case games + climbing → 404');

// junctions: one planted inside northwind's sandbox pointing at client B's, and a registered file swapped for one
let junction = false;
try { fs.symlinkSync(fabHome, path.join(nwHome, 'Tasks', 'c1', 'peek'), 'junction'); junction = true; } catch (e) { console.log(`skip junction tests (${e.message})`); }
if (junction) {
  ok(!A.register(rA, path.join(nwHome, 'Tasks', 'c1', 'peek', 'Tasks', 'o1', 'secret.txt')), 'a junction into client B’s sandbox isn’t registered');
  ok(status(() => CV.guard(NORTHWIND, forge('.clients/wsa-northwind/Tasks/c1/peek/Tasks/o1/secret.txt'))) === 404, 'a record through the junction → 404');
  const again = CV.listFor(NORTHWIND, rA, { ended: true });
  ok(!JSON.stringify(again).includes('secret'), 'the listing never shows files behind the junction');
  // swap a registered folder for a junction after registration
  const swapDir = path.join(nwHome, 'Tasks', 'c1', 'swap');
  put(path.join(swapDir, 'secret.txt'), 'northwind copy');
  const swapped = A.register(rA, path.join(swapDir, 'secret.txt'));
  ok(swapped && status(() => CV.guard(NORTHWIND, swapped.id)) === 200, 'a real file in the sandbox opens');
  fs.rmSync(swapDir, { recursive: true, force: true });
  fs.symlinkSync(path.join(fabHome, 'Tasks', 'o1'), swapDir, 'junction');
  ok(status(() => CV.guard(NORTHWIND, swapped.id)) === 404, 'the same record after its folder became a junction to client B → 404');
}

// ── 5. live events, per client ──
const ev = id => ({ type: 'artifact.updated', artifact: A.publicArtifact(A.getArtifact(id)) });
ok(CV.artifactEvent(NORTHWIND, ev(secretId)) === null && CV.artifactEvent(NORTHWIND, ev(ownerId)) === null, 'client A never gets B’s or the owner’s artifact events');
const mine = CV.artifactEvent(NORTHWIND, ev(chartId));
ok(mine?.[0] === 'artifact.updated' && mine[1].artifact.rel === 'Tasks/c1/chart.png' && !JSON.stringify(mine).includes(tmp) && !('workspace' in mine[1].artifact), 'their own event comes scrubbed');
ok(CV.artifactEvent(NORTHWIND, { type: 'run.event' }) === null, 'other event types aren’t artifact events');

// ── 6. video: never the tunnel; R2 off → the "not switched on" state; R2 on → upload under their prefix, short link ──
A.updateMedia(videoId, { state: 'ready', play: 'original', poster: true, durationSec: 3, w: 320, h: 240, error: `ffmpeg C:\\Users\\x\\${tmp}` });
playable.set(videoId, nwVideo);
CV.configureClientView({ onOff: c => offTold.push(c.id) });
const offTold = [];
R2.configureR2({ readEnv: () => '' });
const vrec = CV.clientArtifact(NORTHWIND, A.getArtifact(videoId));
ok(vrec.video?.state === 'off', 'R2 off: the record says video is off');
ok(!JSON.stringify(vrec).includes('ffmpeg') && !('error' in vrec.media), 'ffmpeg errors (with paths) never reach the client');
const off = CV.playFor(NORTHWIND, videoId);
ok(off.off === true && off.message === CV.offMessage() && /isn’t switched on yet/.test(off.message) && !off.url, 'R2 off: playFor says “isn’t switched on yet”, no URL');
ok(offTold.join() === 'wsa-northwind', 'the owner is told (once per ask; portal keeps it to once)');
ok(status(() => CV.playFor(NORTHWIND, chartId)) === 400, 'only video/audio play through playFor');
ok(R2.r2Status().on === false && R2.r2Status().missing.length === 4 && R2.mediaOrigin() === null, 'r2Status lists the four missing keys; no CSP origin');

const ENV = { R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef', R2_ACCESS_KEY_ID: 'AKTEST', R2_SECRET_ACCESS_KEY: 'SKTEST', R2_BUCKET: 'orchy-clients' };
R2.configureR2({ readEnv: k => ({ ...ENV, R2_ACCOUNT_ID: 'nope' })[k] || '' });
ok(R2.r2Status().reason === 'bad-account' && R2.r2Config() === null, 'a malformed account id keeps it off');
const calls = [];
R2.configureR2({
  readEnv: k => ENV[k] || '',
  transport: async req => {
    calls.push(req);
    if (req.method === 'GET') return { status: 200, text: `<ListBucketResult><Contents><Key>clients/wsa-northwind/${videoId}/v0/old.mp4</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>` };
    if (req.method === 'DELETE') return { status: 204, text: '' };
    if (req.method === 'PUT') return { status: 200, text: '' };
    return { status: 400, text: '<Error><Code>Bad</Code></Error>' };
  },
});
ok(R2.mediaOrigin() === 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com', 'R2 on: CSP media origin is the account endpoint');
ok(CV.clientArtifact(NORTHWIND, A.getArtifact(videoId)).video.state === 'waiting', 'R2 on, not uploaded yet: waiting');
const first = CV.playFor(NORTHWIND, videoId);
ok(first.state === 'uploading' && !first.url, 'first ask starts the upload');
await CV.upload('wsa-northwind', A.getArtifact(videoId)); // waits for the chain
const put1 = calls.find(c => c.method === 'PUT');
ok(put1 && put1.path === `/orchy-clients/clients/wsa-northwind/${videoId}/v1/original.mp4` && put1.file === nwVideo, 'the playable file goes up under clients/<their id>/<artifact>/v<version>/', put1?.path);
ok(/^AWS4-HMAC-SHA256 Credential=AKTEST\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/.test(put1?.headers.authorization || ''), 'PUT is SigV4-signed (region auto)', put1?.headers.authorization);
ok(put1?.headers['content-type'] === 'video/mp4' && put1.headers['x-amz-content-sha256'] === 'UNSIGNED-PAYLOAD', 'PUT content type + unsigned payload');
ok(calls.some(c => c.method === 'DELETE' && c.path === `/orchy-clients/clients/wsa-northwind/${videoId}/v0/old.mp4`), 'the old version’s copy is deleted first');
const st = A.getArtifact(videoId).media.r2;
ok(st.state === 'ready' && st.version === 1, 'R2 state ready for this version');
const pl = CV.playFor(NORTHWIND, videoId);
const pu = new URL(pl.url);
ok(pu.host === '0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com' && pu.pathname === `/orchy-clients/clients/wsa-northwind/${videoId}/v1/original.mp4`, 'play link points at their own object', pl.url);
ok(Number(pu.searchParams.get('X-Amz-Expires')) <= 900 && Date.parse(pl.expiresAt) - Date.now() <= 900_000, 'play link expires within 15 min');
ok(new URL(pl.download).searchParams.get('response-content-disposition')?.includes('cut.mp4'), 'download link names the file');
const vr = CV.clientArtifact(NORTHWIND, A.getArtifact(videoId));
ok(vr.video.state === 'ready' && !JSON.stringify(vr).includes('clients/wsa-northwind') && !JSON.stringify(vr).includes('AKTEST'), 'record: ready, but no R2 key or credential');
// a new version → the old link isn't handed out again
put(nwVideo, 'a new cut, longer');
A.openArtifact(videoId);
ok(A.getArtifact(videoId).version === 2 && CV.clientArtifact(NORTHWIND, A.getArtifact(videoId)).video.state === 'preparing', 'a new version needs its own copy (preparing until media is ready)');
// client B can't mint a link to A's video, and A can't to B's
ok(status(() => CV.playFor(FABRIKAM, videoId)) === 404 && status(() => CV.playFor(NORTHWIND, theirVideo)) === 404, 'no client mints another client’s video');
// a client removed: everything under their prefix goes
calls.length = 0;
await CV.forgetClient('wsa-northwind');
ok(calls[0]?.method === 'GET' && calls[0].query.prefix === 'clients/wsa-northwind/' && calls.filter(c => c.method === 'DELETE').every(c => c.path.startsWith('/orchy-clients/clients/wsa-northwind/')), 'forgetClient lists + deletes only their prefix');
let threw = false;
try { await CV.forgetClient('../wsa-fabrikam'); } catch { threw = true; }
ok(threw, 'forgetClient refuses a bad id');

// ── 7. where task folders sit: a client's is always Tasks in their own corner; a bad taskRoot falls back to Tasks ──
ok(taskRootRel({}) === 'Tasks' && taskRootRel({ taskRoot: 'Marketing/Writer/Tasks' }) === 'Marketing/Writer/Tasks', 'taskRootRel: default Tasks, an agent home kept');
ok(taskRootRel({ client: 'wsa-northwind', taskRoot: 'Marketing/Writer/Tasks' }) === 'Tasks', 'a client run never leaves Tasks');
ok(['../x/Tasks', 'Marketing/../../Tasks', '.claude/Tasks', 'C:/x/Tasks', 'Marketing/Writer', 'a/b/c/d/e/Tasks', 'Tasks'].every(r => taskRootRel({ taskRoot: r }) === 'Tasks'), 'taskRootRel refuses climbing, hidden, drive and odd roots');
ok(taskRoot(WS, { client: 'wsa-northwind', taskDir: 'c1' }) === path.join(nwHome, 'Tasks', 'c1') && taskRoot(WS, { taskDir: 'j1' }) === path.join(W, 'Tasks', 'j1'), 'taskRoot: the client corner, or the workspace');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n${fail} FAILED` : '\nall client viewer tests passed');
process.exit(fail ? 1 : 0);
