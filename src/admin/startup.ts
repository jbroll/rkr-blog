// Offline-infrastructure startup. Lives outside main.ts to keep the
// editor mount and the OPFS init in separate files (and main.ts
// under the 500-line cap).

import type { Editor, JSONContent } from '@tiptap/core';

import { setStatus } from './dom.ts';
import {
  getOrCreateDraftId,
  loadDraft,
  readMeta,
  startDraftPersistence,
  updateMeta
} from './draft.ts';
import { drainCommitImageEdit, drainSavePost, drainUpload } from './drainers.ts';
import { runEviction } from './eviction.ts';
import { hydrateLocalThumbs } from './local-thumb.ts';
import { onChange as onOnlineChange, start as startOnline } from './online-state.ts';
import { ensureSchema, mutateRoot } from './opfs-schema.ts';
import {
  dropLegacyOpEntries,
  gcUnderAppendLock,
  append as outboxAppend,
  list as outboxList,
  pendingCount
} from './outbox.ts';
import { refreshPageTitle } from './page-title.ts';
import type { PinManifest } from './pin.ts';
import { pinPost } from './pin.ts';
import { mountStatusBadge } from './status-badge.ts';
import { openStoragePanel } from './storage-panel.ts';
import { discardConflictedSave, forceConflictedSave, registerDrainer, tryDrain } from './sync.ts';

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
      __rkrOutboxList: outboxList,
      __rkrEviction: runEviction
    });
  }
  await ready;
}

async function runStart(editor: Editor): Promise<void> {
  // Start online detection unconditionally — it must run even if OPFS
  // init fails or is unsupported, otherwise the sync badge stays 'online'
  // but the drain loop never fires and saves silently queue forever.
  startOnline();
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
    // up front — and AWAIT before the first tryDrain below — so the
    // drain loop never observes a legacy op and never flashes a
    // spurious 'halted' badge on boot.
    await dropLegacyOpEntries();
    // Sweep three classes of orphans (outbox blobs written before
    // their JSON commit, leaked pending-upload markers, leaked
    // atomic-write temps) — all under the rkr-outbox-append Web Lock
    // so a sweep can't race a concurrent append()'s half-written
    // (blob-but-no-JSON) state and delete a live blob. Eviction
    // doesn't reach these dirs; without the sweeps they'd accumulate.
    // Fire-and-forget: the lock-held window is short, boot isn't
    // gated on it, and the legacy drop above already completed.
    void gcUnderAppendLock();
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
    // ?mode=figure: single-figure editing mode (banner). Applied before
    // any other setup so CSS can hide irrelevant chrome immediately.
    const modeParam = params.get('mode');
    if (modeParam && typeof document !== 'undefined') {
      document.body.dataset.mode = modeParam;
    }
    const newParam = params.get('new');
    if (newParam) {
      await mutateRoot((root) => ({ ...root, currentDraftId: '' }));
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
        setStatus(`could not load /${slugParam}: ${(err as Error).message}`, true);
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
    // Restore form fields that survived the reload via draft meta.
    // Only fills fields seedFormFields (the ?slug= pin flow) hasn't
    // already populated — so an existing-post edit isn't overwritten.
    const savedMeta = await readMeta(draftId);
    if (savedMeta) {
      const slugEl = document.getElementById('rkr-slug') as HTMLInputElement | null;
      const titleEl = document.getElementById('rkr-title') as HTMLInputElement | null;
      const subtitleEl = document.getElementById('rkr-subtitle') as HTMLInputElement | null;
      const tagsEl = document.getElementById('rkr-tags') as HTMLInputElement | null;
      const dateEl = document.getElementById('rkr-date') as HTMLInputElement | null;
      if (slugEl && !slugEl.value && savedMeta.slug) slugEl.value = savedMeta.slug;
      if (titleEl && !titleEl.value && savedMeta.title) {
        titleEl.value = savedMeta.title;
        refreshPageTitle();
      }
      if (subtitleEl && !subtitleEl.value && savedMeta.subtitle)
        subtitleEl.value = savedMeta.subtitle;
      if (tagsEl && !tagsEl.value && savedMeta.tags) tagsEl.value = savedMeta.tags;
      if (dateEl && !dateEl.value && savedMeta.date) dateEl.value = savedMeta.date;
    }
    // Wire form-field inputs to persist changes so a reload doesn't
    // wipe what the user has typed.
    const titleEl = document.getElementById('rkr-title') as HTMLInputElement | null;
    const subtitleEl = document.getElementById('rkr-subtitle') as HTMLInputElement | null;
    const tagsEl = document.getElementById('rkr-tags') as HTMLInputElement | null;
    const dateEl = document.getElementById('rkr-date') as HTMLInputElement | null;
    titleEl?.addEventListener('input', () => {
      void updateMeta(draftId, { title: titleEl.value });
    });
    subtitleEl?.addEventListener('input', () => {
      void updateMeta(draftId, { subtitle: subtitleEl.value });
    });
    tagsEl?.addEventListener('input', () => {
      void updateMeta(draftId, { tags: tagsEl.value });
    });
    dateEl?.addEventListener('change', () => {
      void updateMeta(draftId, { date: dateEl.value });
    });
    mountStatusBadge();
    void populateTagsDatalist();
    // Eviction-after-drain is wired directly inside sync.ts; this
    // initial run reclaims OPFS for whatever's already stale on
    // mount.
    void runEviction();
    const pending = await pendingCount();
    if (pending > 0) setStatus(`${pending} pending offline edit(s)`);
    onOnlineChange((state) => {
      if (state === 'online') void tryDrain();
    });
    await tryDrain();
  } catch (err) {
    setStatus(`offline cache init failed: ${(err as Error).message}`, true);
  }
}

/* c8 ignore next 12 -- DOM + fetch coupled */
async function populateTagsDatalist(): Promise<void> {
  const list = document.getElementById('rkr-tags-list') as HTMLDataListElement | null;
  if (!list) return;
  try {
    const res = await fetch('/admin/api/tags?q=');
    if (!res.ok) return;
    const tags = (await res.json()) as { name: string }[];
    list.innerHTML = tags.map((t) => `<option value="${t.name}"></option>`).join('');
  } catch {
    // Non-critical — just means no suggestions appear.
  }
}

function seedFormFields(manifest: PinManifest): void {
  const slugEl = document.getElementById('rkr-slug') as HTMLInputElement | null;
  const titleEl = document.getElementById('rkr-title') as HTMLInputElement | null;
  const subtitleEl = document.getElementById('rkr-subtitle') as HTMLInputElement | null;
  if (slugEl) slugEl.value = manifest.slug;
  if (titleEl) titleEl.value = manifest.title;
  if (subtitleEl) subtitleEl.value = manifest.subtitle ?? '';
  const tagsEl = document.getElementById('rkr-tags') as HTMLInputElement | null;
  if (tagsEl) tagsEl.value = (manifest.tags ?? []).join(', ');
  const dateEl = document.getElementById('rkr-date') as HTMLInputElement | null;
  if (dateEl && manifest.date) dateEl.value = manifest.date.slice(0, 10);
  // Programmatic value assignment doesn't fire 'input' events, so the
  // page-title binding wouldn't see the new slug otherwise.
  refreshPageTitle();
}
