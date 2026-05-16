// Admin SPA: TipTap editor wired to /admin/upload + /admin/posts.

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
// CSS side-effect import — esbuild bundles into static/admin/main.js.
import 'cropperjs/dist/cropper.css';

import { hasWebglSupport } from './canvas-loaders';
import { openModal } from './dialog-focus';
import { $, setStatus } from './dom';
import { makeDropHandlers, wireDragOverlay } from './drag-drop';
import { makeCommitFigureAttr, wireDebouncedAttrInput } from './figure-attr-panel';
import { type FigureAttrs, FigureNode } from './figure-node';
import { wireFigureReorder } from './figure-reorder';
import { dirtyImageStates } from './image-edit';
import { wireImageEditPanel } from './image-edit-panel';
import { createImageInserter } from './image-insert';
import { mountMatrixControl } from './matrix-control';
import { initPageTitle } from './page-title.ts';
import { startOfflineInfrastructure } from './startup';
import { mountToolbar } from './toolbar';

function mount(): void {
  // Mount inside <article> so site.css prose typography applies; the
  // outer #rkroll-admin-root keeps the framed-box look.
  const root = $('rkroll-admin-article');
  const toolbar = $('rkroll-admin-toolbar');
  const fileInput = $<HTMLInputElement>('rkr-image-input');

  // Two scoped dialogs: figureDialog (figure-level) and cellDialog
  // (per-image, opened when the author clicks one image).
  const figureDialog = $<HTMLDialogElement>('rkr-figure-dialog');
  const cellDialog = $<HTMLDialogElement>('rkr-cell-dialog');
  const attrIds = $<HTMLInputElement>('rkr-figure-ids');
  // Figure-level inputs.
  const attrCaption = $<HTMLInputElement>('rkr-figure-caption');
  const attrMatrixRoot = $<HTMLDivElement>('rkr-figure-matrix');
  // The arrow captures commitFigureAttr lexically; it's defined later
  // in this scope but only invoked when the user actually picks a layout.
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

  // <h1>+document.title binding (drives the tab-title dirty marker).
  initPageTitle(editor);

  wireDragOverlay($('rkroll-admin-root'));

  // Multi-select so a single +Image → Local pick can populate a
  // whole figure. Playwright bypasses the dialog via setInputFiles.
  fileInput.multiple = true;

  // Source-picker + insertion plumbing in image-insert.ts.
  const inserter = createImageInserter({ editor, fileInput, sourceDialog });

  const syncToolbarActiveStates = mountToolbar({
    editor,
    toolbar,
    insertImage: () => inserter.insertNew(),
    figureOnly: document.body.dataset.mode === 'figure'
  });

  // `populating` guards attribute writes against the feedback loop
  // (selectionUpdate fires on every panel commit). activeCellIndex
  // = user's per-cell pick (null = figure-level). lastFigurePos
  // detects "different figure" so we reset the cell pick.
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

    // Reset cell pick when the active figure changes; same-figure
    // re-selects preserve it.
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

  /** Show/hide the per-cell modal dialog and seed caption + alt
   * inputs from the active cell's pipe-separated slot. */
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
    openModal(cellDialog);
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

  /** Activate the image-edit section for the active cell's id, or
   * deactivate if no cell. Async work lives in image-edit-panel. */
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

  // Clear DOM Ranges that span only non-text content (atoms, breaks,
  // CSS gaps) — Android Firefox pops the OS action bar for those
  // even though Copy yields nothing.
  document.addEventListener('selectionchange', () => {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    // Scope to the article — view.dom is a child of it, so phantom
    // ranges anchored at the article level escape view.dom.contains.
    const anc = range.commonAncestorContainer;
    if (anc !== root && !root.contains(anc)) return;
    if (range.toString().trim() === '') {
      sel.removeAllRanges();
    }
  });

  // In-figure click delegation: data-add-image, data-figure-config,
  // data-figure-delete, img[data-cell-index]. ProseMirror has already
  // set NodeSelection on the figure before this bubble fires.
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
      openModal(figureDialog);
      return;
    }
    if (target.closest('[data-figure-delete]')) {
      ev.preventDefault();
      if (
        !window.confirm(
          'Remove this figure from the post? Image files stay on disk; this post stops referencing them.'
        )
      ) {
        return;
      }
      // Match the placeholder DOM to its figure node via nodeDOM —
      // posAtDOM is ambiguous on atoms (returns a position adjacent
      // to the node, not on it).
      const placeholder = target.closest('.rkr-figure-placeholder');
      if (!placeholder) return;
      let figurePos: number | null = null;
      editor.state.doc.descendants((node, pos) => {
        if (figurePos !== null) return false;
        if (node.type.name === 'figure' && editor.view.nodeDOM(pos) === placeholder) {
          figurePos = pos;
          return false;
        }
        return true;
      });
      if (figurePos === null) return;
      // Blur in the same chain so the editor doesn't auto-restore
      // focus to the article (which would otherwise pop the soft
      // keyboard on touch — same path as the per-cell close fix).
      editor
        .chain()
        .focus()
        .deleteRange({ from: figurePos, to: figurePos + 1 })
        .blur()
        .run();
      // selectionUpdate fires off-figure: activeCellIndex clears
      // and any open dialogs close via the existing !isFigure branch.
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

  // Delegated pointer/keyboard reorder of figure thumbs. Self-contained:
  // a capture-phase click listener swallows the post-drag synthetic
  // click so the tap-to-edit handler above is unaffected.
  wireFigureReorder(editor);

  // Any close path (✕, ESC, backdrop, Save, Delete) clears the
  // active cell so the next figure-level edit isn't stale.
  cellDialog.addEventListener('close', () => {
    if (activeCellIndex === null) return;
    const figurePos = lastFigurePos;
    activeCellIndex = null;
    clearActiveCellHighlight();
    editPanel.deactivate();
    // Collapse the NodeSelection past the atom + blur, so the
    // dialog's focus-return doesn't pop the keyboard or paint a
    // selection rect that touch browsers misread as a real range.
    if (figurePos !== null) {
      editor
        .chain()
        .setTextSelection(figurePos + 1)
        .blur()
        .run();
    } else {
      editor.commands.blur();
    }
  });
  // Backdrop click → close. The native <dialog>::backdrop bubbles
  // on the dialog element itself; ev.target === cellDialog disambiguates.
  cellDialog.addEventListener('click', (ev) => {
    if (ev.target === cellDialog) cellDialog.close();
  });
  // Figure dialog: same backdrop-close, no `close` listener — its
  // state is just the editor's NodeSelection on the figure.
  figureDialog.addEventListener('click', (ev) => {
    if (ev.target === figureDialog) figureDialog.close();
  });

  const commitFigureAttr = makeCommitFigureAttr(editor, () => populating);

  /** Replace one slot of a parallel array (pads with empties). */
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
  wireDebouncedAttrInput({
    key: 'caption',
    input: attrCaption,
    buildValue: () => attrCaption.value,
    commit: (v, h) => commitFigureAttr('caption', v, { addToHistory: h }),
    onInput: warnInlineCap
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
  const cellSlotGuard = (): boolean =>
    !populating && activeCellIndex !== null && editor.isActive('figure');
  wireDebouncedAttrInput({
    key: 'captions',
    input: attrCellCaption,
    buildValue: () => {
      if (!cellSlotGuard() || activeCellIndex === null) return null;
      const cur = (editor.getAttributes('figure') as Partial<FigureAttrs>).captions ?? '';
      return spliceCellSlot(cur, '|', activeCellIndex, attrCellCaption.value);
    },
    commit: (v, h) => commitFigureAttr('captions', v, { addToHistory: h })
  });
  wireDebouncedAttrInput({
    key: 'alts',
    input: attrCellAlt,
    buildValue: () => {
      if (!cellSlotGuard() || activeCellIndex === null) return null;
      const cur = (editor.getAttributes('figure') as Partial<FigureAttrs>).alts ?? '';
      return spliceCellSlot(cur, ',', activeCellIndex, attrCellAlt.value.trim());
    },
    commit: (v, h) => commitFigureAttr('alts', v, { addToHistory: h })
  });

  // Remove the active cell from the figure (image bytes + sidecar
  // stay on disk; only this figure's reference is dropped).
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
    // Walk the doc + setNodeMarkup: avoids the selection-anchor
    // flakiness of the chain helper after a dialog focus shift.
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

  /** Active cell's image id (null when no figure / no cell active).
   * wireImageEditPanel uses this to read live selection at click time. */
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
