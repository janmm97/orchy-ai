// Files for an agent's task (Give a task, Follow up): the Files button, or a drop or paste on the box.
// Each file lands in Uploads as soon as it's picked, like the chat box's; when the task starts
// the server copies them into the agent's workspace (uploads.mjs#handToWorkspace).
import { icon } from './pixel.mjs';
import { esc, ownerHeaders } from './util.mjs';

const fsize = n => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');

/**
 * One tray per box. It outlives re-renders: call mount() each time the box is drawn again.
 * opts (the client page sets these): url to upload to, size cap, accepted types, a thumbnail URL for an image
 * (or none), and what ready() hands back for each file (the owner's: its name in Uploads; a client's: its upload id).
 */
export function fileTray(toast, {
  url = '/api/uploads', maxFiles = 10, maxBytes = 50 * 1024 * 1024, accept = '',
  thumb = data => `/api/uploads/${encodeURIComponent(data.name)}`, keyOf = data => data.name, keptHint = 'it stays in Uploads',
} = {}) {
  const list = []; // { key, name, size, status: 'uploading' | 'ready' | 'error', file, kind, ref, thumb }
  let box = null;

  const draw = () => {
    if (!box?.isConnected) return;
    box.innerHTML = list.map(a => `<span class="fchip ${a.status}">
      ${a.status === 'ready' && a.kind === 'image' && a.thumb ? `<img src="${esc(a.thumb)}" alt="">` : icon(a.status === 'error' ? 'bang' : 'doc')}
      <span class="t" title="${esc(a.file || a.name)}">${esc(a.file || a.name)}</span>
      <span class="sz">${a.status === 'uploading' ? 'saving…' : a.status === 'error' ? 'failed' : fsize(a.size)}</span>
      <button type="button" class="x" data-unattach="${esc(a.key)}" aria-label="Take ${esc(a.name)} off this task" title="Take it off this task${keptHint ? ` (${esc(keptHint)})` : ''}">${icon('close')}</button>
    </span>`).join('');
    box.querySelectorAll('[data-unattach]').forEach(b => b.addEventListener('click', () => { list.splice(list.findIndex(a => a.key === b.dataset.unattach), 1); draw(); }));
  };

  const add = files => {
    for (const f of files) {
      if (list.length >= maxFiles) { toast(`Up to ${maxFiles} files per task.`, 'warn'); break; }
      if (f.size > maxBytes) { toast(`${f.name} is over ${Math.round(maxBytes / 1024 / 1024)} MB.`, 'warn'); continue; }
      // pasted screenshots all arrive as "image.png"
      const name = f.name && f.name !== 'image.png' ? f.name : `pasted-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
      const a = { key: Math.random().toString(36).slice(2), name, size: f.size, status: 'uploading' };
      list.push(a);
      fetch(url, { method: 'POST', headers: { ...ownerHeaders(), 'X-File-Name': encodeURIComponent(name), 'Content-Type': 'application/octet-stream' }, body: f })
        .then(async res => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
          Object.assign(a, { status: 'ready', file: data.name, kind: data.kind, ref: keyOf(data), thumb: thumb && thumb(data) });
        })
        .catch(e => { a.status = 'error'; toast(`${name}: ${e.message}`, 'warn'); })
        .finally(draw);
    }
    draw();
  };

  return {
    /** The Files button (with its hidden picker). */
    button: () => `<input type="file" multiple hidden data-tray-input${accept ? ` accept="${esc(accept)}"` : ''}><button type="button" class="btn" data-tray-pick title="Give the agent files: documents, PDFs, images, spreadsheets. You can also drop or paste them on the box.">${icon('clip')}Files</button>`,
    /** Where the file chips go. */
    chips: () => '<div class="attachments" data-tray aria-live="polite"></div>',
    /** Wire the freshly drawn box: `scope` holds the button and chips, `zone` takes drops and pastes. */
    mount(scope, zone) {
      box = scope.querySelector('[data-tray]');
      const input = scope.querySelector('[data-tray-input]');
      scope.querySelector('[data-tray-pick]')?.addEventListener('click', () => input.click());
      input?.addEventListener('change', e => { add([...e.target.files]); e.target.value = ''; });
      if (zone) {
        zone.addEventListener('paste', e => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); add(fs); } });
        let depth = 0;
        zone.addEventListener('dragenter', e => { if (hasFiles(e)) { depth++; zone.dataset.drop = ''; } });
        zone.addEventListener('dragleave', e => { if (hasFiles(e) && --depth <= 0) { depth = 0; delete zone.dataset.drop; } });
        zone.addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
        zone.addEventListener('drop', e => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; delete zone.dataset.drop; add([...e.dataTransfer.files]); });
      }
      draw();
    },
    busy: () => list.some(a => a.status === 'uploading'),
    /** The files ready to go (names in Uploads, or a client's upload ids). */
    ready: () => list.filter(a => a.status === 'ready').map(a => a.ref),
    clear() { list.length = 0; draw(); },
  };
}
