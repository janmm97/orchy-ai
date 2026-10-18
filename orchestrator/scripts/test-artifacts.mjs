// The artifact registry (artifacts.mjs) on temp folders: kinds, the path guard (.., absolute paths, drive
// letters, ADS, trailing-dot aliases, hidden/setup/secret files, node_modules, junctions out and into other clients'
// sandboxes, another workspace's folder and one nested inside), live discovery from tool events, the run-end sync
// (task folder, report outputs + links, the modified-files scan and its excludes, client runs kept to their sandbox),
// version bumps, status rules, missing files, the cap, previews (CSV, JSON, xlsx, pptx, docx via mammoth), research
// sources, and Range on /raw. The real state.json is never touched (deps are swapped). Run: node orchestrator/scripts/test-artifacts.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import * as A from '../lib/artifacts.mjs';
import { sendTaskFile } from '../lib/clientspace.mjs';
import { bus } from '../lib/bus.mjs';

let fail = 0;
const ok = (cond, label, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : `  ${extra}`}`); if (!cond) fail++; };

// ── a tiny stored zip (for the Office fixtures) ──
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export function zip(entries) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text), nm = Buffer.from(name), crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nm, data); centrals.push(ch, nm);
    off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const CT = parts => `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${parts}</Types>`;
const RELS = target => `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/></Relationships>`;
export const DOCX = () => zip({
  '[Content_Types].xml': CT('<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'),
  '_rels/.rels': RELS('word/document.xml'),
  'word/document.xml': '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Launch plan</w:t></w:r></w:p><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold start</w:t></w:r><w:r><w:t xml:space="preserve"> and the rest of the week.</w:t></w:r></w:p></w:body></w:document>',
});
export const XLSX = () => zip({
  '[Content_Types].xml': CT('<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'),
  '_rels/.rels': RELS('xl/workbook.xml'),
  'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Leads" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
  'xl/sharedStrings.xml': '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Name</t></si><si><t>Deals</t></si><si><t>Ada &amp; Co</t></si></sst>',
  'xl/worksheets/sheet1.xml': '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>42</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Bea</t></is></c><c r="B3" t="b"><v>1</v></c></row></sheetData></worksheet>',
});
export const PPTX = () => zip({
  '[Content_Types].xml': CT(''),
  'ppt/presentation.xml': '<p:presentation xmlns:p="p"/>',
  'ppt/slides/slide1.xml': '<p:sld xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>Q3 review</a:t></a:r></a:p><a:p><a:r><a:t>Revenue up</a:t></a:r></a:p></p:sld>',
  'ppt/slides/slide2.xml': '<p:sld xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>Next steps</a:t></a:r></a:p></p:sld>',
  'ppt/notesSlides/notesSlide2.xml': '<p:notes xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>Say it slowly</a:t></a:r></a:p></p:notes>',
});

// ── fixtures ──
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orchy-artifacts-test-')));
const W = path.join(tmp, 'wsA'), B = path.join(tmp, 'wsB'), N = path.join(W, 'Nested');
const put = (p, s = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); return p; };
put(path.join(W, 'out', 'chart.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
put(path.join(W, 'Tasks', 't1', 'report.md'), '# Report\n');
put(path.join(W, '.env'), 'SECRET=1');
put(path.join(W, '.claude', 'agents', 'x.md'), 'agent');
put(path.join(W, 'CLAUDE.md'), 'map');
put(path.join(W, 'node_modules', 'x', 'i.js'), '1');
put(path.join(W, 'key.pem'), 'k');
put(path.join(W, 'prod.env'), 'k');
put(path.join(W, '.clients', 'acme', 'Tasks', 'c1', 'out.txt'), 'for acme');
put(path.join(W, '.clients', 'other', 'secret.txt'), 'not for acme');
put(path.join(N, 'n.txt'), 'nested ws');
put(path.join(B, 'b.txt'), 'other ws');
put(path.join(tmp, 'outside.txt'), 'outside');

const state = { runs: {}, artifacts: {} };
const events = [];
const dropped = [];
const WS = { wsa: { id: 'wsa', dir: W }, wsb: { id: 'wsb', dir: B }, wsn: { id: 'wsn', dir: N } };
A.configure({
  db: () => state, save: () => {}, emit: (type, data) => events.push({ type, ...data }),
  workspace: id => WS[id] || (() => { throw Object.assign(new Error('Unknown workspace'), { status: 404 }); })(),
  workspaces: () => Object.values(WS), previewsDir: path.join(tmp, 'previews'), onDropped: id => dropped.push(id),
  eventsOf: () => [],
});
const ws = WS.wsa;

// ── kinds ──
ok(['a.png', 'b.PDF', 'c.mp4', 'd.mp3', 'e.md', 'f.json', 'g.csv', 'h.xlsx', 'i.docx', 'j.pptx', 'k.html', 'l.py', 'm.txt', 'n.bin'].map(A.kindFor).join() === 'image,pdf,video,audio,markdown,json,csv,sheet,doc,slides,html,code,text,other', 'kindFor maps extensions to viewer kinds');
ok(A.VIEW_TYPES['.js'] === 'text/plain; charset=utf-8' && A.VIEW_TYPES['.svg'] === 'image/svg+xml' && !A.VIEW_TYPES['.docx'], 'raw types: code as text/plain, SVG as an image, Office downloads');

// ── the path guard ──
const R = (rel, client = null, w = ws) => A.resolveFile(w, rel, client);
ok(!!R('out/chart.png') && !!R('out\\chart.png'), 'a file in the workspace resolves (either slash)');
ok(R('Tasks/t1/report.md') === path.join(W, 'Tasks', 't1', 'report.md'), 'resolves to the real path');
for (const [rel, why] of [
  ['../wsB/b.txt', 'climbing with ..'], ['..\\wsB\\b.txt', 'climbing with ..\\'], ['out/../../wsB/b.txt', '.. in the middle'], ['./out/chart.png', 'a . segment'],
  [path.join(B, 'b.txt'), 'an absolute path'], ['C:/Windows/win.ini', 'a drive letter'], ['/etc/passwd', 'a rooted path'], ['\\\\server\\share\\x', 'a UNC path'],
  ['out/chart.png:hidden', 'an alternate data stream'], ['CLAUDE.md.', 'a trailing-dot alias'], ['out/chart.png ', 'a trailing-space alias'],
  ['.env', '.env'], ['prod.env', 'a *.env file'], ['key.pem', 'a key file'], ['.claude/agents/x.md', '.claude/'], ['CLAUDE.md', 'CLAUDE.md'], ['claude.MD', 'CLAUDE.md in any case'],
  ['node_modules/x/i.js', 'node_modules'], ['Nested/n.txt', 'a workspace nested inside this one'], ['out/nope.png', 'a file that isn’t there'], ['out', 'a folder'], ['', 'empty'], ['a\0b', 'a NUL'],
]) ok(R(rel) === null, `refused: ${why}`);
ok(R('.clients/acme/Tasks/c1/out.txt') === null, 'an owner run never reaches a client sandbox');
ok(!!R('.clients/acme/Tasks/c1/out.txt', 'acme'), 'a client’s artifact resolves inside its own sandbox');
ok(R('.clients/other/secret.txt', 'acme') === null, 'another client’s sandbox is refused');
ok(R('out/chart.png', 'acme') === null, 'a client’s artifact can’t sit outside its sandbox');
ok(R('.clients/acme', 'acme') === null && R('.clients/ACME/../other/secret.txt', 'acme') === null, 'the sandbox root and climbs out of it are refused');
ok(A.resolveFile(WS.wsb, 'b.txt') && R('b.txt') === null, 'another workspace’s file only resolves for that workspace');
// junctions (no admin needed on Windows) and symlinks (skipped where not allowed)
const link = (target, at, type = 'junction') => { try { fs.symlinkSync(target, at, type); return true; } catch { return false; } };
if (link(B, path.join(W, 'jumpout'))) ok(R('jumpout/b.txt') === null, 'a junction out of the workspace is refused');
if (link(path.join(W, '.clients', 'other'), path.join(W, 'peek'))) {
  ok(R('peek/secret.txt') === null, 'a junction into a client sandbox is refused (owner run)');
  ok(R('peek/secret.txt', 'acme') === null, 'a junction into another client’s sandbox is refused (client run)');
}
if (link(path.join(W, '.claude'), path.join(W, 'cfg'))) ok(R('cfg/agents/x.md') === null, 'a junction onto .claude/ is refused');
if (link(path.join(tmp, 'outside.txt'), path.join(W, 'out', 'sym.txt'), 'file')) ok(R('out/sym.txt') === null, 'a file symlink out is refused');
else console.log('skip  file symlink (not allowed on this PC without developer mode)');
// an 8.3 short name for .claude (when the volume makes them)
try {
  const short = execFileSync('cmd', ['/c', `for %I in ("${path.join(W, '.claude')}") do @echo %~sI`], { encoding: 'utf8', windowsVerbatimArguments: true }).trim().replace(/^"|"$/g, '');
  const base = path.basename(short);
  if (base && base.toLowerCase() !== '.claude') ok(R(`${base}/agents/x.md`) === null, `an 8.3 short name (${base}) for .claude/ is refused`);
  else console.log('skip  8.3 short names (off on this volume)');
} catch { console.log('skip  8.3 short names (no cmd)'); }

// ── live discovery from tool events ──
const run = { id: 'run_a', workspace: 'wsa', agentSlug: 'writer', agentName: 'Writer', startedAt: new Date(Date.now() - 60_000).toISOString(), status: 'working' };
state.runs[run.id] = run;
const draftPath = put(path.join(W, 'out', 'draft.md'), '# Draft\n');
A.onRunEvent(run.id, { kind: 'tool', tool: 'Write', toolUseId: 'tu1', input: { file_path: draftPath } });
ok(!Object.values(state.artifacts).some(a => a.name === 'draft.md'), 'nothing registers before tool_done');
A.onRunEvent(run.id, { kind: 'tool_done', toolUseId: 'tu1', tool: 'Write', ok: true });
let draft = Object.values(state.artifacts).find(a => a.name === 'draft.md');
ok(draft && draft.status === 'draft' && draft.source === 'write' && draft.kind === 'markdown' && draft.rel === 'out/draft.md' && draft.runId === run.id && draft.agentSlug === 'writer', 'Write + tool_done registers a draft', JSON.stringify(draft));
ok(events.some(e => e.type === 'artifact.created' && e.artifact.id === draft.id && !('stamp' in e.artifact) && !JSON.stringify(e.artifact).includes(tmp)), 'artifact.created carries the public record (no absolute path)');
A.onRunEvent(run.id, { kind: 'tool', tool: 'Edit', toolUseId: 'tu2', input: { file_path: 'out/chart.png' } });
A.onRunEvent(run.id, { kind: 'tool_error', toolUseId: 'tu2', tool: 'Edit', text: 'nope' });
A.onRunEvent(run.id, { kind: 'tool_done', toolUseId: 'tu2', tool: 'Edit', ok: true });
ok(!Object.values(state.artifacts).some(a => a.name === 'chart.png'), 'a failed edit registers nothing');
A.onRunEvent(run.id, { kind: 'tool', tool: 'Edit', toolUseId: 'tu3', input: { file_path: path.join(B, 'b.txt') }, codex: 'patch' });
A.onRunEvent(run.id, { kind: 'tool_done', toolUseId: 'tu3', tool: 'Edit', ok: true });
A.onRunEvent(run.id, { kind: 'tool', tool: 'Write', toolUseId: 'tu4', input: { file_path: path.join(W, '.clients', 'acme', 'Tasks', 'c1', 'out.txt') } });
A.onRunEvent(run.id, { kind: 'tool_done', toolUseId: 'tu4', tool: 'Write', ok: true });
A.onRunEvent(run.id, { kind: 'tool', tool: 'Write', toolUseId: 'tu5', input: { file_path: path.join(W, '.claude', 'agents', 'x.md') } });
A.onRunEvent(run.id, { kind: 'tool_done', toolUseId: 'tu5', tool: 'Write', ok: true });
ok(Object.keys(state.artifacts).length === 1, 'writes into another workspace, a client sandbox or .claude/ register nothing', Object.values(state.artifacts).map(a => a.rel).join());
A.onRunEvent(run.id, { kind: 'tool', tool: 'Edit', toolUseId: 'tu6', input: { file_path: 'out/chart.png' }, codex: 'patch' });
A.onRunEvent(run.id, { kind: 'tool_done', toolUseId: 'tu6', tool: 'Edit', ok: true });
ok(Object.values(state.artifacts).find(a => a.name === 'chart.png')?.source === 'codex-patch', 'a Codex patch (relative path) registers as codex-patch');

// ── version bump ──
const v1 = draft.version, ev0 = events.length;
A.register(run, draftPath, { source: 'edit' });
ok(draft.version === v1 && events.length === ev0, 'the same file again: no bump, no event');
fs.writeFileSync(draftPath, '# Draft\n\nMore words.\n');
A.register(run, draftPath, { source: 'edit' });
ok(draft.version === v1 + 1 && draft.source === 'edit' && events.at(-1).type === 'artifact.updated', 'a changed file bumps the version and emits artifact.updated');
const other = { id: 'run_b', workspace: 'wsa', agentSlug: 'editor', agentName: 'Editor', startedAt: new Date().toISOString() };
state.runs[other.id] = other;
fs.writeFileSync(draftPath, '# Draft\n\nEdited by another run.\n');
A.register(other, draftPath, { source: 'edit' });
ok(draft.runId === 'run_b' && draft.runIds.join() === 'run_a,run_b' && draft.agentSlug === 'editor', 'two runs on one file: the latest writer wins, both kept in runIds');

// ── the run-end sync ──
const t0 = Date.now();
const ended = { id: 'run_c', workspace: 'wsa', agentSlug: null, agentName: 'Generalist', taskDir: 't1', startedAt: new Date(t0 - 1000).toISOString(), status: 'done', outcome: 'completed',
  report: { outputs: ['Saved the deck to `Decks/q3.pptx` and the leads in Leads/leads.csv', 'Live at https://example.com/post/1.', 'not-a-file', 'D:/elsewhere/x.pdf'] } };
state.runs[ended.id] = ended;
put(path.join(W, 'Decks', 'q3.pptx'), PPTX());
put(path.join(W, 'Leads', 'leads.csv'), 'name,deals\n"Ada, Co",3\n"Bea ""B""",5\n');
put(path.join(W, 'Notes', 'deep', 'a', 'b', 'c', 'd', 'e', 'too-deep.txt'), 'deep');
put(path.join(W, 'Notes', 'fresh.txt'), 'fresh');
put(path.join(W, 'Uploads', 'brief.pdf'), '%PDF-1.4');
put(path.join(W, 'Tasks', 'other', 'TASK.md'), 'another run’s summary');
fs.writeFileSync(path.join(W, '.claude', 'agents', 'x.md'), 'agent changed');
fs.writeFileSync(path.join(W, 'CLAUDE.md'), 'map changed');
const old = path.join(W, 'Notes', 'old.txt');
put(old, 'old'); fs.utimesSync(old, new Date(t0 - 3600_000), new Date(t0 - 3600_000));
ended.endedAt = new Date(Date.now() + 1000).toISOString();
A.syncRun(ended, { ended: true });
const names = () => Object.values(state.artifacts).map(a => a.rel);
const has = rel => names().includes(rel);
ok(has('Tasks/t1/report.md'), 'the task folder is registered');
ok(has('Decks/q3.pptx') && has('Leads/leads.csv'), 'report outputs that name files are registered');
ok(ended.links?.join() === 'https://example.com/post/1', 'report URLs go to run.links', JSON.stringify(ended.links));
ok(has('Notes/fresh.txt'), 'the scan finds files modified while the run ran');
ok(!has('Notes/old.txt'), 'the scan skips files modified before the run');
ok(!has('Notes/deep/a/b/c/d/e/too-deep.txt'), 'the scan stops at depth 6');
ok(!has('Uploads/brief.pdf') && !has('Tasks/other/TASK.md') && !names().some(r => /claude|\.clients|node_modules/i.test(r)), 'the scan skips Uploads, other runs’ TASK.md, setup and client folders', names().join());
ok(Object.values(state.artifacts).filter(a => a.runId === 'run_c').every(a => a.status === 'final'), 'a completed run’s files are final');
ok(Object.values(state.artifacts).find(a => a.name === 'draft.md').runId === 'run_b', 'the scan leaves an unchanged file with the run that wrote it');
const nScan = names().length;
A.syncRun(ended, { ended: true });
ok(names().length === nScan, 'a second sync of the same run scans nothing new');
const failed = { id: 'run_d', workspace: 'wsa', startedAt: new Date().toISOString(), outcome: 'failed', status: 'failed' };
state.runs[failed.id] = failed;
put(path.join(W, 'out', 'half.md'), 'half');
failed.endedAt = new Date(Date.now() + 1000).toISOString();
A.syncRun(failed, { ended: true });
ok(Object.values(state.artifacts).find(a => a.name === 'half.md')?.status === 'failed', 'a failed run’s files are failed (still viewable)');
const live = { id: 'run_e', workspace: 'wsa', startedAt: new Date().toISOString(), taskDir: 't1', status: 'working' };
const before = names().length;
put(path.join(W, 'Notes', 'during-live.txt'), 'x');
A.syncRun(live, { ended: false });
ok(names().length === before && !live.artifactScan, 'a live run only gets its task folder (no scan yet)');

// ── the wiring: the bus's run.event and run.ended reach the registry (start()) ──
A.start();
const wired = { id: 'run_w', workspace: 'wsa', startedAt: new Date(Date.now() - 1000).toISOString(), status: 'working' };
state.runs[wired.id] = wired;
const wiredFile = put(path.join(W, 'out', 'wired.md'), 'via the bus');
bus.emit('event', { type: 'run.event', runId: wired.id, event: { kind: 'tool', tool: 'Write', toolUseId: 'w1', input: { file_path: wiredFile } } });
bus.emit('event', { type: 'run.event', runId: wired.id, event: { kind: 'tool_done', toolUseId: 'w1', tool: 'Write', ok: true } });
const wa = Object.values(state.artifacts).find(a => a.name === 'wired.md');
ok(wa?.status === 'draft' && wa.runId === 'run_w', 'run.event on the bus registers a draft');
Object.assign(wired, { status: 'done', outcome: 'completed', endedAt: new Date(Date.now() + 1000).toISOString() });
bus.emit('event', { type: 'run.ended', run: { id: wired.id } });
await new Promise(r => setTimeout(r, 150));
ok(wa.status === 'final' && wired.artifactScan, 'run.ended on the bus syncs the run (its files final, scan done)');

// ── a client run: its sandbox only ──
const crun = { id: 'run_f', workspace: 'wsa', client: 'acme', taskDir: 'c1', startedAt: new Date(Date.now() - 1000).toISOString(), outcome: 'completed', status: 'done' };
state.runs[crun.id] = crun;
put(path.join(W, '.clients', 'acme', 'Tasks', 'c1', 'deliverable.md'), '# For Acme');
put(path.join(W, 'out', 'owner-only.md'), 'the owner’s');
put(path.join(W, '.clients', 'other', 'theirs.md'), 'other client');
crun.endedAt = new Date(Date.now() + 1000).toISOString();
A.syncRun(crun, { ended: true });
const cl = Object.values(state.artifacts).filter(a => a.runId === 'run_f');
ok(cl.length >= 2 && cl.every(a => a.client === 'acme' && a.rel.startsWith('.clients/acme/')), 'a client run registers only inside its sandbox', cl.map(a => a.rel).join());
ok(!has('out/owner-only.md') && !names().some(r => r.includes('other/')), 'a client run’s scan never sees the owner’s files or another client’s');
const listed = A.listArtifacts({ run: crun });
ok(listed.length === cl.length && listed.every(a => !('stamp' in a)), 'listArtifacts by run returns its files, public records');
ok(A.listArtifacts({ run: ended }).some(a => a.rel === 'Tasks/t1/report.md') && A.listArtifacts({ workspace: 'wsa', kind: 'csv' }).length === 1, 'list by run (with its task folder), workspace and kind');

// ── missing ──
const fresh = Object.values(state.artifacts).find(a => a.name === 'fresh.txt');
fs.rmSync(path.join(W, 'Notes', 'fresh.txt'));
let err = null;
try { A.openArtifact(fresh.id); } catch (e) { err = e; }
ok(err?.status === 404 && fresh.status === 'missing' && fresh.was === 'final', 'a gone file → 404 and status missing');
put(path.join(W, 'Notes', 'fresh.txt'), 'back again');
const back = A.openArtifact(fresh.id);
ok(back.artifact.status === 'final' && back.artifact.version === 2, 'it comes back with its status and a new version');
ok(A.openArtifact(draft.id).file === draftPath, 'openArtifact re-resolves through the guard');

// ── the cap ──
const keep = Object.keys(state.artifacts).length;
for (let i = 0; i < A.MAX_ARTIFACTS; i++) state.artifacts[`art_fake${i}`] = { id: `art_fake${i}`, updatedAt: new Date(2000, 0, 1, 0, 0, i).toISOString() };
A.register(run, put(path.join(W, 'out', 'one-more.txt'), 'x'));
ok(Object.keys(state.artifacts).length === A.MAX_ARTIFACTS && dropped.length === keep + 1 && dropped[0] === 'art_fake0' && state.artifacts['art_fake' + (A.MAX_ARTIFACTS - 1)], `capped at ${A.MAX_ARTIFACTS}, oldest dropped first (and its previews)`, `${Object.keys(state.artifacts).length} ${dropped.length}`);
for (const k of Object.keys(state.artifacts)) if (k.startsWith('art_fake')) delete state.artifacts[k];

// ── previews ──
let p = await A.previewFile(path.join(W, 'Leads', 'leads.csv'));
ok(p.type === 'rows' && p.rows.length === 3 && p.rows[1][0] === 'Ada, Co' && p.rows[2][0] === 'Bea "B"', 'CSV: quoted commas and doubled quotes', JSON.stringify(p.rows));
ok(A.parseDelimited('a\tb\n1\t"two\nlines"\n', '\t').rows[1][1] === 'two\nlines', 'TSV with a newline inside quotes');
const many = Array.from({ length: 1500 }, (_, i) => `${i},x`).join('\n');
ok(A.parseDelimited(many).rows.length === 1000 && A.parseDelimited(many).truncated, 'CSV stops at 1000 rows and says so');
put(path.join(W, 'out', 'data.json'), '{"a":1,"b":[1,2]}');
p = await A.previewFile(path.join(W, 'out', 'data.json'));
ok(p.type === 'text' && p.pretty && p.text.includes('\n  "a": 1'), 'JSON is pretty-printed');
put(path.join(W, 'out', 'broken.json'), '{"a":');
ok((await A.previewFile(path.join(W, 'out', 'broken.json'))).text === '{"a":', 'broken JSON shows as it is');
put(path.join(W, 'out', 'leads.xlsx'), XLSX());
p = await A.previewFile(path.join(W, 'out', 'leads.xlsx'));
ok(p.type === 'sheets' && p.sheets[0].name === 'Leads' && p.sheets[0].rows[1].join('|') === 'Ada & Co||42' && p.sheets[0].rows[2].join('|') === 'Bea|TRUE', 'xlsx: sheet names, shared strings, gaps by cell ref, inline strings, booleans', JSON.stringify(p.sheets));
p = await A.previewFile(path.join(W, 'Decks', 'q3.pptx'));
ok(p.type === 'slides' && p.slides.length === 2 && p.slides[0].text.includes('Revenue up') && p.slides[1].notes === 'Say it slowly', 'pptx: one card per slide, with speaker notes', JSON.stringify(p.slides));
put(path.join(W, 'out', 'plan.docx'), DOCX());
p = await A.previewFile(path.join(W, 'out', 'plan.docx'));
ok(p.type === 'html' && /<h1>Launch plan<\/h1>/.test(p.html) && /<strong>Bold start<\/strong>/.test(p.html), 'docx → HTML through mammoth', p.html);
put(path.join(W, 'out', 'notes.srt2'), '1\n00:00 hi');
ok((await A.previewFile(path.join(W, 'out', 'notes.srt2'))).type === 'text', 'an unknown text file previews as text');
put(path.join(W, 'out', 'blob.bin'), Buffer.from([0, 1, 2, 0]));
err = null; try { await A.previewFile(path.join(W, 'out', 'blob.bin')); } catch (e) { err = e; }
ok(err?.status === 415, 'a binary file: can’t preview (415)');
put(path.join(W, 'out', 'bad.docx'), 'not a zip');
err = null; try { await A.previewFile(path.join(W, 'out', 'bad.docx')); } catch (e) { err = e; }
ok(err?.status === 415, 'a broken docx says so (415)');

// ── report output parsing and research sources ──
const bits = A.outputBits('Wrote `Tasks/x/plan.md`, see [the chart](out/c.png) and https://a.io/x?y=1. Also out/final.mp4');
ok(bits.urls.join() === 'https://a.io/x?y=1' && ['Tasks/x/plan.md', 'out/c.png', 'out/final.mp4'].every(x => bits.paths.includes(x)), 'outputBits: backticks, markdown links, bare paths, URLs', JSON.stringify(bits));
const posix = A.outputBits('Saved to /home/sam/acme/out/deck.pdf and C:\\work\\acme\\out\\notes.md');
ok(posix.paths.includes('/home/sam/acme/out/deck.pdf') && posix.paths.includes('C:\\work\\acme\\out\\notes.md'), 'outputBits: POSIX and Windows absolute paths', JSON.stringify(posix));
// a report naming a file by its absolute path (POSIX or Windows, whichever this machine is) registers it
const absRun = { id: 'run_abs', workspace: 'wsa', startedAt: new Date().toISOString(), outcome: 'completed', status: 'done', endedAt: new Date().toISOString(), artifactScan: null, report: { outputs: [`Wrote ${path.join(W, 'Leads', 'leads.csv')}`] } };
ok(A.relFor(ws, absRun, path.join(W, 'Leads', 'leads.csv')) === 'Leads/leads.csv' && A.relFor(ws, absRun, path.join(B, 'b.txt')) === null, 'relFor: an absolute path inside the workspace → its relative path; outside → null');
ok(A.relFor(ws, absRun, `file://${process.platform === 'win32' ? '/' : ''}${path.join(W, 'Leads', 'leads.csv').replace(/\\/g, '/')}`) === 'Leads/leads.csv', 'relFor: a file:// URL');
const src = A.runSources([
  { kind: 'tool', tool: 'WebFetch', input: { url: 'https://news.example/a' }, t: '1' },
  { kind: 'tool', tool: 'WebSearch', input: { query: 'best crm 2026' }, t: '2' },
  { kind: 'tool', tool: 'mcp__exa__web_search_exa', input: { query: 'exa q', urls: ['https://exa.example/r'] }, t: '3' },
  { kind: 'tool', tool: 'mcp__firecrawl__firecrawl_scrape', input: { url: 'https://site.example/p' }, t: '4' },
  { kind: 'tool', tool: 'Bash', input: { command: 'one --agent actions execute firecrawl conn_x act_y -d \'{"url":"https://deep.example/z"}\'' }, t: '5' },
  { kind: 'tool', tool: 'WebFetch', input: { url: 'https://news.example/a' }, t: '6' },
  { kind: 'tool', tool: 'Read', input: { file_path: 'x' } }, { kind: 'text', text: 'https://not.a.source' },
]);
ok(src.urls.map(u => u.url).join() === 'https://news.example/a,https://exa.example/r,https://site.example/p,https://deep.example/z' && src.searches.map(s => s.query).join() === 'best crm 2026,exa q', 'runSources: fetched URLs and searches from tool events only, deduped', JSON.stringify(src));

