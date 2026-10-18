// Offline checks for the Office readers in uploads.mjs (no dependency: a small zip reader): xlsxSheets (sheets as rows,
// shared and inline strings, booleans, gaps, the row cap) and pptxSlides (slide text and speaker notes, in slide order),
// plus officeText on the same files. Builds tiny .xlsx/.pptx files itself. Run: node orchestrator/scripts/test-uploads.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { xlsxSheets, pptxSlides, officeText } from '../lib/uploads.mjs';

const ok = name => console.log(`ok - ${name}`);

/** A minimal zip (deflated entries), enough for the reader: local headers, central directory, end record. */
function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8'), data = zlib.deflateRawSync(raw), nm = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nm.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nm.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nm, data); centrals.push(central, nm);
    offset += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchy-uploads-test-'));
try {
  const xlsx = path.join(tmp, 'budget.xlsx');
  const rows = Array.from({ length: 5 }, (_, i) => `<row r="${i + 3}"><c r="A${i + 3}"><v>${i}</v></c></row>`).join('');
  fs.writeFileSync(xlsx, zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Q1 &amp; Q2" sheetId="1"/><sheet name="Notes" sheetId="2"/></sheets></workbook>',
    'xl/sharedStrings.xml': '<sst><si><t>Item</t></si><si><t>Cost</t></si><si><r><t>Pa</t></r><r><t>per</t></r></si></sst>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="b"><v>1</v></c><c r="C2"><v>12.5</v></c></row>${rows}</sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="B1" t="inlineStr"><is><t>Check &lt;this&gt;</t></is></c></row><row r="2"></row></sheetData></worksheet>',
  }));
  const sheets = xlsxSheets(xlsx);
  assert.deepEqual(sheets.map(s => s.name), ['Q1 & Q2', 'Notes']);
  assert.deepEqual(sheets[0].rows.slice(0, 2), [['Item', '', 'Cost'], ['Paper', 'TRUE', '12.5']]);
  assert.equal(sheets[0].rows.length, 7); assert.equal(sheets[0].truncated, false);
  assert.deepEqual(sheets[1].rows, [['', 'Check <this>']]); // trailing empty rows dropped
  const capped = xlsxSheets(xlsx, { maxRows: 3, maxCols: 2 });
  assert.equal(capped[0].rows.length, 3); assert.equal(capped[0].truncated, true); assert.deepEqual(capped[0].rows[0], ['Item']);
  assert.match(officeText(xlsx), /Item/);
  ok('xlsxSheets: sheet names, shared/rich/inline strings, booleans, gaps, row and column caps');

  const pptx = path.join(tmp, 'deck.pptx');
  fs.writeFileSync(pptx, zip({
    'ppt/slides/slide10.xml': '<p:sld><a:p><a:r><a:t>Ten</a:t></a:r></a:p></p:sld>',
    'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>Plan</a:t></a:r></a:p><a:p><a:r><a:t>Step one &amp; two</a:t></a:r></a:p></p:sld>',
    'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>Welcome</a:t></a:r></a:p></p:sld>',
    'ppt/notesSlides/notesSlide2.xml': '<p:notes><a:p><a:r><a:t>Say it   slowly</a:t></a:r></a:p></p:notes>',
  }));
  const slides = pptxSlides(pptx);
  assert.deepEqual(slides.map(s => s.text), ['Welcome', 'Plan\nStep one & two', 'Ten']);
  assert.deepEqual(slides.map(s => s.n), [1, 2, 3]);
  assert.equal(slides[1].notes, 'Say it slowly'); assert.equal(slides[0].notes, '');
  ok('pptxSlides: slides in number order (10 after 2), paragraphs, speaker notes');

  fs.writeFileSync(path.join(tmp, 'bad.xlsx'), 'not a zip');
  assert.throws(() => xlsxSheets(path.join(tmp, 'bad.xlsx')), /not a zip/);
  ok('a file that isn\'t a zip is refused');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('test-uploads: all passed');
