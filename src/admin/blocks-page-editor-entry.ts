// Blocks editor entry: hydrates the server-rendered page in place.
// The edit route embeds the canonical tree (#rkr-tree) and renders the
// public body with `rkr:path` markers, so this module only mounts the
// unified shell: no page fetch, no client-side renderer, no iframe
// preview. Structural edits re-render through POST /admin/blocks/_render.
// Same-origin fetch carries the admin session cookie, so no token
// handling is needed here; scripted clients use /admin/blocks/:slug.

import 'cropperjs/dist/cropper.css';

import type { BlockTree } from '../lib/blocks.ts';
import type { PaletteMacro } from './blocks-editor.ts';
import { getPreviewUrl } from './canvas-loaders.ts';
import type { ImageEditorHost, MediaDialogDeps } from './figure-dialog-tree.ts';
import { imageEditPipeline } from './image-edit.ts';
import { type ImageEditPanel, wireImageEditPanel } from './image-edit-panel.ts';
import {
  browserMediaDeps,
  type MediaSourceDeps,
  pickMedia,
  uploadImageDirect
} from './media-source.ts';
import { initOpfsForUnifiedEditor } from './opfs-init-unified.ts';
import { awaitDrainSettled } from './sync.ts';
import { mountUnifiedShell } from './unified-shell.ts';
import { uploadImage } from './upload.ts';
import { uploadVideo } from './video-upload.ts';

const root = document.getElementById('rkr-blocks-edit-root');
const slug = root?.dataset.slug ?? '';

/** The canonical tree the server embedded for this page. */
function embeddedTree(): BlockTree | null {
  const script = document.getElementById('rkr-tree');
  if (!script?.textContent) return null;
  try {
    return JSON.parse(script.textContent) as BlockTree;
  } catch {
    return null;
  }
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`blocks editor: missing #${id}`);
  return el as T;
}

function wirePanel(onPreview: (id: string, url: string) => void, active: () => string | null) {
  return wireImageEditPanel({
    onPreview,
    section: byId<HTMLDivElement>('rkr-image-edit'),
    buttons: {
      crop: byId('rkr-image-crop-btn'),
      rotateL: byId('rkr-image-rotate-l-btn'),
      rotateR: byId('rkr-image-rotate-r-btn'),
      flipH: byId('rkr-image-flip-h-btn'),
      flipV: byId('rkr-image-flip-v-btn'),
      perspective: byId('rkr-image-perspective-btn'),
      undo: byId('rkr-image-undo-btn'),
      redo: byId('rkr-image-redo-btn'),
      reset: byId('rkr-image-reset-btn'),
      resample: byId('rkr-image-resample-btn'),
      tilt: byId('rkr-image-tilt-btn')
    },
    resampleInput: byId('rkr-image-resample'),
    tiltSlider: byId('rkr-image-tilt-slider'),
    tiltInput: byId('rkr-image-tilt-input'),
    editsList: byId('rkr-image-edits'),
    activeImageId: active,
    pipeline: imageEditPipeline
  });
}

/** The page's image-edit section, lent to the figure dialog one image
 * at a time and returned to its hidden stash afterwards. */
function imageEditorHost(): ImageEditorHost {
  const section = byId<HTMLDivElement>('rkr-image-edit');
  const stash = byId('rkr-image-edit-host');
  let active: string | null = null;
  const panel: ImageEditPanel = wirePanel(
    () => {},
    () => active
  );
  return {
    open(id, into) {
      active = id;
      into.append(section);
      panel.activateForId(id, () => active === id);
    },
    apply: () => panel.save(),
    close(discard) {
      if (discard) panel.discard();
      panel.deactivate();
      active = null;
      stash.append(section);
    },
    dirty: () => panel.dirty(),
    previewUrl: getPreviewUrl
  };
}

/** Media deps for the shell. The shell mounts before OPFS is ready, so
 * uploads and the image editor check `opfs()` when they are used. */
function pageMedia(opfs: () => boolean): MediaDialogDeps {
  const posters = new Map<string, string>();
  let editor: ImageEditorHost | undefined;
  const io: Pick<MediaSourceDeps, 'upload' | 'settle'> = {
    upload: async (kind, file) => {
      if (kind === 'image') return opfs() ? (await uploadImage(file)).id : uploadImageDirect(file);
      const video = await uploadVideo(file);
      posters.set(video.id, video.posterUrl);
      return video.id;
    },
    settle: async () => {
      if (opfs()) await awaitDrainSettled();
    }
  };
  return {
    pick: (kind, multiple) => pickMedia(kind, browserMediaDeps(document, multiple, io)),
    thumbUrl: (kind, id) => {
      if (kind === 'image') return `/admin/preview/${id}`;
      const rendered = document.querySelector(`video[poster*="${CSS.escape(id)}"]`);
      return posters.get(id) ?? rendered?.getAttribute('poster') ?? null;
    },
    get imageEditor() {
      if (opfs()) editor ??= imageEditorHost();
      return editor;
    }
  };
}

const tree = embeddedTree();

if (root && slug && tree) {
  const save = async (next: BlockTree): Promise<void> => {
    const res = await fetch(`/admin/blocks/${encodeURIComponent(slug)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tree: next })
    });
    if (!res.ok) throw new Error(`save page ${res.status}`);
  };

  const render = async (next: BlockTree): Promise<string> => {
    const res = await fetch('/admin/blocks/_render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tree: next })
    });
    if (!res.ok) throw new Error(`render page ${res.status}`);
    return ((await res.json()) as { html: string }).html;
  };

  void (async () => {
    try {
      const res = await fetch('/admin/blocks/macros');
      if (!res.ok) throw new Error(`load macros ${res.status}`);
      const macros = (await res.json()) as PaletteMacro[];
      let opfsReady = false;
      mountUnifiedShell(root, {
        tree,
        macros,
        onSave: save,
        render,
        media: pageMedia(() => opfsReady)
      });
      opfsReady = await initOpfsForUnifiedEditor();
    } catch (err: unknown) {
      root.innerHTML = `<p role="alert">Editor failed to load: ${err instanceof Error ? err.message : String(err)}</p>`;
    }
  })();
}
