// Sequential upload helper used by the +Image source picker's Local
// branch. Drag/drop and clipboard inserts have their own paths in
// drag-drop.ts (they extract files from a DataTransfer rather than
// prompting via <input type="file">).

import { setStatus } from './dom';
import { uploadImage } from './upload';

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