// ── /raw: inline types, download, Range ──
put(path.join(W, 'out', 'clip.mp4'), Buffer.alloc(5000, 7));
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  sendTaskFile(res, path.join(W, 'out', u.searchParams.get('f')), {}, { req, media: true, types: A.VIEW_TYPES, download: u.searchParams.has('download') });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const get = (f, h = {}) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: srv.address().port, path: `/?f=${f}`, headers: h }, res => { res.resume(); res.on('end', () => resolve(res)); }).on('error', reject));
let r = await get('clip.mp4', { Range: 'bytes=1000-1999' });
ok(r.statusCode === 206 && r.headers['content-range'] === 'bytes 1000-1999/5000' && r.headers['content-type'] === 'video/mp4' && /^inline/.test(r.headers['content-disposition']), 'video on /raw: Range → 206, inline video/mp4');
r = await get('data.json');
ok(r.headers['content-type'] === 'text/plain; charset=utf-8' && /sandbox/.test(r.headers['content-security-policy']) && r.headers['x-content-type-options'] === 'nosniff', 'JSON on /raw: text/plain, CSP sandbox, nosniff');
r = await get('plan.docx');
ok(/^attachment/.test(r.headers['content-disposition']), 'Office files download');
r = await get('chart.png&download=1');
ok(/^attachment/.test(r.headers['content-disposition']), '?download=1 forces an attachment');
srv.close();

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n${fail} FAILED` : '\nall artifact checks passed');
process.exit(fail ? 1 : 0);
