// Video insertion plumbing: toolbar +Video entry and drop handling.
// Mirrors image-insert.ts but without the source-picker branching.

import type { Editor } from '@tiptap/core';

import { setStatus } from './dom';
import { uploadVideo } from './video-upload';

export interface VideoInserter {
  insertNew(): Promise<void>;
  handleFileChange(): Promise<void>;
}

export interface VideoInserterDeps {
  editor: Editor;
  fileInput: HTMLInputElement;
}

export function createVideoInserter(deps: VideoInserterDeps): VideoInserter {
  const { editor, fileInput } = deps;

  async function insertVideoFile(file: File): Promise<void> {
    setStatus(`uploading ${file.name}…`);
    try {
      const result = await uploadVideo(file);
      editor
        .chain()
        .focus()
        .insertContent({ type: 'video', attrs: { ids: result.id } })
        .run();
      setStatus(
        `uploaded ${file.name} (${result.bytes} bytes${result.deduplicated ? ', dedup' : ''})`
      );
    } catch (err) {
      setStatus(`video upload error: ${(err as Error).message}`, true);
    }
  }

  async function insertNew(): Promise<void> {
    fileInput.click();
  }

  async function handleFileChange(): Promise<void> {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = '';
    if (files.length === 0) return;
    for (const file of files) await insertVideoFile(file);
  }

  return { insertNew, handleFileChange };
}
