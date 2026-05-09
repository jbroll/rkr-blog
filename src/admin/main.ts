// Admin SPA: TipTap editor wired to /admin/upload (insert image) and
// /admin/posts (save). proseToMarkdown converts on save before POST;
// the server's /admin/posts persists the markdown after validation.

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
// CSS side-effect import — esbuild bundles into static/admin/main.js.
import 'cropperjs/dist/cropper.css';

import type { SidecarOp } from '../lib/sidecar-types.ts';
import { hasWebglSupport, refreshImagePreview } from './canvas-loaders';
import { openCropper } from './cropper-modal';
import { $, setStatus } from './dom';
import { makeDropHandlers, wireDragOverlay } from './drag-drop';
import { type FigureAttrs, FigureNode, idCount, singleId } from './figure-node';
import {
  describeOp,
  dirtyImageStates,
  ensureLocalState,
  getLocalEditState,
  isDirty,
  type LocalEditState,
  localDeleteAt,
  localMutate,
  localRedo,
  localUndo,
  saveImageEdits
} from './image-edit';
import { pickFromDrive } from './integrations/gdrive';
import { pickFromOneDrive } from './integrations/onedrive';
import { openPerspective } from './perspective-modal';
import { pickMany, uploadMany } from './pick';
import { handleSave } from './save';
import { uploadImage } from './upload';

function makeButton(label: string, onClick: () => void, name?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (name) b.dataset.cmd = name;
  b.addEventListener('click', onClick);
  return b;
}

