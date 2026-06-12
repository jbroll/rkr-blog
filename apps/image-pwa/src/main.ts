// Standalone image-editor PWA entry. Pick/drop an image, edit it with the same
// pipeline + modals as the blog editor (via @rkr/image-edit), download the
// result. Fully client-side: no server, no persistence — reload starts fresh.

import 'cropperjs/dist/cropper.css';
import './style.css';
import { PipelineCache, resizeForUpload } from '@rkr/image-edit/canvas';
import { createMemoryState } from './memory-edit-state.ts';
import { mountToolbar } from './toolbar.ts';

const fileInput = document.getElementById('file') as HTMLInputElement;
const preview = document.getElementById('preview') as HTMLImageElement;
const toolbar = document.getElementById('toolbar') as HTMLElement;
const empty = document.getElementById('empty');

function setStatus(msg: string, isError = false): void {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('is-error', isError);
}

async function loadFile(file: File): Promise<void> {
  setStatus('loading…');
  let bitmap: ImageBitmap;
  try {
    // EXIF-bake + long-edge clamp, same as the blog's upload ingest; falls back
    // to the raw file for formats resizeForUpload declines (SVG, animated GIF).
    const resized = await resizeForUpload(file);
    bitmap = await createImageBitmap(resized?.blob ?? file);
  } catch (err) {
    setStatus(`load failed: ${(err as Error).message}`, true);
    return;
  }

  const source = { drawable: bitmap, width: bitmap.width, height: bitmap.height };
  const pipeline = new PipelineCache();
  const mem = createMemoryState(bitmap.width, bitmap.height);
  const renderPreview = (): void => {
    const canvas = pipeline.apply(source, mem.state.ops);
    preview.src = canvas.toDataURL();
  };
  mem.onChange = renderPreview;

  empty?.setAttribute('hidden', '');
  toolbar.hidden = false;
  preview.hidden = false;
  mountToolbar(toolbar, {
    mem,
    pipeline,
    source,
    inputName: file.name,
    renderPreview,
    onStatus: setStatus
  });
  setStatus(`${file.name} — ${bitmap.width}×${bitmap.height}`);
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void loadFile(file);
});

document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file) void loadFile(file);
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./dist/sw.js').catch(() => {});
}
