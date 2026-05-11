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
import { append as outboxAppend, list as outboxList, pendingCount } from './outbox.ts';
import type { PinManifest } from './pin.ts';
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
  /* v8 ignore next 10 -- prod path skips */
  if (typeof location !== 'undefined' && location.search.includes('e2e=1')) {
    Object.assign(window, {
      __rkrEditor: editor,
      __rkrOfflineReady: ready,
      __rkrDiscardConflict: discardConflictedSave,
      __rkrForceConflict: forceConflictedSave,
      __rkrPin: pinPost,
      __rkrPanel: openStoragePanel,
      __rkrOutboxAppend: outboxAppend,
      __rkrOutboxList: outboxList
    });
  }
  await ready;
}

async function runStart(editor: Editor): Promise<void> {
  try {
    const schema = await ensureSchema();
    if (schema.status === 'unsupported') {
      // OPFS isn't available — skip the offline machinery entirely
      // rather than half-mount with a dead draft path. v1 (online-
      // only) behaviour is the right fallback per spec-offline §13.
      setStatus('offline mode unavailable in this browser');
      return;
    }
    registerDrainer('upload', drainUpload);
    registerDrainer('setOps', drainSetOps);
    registerDrainer('bake', drainBake);
    registerDrainer('savePost', drainSavePost);
    // ?slug=foo: caller asked to edit an existing post. Pin its
    // bundle into OPFS (writes drafts/<new-id>.json + meta,
    // bumps currentDraftId), then fall through to the normal
    // draft restore which picks up the fresh draft. Any prior
    // in-progress draft is orphaned in OPFS; eviction reclaims.
    // Also seed the title/slug/status form fields from the bundle
    // so handleSave overwrites the right post.
    const slugParam = new URLSearchParams(location.search).get('slug');
    if (slugParam) {
      try {
        const { manifest } = await pinPost(slugParam);
        seedFormFields(manifest);
      } catch (err) {
        setStatus(`could not load /${slugParam}: ${(err as Error).message}`);
      }
    }
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

function seedFormFields(manifest: PinManifest): void {
  const slugEl = document.getElementById('rkr-slug') as HTMLInputElement | null;
  const titleEl = document.getElementById('rkr-title') as HTMLInputElement | null;
  const statusEl = document.getElementById('rkr-status') as HTMLSelectElement | null;
  if (slugEl) slugEl.value = manifest.slug;
  if (titleEl) titleEl.value = manifest.title;
  if (statusEl && (manifest.status === 'draft' || manifest.status === 'published')) {
    statusEl.value = manifest.status;
  }
}