function mount(): void {
  // Mount inside the <article> child so site.css's prose typography
  // (max-width, headings, blockquote, hr, code) applies to the editable
  // region. The outer #rkroll-admin-root keeps the framed-box look.
  const root = $('rkroll-admin-article');
  const toolbar = $('rkroll-admin-toolbar');
  const fileInput = $<HTMLInputElement>('rkr-image-input');

  // Unified figure attribute panel.
  const attrPanel = $<HTMLDivElement>('rkr-figure-attrs');
  const attrIds = $<HTMLInputElement>('rkr-figure-ids');
  const attrAlts = $<HTMLTextAreaElement>('rkr-figure-alts');
  const attrCaption = $<HTMLInputElement>('rkr-figure-caption');
  const attrMatrix = $<HTMLInputElement>('rkr-figure-matrix');
  const attrJustify = $<HTMLSelectElement>('rkr-figure-justify');
  const attrWidth = $<HTMLInputElement>('rkr-figure-width');
  const attrAspect = $<HTMLInputElement>('rkr-figure-aspect');
  const attrFit = $<HTMLSelectElement>('rkr-figure-fit');
  const attrTimer = $<HTMLInputElement>('rkr-figure-timer');

  // Image-edit pipeline section — visible when the figure has exactly
  // one image (cropper / rotate / flip / perspective / resample / ops list).
  const imageEditSection = $<HTMLDivElement>('rkr-image-edit');
  const attrCropBtn = $<HTMLButtonElement>('rkr-image-crop-btn');
  const attrRotateLBtn = $<HTMLButtonElement>('rkr-image-rotate-l-btn');
  const attrRotateRBtn = $<HTMLButtonElement>('rkr-image-rotate-r-btn');
  const attrFlipHBtn = $<HTMLButtonElement>('rkr-image-flip-h-btn');
  const attrFlipVBtn = $<HTMLButtonElement>('rkr-image-flip-v-btn');
  const attrPerspBtn = $<HTMLButtonElement>('rkr-image-perspective-btn');
  // Perspective rectify needs WebGL (Canvas2D's setTransform is affine
  // only, so a homography can't be applied without a fragment shader).
  // Detect at mount time and disable the button up front rather than
  // surprising the user with a silent no-op when they save the modal.
  if (!hasWebglSupport()) {
    attrPerspBtn.disabled = true;
    attrPerspBtn.title = 'Perspective rectify requires WebGL; your browser does not support it.';
  }
  const attrUndoBtn = $<HTMLButtonElement>('rkr-image-undo-btn');
  const attrRedoBtn = $<HTMLButtonElement>('rkr-image-redo-btn');
  const attrResampleInput = $<HTMLInputElement>('rkr-image-resample');
  const attrResampleBtn = $<HTMLButtonElement>('rkr-image-resample-btn');
  const attrResetBtn = $<HTMLButtonElement>('rkr-image-reset-btn');
  const attrSaveBtn = $<HTMLButtonElement>('rkr-image-save-btn');
  const attrEditsList = $<HTMLOListElement>('rkr-image-edits');

  const editor = new Editor({
    element: root,
    extensions: [StarterKit, FigureNode],
    content: '<p></p>',
    autofocus: 'end',
    editorProps: makeDropHandlers(() => editor)
  });

  wireDragOverlay($('rkroll-admin-root'));

  /** Multi-upload helper: pick N files, upload, insert one figure with
   * matrix=justified by default. Author edits matrix in the figure
   * panel to convert to 1x1 (carousel), 1x2 (diptych), 1x3 (triptych),
   * NxM, or masonry. */
  async function insertGallery(): Promise<void> {
    const files = await pickMany();
    if (files.length === 0) return;
    try {
      const ids = await uploadMany(files);
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'figure',
          attrs: { ids: ids.join(','), matrix: ids.length > 1 ? 'justified' : '' }
        })
        .run();
      setStatus(`inserted figure with ${ids.length} image(s)`);
    } catch (err) {
      setStatus(`gallery insert failed: ${(err as Error).message}`);
    }
  }

  toolbar.replaceChildren(
    makeButton('B', () => editor.chain().focus().toggleBold().run(), 'bold'),
    makeButton('I', () => editor.chain().focus().toggleItalic().run(), 'italic'),
    makeButton('H2', () => editor.chain().focus().toggleHeading({ level: 2 }).run(), 'h2'),
    makeButton('H3', () => editor.chain().focus().toggleHeading({ level: 3 }).run(), 'h3'),
    makeButton(
      'Link',
      () => {
        const url = prompt('URL?');
        if (!url) return;
        editor.chain().focus().setLink({ href: url }).run();
      },
      'link'
    ),
    makeButton('Image', () => fileInput.click(), 'image'),
    makeButton('Gallery', () => void insertGallery(), 'gallery'),
    makeButton(
      'Drive',
      () => {
        void pickFromDrive(editor).catch((err: unknown) => {
          setStatus(`Drive: ${(err as Error).message}`);
        });
      },
      'gdrive'
    ),
    makeButton(
      'OneDrive',
      () => {
        void pickFromOneDrive(editor).catch((err: unknown) => {
          setStatus(`OneDrive: ${(err as Error).message}`);
        });
      },
      'onedrive'
    ),
    makeButton('Save', () => void handleSave(editor), 'save')
  );

  // Sync active states on selection change. Also reveals the figure
  // attribute panel when a figure is selected, populates every editable
  // field from the node's attrs, and reveals the image-edit pipeline
  // section when the figure has exactly one image. Programmatic updates
  // from panel inputs re-trigger this handler; we guard against
  // feedback loops via `populating`.
  let populating = false;
  editor.on('selectionUpdate', () => {
    for (const b of toolbar.querySelectorAll<HTMLButtonElement>('button[data-cmd]')) {
      const cmd = b.dataset.cmd;
      let active = false;
      if (cmd === 'bold') active = editor.isActive('bold');
      else if (cmd === 'italic') active = editor.isActive('italic');
      else if (cmd === 'h2') active = editor.isActive('heading', { level: 2 });
      else if (cmd === 'h3') active = editor.isActive('heading', { level: 3 });
      else if (cmd === 'link') active = editor.isActive('link');
      b.classList.toggle('is-active', active);
    }

    const isFigure = editor.isActive('figure');
    if (!isFigure) {
      attrPanel.hidden = true;
      return;
    }
    const attrs = editor.getAttributes('figure') as Partial<FigureAttrs>;
    const ids = attrs.ids ?? '';
    const idList = ids
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const altsList = (attrs.alts ?? '').split(',').map((s) => s.trim());
    while (altsList.length < idList.length) altsList.push('');

    populating = true;
    attrIds.value = ids;
    attrAlts.value = altsList.slice(0, Math.max(idList.length, altsList.length)).join('\n');
    attrAlts.rows = Math.min(8, Math.max(3, idList.length));
    attrCaption.value = attrs.caption ?? '';
    attrMatrix.value = attrs.matrix ?? '';
    attrJustify.value = attrs.justify ?? 'center';
    attrWidth.value = attrs.width ?? '';
    attrAspect.value = attrs.aspect ?? '';
    attrFit.value = attrs.fit ?? 'cover';
    attrTimer.value = String(attrs.timer ?? 0);
    populating = false;
    attrPanel.hidden = false;

    // Image-edit pipeline (crop/rotate/flip/perspective/resample) only
    // applies to single-image figures — operations target one
    // originals/<id>. Hide the section otherwise.
    const isSingle = idList.length === 1;
    imageEditSection.hidden = !isSingle;
    attrResetBtn.hidden = true;
    attrResampleInput.value = '';
    attrUndoBtn.disabled = true;
    attrRedoBtn.disabled = true;
    attrSaveBtn.disabled = true;
    attrEditsList.replaceChildren();
    if (isSingle) {
      const id = idList[0] as string;
      void ensureLocalState(id).then(
        (s) => {
          const resample = s.ops.find((o) => o.type === 'resample');
          if (resample && typeof resample.w === 'number') {
            attrResampleInput.value = String(resample.w);
          }
          renderEditsPanel(id, s);
          // Repaint preview from local ops — there might be unsaved
          // edits from a prior selection of this image in this session.
          void refreshImagePreview(editor, id, s.ops);
        },
        () => {
          /* best-effort */
        }
      );
    }
  });

  /** Patch a single figure attr. Field name maps directly to a
   * FigureAttrs key; value is the raw input value (timer is coerced). */
  function commitFigureAttr(name: keyof FigureAttrs, value: string): void {
    if (populating || !editor.isActive('figure')) return;
    const patch: Partial<FigureAttrs> =
      name === 'timer'
        ? { timer: Math.max(0, Math.min(60, Math.floor(Number(value) || 0))) }
        : ({ [name]: value } as Partial<FigureAttrs>);
    editor.chain().focus().updateAttributes('figure', patch).run();
  }
  attrAlts.addEventListener('input', () => {
    const csv = attrAlts.value
      .split('\n')
      .map((s) => s.trim())
      .join(',');
    commitFigureAttr('alts', csv);
  });
  // justify=inline hides figcaption via site.css; warn so the author
  // doesn't watch their caption silently disappear at render time.
  const warnInlineCap = (): void => {
    if (attrJustify.value === 'inline' && attrCaption.value.trim().length > 0) {
      setStatus('warning: justify=inline hides the caption at render time');
    }
  };
  attrCaption.addEventListener('input', () => {
    commitFigureAttr('caption', attrCaption.value);
    warnInlineCap();
  });
  attrMatrix.addEventListener('input', () => commitFigureAttr('matrix', attrMatrix.value));
  attrJustify.addEventListener('change', () => {
    commitFigureAttr('justify', attrJustify.value);
    warnInlineCap();
  });
  attrWidth.addEventListener('input', () => commitFigureAttr('width', attrWidth.value));
  attrAspect.addEventListener('input', () => commitFigureAttr('aspect', attrAspect.value));
  attrFit.addEventListener('change', () => commitFigureAttr('fit', attrFit.value));
  attrTimer.addEventListener('input', () => commitFigureAttr('timer', attrTimer.value));

  function activeImageId(): string | null {
    if (!editor.isActive('figure')) return null;
    const attrs = editor.getAttributes('figure') as Partial<FigureAttrs>;
    if (idCount(attrs.ids) !== 1) return null;
    return singleId(attrs.ids) || null;
  }

  /** Render one row per op (in click order), plus per-row delete buttons,
   * and update the undo/redo/save/reset button states. The id is captured
   * at render time so each delete button is bound to the image whose
   * panel was showing when the row was rendered — selectionUpdate will
   * rebuild the list if the selection changes. */
  function renderEditsPanel(id: string, s: LocalEditState): void {
    attrUndoBtn.disabled = s.ops.length === 0;
    attrRedoBtn.disabled = s.redoStack.length === 0;
    attrResetBtn.hidden = s.ops.length === 0;
    attrSaveBtn.disabled = !isDirty(s);
    const items = s.ops.map((op, idx) => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.className = 'rkr-edits-step';
      span.textContent = `${idx + 1}. ${describeOp(op)}`;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'rkr-edits-del';
      del.textContent = '×';
      del.title = 'Delete this step';
      del.setAttribute('aria-label', `Delete step ${idx + 1}: ${describeOp(op)}`);
      del.addEventListener('click', () => {
        localDeleteAt(s, idx);
        setStatus(`deleted step ${idx + 1}`);
        renderEditsPanel(id, s);
        void refreshImagePreview(editor, id, s.ops);
      });
      li.replaceChildren(span, del);
      return li;
    });
    attrEditsList.replaceChildren(...items);
  }

  /** Re-render the edits list + Save button state from local state, and
   * repaint the editor's <img> via the canvas pipeline. No server I/O —
   * the bake goes up only on Save (see attrSaveBtn handler). */
  function refreshAfterEdit(id: string, s: LocalEditState, label: string): void {
    setStatus(`${label} ${id.slice(0, 8)}…`);
    renderEditsPanel(id, s);
    void refreshImagePreview(editor, id, s.ops);
  }

  /** Mutate the active image's local state. Refuses if no image is
   * selected. Adding any op clears redoStack via localMutate. */
  function runEdit(label: string, mutator: (ops: SidecarOp[]) => SidecarOp[]): void {
    const id = activeImageId();
    if (!id) return;
    const s = getLocalEditState(id);
    if (!s) return;
    localMutate(s, mutator);
    refreshAfterEdit(id, s, label);
  }

  attrCropBtn.addEventListener('click', () => {
    const id = activeImageId();
    if (!id) return;
    const s = getLocalEditState(id);
    if (!s) return;
    void openCropper(id, s, () => {
      refreshAfterEdit(id, s, 'crop');
    });
  });
  attrRotateLBtn.addEventListener('click', () =>
    runEdit('rotate', (ops) => [...ops, { type: 'rotate', degrees: -90 }])
  );
  attrRotateRBtn.addEventListener('click', () =>
    runEdit('rotate', (ops) => [...ops, { type: 'rotate', degrees: 90 }])
  );
  attrFlipHBtn.addEventListener('click', () =>
    runEdit('flip', (ops) => [...ops, { type: 'flip', axis: 'horizontal' }])
  );
  attrFlipVBtn.addEventListener('click', () =>
    runEdit('flip', (ops) => [...ops, { type: 'flip', axis: 'vertical' }])
  );
  attrPerspBtn.addEventListener('click', () => {
    const id = activeImageId();
    if (!id) return;
    const s = getLocalEditState(id);
    if (!s) return;
    void openPerspective(id, s, () => {
      refreshAfterEdit(id, s, 'perspective');
    });
  });
  attrUndoBtn.addEventListener('click', () => {
    const id = activeImageId();
    if (!id) return;
    const s = getLocalEditState(id);
    if (!s) return;
    localUndo(s);
    refreshAfterEdit(id, s, 'undo');
  });
  attrRedoBtn.addEventListener('click', () => {
    const id = activeImageId();
    if (!id) return;
    const s = getLocalEditState(id);
    if (!s) return;
    localRedo(s);
    refreshAfterEdit(id, s, 'redo');
  });
  attrResampleBtn.addEventListener('click', () => {
    const w = Math.floor(Number(attrResampleInput.value) || 0);
    if (w <= 0) {
      // Empty input clears any existing resample op.
      runEdit('resample cleared', (ops) => ops.filter((o) => o.type !== 'resample'));
      return;
    }
    runEdit('resample', (ops) => [
      ...ops.filter((o) => o.type !== 'resample'),
      { type: 'resample', w, fit: 'inside' }
    ]);
  });
  attrResetBtn.addEventListener('click', () => {
    const id = activeImageId();
    if (!id) return;
    const s = getLocalEditState(id);
    if (!s) return;
    localMutate(s, () => []);
    attrResampleInput.value = '';
    refreshAfterEdit(id, s, 'edits reset');
  });
  attrSaveBtn.addEventListener('click', () => {
    const id = activeImageId();
    if (!id) return;
    const s = getLocalEditState(id);
    if (!s || !isDirty(s)) return;
    // Guard against double-clicks during the (potentially multi-MB)
    // bake upload. Re-enabled by renderEditsPanel on success (where
    // isDirty is now false → disabled stays true) or explicitly on
    // failure so the user can retry.
    attrSaveBtn.disabled = true;
    setStatus(`saving edits ${id.slice(0, 8)}…`);
    void saveImageEdits(id, s).then(
      () => {
        renderEditsPanel(id, s);
        setStatus(`saved edits ${id.slice(0, 8)}…`);
      },
      (err: unknown) => {
        attrSaveBtn.disabled = false;
        setStatus(`save edits failed: ${(err as Error).message}`);
      }
    );
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    fileInput.value = '';
    setStatus(`uploading ${file.name}…`);
    try {
      const result = await uploadImage(file);
      // Insert with just the id; author edits the rest via the figure
      // panel that auto-reveals on selection.
      editor
        .chain()
        .focus()
        .insertContent({ type: 'figure', attrs: { ids: result.id } })
        .run();
      setStatus(
        `uploaded ${file.name} (${result.bytes} bytes${result.deduplicated ? ', dedup' : ''})`
      );
    } catch (err) {
      setStatus(`upload error: ${(err as Error).message}`);
    }
  });
}

// Warn on reload / close while any image has unsaved local edits.
// Modern browsers ignore the returned string and show a fixed prompt;
// preventDefault + a non-empty returnValue is the cross-browser idiom.
window.addEventListener('beforeunload', (ev) => {
  if (dirtyImageStates().length === 0) return;
  ev.preventDefault();
  ev.returnValue = '';
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
