// PDFs in the viewer: a vendored pdf.js (dashboard/vendor/pdfjs-<version>/, no CDN), scripting and eval off.
// Continuous scroll with pages drawn as they come into view, page n/N, prev/next, zoom steps and Fit width.
// (Chrome's own PDF viewer can't run under /raw's CSP sandbox, and this one can be drawn 1-bit.)
import { icon } from '../pixel.mjs';

const PDFJS = '/vendor/pdfjs-6.3.289';
let lib = null;
async function pdfjs() {
  if (!lib) {
    lib = await import(`${PDFJS}/pdf.min.mjs`);
    lib.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.mjs`;
  }
  return lib;
}
const STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export async function pdfView(stage, s, ctx) {
  const L = await pdfjs();
  const task = L.getDocument({
    url: s.raw, cMapUrl: `${PDFJS}/cmaps/`, cMapPacked: true, standardFontDataUrl: `${PDFJS}/standard_fonts/`, wasmUrl: `${PDFJS}/wasm/`, iccUrl: `${PDFJS}/iccs/`,
    isEvalSupported: false, enableXfa: false, withCredentials: false,
  });
  const doc = await task.promise;
  if (!ctx.live()) { doc.destroy(); return; }
  const N = doc.numPages;
  const first = (await doc.getPage(1)).getViewport({ scale: 1 });
  stage.innerHTML = `
    <div class="vtools">
      <button class="btn sm icon" data-p="prev" aria-label="Previous page">${icon('left')}</button><span class="px" data-pg>1 / ${N}</span><button class="btn sm icon" data-p="next" aria-label="Next page">${icon('right')}</button>
      <button class="btn sm icon" data-z="-" aria-label="Zoom out">${icon('zoomout')}</button><span class="px vzl" data-zl></span><button class="btn sm icon" data-z="+" aria-label="Zoom in">${icon('zoomin')}</button>
      <button class="btn sm" data-z="fit">${icon('fit')}Fit width</button>
    </div>
    <div class="vpdf" data-pages tabindex="-1"></div>`;
  const pages = stage.querySelector('[data-pages]');
  const fitW = () => Math.max(0.25, Math.min(4, (pages.clientWidth - 24) / first.width));
  let scale = fitW(), fitting = true, gen = 0;
  const sizes = new Map(); // page → {w, h} at scale 1, as each is learned
  const slots = Array.from({ length: N }, (_, i) => {
    const el = document.createElement('div');
    el.className = 'vpage';
    el.dataset.n = String(i + 1);
    el.setAttribute('aria-label', `Page ${i + 1} of ${N}`);
    pages.appendChild(el);
    return el;
  });
  const size = i => sizes.get(i) || { w: first.width, h: first.height };
  const layout = () => {
    gen++;
    for (const [i, el] of slots.entries()) { const z = size(i + 1); el.style.width = `${Math.floor(z.w * scale)}px`; el.style.height = `${Math.floor(z.h * scale)}px`; el.dataset.done = ''; }
    stage.querySelector('[data-zl]').textContent = `${Math.round(scale * 100)}%`;
  };
  const draw = async el => {
    const n = Number(el.dataset.n), my = gen;
    if (el.dataset.done === String(my)) return;
    el.dataset.done = String(my);
    try {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      if (!sizes.has(n)) { sizes.set(n, { w: base.width, h: base.height }); el.style.width = `${Math.floor(base.width * scale)}px`; el.style.height = `${Math.floor(base.height * scale)}px`; }
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const vp = page.getViewport({ scale: scale * dpr });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
      await page.render({ canvas, viewport: vp }).promise;
      if (my !== gen || !ctx.live()) return;
      el.replaceChildren(canvas);
    } catch (e) { if (my === gen) el.innerHTML = `<span class="hint">Page ${n} didn’t draw (${e.message}).</span>`; }
  };
  const io = new IntersectionObserver(entries => { for (const en of entries) if (en.isIntersecting) draw(en.target); }, { root: pages, rootMargin: '400px 0px' });
  slots.forEach(el => io.observe(el));
  const current = () => {
    const top = pages.scrollTop + 40;
    let n = 1;
    for (const el of slots) { if (el.offsetTop <= top) n = Number(el.dataset.n); else break; }
    return n;
  };
  const label = () => { stage.querySelector('[data-pg]').textContent = `${current()} / ${N}`; };
  pages.addEventListener('scroll', label, { passive: true });
  const goPage = n => { const el = slots[Math.max(0, Math.min(N - 1, n - 1))]; pages.scrollTop = el.offsetTop - 8; label(); };
  const rezoom = next => {
    const at = current();
    scale = next;
    layout();
    slots.forEach(el => { io.unobserve(el); io.observe(el); });
    goPage(at);
  };
  const step = dir => { const next = dir > 0 ? STEPS.find(x => x > scale + 1e-3) : [...STEPS].reverse().find(x => x < scale - 1e-3); if (next) { fitting = false; rezoom(next); } };
  stage.querySelector('[data-p="prev"]').addEventListener('click', () => goPage(current() - 1));
  stage.querySelector('[data-p="next"]').addEventListener('click', () => goPage(current() + 1));
  stage.querySelectorAll('[data-z]').forEach(b => b.addEventListener('click', () => (b.dataset.z === 'fit' ? (fitting = true, rezoom(fitW())) : step(b.dataset.z === '+' ? 1 : -1))));
  const ro = new ResizeObserver(() => { if (fitting && Math.abs(fitW() - scale) > 0.02) rezoom(fitW()); });
  ro.observe(pages);
  layout();
  ctx.setKeys(e => {
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { goPage(current() - 1); return true; }
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { goPage(current() + 1); return true; }
    if (e.key === '+' || e.key === '=') { step(1); return true; }
    if (e.key === '-') { step(-1); return true; }
    return false;
  });
  return () => { io.disconnect(); ro.disconnect(); doc.destroy(); };
}
