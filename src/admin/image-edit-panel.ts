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
import { getPreviewUrl, refreshImagePreview } from './canvas-loaders';
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
  tilt: HTMLButtonElement;
}

export interface ImageEditPanelDeps {
  editor: Editor;
  section: HTMLDivElement;
  buttons: ImageEditPanelButtons;
  resampleInput: HTMLInputElement;
  tiltSlider: HTMLInputElement;
  tiltInput: HTMLInputElement;
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
  const {
    editor,
    section,
    buttons,
    resampleInput,
    tiltSlider,
    tiltInput,
    editsList,
    activeImageId
  } = deps;
  // Empty-state hint shown in the cell dialog when no cell is active.
  // openCellDialog can fire with activeCellIndex===null (idx falls back
  // to 0 for caption/alt but the image-edit section stays hidden), so
  // first-time users get a pointer instead of a silent gap.
  const hint = document.getElementById('rkr-cell-hint') as HTMLElement | null;

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
   * via the canvas pipeline. The bake goes up only on Save. After
   * the pipeline resolves the dialog's in-modal preview is repointed
   * at the same blob URL so the author sees the result of each edit
   * without dismissing the dialog. */
  function refreshAfterEdit(id: string, s: LocalEditState, label: string): void {
    setStatus(`${label} ${id.slice(0, 8)}…`);
    renderEditsPanel(id, s);
    persistImageState(id, s);
    void refreshImagePreview(editor, id, s.ops).then(() => updateDialogPreview(id));
  }

  /** Sync the in-dialog <img> to the latest pipeline output for `id`.
   * The blob URL is owned by canvas-loaders' LRU, so we just point
   * src at it — no revoke responsibility here. */
  function updateDialogPreview(id: string): void {
    const img = document.getElementById('rkr-cell-preview') as HTMLImageElement | null;
    if (!img) return;
    const url = getPreviewUrl(id);
    if (url) {
      img.src = url;
      img.hidden = false;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
    }
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
  tiltSlider.addEventListener('input', () => {
    const v = Math.max(-45, Math.min(45, Number(tiltSlider.value)));
    tiltInput.value = String(v);
  });
  tiltInput.addEventListener('input', () => {
    const v = Math.max(-45, Math.min(45, Number(tiltInput.value) || 0));
    tiltSlider.value = String(v);
  });
  buttons.tilt.addEventListener('click', () => {
    const deg = Math.max(-45, Math.min(45, Number(tiltInput.value) || 0));
    if (deg === 0) return;
    const norm = ((deg % 360) + 360) % 360;
    runEdit('rotate', (ops) => [...ops, { type: 'rotate', degrees: norm }]);
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
          // Repoint the editor's <img data-id> at the freshly-baked
          // server derivative so the in-editor pixels match what
          // visitors will see (and so a same-id cell elsewhere on the
          // page picks up the bake without a re-select).
          void refreshImagePreview(editor, id, s.ops).then(() => updateDialogPreview(id));
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
    // Drop the dialog preview's src — otherwise reopening the dialog
    // for a different image would flash the previous image first.
    const preview = document.getElementById('rkr-cell-preview') as HTMLImageElement | null;
    if (preview) {
      preview.hidden = true;
      preview.removeAttribute('src');
    }
    section.hidden = true;
    section.dataset.ready = 'false';
    if (hint) hint.hidden = false;
  }

  function activateForId(id: string, stillCurrent: () => boolean): void {
    if (hint) hint.hidden = true;
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
        // unsaved edits from a prior selection of this image. Show
        // the result in the dialog too once the canvas pipeline
        // resolves.
        void refreshImagePreview(editor, id, s.ops).then(() => updateDialogPreview(id));
        section.dataset.ready = 'true';
      },
      () => {
        /* best-effort */
      }
    );
  }

  return { activateForId, deactivate };
}
