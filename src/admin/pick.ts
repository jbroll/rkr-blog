// File-picker + sequential upload helpers used by the toolbar's
// Image / Gallery buttons. Drag/drop and clipboard inserts have their
// own paths in drag-drop.ts (they extract files from a DataTransfer
// rather than prompting via <input type="file">).

import { setStatus } from './dom';
import { uploadImage } from './upload';

/** Open a transient <input type="file" multiple> and resolve with the
 * picked files (or [] if the user dismissed the picker).
 *
 * `cancel` + focus-return fallback are both needed: browsers that
 * don't fire `cancel` (older Safari/Firefox) only signal a dismissed
 * picker via the focus event; without one of these the Promise hangs
 * and the input leaks into the DOM. */
export function pickMany(): Promise<File[]> {
  return new Promise<File[]>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.style.display = 'none';
    let settled = false;
    const finish = (files: File[]): void => {
      if (settled) return;
      settled = true;
      if (input.parentNode) input.parentNode.removeChild(input);
      resolve(files);
    };
    input.addEventListener('change', () => finish(input.files ? Array.from(input.files) : []), {
      once: true
    });
    input.addEventListener('cancel', () => finish([]), { once: true });
    // Focus-return fallback: browsers that don't fire `cancel` (older
    // Safari/Firefox) restore focus to the window when the picker closes
    // without a selection. Resolve empty after a short delay so we don't
    // race the change event.
    window.addEventListener('focus', () => setTimeout(() => finish([]), 300), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

/** Upload N files in series, returning the assigned ids in order.
 * Sequential so a partial-batch failure doesn't dribble half the ids
 * into the editor before throwing. */
export async function uploadMany(files: File[]): Promise<string[]> {
  const ids: string[] = [];
  for (const f of files) {
    setStatus(`uploading ${f.name} (${ids.length + 1}/${files.length})…`);
    const r = await uploadImage(f);
    ids.push(r.id);
  }
  return ids;
}
