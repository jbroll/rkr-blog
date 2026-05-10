// Offline-infrastructure startup. Lives outside main.ts to keep the
// editor mount and the OPFS init in separate files (and main.ts
// under the 500-line cap).

import type { Editor, JSONContent } from '@tiptap/core';

import { setStatus } from './dom.ts';
import { getOrCreateDraftId, loadDraft, startDraftPersistence } from './draft.ts';
import { drainBake, drainSavePost, drainSetOps, drainUpload } from './drainers.ts';
import { runEviction } from './eviction.ts';
import { onChange as onOnlineChange, start as startOnline } from './online-state.ts';
import { ensureSchema } from './opfs-schema.ts';
import { pendingCount } from './outbox.ts';
import { pinPost } from './pin.ts';
import { mountStatusBadge } from './status-badge.ts';
import { openStoragePanel } from './storage-panel.ts';
import {
  discardConflictedSave,
  forceConflictedSave,
  onAfterDrainEmpty,
  registerDrainer,
  tryDrain
} from './sync.ts';

export async function startOfflineInfrastructure(editor: Editor): Promise<void> {
  const ready = runStart(editor);
  // ?e2e=1 hooks attached synchronously so tests can await
  // __rkrOfflineReady before driving the editor.
  /* v8 ignore next 8 -- prod path skips */
  if (typeof location !== 'undefined' && location.search.includes('e2e=1')) {
    Object.assign(window, {
      __rkrEditor: editor,
      __rkrOfflineReady: ready,
      __rkrDiscardConflict: discardConflictedSave,
      __rkrForceConflict: forceConflictedSave,
      __rkrPin: pinPost,
      __rkrPanel: openStoragePanel
    });
  }
  await ready;
}

async function runStart(editor: Editor): Promise<void> {
  try {
    await ensureSchema();
    registerDrainer('upload', drainUpload);
    registerDrainer('setOps', drainSetOps);
    registerDrainer('bake', drainBake);
    registerDrainer('savePost', drainSavePost);
    const draftId = await getOrCreateDraftId();
    const restored = (await loadDraft(draftId)) as JSONContent | null;
    if (restored) {
      editor.commands.setContent(restored, { emitUpdate: false });
    }
    startDraftPersistence(editor, draftId);
    mountStatusBadge();
    onAfterDrainEmpty(() => runEviction().then(() => undefined));
    void runEviction();
    const pending = await pendingCount();
    if (pending > 0) setStatus(`${pending} pending offline edit(s)`);
    startOnline();
    onOnlineChange((state) => {
      if (state === 'online') void tryDrain();
    });
    await tryDrain();
  } catch (err) {
    setStatus(`offline cache init failed: ${(err as Error).message}`);
  }
}
