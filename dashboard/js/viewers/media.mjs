// Images, video and audio in the viewer. The browser shows the original whenever it can; the server's media
// pipeline (media.mjs) gives thumbs, fit views for huge images, previews for HEIC/TIFF, posters, and a playable copy
// when the original won't play. Every state shown comes from the server's record (`artifact.media`): "Rendering…"
// while the file still grows, "Making a playable copy… 42%" from ffmpeg's measured progress. Never autoplay.
import { icon } from '../pixel.mjs';
import { esc } from '../util.mjs';
import { fsize, stateHTML, loadingHTML } from '../viewer.mjs';

const NATIVE_IMG = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg']);
const PLAYS = new Set(['mp4', 'm4v', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac']);
const PENDING = new Set(['queued', 'working']);
const STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];
const clock = sec => { const s = Math.round(sec || 0), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`; };

/** The thumbs/posters strip for the other images or videos in this list. */
function stripHTML(ctx, kinds) {
  const list = ctx.items.map((s, i) => ({ s, i })).filter(({ s }) => kinds.includes(s.kind));
  if (list.length < 2) return '';
  return `<div class="vgal" role="list">${list.map(({ s, i }) => {
    const m = s.media || {};
    const src = m.thumb ? s.mediaURL('thumb') : s.kind === 'image' && NATIVE_IMG.has(s.ext) && (s.size || 0) < 3 * 1024 * 1024 ? s.raw : null;
    return `<button class="vthumb" role="listitem" data-go="${i}" ${i === ctx.index ? 'aria-current="true"' : ''} title="${esc(s.name)}">${src ? `<img src="${esc(src)}" alt="" loading="lazy" draggable="false">` : icon(s.kind === 'video' ? 'film' : 'image')}</button>`;
  }).join('')}</div>`;
}
const wireStrip = (stage, ctx) => stage.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => ctx.go(Number(b.dataset.go))));

// ── images: fit / 1:1 / stepped zoom, drag to pan, double-click toggles, a dithered checker under transparency ──
export async function imageView(stage, s, ctx) {
  const m = s.media || {};
  const native = NATIVE_IMG.has(s.ext);
  let fitSrc, fullSrc;
  if (native) { fullSrc = s.raw; fitSrc = m.fit ? s.mediaURL('fit') : s.raw; }
  else if (m.preview) { fullSrc = fitSrc = s.mediaURL('preview'); }
  else if (s.isArtifact && (PENDING.has(m.state) || !m.state)) { stage.innerHTML = loadingHTML('Making a preview…'); return; }
  else { stage.innerHTML = stateHTML('Can’t preview this image', m.error ? `.${s.ext} files don’t open here (${m.error}).` : `.${s.ext} files don’t open here.`, { download: s.download, name: s.name }); return; }
  stage.innerHTML = `
    <div class="vtools">
      <span class="seg"><button data-z="fit" aria-pressed="true">${icon('fit')}Fit</button><button data-z="1" aria-pressed="false">1:1</button></span>
      <button class="btn sm icon" data-z="-" aria-label="Zoom out">${icon('zoomout')}</button><span class="px vzl" data-zl>Fit</span><button class="btn sm icon" data-z="+" aria-label="Zoom in">${icon('zoomin')}</button>
      <span class="hint" data-dims>${m.w ? `${m.w}×${m.h}` : ''}${m.frames > 1 ? ` · ${m.frames} frames` : ''}${m.preview ? ' · preview' : ''}</span>
    </div>
    <div class="vimg" data-box tabindex="-1"><span class="vpix" data-pix><img data-img alt="${esc(s.name)}" draggable="false"></span></div>
    ${stripHTML(ctx, ['image'])}`;
  wireStrip(stage, ctx);
  const box = stage.querySelector('[data-box]'), img = stage.querySelector('[data-img]'), pix = stage.querySelector('[data-pix]'), zl = stage.querySelector('[data-zl]');
  let W = m.w || 0, H = m.h || 0, mode = 'fit', scale = 1;
  const fitScale = () => (W && H ? Math.min(1, (box.clientWidth - 8) / W, (box.clientHeight - 8) / H) : 1);
  const place = (cx = 0.5, cy = 0.5) => {
    const sc = mode === 'fit' ? fitScale() : scale;
    const want = m.fit && sc * W > 2560 ? fullSrc : fitSrc; // the original only loads past what the fit view holds
    if (img.getAttribute('src') !== want) img.src = want;
    pix.style.width = `${Math.max(1, Math.round(W * sc))}px`;
    pix.style.height = `${Math.max(1, Math.round(H * sc))}px`;
    box.classList.toggle('zoomed', mode !== 'fit' && (W * sc > box.clientWidth || H * sc > box.clientHeight));
    zl.textContent = mode === 'fit' ? 'Fit' : `${Math.round(sc * 100)}%`;
    stage.querySelector('[data-z="fit"]').setAttribute('aria-pressed', String(mode === 'fit'));
    stage.querySelector('[data-z="1"]').setAttribute('aria-pressed', String(mode !== 'fit' && scale === 1));
    if (mode !== 'fit') { box.scrollLeft = Math.max(0, W * sc * cx - box.clientWidth / 2); box.scrollTop = Math.max(0, H * sc * cy - box.clientHeight / 2); }
  };
  const zoomTo = (next, cx, cy) => { if (next === 'fit') mode = 'fit'; else { mode = 'zoom'; scale = next; } place(cx, cy); };
  const step = dir => {
    const cur = mode === 'fit' ? fitScale() : scale;
    const next = dir > 0 ? STEPS.find(x => x > cur + 1e-3) : [...STEPS].reverse().find(x => x < cur - 1e-3);
    if (next) zoomTo(next);
  };
  img.addEventListener('load', () => { if (!W) { W = img.naturalWidth; H = img.naturalHeight; stage.querySelector('[data-dims]').textContent = `${W}×${H}`; } place(); }, { once: true });
  img.addEventListener('error', () => { stage.innerHTML = stateHTML('Couldn’t open the image', 'It didn’t load: maybe it was moved or isn’t a real image.', { retry: true, download: s.download, name: s.name }); stage.querySelector('[data-retry]')?.addEventListener('click', ctx.rerender); });
  img.src = fitSrc;
  if (W) place();
  stage.querySelectorAll('[data-z]').forEach(b => b.addEventListener('click', () => (b.dataset.z === '+' ? step(1) : b.dataset.z === '-' ? step(-1) : zoomTo(b.dataset.z === 'fit' ? 'fit' : 1))));
  box.addEventListener('dblclick', e => {
    const r = pix.getBoundingClientRect();
    zoomTo(mode === 'fit' ? 1 : 'fit', (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  });
  // drag to pan
  let drag = null;
  box.addEventListener('pointerdown', e => { if (!box.classList.contains('zoomed')) return; drag = { x: e.clientX, y: e.clientY, l: box.scrollLeft, t: box.scrollTop }; box.setPointerCapture(e.pointerId); box.classList.add('dragging'); });
  box.addEventListener('pointermove', e => { if (!drag) return; box.scrollLeft = drag.l - (e.clientX - drag.x); box.scrollTop = drag.t - (e.clientY - drag.y); });
  const end = () => { drag = null; box.classList.remove('dragging'); };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
  const ro = new ResizeObserver(() => { if (mode === 'fit') place(); });
  ro.observe(box);
  ctx.setKeys(e => {
    if (e.key === '+' || e.key === '=') { step(1); return true; }
    if (e.key === '-') { step(-1); return true; }
    if (e.key === '0') { zoomTo('fit'); return true; }
    if (e.key === '1') { zoomTo(1); return true; }
    return false;
  });
  return () => ro.disconnect();
}

// ── video and audio: the native player in a 1-bit frame ──
function pendingMedia(stage, s, m) {
  const poster = m.poster ? `<img class="vposter" src="${esc(s.mediaURL('poster'))}" alt="">` : '';
  const line = m.state === 'processing' ? `Rendering… · ${fsize(m.bytes)} so far`
    : m.state === 'transcoding' ? 'Making a playable copy… <span data-progress>' + `${m.progress ?? 0}%</span>`
    : m.state === 'remuxing' ? 'Getting it ready to stream…' : s.kind === 'video' ? 'Looking at the video…' : 'Looking at the audio…';
  stage.innerHTML = `<div class="vvideo pending">${poster}<span class="label blink">${line}</span></div>
    <p class="hint vnote">${m.state === 'processing' ? 'The file is still being written; it plays once it’s finished.' : m.state === 'transcoding' ? 'The original stays as it is, and downloads any time.' : ''}</p>`;
}
const BAD = { 'too-big': 'It’s over 4 GB: download it to watch.', 'too-long': 'It’s over 3 hours: download it to watch.', unsupported: 'The browser can’t play this, and no playable copy could be made.', error: 'Making a playable copy failed.', 'no-ffmpeg': 'ffmpeg isn’t installed on this PC, so no previews or copies (set FFMPEG_PATH in .env).' };

// a client's page: the portal never streams video or audio through the tunnel; the file plays from R2
// through a short-lived link (`s.remotePlay()`), or the page says why it can't yet
const REMOTE_WAIT = { preparing: 'Getting it ready to play…', uploading: 'Getting it ready to play…', waiting: 'Getting it ready to play…', error: 'Getting it ready didn’t work this time.' };
async function remoteSource(stage, s, ctx, m) {
  const poster = m.poster ? `<div class="vvideo"><img class="vposter" src="${esc(s.mediaURL('poster'))}" alt=""></div>` : '';
  if (!m.play) {
    if (PENDING.has(m.state) || ['processing', 'transcoding', 'remuxing'].includes(m.state) || !m.state) { pendingMedia(stage, s, m); return null; }
    stage.innerHTML = `${poster}${stateHTML('Can’t play this here', BAD[m.state] && m.state !== 'no-ffmpeg' ? BAD[m.state].replace(/: download it to watch\./, '.') : 'This one can’t be played in the browser. Ask for another format.')}`;
    return null;
  }
  const r = await s.remotePlay();
  if (!ctx.live()) return null;
  if (r.off) { stage.innerHTML = `${poster}${stateHTML('Video playback isn’t switched on yet', r.note || 'The owner has been told. It plays right here once it is.')}`; return null; }
  if (!r.url) {
    stage.innerHTML = `<div class="vvideo pending">${m.poster ? `<img class="vposter" src="${esc(s.mediaURL('poster'))}" alt="">` : ''}<span class="label${r.state === 'error' ? '' : ' blink'}">${esc(REMOTE_WAIT[r.state] || r.message || 'Getting it ready…')}</span></div>${r.state === 'error' ? stateHTML('It isn’t ready', 'Try again in a minute.', { retry: true }) : ''}`;
    stage.querySelector('[data-retry]')?.addEventListener('click', ctx.rerender);
    return null; // the page hears artifact.updated when it's ready, and draws the player then
  }
  return r;
}

async function playerView(stage, s, ctx, tag) {
  const m = s.media || {};
  let src = null, download = s.download, remote = null;
  if (s.remotePlay) {
    remote = await remoteSource(stage, s, ctx, m);
    if (!remote) return;
    src = remote.url;
    download = remote.download;
  } else if (s.isArtifact) {
    if (m.play) src = s.mediaURL('play');
    else if (m.state === 'no-ffmpeg' && PLAYS.has(s.ext)) src = s.raw;
    else if (PENDING.has(m.state) || ['processing', 'transcoding', 'remuxing'].includes(m.state) || !m.state) { pendingMedia(stage, s, m); return; }
    else {
      stage.innerHTML = `${m.poster ? `<div class="vvideo"><img class="vposter" src="${esc(s.mediaURL('poster'))}" alt=""></div>` : ''}${stateHTML('Can’t play this here', `${BAD[m.state] || ''}${m.error ? ` (${m.error})` : ''}`, { download: s.download, name: s.name })}`;
      return;
    }
  } else if (PLAYS.has(s.ext)) src = s.raw;
  else { stage.innerHTML = stateHTML('Can’t play this here', `.${s.ext} files don’t play in the browser.`, { download: s.download, name: s.name }); return; }
  const info = [m.durationSec ? clock(m.durationSec) : '', m.w ? `${m.w}×${m.h}` : '', [m.vcodec, m.acodec].filter(Boolean).join(' / '), m.fps && tag === 'video' ? `${m.fps} fps` : ''].filter(Boolean).map(esc).join(' · ');
  stage.innerHTML = `<div class="vvideo ${tag}"><${tag} controls preload="metadata" playsinline ${m.poster && tag === 'video' ? `poster="${esc(s.mediaURL('poster'))}"` : ''} src="${esc(src)}"></${tag}></div>
    <div class="vinfo hint">${info}${m.play === 'copy' ? ' · <span class="chip">Playing a copy</span>' : ''}${download ? ` · <a href="${esc(download)}" download="${esc(s.name)}">${remote ? 'Download' : 'Download the original'}</a>` : ''}</div>
    ${stripHTML(ctx, [s.kind])}`;
  wireStrip(stage, ctx);
  const el = stage.querySelector(tag);
  let renewed = 0;
  const failed = () => {
    if (!ctx.live() || stage.querySelector('[data-retry]')) return;
    stage.querySelector('.vinfo').insertAdjacentHTML('beforebegin', stateHTML('It didn’t play', 'The browser couldn’t read this file. Download it, or retry.', { retry: true }));
    stage.querySelector('[data-retry]')?.addEventListener('click', ctx.rerender);
  };
  el.addEventListener('error', async () => {
    // an R2 link only lives a few minutes: a seek after that gets a fresh one, once, and carries on where it was
    if (remote && Date.now() - renewed > 30_000) {
      renewed = Date.now();
      try {
        const r = await s.remotePlay();
        if (r.url && ctx.live()) { const t = el.currentTime, paused = el.paused; el.src = r.url; el.currentTime = t; if (!paused) el.play().catch(() => {}); return; }
      } catch {}
    }
    failed();
  });
  ctx.setKeys(e => {
    if (e.target.closest('video, audio') && e.key !== 'f' && e.key !== 'F') return false; // the player's own keys
    if (e.key === ' ') { if (el.paused) el.play().catch(() => {}); else el.pause(); return true; }
    if (e.key === 'ArrowLeft') { el.currentTime = Math.max(0, el.currentTime - 5); return true; }
    if (e.key === 'ArrowRight') { el.currentTime = Math.min(el.duration || 1e9, el.currentTime + 5); return true; }
    if ((e.key === 'f' || e.key === 'F') && tag === 'video') { (document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen()).catch?.(() => {}); return true; }
    return false;
  });
  return () => { el.pause(); el.removeAttribute('src'); el.load(); };
}
// (async: on a client's page the source comes from the portal first)
export const videoView = (stage, s, ctx) => playerView(stage, s, ctx, 'video');
export const audioView = (stage, s, ctx) => playerView(stage, s, ctx, 'audio');
