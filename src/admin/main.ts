// Admin SPA: TipTap editor wired to /admin/upload (insert image) and
// /admin/posts (save). proseToMarkdown converts on save before POST;
// the server's /admin/posts persists the markdown after validation.

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
// CSS side-effect import — esbuild bundles into static/admin/main.js.
import 'cropperjs/dist/cropper.css';

import {
  describeOp,
  isDirty,
  type LocalEditState,
  localDeleteAt,
  localMutate,
  localRedo,
  localUndo
} from '../lib/image-edit-ops.ts';
import type { SidecarOp } from '../lib/sidecar-types.ts';
import { hasWebglSupport, refreshImagePreview } from './canvas-loaders';
import { openCropper } from './cropper-modal';
import { $, setStatus } from './dom';
import { makeDropHandlers, wireDragOverlay } from './drag-drop';
import { type FigureAttrs, FigureNode } from './figure-node';
import {
  dirtyImageStates,
  ensureLocalState,
  getLocalEditState,
  persistImageState,
  saveImageEdits
} from './image-edit';
import { openPerspective } from './perspective-modal';
import { pickMany, uploadMany } from './pick';
import { startOfflineInfrastructure } from './startup';
import { mountToolbar } from './toolbar';
import { uploadImage } from './upload';

function mount(): void {
  // Mount inside the <article> child so site.css's prose typography
  // applies to the editable region; outer #rkroll-admin-root keeps
  // the framed-box look.
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
  // Perspective requires WebGL (Canvas2D can't do homographies).
  // Disable up front rather than letting clicks silently no-op.
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

  // `editor: Editor` annotation breaks the TS self-reference cycle
  // through makeDropHandlers' `() => editor` closure.
  const editor: Editor = new Editor({
    element: root,
    extensions: [StarterKit, FigureNode],
    content: '<p></p>',
    autofocus: 'end',
    editorProps: makeDropHandlers(() => editor)
  });

  // OPFS init + draft restore + outbox + online-state. Runs after
  // editor construction so draft restore can setContent. Handles
  // ?e2e=1 hook exposure internally.
  void startOfflineInfrastructure(editor);

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

  const syncToolbarActiveStates = mountToolbar({ editor, toolbar, fileInput, insertGallery });

  // selectionUpdate fires on every panel-input commit too, so guard
  // attribute writes against feedback loops via `populating`.
  // activeCellIndex: which cell of a multi-image figure is selected
  // (auto-0 for single-image; null until the user clicks a thumb in
  // multi-image). lastFigurePos detects "different figure" to reset.
  let populating = false;
  let activeCellIndex: number | null = null;
  let lastFigurePos: number | null = null;

  editor.on('selectionUpdate', () => {
    syncToolbarActiveStates();

    const isFigure = editor.isActive('figure');
    if (!isFigure) {
      attrPanel.hidden = true;
      imageEditSection.hidden = true;
      activeCellIndex = null;
      lastFigurePos = null;
      clearActiveCellHighlight();
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

    // Reset cell selection when the active figure changes (different
    // node position). Same-figure re-selects (e.g. attribute edits
    // re-trigger selectionUpdate) preserve the user's cell pick.
    const figurePos = editor.state.selection.from;
    if (figurePos !== lastFigurePos) {
      lastFigurePos = figurePos;
      // Single-image: implicit cell 0. Multi: clear and wait for a click.
      activeCellIndex = idList.length === 1 ? 0 : null;
      clearActiveCellHighlight();
    } else if (activeCellIndex !== null && activeCellIndex >= idList.length) {
      // Author edited `ids` and the previously-active cell no longer
      // exists. Drop selection rather than pointing at a stale id.
      activeCellIndex = null;
      clearActiveCellHighlight();
    }

    populateImageEditForActiveCell(idList);
  });

  /** Highlight the data-cell-index thumb that matches activeCellIndex,
   * clearing any prior highlight. No-op when activeCellIndex is null. */
  function applyActiveCellHighlight(): void {
    clearActiveCellHighlight();
    if (activeCellIndex === null) return;
    for (const img of editor.view.dom.querySelectorAll<HTMLImageElement>(
      `img[data-cell-index="${activeCellIndex}"]`
    )) {
      img.classList.add('is-active-cell');
    }
  }
  function clearActiveCellHighlight(): void {
    for (const img of editor.view.dom.querySelectorAll<HTMLImageElement>('.is-active-cell')) {
      img.classList.remove('is-active-cell');
    }
  }

  /** Reset the image-edit section to its empty state, then if a cell is
   * active populate it with that cell's id state (lazy fetch via
   * ensureLocalState). Multi-image figures with no active cell just
   * leave the section hidden. */
  function populateImageEditForActiveCell(idList: string[]): void {
    attrResetBtn.hidden = true;
    attrResampleInput.value = '';
    attrUndoBtn.disabled = true;
    attrRedoBtn.disabled = true;
    attrSaveBtn.disabled = true;
    attrEditsList.replaceChildren();
    if (activeCellIndex === null || idList.length === 0) {
      imageEditSection.hidden = true;
      return;
    }
    const id = idList[activeCellIndex];
    if (!id) {
      imageEditSection.hidden = true;
      return;
    }
    imageEditSection.hidden = false;
    applyActiveCellHighlight();
    void ensureLocalState(id).then(
      (s) => {
        // Selection may have moved on while the meta fetch was in
        // flight; only paint if we're still on the same cell.
        if (idList[activeCellIndex ?? -1] !== id) return;
        const resample = s.ops.find((o) => o.type === 'resample');
        if (resample && typeof resample.w === 'number') {
          attrResampleInput.value = String(resample.w);
        }
        renderEditsPanel(id, s);
        // Repaint the cell preview from local ops — there might be
        // unsaved edits from a prior selection of this image in this
        // session.
        void refreshImagePreview(editor, id, s.ops);
      },
      () => {
        /* best-effort */
      }
    );
  }

  // Per-cell click delegation. Only fires for thumbs INSIDE the
  // currently-selected figure node — clicks on other figures are
  // handled by ProseMirror's normal click-to-select-node path, and the
  // resulting selectionUpdate above will reset our cell state.
  editor.view.dom.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target?.matches('img[data-cell-index]')) return;
    if (!editor.isActive('figure')) return;
    const idxRaw = target.dataset.cellIndex;
    const idx = Number(idxRaw);
    if (!Number.isInteger(idx) || idx < 0) return;
    const attrs = editor.getAttributes('figure') as Partial<FigureAttrs>;
    const idList = (attrs.ids ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (idx >= idList.length) return;
    activeCellIndex = idx;
    populateImageEditForActiveCell(idList);
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
    const idList = (attrs.ids ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (idList.length === 0) return null;
    // Single-image figures: cell 0 is implicit so callers don't need
    // to track activeCellIndex. Multi-image figures: only return when
    // a cell is explicitly active (clicked) — otherwise the edit
    // buttons would no-op silently and confuse the author.
    if (idList.length === 1) return idList[0] ?? null;
    if (activeCellIndex === null || activeCellIndex >= idList.length) return null;
    return idList[activeCellIndex] ?? null;
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
        refreshAfterEdit(id, s, `deleted step ${idx + 1}`);
      });
      li.replaceChildren(span, del);
      return li;
    });
    attrEditsList.replaceChildren(...items);
  }

  /** Re-render the edits list + Save button state, persist to OPFS
   * (reload restores unsaved edits), and repaint the editor's <img>
   * via the canvas pipeline. The bake goes up only on Save. */
  function refreshAfterEdit(id: string, s: LocalEditState, label: string): void {
    setStatus(`${label} ${id.slice(0, 8)}…`);
    renderEditsPanel(id, s);
    persistImageState(id, s);
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

  /** Run `fn(id, state)` only when the active cell has a resolved id
   * AND its local state has been fetched. Collapses the id+state guard
   * pattern shared across all 7 image-edit click handlers. */
  function runWithState(fn: (id: string, s: LocalEditState) => void): void {
    const id = activeImageId();
    if (!id) return;
    const s = getLocalEditState(id);
    if (!s) return;
    fn(id, s);
  }

  attrCropBtn.addEventListener('click', () =>
    runWithState((id, s) => void openCropper(id, s, () => refreshAfterEdit(id, s, 'crop')))
  );
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
  attrPerspBtn.addEventListener('click', () =>
    runWithState(
      (id, s) => void openPerspective(id, s, () => refreshAfterEdit(id, s, 'perspective'))
    )
  );
  attrUndoBtn.addEventListener('click', () =>
    runWithState((id, s) => {
      localUndo(s);
      refreshAfterEdit(id, s, 'undo');
    })
  );
  attrRedoBtn.addEventListener('click', () =>
    runWithState((id, s) => {
      localRedo(s);
      refreshAfterEdit(id, s, 'redo');
    })
  );
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
  attrResetBtn.addEventListener('click', () =>
    runWithState((id, s) => {
      localMutate(s, () => []);
      attrResampleInput.value = '';
      refreshAfterEdit(id, s, 'edits reset');
    })
  );
  attrSaveBtn.addEventListener('click', () =>
    runWithState((id, s) => {
      if (!isDirty(s)) return;
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
    })
  );

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
