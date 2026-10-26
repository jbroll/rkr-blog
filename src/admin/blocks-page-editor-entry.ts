// Blocks editor entry: hydrates the server-rendered page in place.
// The edit route embeds the canonical tree (#rkr-tree) and renders the
// public body with `rkr:path` markers, so this module only mounts the
// unified shell: no page fetch, no client-side renderer, no iframe
// preview. Structural edits re-render through POST /admin/blocks/_render.
// Same-origin fetch carries the admin session cookie, so no token
// handling is needed here; scripted clients use /admin/blocks/:slug.

import 'cropperjs/dist/cropper.css';

import type { BlockTree } from '../lib/blocks.ts';
import { EDITOR_SAVED } from '../site/sw-admin-core.ts';
import type { PaletteMacro } from './blocks-editor.ts';
import { getPreviewUrl, hasWebglSupport } from './canvas-loaders.ts';
import { createRecache, guardUnload, shouldWarnOnLeave } from './editor-leave.ts';
import type { ImageEditorHost, MediaDialogDeps } from './figure-dialog-tree.ts';
import { imageEditPipeline } from './image-edit.ts';
import { type ImageEditPanel, wireImageEditPanel } from './image-edit-panel.ts';
import { readLocalOriginal } from './local-thumb.ts';
import {
  browserMediaDeps,
  type MediaSourceDeps,
  pickMedia,
  uploadImageDirect
} from './media-source.ts';
import { initOpfsForUnifiedEditor } from './opfs-init-unified.ts';
import { awaitDrainSettled } from './sync.ts';
import { indexedDbDraftStore } from './unified-draft.ts';
import { SaveConflict, SaveFailure, SaveOffline } from './unified-save.ts';
import { mountUnifiedShell } from './unified-shell.ts';
import { uploadImage } from './upload.ts';
import { uploadVideo } from './video-upload.ts';

const SLUG_TAKEN = 'Not saved. Another page already uses this address.';

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
  // Straighten is a homography; Canvas2D can't draw one.
  const straighten = byId<HTMLButtonElement>('rkr-image-perspective-btn');
  if (!hasWebglSupport()) {
    straighten.disabled = true;
    straighten.title = 'Straighten needs WebGL, which this browser does not support.';
  }
  return wireImageEditPanel({
    onPreview,
    section: byId<HTMLDivElement>('rkr-image-edit'),
    buttons: {
      crop: byId('rkr-image-crop-btn'),
      rotateL: byId('rkr-image-rotate-l-btn'),
      rotateR: byId('rkr-image-rotate-r-btn'),
      flipH: byId('rkr-image-flip-h-btn'),
      flipV: byId('rkr-image-flip-v-btn'),
      perspective: straighten,
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
let imageEditor: ImageEditorHost | undefined;

function pageMedia(opfs: () => boolean): MediaDialogDeps {
  const posters = new Map<string, string>();
  const localThumbs = new Map<string, string>();
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
    localThumbUrl: async (id) => {
      if (!opfs()) return null;
      const cached = localThumbs.get(id);
      if (cached) return cached;
      const blob = await readLocalOriginal(id);
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      localThumbs.set(id, url);
      return url;
    },
    get imageEditor() {
      if (opfs()) imageEditor ??= imageEditorHost();
      return imageEditor;
    }
  };
}

// The service worker re-caches this page after saves, so an offline
// reload opens the saved tree rather than the one first loaded.
const recache = createRecache({
  win: window,
  doc: document,
  timers: window,
  post: () => {
    navigator.serviceWorker?.controller?.postMessage({
      type: EDITOR_SAVED,
      path: location.pathname
    });
  }
});

const tree = embeddedTree();

if (root && slug && tree) {
  const save = async (next: BlockTree, baseVersion?: string): Promise<string | undefined> => {
    let res: Response;
    try {
      res = await fetch(`/admin/blocks/${encodeURIComponent(slug)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tree: next, baseVersion })
      });
    } catch {
      // fetch itself rejects only when the request never got a response.
      throw new SaveOffline();
    }
    const reply = (await res.json().catch(() => ({}))) as { error?: unknown; version?: unknown };
    const version = typeof reply.version === 'string' ? reply.version : undefined;
    if (res.status === 409 && reply.error === 'conflict' && version)
      throw new SaveConflict(version);
    if (res.status === 409) throw new SaveFailure(SLUG_TAKEN);
    if (!res.ok) throw new Error(`save page ${res.status}`);
    recache.request();
    return version;
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

  const drafts = indexedDbDraftStore(slug);
  let deleted = false;
  const deletePage = async (): Promise<void> => {
    const res = await fetch(`/admin/blocks/${encodeURIComponent(slug)}/delete`, {
      method: 'POST'
    });
    if (!res.ok) throw new Error(`delete page ${res.status}`);
    deleted = true;
    await drafts.clear().catch(() => {});
    location.assign('/admin/blocks');
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
        version: root.dataset.version,
        drafts,
        onSave: save,
        onDelete: deletePage,
        render,
        media: pageMedia(() => opfsReady)
      });
      guardUnload(
        window,
        () =>
          !deleted &&
          shouldWarnOnLeave({
            saveState:
              root.querySelector('#rkr-unified-shell')?.getAttribute('data-save-state') ?? null,
            imageDirty: imageEditor?.dirty() ?? false
          })
      );
      opfsReady = await initOpfsForUnifiedEditor();
    } catch (err: unknown) {
      root.innerHTML = `<p role="alert">Editor failed to load: ${err instanceof Error ? err.message : String(err)}</p>`;
    }
  })();
}
