// Admin SPA: TipTap editor wired to /admin/upload (insert image) and
// /admin/posts (save). proseToMarkdown converts on save before POST;
// the server's /admin/posts persists the markdown after validation.

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
// CSS side-effect import — esbuild bundles into static/admin/main.js.
import 'cropperjs/dist/cropper.css';

import { hasWebglSupport } from './canvas-loaders';
import { $, setStatus } from './dom';
import { makeDropHandlers, wireDragOverlay } from './drag-drop';
import { type FigureAttrs, FigureNode } from './figure-node';
import { dirtyImageStates } from './image-edit';
import { wireImageEditPanel } from './image-edit-panel';
import { createImageInserter } from './image-insert';
import { initCopyLink, initPageTitle } from './page-title.ts';
import { startOfflineInfrastructure } from './startup';
import { mountToolbar } from './toolbar';

function mount(): void {
  // Mount inside the <article> child so site.css's prose typography
  // applies to the editable region; outer #rkroll-admin-root keeps
  // the framed-box look.
  const root = $('rkroll-admin-article');
  const toolbar = $('rkroll-admin-toolbar');
  const fileInput = $<HTMLInputElement>('rkr-image-input');

  // Unified figure attribute panel. Two scoped sections inside it:
  //   data-scope="figure" — figure-level controls (visible when the
  //     figure is selected but no specific cell is active).
  //   data-scope="cell"   — per-image controls (visible when the user
  //     has clicked one image in the figure).
  const attrPanel = $<HTMLDivElement>('rkr-figure-attrs');
  const attrSectionFigure = $<HTMLDivElement>('rkr-figure-attrs-figure');
  const attrSectionCell = $<HTMLDivElement>('rkr-figure-attrs-cell');
  const attrIds = $<HTMLInputElement>('rkr-figure-ids');
  // Figure-level inputs.
  const attrCaption = $<HTMLInputElement>('rkr-figure-caption');
  const attrMatrix = $<HTMLInputElement>('rkr-figure-matrix');
  const attrJustify = $<HTMLSelectElement>('rkr-figure-justify');
  const attrWidth = $<HTMLInputElement>('rkr-figure-width');
  const attrAspect = $<HTMLInputElement>('rkr-figure-aspect');
  const attrFit = $<HTMLSelectElement>('rkr-figure-fit');
  const attrTimer = $<HTMLInputElement>('rkr-figure-timer');
  // Per-cell inputs (active cell only).
  const attrCellCaption = $<HTMLInputElement>('rkr-cell-caption');
  const attrCellAlt = $<HTMLInputElement>('rkr-cell-alt');
  // Source picker dialog (shared by toolbar +Image and the in-figure
  // "+" cell). Resolves to a source choice; the caller drives the
  // resulting upload + insert/append.
  const sourceDialog = $<HTMLDialogElement>('rkr-source-picker');

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

  // Editor-page chrome: <h1>+document.title binding (drives the
  // dirty marker) and the top-right Copy-link button.
  initPageTitle(editor);
  initCopyLink();

  wireDragOverlay($('rkroll-admin-root'));

  // The hidden file input is the local-source entry point. Allow
  // multi-select so a single +Image → Local pick can populate a whole
  // figure. Playwright drives this directly via setInputFiles() in
  // e2e (the source-picker dialog is bypassed entirely in tests).
  fileInput.multiple = true;

  // Source-picker + insertion plumbing lives in image-insert.ts so
  // this file can stay focused on the per-cell attribute panel +
  // image-edit pipeline. The closure carries pendingInsertMode.
  const inserter = createImageInserter({ editor, fileInput, sourceDialog });

  const syncToolbarActiveStates = mountToolbar({
    editor,
    toolbar,
    insertImage: () => inserter.insertNew()
  });

  // selectionUpdate fires on every panel-input commit too, so guard
  // attribute writes against feedback loops via `populating`.
  // activeCellIndex: which image of the figure is currently selected
  // (null until the user clicks one — that applies to single- and
  // multi-image figures alike, so the figure-level panel is the
  // default on selection). lastFigurePos detects "different figure"
  // to reset the cell pick.
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

    populating = true;
    attrIds.value = ids;
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
      activeCellIndex = null;
      clearActiveCellHighlight();
    } else if (activeCellIndex !== null && activeCellIndex >= idList.length) {
      // Author edited `ids` and the previously-active cell no longer
      // exists. Drop selection rather than pointing at a stale id.
      activeCellIndex = null;
      clearActiveCellHighlight();
    }

    syncScopeVisibility(idList);
    populateImageEditForActiveCell(idList);
  });

  /** Toggle the figure-level vs per-cell sections of the attr panel,
   * and seed the per-cell caption/alt inputs from the active cell's
   * pipe-separated entry. */
  function syncScopeVisibility(idList: string[]): void {
    const cellMode = activeCellIndex !== null;
    attrSectionFigure.hidden = cellMode;
    attrSectionCell.hidden = !cellMode;
    if (!cellMode) return;
    const attrs = editor.getAttributes('figure') as Partial<FigureAttrs>;
    const captionsList = (attrs.captions ?? '').split('|');
    const altsList = (attrs.alts ?? '').split(',').map((s) => s.trim());
    const idx = activeCellIndex ?? 0;
    populating = true;
    attrCellCaption.value = captionsList[idx] ?? '';
    attrCellAlt.value = altsList[idx] ?? '';
    populating = false;
    // idList is the source of truth; we only read it here to keep the
    // signature parallel with populateImageEditForActiveCell.
    void idList;
  }

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

  /** Reset the image-edit section, then activate it for the active
   * cell's id (if any). Delegates to image-edit-panel which owns the
   * ensureLocalState fetch + button wiring. */
  function populateImageEditForActiveCell(idList: string[]): void {
    if (activeCellIndex === null || idList.length === 0) {
      editPanel.deactivate();
      return;
    }
    const id = idList[activeCellIndex];
    if (!id) {
      editPanel.deactivate();
      return;
    }
    applyActiveCellHighlight();
    editPanel.activateForId(id, () => idList[activeCellIndex ?? -1] === id);
  }

  // In-figure click delegation. Two shapes:
  //   [data-add-image] — the "+" cell that opens the source picker in
  //                       append mode (append to this figure's ids).
  //   img[data-cell-index] — a thumb; click selects that cell, which
  //                       reveals the per-cell attribute section.
  // ProseMirror handles click-to-select-figure on its own (atom node),
  // so by the time this bubble handler runs the figure is active.
  editor.view.dom.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    if (!editor.isActive('figure')) return;
    if (target.closest('[data-add-image]')) {
      ev.preventDefault();
      void inserter.appendToActive();
      return;
    }
    if (!target.matches('img[data-cell-index]')) return;
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
    syncScopeVisibility(idList);
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

  /** Replace the active cell's slot in a pipe- or comma-separated
   * parallel array, padding earlier slots with empty strings if the
   * array was shorter than the cell index. */
  function spliceCellSlot(current: string, sep: '|' | ',', idx: number, value: string): string {
    const list = current.split(sep);
    while (list.length <= idx) list.push('');
    list[idx] = value;
    return list.join(sep);
  }

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

  // Per-cell caption + alt: edit the slot in the parallel captions
  // (pipe-separated) and alts (comma-separated) arrays.
  attrCellCaption.addEventListener('input', () => {
    if (populating || activeCellIndex === null || !editor.isActive('figure')) return;
    const cur = (editor.getAttributes('figure') as Partial<FigureAttrs>).captions ?? '';
    commitFigureAttr('captions', spliceCellSlot(cur, '|', activeCellIndex, attrCellCaption.value));
  });
  attrCellAlt.addEventListener('input', () => {
    if (populating || activeCellIndex === null || !editor.isActive('figure')) return;
    const cur = (editor.getAttributes('figure') as Partial<FigureAttrs>).alts ?? '';
    commitFigureAttr('alts', spliceCellSlot(cur, ',', activeCellIndex, attrCellAlt.value.trim()));
  });

  /** Resolve the currently-active image id (the id of the cell the
   * author clicked). Returns null when no figure is selected or no
   * cell is active. Passed to wireImageEditPanel so its button
   * handlers can read the live selection at click time. */
  function activeImageId(): string | null {
    if (!editor.isActive('figure')) return null;
    const attrs = editor.getAttributes('figure') as Partial<FigureAttrs>;
    const idList = (attrs.ids ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (activeCellIndex === null || activeCellIndex >= idList.length) return null;
    return idList[activeCellIndex] ?? null;
  }

  const editPanel = wireImageEditPanel({
    editor,
    section: imageEditSection,
    buttons: {
      crop: attrCropBtn,
      rotateL: attrRotateLBtn,
      rotateR: attrRotateRBtn,
      flipH: attrFlipHBtn,
      flipV: attrFlipVBtn,
      perspective: attrPerspBtn,
      undo: attrUndoBtn,
      redo: attrRedoBtn,
      reset: attrResetBtn,
      save: attrSaveBtn,
      resample: attrResampleBtn
    },
    resampleInput: attrResampleInput,
    editsList: attrEditsList,
    activeImageId
  });

  fileInput.addEventListener('change', () => void inserter.handleFileChange());
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
