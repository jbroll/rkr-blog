// Drag-and-drop / paste media plumbing for the editor.
//
// Three pieces:
//   • mediaFilesFrom — pulls image and video File entries out of a
//     DataTransfer or ClipboardData payload (.files for drops, .items
//     fallback for paste in browsers where clipboardData.files is empty).
//   • uploadAndInsertAt — sequential upload + figure/video-node insertion
//     at a ProseMirror position, so a partial-batch failure doesn't
//     dribble half the ids into the doc before throwing.
//   • makeDropHandlers / wireDragOverlay — TipTap editorProps for
//     handleDrop+handlePaste and the visual cue on the editor frame.
//
// Toolbar +Image / +Video go through image-insert.ts / video-insert.ts
// instead — they prompt via <input type="file"> rather than extracting
// from a drop.

import type { Editor } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';

import { setStatus } from './dom';
import { hydrateLocalThumbs } from './local-thumb';
import { uploadImage } from './upload';
import { uploadVideo } from './video-upload';

function isMedia(type: string): boolean {
  return type.startsWith('image/') || type.startsWith('video/');
}

/** Pull image/video File entries out of a DataTransfer / Clipboard event.
 * Filters by type so a drop containing both an image and a text snippet
 * doesn't double-handle. */
function mediaFilesFrom(source: { files?: FileList | null; items?: DataTransferItemList }): File[] {
  const out: File[] = [];
  // .files works for drag-drop. clipboardData.files is empty in some
  // browsers for image paste; .items is the fallback.
  if (source.files) {
    for (const f of Array.from(source.files)) {
      if (isMedia(f.type)) out.push(f);
    }
  }
  if (out.length === 0 && source.items) {
    for (const item of Array.from(source.items)) {
      if (item.kind === 'file' && isMedia(item.type)) {
        const f = item.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  return out;
}

/** Upload + insert N media files. Sequential so a partial-batch failure
 * doesn't dribble half the ids into the editor before throwing.
 * `pos === null` means "at current cursor". */
async function uploadAndInsertAt(ed: Editor, files: File[], pos: number | null): Promise<void> {
  let cursor = pos;
  for (let i = 0; i < files.length; i++) {
    const f = files[i] as File;
    const video = f.type.startsWith('video/');
    const kind = video ? 'video' : 'image';
    setStatus(`uploading ${f.name || kind} (${i + 1}/${files.length})…`);
    try {
      const r = video ? await uploadVideo(f) : await uploadImage(f);
      const attrs = { ids: r.id };
      const chain = ed.chain().focus();
      if (cursor !== null) {
        chain.insertContentAt(cursor, { type: video ? 'video' : 'figure', attrs });
        // Advance cursor for subsequent inserts so multiple files land
        // in source order, not stacked at the same point.
        cursor += 1;
      } else {
        chain.insertContent({ type: video ? 'video' : 'figure', attrs });
      }
      chain.run();
      if (!video) void hydrateLocalThumbs(ed, [r.id]);
      setStatus(`inserted ${f.name || kind} (${r.bytes} bytes${r.deduplicated ? ', dedup' : ''})`);
    } catch (err) {
      setStatus(`upload error: ${(err as Error).message}`, true);
      return;
    }
  }
}

/** TipTap editorProps factory: returns handleDrop/handlePaste closures
 * that defer to uploadAndInsertAt. The getEditor() indirection lets us
 * reference the Editor before it's constructed (the closures are only
 * called after construction). Returning true tells ProseMirror to skip
 * its default drop/paste handling, which would otherwise insert garbage
 * HTML for dropped files. */
export function makeDropHandlers(getEditor: () => Editor): {
  handleDrop: (view: EditorView, ev: Event) => boolean;
  handlePaste: (view: EditorView, ev: Event) => boolean;
} {
  return {
    handleDrop: (view, ev): boolean => {
      const dt = (ev as DragEvent).dataTransfer;
      const files = dt ? mediaFilesFrom(dt) : [];
      if (files.length === 0) return false;
      ev.preventDefault();
      const e = ev as DragEvent;
      const pos =
        view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos ?? view.state.selection.from;
      void uploadAndInsertAt(getEditor(), files, pos);
      return true;
    },
    handlePaste: (_view, ev): boolean => {
      const cd = (ev as ClipboardEvent).clipboardData;
      const files = cd ? mediaFilesFrom(cd) : [];
      if (files.length === 0) return false;
      ev.preventDefault();
      void uploadAndInsertAt(getEditor(), files, null);
      return true;
    }
  };
}

/** Wire the visual drag-over cue on the editor frame. The browser fires
 * dragenter / dragleave on every descendant traversal, so we count
 * enter/leave to distinguish "actually left the drop zone" from "crossed
 * an internal boundary". The dragover preventDefault is mandatory:
 * without it, Chrome/Firefox refuse the drop and navigate to the file. */
export function wireDragOverlay(frame: HTMLElement): void {
  let dragDepth = 0;
  frame.addEventListener('dragenter', (ev) => {
    if (!ev.dataTransfer || !Array.from(ev.dataTransfer.types).includes('Files')) return;
    dragDepth++;
    frame.classList.add('is-drag-over');
  });
  frame.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) frame.classList.remove('is-drag-over');
  });
  frame.addEventListener('dragover', (ev) => {
    if (ev.dataTransfer && Array.from(ev.dataTransfer.types).includes('Files')) {
      ev.preventDefault();
    }
  });
  frame.addEventListener('drop', () => {
    dragDepth = 0;
    frame.classList.remove('is-drag-over');
  });
}
