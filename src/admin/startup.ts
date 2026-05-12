// Offline-infrastructure startup. Lives outside main.ts to keep the
// editor mount and the OPFS init in separate files (and main.ts
// under the 500-line cap).

import type { Editor, JSONContent } from '@tiptap/core';

import { setStatus } from './dom.ts';
import { getOrCreateDraftId, loadDraft, startDraftPersistence } from './draft.ts';
import { drainCommitImageEdit, drainSavePost, drainUpload } from './drainers.ts';
import { runEviction } from './eviction.ts';
import { hydrateLocalThumbs } from './local-thumb.ts';
import { onChange as onOnlineChange, start as startOnline } from './online-state.ts';
import { ensureSchema, readRoot, writeRoot } from './opfs-schema.ts';
import {
  dropLegacyOpEntries,
  append as outboxAppend,
  list as outboxList,
  pendingCount
} from './outbox.ts';
import { refreshPageTitle } from './page-title.ts';
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
    registerDrainer('commitImageEdit', drainCommitImageEdit);
    registerDrainer('savePost', drainSavePost);
    // One-shot migration: pre-/commit outboxes carry op='setOps' and
    // op='bake' entries that have no drainer in this build. Drop them
    // up front so the drain loop doesn't halt on the first one.
    void dropLegacyOpEntries();
    // URL drives one of three startup modes:
    //   ?slug=foo  → pin the named post, edit it.
    //   ?new=1     → discard any in-progress draftId and create a
    //                fresh blank one. The previous draft stays in
    //                OPFS (eviction reclaims it later if not pinned)
    //                so the author doesn't lose work; we just stop
    //                pointing at it from `currentDraftId`. Without
    //                this branch, clicking "+ New post" from the
    //                index would resurrect whatever post the author
    //                was last editing.
    //   (neither)  → restore the existing currentDraftId (default).
    const params = new URLSearchParams(location.search);
    const newParam = params.get('new');
    if (newParam) {
      const root = await readRoot();
      /* v8 ignore next 3 -- ensureSchema runs first */
      if (!root) {
        throw new Error('startup: _root.json missing — ensureSchema not called?');
      }
      await writeRoot({ ...root, currentDraftId: '' });
    }
    // ?slug=foo: caller asked to edit an existing post. Pin its
    // bundle into OPFS (writes drafts/<new-id>.json + meta,
    // bumps currentDraftId), then fall through to the normal
    // draft restore which picks up the fresh draft. Any prior
    // in-progress draft is orphaned in OPFS; eviction reclaims.
    // Also seed the title/slug/status form fields from the bundle
    // so handleSave overwrites the right post.
    const slugParam = params.get('slug');
    if (slugParam) {
      // pinPost downloads the post bundle (manifest + originals + side-
      // cars). On a long post this is multi-second; reuse the page-
      // title h1 (the "New post" / "Edit post" mode label) to show
      // "loading /slug…" so the author has visible feedback in the
      // exact spot the final "Edit post" will land — no separate
      // banner needed. seedFormFields() calls refreshPageTitle()
      // after writing the manifest, which flips the label to the
      // post-load state.
      const pageTitleEl = document.getElementById('rkr-page-title');
      if (pageTitleEl) pageTitleEl.textContent = `loading /${slugParam}…`;
      try {
        const { manifest } = await pinPost(slugParam);
        seedFormFields(manifest);
      } catch (err) {
        setStatus(`could not load /${slugParam}: ${(err as Error).message}`);
        // Failed load → revert the h1 to the default state so the
        // "loading …" string doesn't get stuck.
        if (pageTitleEl) pageTitleEl.textContent = 'New post';
      }
    }
    const draftId = await getOrCreateDraftId();
    const restored = (await loadDraft(draftId)) as JSONContent | null;
    if (restored) {
      editor.commands.setContent(restored, { emitUpdate: false });
      // Restored figures reference image ids by `/admin/preview/<id>`;
      // ids whose uploads haven't drained 404 on that path. Swap each
      // <img> to a blob: URL backed by OPFS originals so the editor
      // doesn't show broken thumbs after reload-before-drain.
      void hydrateLocalThumbs(editor);
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
  const subtitleEl = document.getElementById('rkr-subtitle') as HTMLInputElement | null;
  if (slugEl) slugEl.value = manifest.slug;
  if (titleEl) titleEl.value = manifest.title;
  if (subtitleEl) subtitleEl.value = manifest.subtitle ?? '';
  // Programmatic value assignment doesn't fire 'input' events, so the
  // page-title binding wouldn't see the new slug otherwise.
  refreshPageTitle();
}
