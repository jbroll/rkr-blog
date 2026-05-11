// Image-edit pipeline UI: the crop / rotate / flip / perspective /
// resample / undo / redo / save / reset buttons + the ordered edit-
// steps list. Scoped to whichever image cell the author has clicked;
// main.ts owns the active-cell state and calls `activateForId`
// after each selection / click change.

import type { Editor } from '@tiptap/core';

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
import { refreshImagePreview } from './canvas-loaders';
import { openCropper } from './cropper-modal';
import { setStatus } from './dom';
import {
  ensureLocalState,
  getLocalEditState,
  persistImageState,
  saveImageEdits
} from './image-edit';
import { openPerspective } from './perspective-modal';

interface ImageEditPanelButtons {
  crop: HTMLButtonElement;
  rotateL: HTMLButtonElement;
  rotateR: HTMLButtonElement;
  flipH: HTMLButtonElement;
  flipV: HTMLButtonElement;
  perspective: HTMLButtonElement;
  undo: HTMLButtonElement;
  redo: HTMLButtonElement;
  reset: HTMLButtonElement;
  save: HTMLButtonElement;
  resample: HTMLButtonElement;
}

export interface ImageEditPanelDeps {
  editor: Editor;
  section: HTMLDivElement;
  buttons: ImageEditPanelButtons;
  resampleInput: HTMLInputElement;
  editsList: HTMLOListElement;
  /** Read the currently-active image id (null when no cell is
   * selected). Called at click time so the latest selection is used. */
  activeImageId: () => string | null;
}

export interface ImageEditPanel {
  /** Fetch local state for `id`, render the edits list, repaint the
   * editor preview, and reveal the panel. `stillCurrent` is checked
   * after the async fetch resolves; if it returns false the paint is
   * skipped (selection moved on while we were waiting). */
  activateForId(id: string, stillCurrent: () => boolean): void;
  /** Hide the panel and clear its contents. */
  deactivate(): void;
}

export function wireImageEditPanel(deps: ImageEditPanelDeps): ImageEditPanel {
  const { editor, section, buttons, resampleInput, editsList, activeImageId } = deps;

  /** Render one row per op (in click order), plus per-row delete
   * buttons, and update the undo/redo/save/reset button states. */
  function renderEditsPanel(id: string, s: LocalEditState): void {
    buttons.undo.disabled = s.ops.length === 0;
    buttons.redo.disabled = s.redoStack.length === 0;
    buttons.reset.hidden = s.ops.length === 0;
    buttons.save.disabled = !isDirty(s);
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
    editsList.replaceChildren(...items);
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
   * AND its local state has been fetched. Collapses the id+state
   * guard shared by all the click handlers below. */
  function runWithState(fn: (id: string, s: LocalEditState) => void): void {
    const id = activeImageId();
    if (!id) return;
    const s = getLocalEditState(id);
    if (!s) return;
    fn(id, s);
  }

  buttons.crop.addEventListener('click', () =>
    runWithState((id, s) => void openCropper(id, s, () => refreshAfterEdit(id, s, 'crop')))
  );
  buttons.rotateL.addEventListener('click', () =>
    runEdit('rotate', (ops) => [...ops, { type: 'rotate', degrees: -90 }])
  );
  buttons.rotateR.addEventListener('click', () =>
    runEdit('rotate', (ops) => [...ops, { type: 'rotate', degrees: 90 }])
  );
  buttons.flipH.addEventListener('click', () =>
    runEdit('flip', (ops) => [...ops, { type: 'flip', axis: 'horizontal' }])
  );
  buttons.flipV.addEventListener('click', () =>
    runEdit('flip', (ops) => [...ops, { type: 'flip', axis: 'vertical' }])
  );
  buttons.perspective.addEventListener('click', () =>
    runWithState(
      (id, s) => void openPerspective(id, s, () => refreshAfterEdit(id, s, 'perspective'))
    )
  );
  buttons.undo.addEventListener('click', () =>
    runWithState((id, s) => {
      localUndo(s);
      refreshAfterEdit(id, s, 'undo');
    })
  );
  buttons.redo.addEventListener('click', () =>
    runWithState((id, s) => {
      localRedo(s);
      refreshAfterEdit(id, s, 'redo');
    })
  );
  buttons.resample.addEventListener('click', () => {
    const w = Math.floor(Number(resampleInput.value) || 0);
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
  buttons.reset.addEventListener('click', () =>
    runWithState((id, s) => {
      localMutate(s, () => []);
      resampleInput.value = '';
      refreshAfterEdit(id, s, 'edits reset');
    })
  );
  buttons.save.addEventListener('click', () =>
    runWithState((id, s) => {
      if (!isDirty(s)) return;
      // Guard against double-clicks during the (potentially multi-MB)
      // bake upload. Re-enabled by renderEditsPanel on success (where
      // isDirty is now false → disabled stays true) or explicitly on
      // failure so the user can retry.
      buttons.save.disabled = true;
      setStatus(`saving edits ${id.slice(0, 8)}…`);
      void saveImageEdits(id, s).then(
        () => {
          renderEditsPanel(id, s);
          setStatus(`saved edits ${id.slice(0, 8)}…`);
        },
        (err: unknown) => {
          buttons.save.disabled = false;
          setStatus(`save edits failed: ${(err as Error).message}`);
        }
      );
    })
  );

  function deactivate(): void {
    buttons.reset.hidden = true;
    resampleInput.value = '';
    buttons.undo.disabled = true;
    buttons.redo.disabled = true;
    buttons.save.disabled = true;
    editsList.replaceChildren();
    section.hidden = true;
    section.dataset.ready = 'false';
  }

  function activateForId(id: string, stillCurrent: () => boolean): void {
    buttons.reset.hidden = true;
    resampleInput.value = '';
    buttons.undo.disabled = true;
    buttons.redo.disabled = true;
    buttons.save.disabled = true;
    editsList.replaceChildren();
    section.hidden = false;
    // data-ready flips to "true" once the async ensureLocalState
    // fetch settles. e2e tests wait on this before clicking any
    // image-edit button — otherwise getLocalEditState (sync) returns
    // null and the click silently no-ops.
    section.dataset.ready = 'false';
    void ensureLocalState(id).then(
      (s) => {
        // Selection may have moved on while the meta fetch was in
        // flight; only paint if we're still on this id.
        if (!stillCurrent()) return;
        const resample = s.ops.find((o) => o.type === 'resample');
        if (resample && typeof resample.w === 'number') {
          resampleInput.value = String(resample.w);
        }
        renderEditsPanel(id, s);
        // Repaint the cell preview from local ops — there might be
        // unsaved edits from a prior selection of this image.
        void refreshImagePreview(editor, id, s.ops);
        section.dataset.ready = 'true';
      },
      () => {
        /* best-effort */
      }
    );
  }

  return { activateForId, deactivate };
}
