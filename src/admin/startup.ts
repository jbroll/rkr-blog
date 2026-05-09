// Startup sequence for the admin SPA's offline infrastructure.
// Runs once per mount; main.ts kicks it off as fire-and-forget after
// constructing the editor (the draft restore needs the editor handle).
//
// Steps in order:
//   1. ensureSchema()           initialize / migrate opfs://meta/_root.json
//   2. registerDrainer(...)     wire each op-drainer
//   3. restore + persist draft  setContent from drafts/<id>.json (phase 1h),
//                               then start debounced writes + heartbeat
//   4. pendingCount()           surface "N pending offline edit(s)" if any
//   5. startOnline()            begin the online/offline state machine
//   6. tryDrain()               attempt an initial drain pass
//
// Lives in its own module so main.ts stays at the 500-line cap and
// the offline-init order has one obvious home.

import type { Editor, JSONContent } from '@tiptap/core';

import { setStatus } from './dom.ts';
import { getOrCreateDraftId, loadDraft, startDraftPersistence } from './draft.ts';
import { drainBake, drainSavePost, drainSetOps, drainUpload } from './drainers.ts';
import { onChange as onOnlineChange, start as startOnline } from './online-state.ts';
import { ensureSchema } from './opfs-schema.ts';
import { pendingCount } from './outbox.ts';
import { mountStatusBadge } from './status-badge.ts';
import { discardConflictedSave, forceConflictedSave, registerDrainer, tryDrain } from './sync.ts';

export async function startOfflineInfrastructure(editor: Editor): Promise<void> {
  const ready = runStart(editor);
  // ?e2e=1 hooks: editor + offline-init promise + conflict APIs.
  // Set synchronously so tests can await __rkrOfflineReady before
  // any other interaction.
  /* v8 ignore next 8 -- prod path skips e2e hook */
  if (typeof location !== 'undefined' && location.search.includes('e2e=1')) {
    Object.assign(window, {
      __rkrEditor: editor,
      __rkrOfflineReady: ready,
      __rkrDiscardConflict: discardConflictedSave,
      __rkrForceConflict: forceConflictedSave
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
    // Restore the persisted draft into the editor BEFORE startup
    // surfaces the pending-edit count — the user sees the previous
    // session's text reappear without an empty-paragraph flash. The
    // editor was created with '<p></p>'; if a draft exists, replace
    // it; otherwise leave the placeholder.
    const draftId = await getOrCreateDraftId();
    const restored = (await loadDraft(draftId)) as JSONContent | null;
    if (restored) {
      editor.commands.setContent(restored, { emitUpdate: false });
    }
    startDraftPersistence(editor, draftId);
    mountStatusBadge();
    const pending = await pendingCount();
    if (pending > 0) setStatus(`${pending} pending offline edit(s)`);
    startOnline();
    // Drain on every offline → online transition. The unsubscribe is
    // intentionally retained for the lifetime of the SPA.
    onOnlineChange((state) => {
      if (state === 'online') void tryDrain();
    });
    await tryDrain();
  } catch (err) {
    setStatus(`offline cache init failed: ${(err as Error).message}`);
  }
}
