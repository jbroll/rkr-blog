// Image insertion plumbing for the editor: the +Image toolbar entry,
// the per-figure "+ Add image" entry, and the persistent file-input
// change listener that the local-file branch and e2e setInputFiles
// flows share. Lives in its own module so main.ts can stay focused
// on the per-cell attribute panel + image-edit pipeline.

import type { Editor } from '@tiptap/core';

import { openModal } from './dialog-focus';
import { setStatus } from './dom';
import type { FigureAttrs } from './figure-node';
import { pickFromDrive } from './integrations/gdrive';
import { pickFromOneDrive } from './integrations/onedrive';
import { hydrateLocalThumbs } from './local-thumb';
import { uploadMany } from './pick';
import { uploadImage } from './upload';

type InsertMode = 'new' | 'append';

export interface ImageInserter {
  /** Toolbar +Image: source-picker → upload → insert a new figure. */
  insertNew(): Promise<void>;
  /** In-figure "+": source-picker → upload → append to the active
   * figure's ids. Falls back to insert-new if no figure is selected. */
  appendToActive(): Promise<void>;
  /** Persistent fileInput change handler. Reads the pending mode
   * stashed by the local-source branch (defaults to 'new' for plain
   * setInputFiles calls from e2e). */
  handleFileChange(): Promise<void>;
}

export interface ImageInserterDeps {
  editor: Editor;
  fileInput: HTMLInputElement;
  sourceDialog: HTMLDialogElement;
}

/** Show the source-picker dialog and resolve with the chosen source
 * (or null on cancel). The dialog has one button per source plus a
 * Cancel button; each carries `data-source` on the click target. */
function openSourcePicker(
  dialog: HTMLDialogElement
): Promise<'local' | 'drive' | 'onedrive' | null> {
  return new Promise((resolve) => {
    const onClick = (ev: Event): void => {
      const btn = (ev.target as HTMLElement | null)?.closest<HTMLButtonElement>(
        'button[data-source]'
      );
      if (!btn) return;
      dialog.removeEventListener('click', onClick);
      dialog.close();
      const src = btn.dataset.source ?? '';
      if (src === 'local' || src === 'drive' || src === 'onedrive') resolve(src);
      else resolve(null);
    };
    dialog.addEventListener('click', onClick);
    openModal(dialog);
  });
}

export function createImageInserter(deps: ImageInserterDeps): ImageInserter {
  const { editor, fileInput, sourceDialog } = deps;

  // Insertion mode shared between the source-picker entry point and
  // the persistent fileInput change listener. The listener can't know
  // whether the user picked Local from the toolbar (mode='new') or
  // from a figure's "+" cell (mode='append'); we stash the intent
  // before .click() and the listener consumes + resets it. e2e tests
  // bypass the source picker, so the default 'new' takes effect — the
  // basic upload-and-insert path is unchanged for them.
  let pendingInsertMode: InsertMode = 'new';

  /** Apply N freshly-uploaded ids to the document — either as a new
   * figure (mode='new') or by appending to the currently-selected
   * figure's `ids` attribute (mode='append'). Append falls back to
   * insert-new when no figure is currently selected. */
  function applyFigureInsert(mode: InsertMode, ids: string[]): void {
    if (mode === 'append' && editor.isActive('figure')) {
      const attrs = editor.getAttributes('figure') as Partial<FigureAttrs>;
      const existing = (attrs.ids ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const combined = [...existing, ...ids];
      // Promote to a carousel (1x1) once we cross two images and the
      // author hadn't already set a matrix. Carousel is the safest
      // default for the grow-by-one gesture — the author can swap to
      // 1x2/justified/masonry from the layout field if they prefer a
      // tiled layout. An explicit matrix is kept verbatim.
      const matrix =
        attrs.matrix && attrs.matrix.length > 0 ? attrs.matrix : combined.length > 1 ? '1x1' : '';
      editor
        .chain()
        .focus()
        .updateAttributes('figure', { ids: combined.join(','), matrix })
        .run();
      setStatus(`appended ${ids.length} image(s) to figure`);
      return;
    }
    editor
      .chain()
      .focus()
      .insertContent({
        type: 'figure',
        attrs: { ids: ids.join(','), matrix: ids.length > 1 ? 'justified' : '' }
      })
      .run();
    // uploadImage is now local-first: it returns once the blob is in
    // OPFS, but the server's /admin/preview/<id> 404s until the
    // background drain completes. Swap the thumb's src to a blob:
    // URL pointing at the OPFS bytes so the figure shows immediately.
    void hydrateLocalThumbs(editor, ids);
    // No status emit on insert-new: the upload status ("uploaded X" /
    // "uploading X (N/M)") is the better signal and e2e asserts on it.
  }

  /** Open the source picker and run the chosen branch. Local routes
   * through fileInput (the change listener then consumes pendingInsertMode);
   * Drive/OneDrive return ids synchronously and we apply them directly. */
  async function insertFromAnySource(mode: InsertMode): Promise<void> {
    const choice = await openSourcePicker(sourceDialog);
    if (!choice) return;
    if (choice === 'local') {
      pendingInsertMode = mode;
      fileInput.click();
      return;
    }
    let ids: string[] = [];
    try {
      if (choice === 'drive') ids = await pickFromDrive();
      else ids = await pickFromOneDrive();
    } catch (err) {
      setStatus(`${choice} error: ${(err as Error).message}`);
      return;
    }
    if (ids.length === 0) return;
    applyFigureInsert(mode, ids);
  }

  async function handleFileChange(): Promise<void> {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = '';
    if (files.length === 0) return;
    // Consume pending mode and reset to default. e2e setInputFiles
    // calls bypass the source picker entirely, so the default 'new'
    // keeps the legacy upload-and-insert behaviour for them.
    const mode = pendingInsertMode;
    pendingInsertMode = 'new';
    // Single-file path: preserve the historical "uploaded <name>"
    // status (`^uploaded pixel\.png` is asserted by editor-flow.spec).
    // Multi-file: uploadMany emits per-file uploading-N/M status.
    try {
      let ids: string[];
      if (files.length === 1) {
        const file = files[0]!;
        setStatus(`uploading ${file.name}…`);
        const result = await uploadImage(file);
        setStatus(
          `uploaded ${file.name} (${result.bytes} bytes${result.deduplicated ? ', dedup' : ''})`
        );
        ids = [result.id];
      } else {
        ids = await uploadMany(files);
      }
      applyFigureInsert(mode, ids);
    } catch (err) {
      setStatus(`upload error: ${(err as Error).message}`);
    }
  }

  return {
    insertNew: () => insertFromAnySource('new'),
    appendToActive: () => insertFromAnySource('append'),
    handleFileChange
  };
}
