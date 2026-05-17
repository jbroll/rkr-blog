// Per-cell delete wiring for the admin editor. Extracted verbatim
// from main.ts's mount() so that file stays under the 500-line size
// cap. Pure move: the handler body is byte-identical to the original
// inline block; the only mechanical change is that `activeCellIndex`
// (a `let` main.ts owns and this handler clears) is passed as a
// get/set accessor pair rather than captured lexically.

import type { Editor } from '@tiptap/core';

import type { FigureAttrs } from './figure-node.ts';

export interface CellDeleteDeps {
  editor: Editor;
  attrCellDeleteBtn: HTMLButtonElement;
  cellDialog: HTMLDialogElement;
  /** main.ts owns activeCellIndex; this handler clears it on delete. */
  getActiveCellIndex: () => number | null;
  setActiveCellIndex: (idx: number | null) => void;
  clearActiveCellHighlight: () => void;
}

/** Wire the per-cell delete button: remove the active cell from the
 * figure (image bytes + sidecar stay on disk; only this figure's
 * reference is dropped). Pure move of the original main.ts block. */
export function wireCellDelete(deps: CellDeleteDeps): void {
  const {
    editor,
    attrCellDeleteBtn,
    cellDialog,
    getActiveCellIndex,
    setActiveCellIndex,
    clearActiveCellHighlight
  } = deps;

  attrCellDeleteBtn.addEventListener('click', () => {
    const activeCellIndex = getActiveCellIndex();
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
    setActiveCellIndex(null);
    if (cellDialog.open) cellDialog.close();
    clearActiveCellHighlight();
  });
}
