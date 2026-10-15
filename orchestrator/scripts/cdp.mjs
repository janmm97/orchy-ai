// Drive headless Chrome over the DevTools protocol: evaluate JS and capture screenshots.
// node orchestrator/scripts/cdp.mjs <url> <width>x<height> <out.png|-> ["js expression" ...]
//   "wait:<ms>" pauses; "gesture:<js>" runs the expression as if the owner clicked (allows window.open pop-outs).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [url = 'http://localhost:8008/?still', size = '1440x900', out = '-', ...exprs] = process.argv.slice(2);
const [width, height] = size.split('x').map(Number);
// CHROME_PATH wins; else the usual places on Windows and macOS, then a browser on the PATH (Linux)
const onPath = name => (process.env.PATH || '').split(path.delimiter).filter(Boolean).map(d => path.join(d, name)).find(p => fs.existsSync(p));
const CH = [process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find(p => p && fs.existsSync(p)) || ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'].map(onPath).find(Boolean);
if (!CH) { console.error('No Chrome, Edge or Chromium found. Install one, or set CHROME_PATH to its program.'); process.exit(1); }
const port = 9300 + Math.floor(Math.random() * 600);
const userDir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'jos-cdp-'));
const chrome = spawn(CH, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${userDir}`, `--window-size=${width},${height}`, 'about:blank'], { stdio: 'ignore' });
chrome.on('error', e => console.error(`${path.basename(CH)}: ${e.message}`));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Chrome and its throwaway profile go away however this ends
async function finish(code) {
  try { chrome.kill(); } catch {}
  if (chrome.exitCode === null && chrome.signalCode === null) await new Promise(r => { chrome.once('exit', r); setTimeout(r, 3000); });
  try { fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  process.exit(code);
}
process.on('SIGINT', () => finish(130));

let ws;
try {
  let target;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch {}
  }
  if (!target) throw new Error(`${path.basename(CH)} didn't open its DevTools port ${port} within 10s`);
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', () => j(new Error('Couldn\'t connect to the browser\'s DevTools'))); });
  let nid = 0;
  const pending = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}, ms = 60_000) => new Promise((r, j) => {
    const id = ++nid;
    const t = setTimeout(() => { pending.delete(id); j(new Error(`${method} got no answer in ${ms / 1000}s`)); }, ms);
    pending.set(id, m => { clearTimeout(t); r(m); });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await send('Page.enable');
  await send('Page.navigate', { url });
  await sleep(3500);
  for (const ex of exprs) {
    if (ex.startsWith('wait:')) { await sleep(Number(ex.slice(5))); continue; }
    const gesture = ex.startsWith('gesture:');
    const r = await send('Runtime.evaluate', { expression: gesture ? ex.slice(8) : ex, awaitPromise: true, returnByValue: true, userGesture: gesture });
    console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description ?? null, null, 1));
  }
  if (out !== '-') {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    console.log('saved', out);
  }
  ws.close();
  await finish(0);
} catch (e) {
  console.error(e.message);
  try { ws?.close(); } catch {}
  await finish(1);
}
