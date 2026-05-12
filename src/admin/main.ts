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
import { mountMatrixControl } from './matrix-control';
import { initPageTitle } from './page-title.ts';
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
  const figureDialog = $<HTMLDialogElement>('rkr-figure-dialog');
  const cellDialog = $<HTMLDialogElement>('rkr-cell-dialog');
  const attrIds = $<HTMLInputElement>('rkr-figure-ids');
  // Figure-level inputs.
  const attrCaption = $<HTMLInputElement>('rkr-figure-caption');
  const attrMatrixRoot = $<HTMLDivElement>('rkr-figure-matrix');
  // The matrix control compiles its radio + spinbox state into the
  // wire-format string the figure attribute carries. commitFigureAttr
  // is hoisted (function declaration) so the forward reference is
  // safe; the call still no-ops while `populating` is true.
  const matrixControl = mountMatrixControl(attrMatrixRoot, (raw) =>
    commitFigureAttr('matrix', raw)
  );
  const attrJustify = $<HTMLSelectElement>('rkr-figure-justify');
  const attrWidth = $<HTMLInputElement>('rkr-figure-width');
  const attrAspect = $<HTMLInputElement>('rkr-figure-aspect');
  const attrFit = $<HTMLSelectElement>('rkr-figure-fit');
  const attrTimer = $<HTMLInputElement>('rkr-figure-timer');
  // Per-cell inputs (active cell only).
  const attrCellCaption = $<HTMLInputElement>('rkr-cell-caption');
  const attrCellAlt = $<HTMLInputElement>('rkr-cell-alt');
  const attrCellDeleteBtn = $<HTMLButtonElement>('rkr-cell-delete-btn');
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
  // dirty marker on the tab title).
  initPageTitle(editor);

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
      imageEditSection.hidden = true;
      activeCellIndex = null;
      lastFigurePos = null;
      clearActiveCellHighlight();
      if (cellDialog.open) cellDialog.close();
      if (figureDialog.open) figureDialog.close();
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
    matrixControl.setFromRaw(attrs.matrix ?? '');
    attrJustify.value = attrs.justify ?? 'center';
    attrWidth.value = attrs.width ?? '';
    attrAspect.value = attrs.aspect ?? '';
    attrFit.value = attrs.fit ?? 'cover';
    attrTimer.value = String(attrs.timer ?? 0);
    populating = false;

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

  /** Show/hide the per-cell modal dialog. Open when a cell is
   * selected (showModal native-stacks above the side panel + traps
   * focus); close clears activeCellIndex via the dialog's own close
   * listener so the figure-level state is consistent. Also seeds the
   * caption + alt inputs from the active cell's pipe-separated entry. */
  function syncScopeVisibility(idList: string[]): void {
    const cellMode = activeCellIndex !== null;
    if (!cellMode) {
      if (cellDialog.open) cellDialog.close();
      return;
    }
    const attrs = editor.getAttributes('figure') as Partial<FigureAttrs>;
    const captionsList = (attrs.captions ?? '').split('|');
    const altsList = (attrs.alts ?? '').split(',').map((s) => s.trim());
    const idx = activeCellIndex ?? 0;
    populating = true;
    attrCellCaption.value = captionsList[idx] ?? '';
    attrCellAlt.value = altsList[idx] ?? '';
    populating = false;
    if (!cellDialog.open) cellDialog.showModal();
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
  //   [data-figure-config] — the gear button that opens the figure-
  //                       level config dialog. Selection-update has
  //                       already populated its inputs.
  //   img[data-cell-index] — a thumb; click opens the per-image
  //                       dialog scoped to that cell.
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
    if (target.closest('[data-figure-config]')) {
      ev.preventDefault();
      if (!figureDialog.open) figureDialog.showModal();
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

  // Dialog teardown: any close path (✕ button, ESC, or backdrop click
  // via the listener below) clears the active cell so the next
  // figure-level edit doesn't keep stale per-cell state. The dialog's
  // <form method="dialog"> submit fires `close` natively.
  cellDialog.addEventListener('close', () => {
    if (activeCellIndex === null) return;
    activeCellIndex = null;
    clearActiveCellHighlight();
    editPanel.deactivate();
  });
  // Backdrop click → close. Native <dialog>::backdrop intercepts the
  // click and bubbles it on the dialog element itself; comparing
  // event.target to the dialog distinguishes that from a click on a
  // child input/button.
  cellDialog.addEventListener('click', (ev) => {
    if (ev.target === cellDialog) cellDialog.close();
  });
  // Figure dialog uses the same backdrop-click-to-close pattern; no
  // `close` listener needed since the dialog state doesn't shadow
  // anything in the editor (no activeFigureIndex equivalent — the
  // ProseMirror selection IS the source of truth for "which figure").
  figureDialog.addEventListener('click', (ev) => {
    if (ev.target === figureDialog) figureDialog.close();
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

  // Remove the active cell from the figure. The image bytes + sidecar
  // stay on disk (other posts may reference the same id); only this
  // figure's reference is dropped. Confirm before splicing so a stray
  // click can't blow away unsaved per-cell edits or attributes.
  attrCellDeleteBtn.addEventListener('click', () => {
    if (activeCellIndex === null || !editor.isActive('figure')) return;
    if (
      !window.confirm(
        'Remove this image from the figure? The image file is kept; only this figure stops referencing it.'
      )
    ) {
      return;
    }
    const attrs = editor.getAttributes('figure') as Partial<FigureAttrs>;
    const ids = (attrs.ids ?? '').split(',').map((s) => s.trim());
    const alts = (attrs.alts ?? '').split(',').map((s) => s.trim());
    const captions = (attrs.captions ?? '').split('|');
    const idx = activeCellIndex;
    if (idx < ids.length) ids.splice(idx, 1);
    if (idx < alts.length) alts.splice(idx, 1);
    if (idx < captions.length) captions.splice(idx, 1);
    while (alts.length > ids.length) alts.pop();
    while (captions.length > ids.length) captions.pop();
    const patch = {
      ids: ids.filter(Boolean).join(','),
      alts: alts.join(','),
      captions: captions.join('|')
    };
    // setNodeMarkup directly: walking the doc to find the figure by
    // ids-set avoids the selection-anchor flakiness of the chain
    // helper, which silently no-ops when ProseMirror's selection has
    // drifted off the atom (e.g. after a focus-stealing dialog click).
    const preIds = attrs.ids ?? '';
    editor.commands.command(({ tr, state, dispatch }) => {
      let target: number | null = null;
      state.doc.descendants((node, pos) => {
        if (node.type.name === 'figure' && target === null) {
          const nodeIds = (node.attrs.ids as string | undefined) ?? '';
          if (nodeIds === preIds) target = pos;
        }
        return target === null;
      });
      if (target === null) return false;
      if (dispatch) {
        const node = state.doc.nodeAt(target);
        if (!node) return false;
        dispatch(tr.setNodeMarkup(target, undefined, { ...node.attrs, ...patch }));
      }
      return true;
    });
    activeCellIndex = null;
    if (cellDialog.open) cellDialog.close();
    clearActiveCellHighlight();
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
