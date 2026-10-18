// Video insertion plumbing: toolbar +Video entry and drop handling.
// Mirrors image-insert.ts's source-picker branching (local file / Google
// Drive / OneDrive), but video has a single insert mode: a new video node.

import type { Editor } from '@tiptap/core';

import { openModal } from './dialog-focus';
import { $, setStatus } from './dom';
import { pickFromDriveVideo } from './integrations/gdrive';
import { pickFromOneDriveVideo } from './integrations/onedrive';
import { uploadVideo } from './video-upload';

export interface VideoInserter {
  insertNew(): Promise<void>;
  handleFileChange(): Promise<void>;
}

export interface VideoInserterDeps {
  editor: Editor;
  fileInput: HTMLInputElement;
  sourceDialog: HTMLDialogElement;
}

/** Show the source-picker dialog and resolve with the chosen source
 * (or null on cancel). The dialog has one button per source plus a
 * Cancel button; each carries `data-source` on the click target.
 * Mirrors image-insert.ts's openSourcePicker contract. */
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

export function createVideoInserter(deps: VideoInserterDeps): VideoInserter {
  const { editor, fileInput, sourceDialog } = deps;

  /** Insert a video node carrying an already-stored id (local upload or
   * a cloud import) without re-uploading. */
  function insertVideoId(id: string): void {
    editor
      .chain()
      .focus()
      .insertContent({ type: 'video', attrs: { ids: id } })
      .run();
  }

  async function insertVideoFile(file: File): Promise<void> {
    setStatus(`uploading ${file.name}…`);
    try {
      const result = await uploadVideo(file);
      insertVideoId(result.id);
      setStatus(
        `uploaded ${file.name} (${result.bytes} bytes${result.deduplicated ? ', dedup' : ''})`
      );
    } catch (err) {
      setStatus(`video upload error: ${(err as Error).message}`, true);
    }
  }

  /** Open the source picker and run the chosen branch. Local routes
   * through fileInput (the change listener inserts the new video node);
   * Drive/OneDrive return stored ids and we insert them directly. */
  async function insertFromAnySource(): Promise<void> {
    const title = $('rkr-source-picker-title');
    title.textContent = 'Add video';
    const choice = await openSourcePicker(sourceDialog);
    if (!choice) return;
    if (choice === 'local') {
      fileInput.click();
      return;
    }
    let ids: string[] = [];
    try {
      if (choice === 'drive') ids = await pickFromDriveVideo();
      else ids = await pickFromOneDriveVideo();
    } catch (err) {
      setStatus(`${choice} error: ${(err as Error).message}`);
      return;
    }
    for (const id of ids) insertVideoId(id);
  }

  async function insertNew(): Promise<void> {
    await insertFromAnySource();
  }

  async function handleFileChange(): Promise<void> {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = '';
    if (files.length === 0) return;
    for (const file of files) await insertVideoFile(file);
  }

  return { insertNew, handleFileChange };
}
