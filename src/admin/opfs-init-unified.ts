// OPFS init for the unified editor: schema, drainers, and draining the
// upload queue on reconnect. Image editing uses OPFS directly through
// canvas-loaders and image-edit; page drafts live in IndexedDB
// (unified-draft.ts).

import { drainCommitImageEdit, drainUpload } from './drainers.ts';
import { onChange as onOnlineChange, start as startOnlineState } from './online-state.ts';
import { ensureSchema } from './opfs-schema.ts';
import { registerDrainer, tryDrain } from './sync.ts';

export async function initOpfsForUnifiedEditor(): Promise<boolean> {
  try {
    const schema = await ensureSchema();
    if (schema.status === 'unsupported') return false;
    registerDrainer('upload', drainUpload);
    registerDrainer('commitImageEdit', drainCommitImageEdit);
    // The drain loop reads online-state to stop retrying while offline.
    // Uploads queued offline, in this session or an earlier one, sync here.
    startOnlineState();
    onOnlineChange((state) => {
      if (state === 'online') void tryDrain();
    });
    void tryDrain();
    return true;
  } catch {
    return false;
  }
}
