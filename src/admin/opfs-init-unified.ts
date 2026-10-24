// Minimal OPFS init for the unified editor: schema + drainers only.
// The full startOfflineInfrastructure (drafts, sync, online state) is
// TipTap-coupled and not needed here — image editing uses OPFS directly
// through canvas-loaders and image-edit.

import { drainCommitImageEdit, drainUpload } from './drainers.ts';
import { ensureSchema } from './opfs-schema.ts';
import { registerDrainer } from './sync.ts';

export async function initOpfsForUnifiedEditor(): Promise<boolean> {
  try {
    const schema = await ensureSchema();
    if (schema.status === 'unsupported') return false;
    registerDrainer('upload', drainUpload);
    registerDrainer('commitImageEdit', drainCommitImageEdit);
    return true;
  } catch {
    return false;
  }
}
