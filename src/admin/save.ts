// Save flow: editor JSON → markdown → server. Three branches:
//   1. Referenced uploads still queued → await drain so the post
//      lands referencing ids the server can resolve.
//   2. Online + queue empty → direct POST; on failure, queue.
//   3. Offline (or direct POST failed) → queue a `savePost` entry;
//      drain handles it later.

import type { Editor } from '@tiptap/core';
import type { SavePostPayload } from '../lib/outbox-types.ts';
import { type ProseDoc, proseToMarkdown } from '../lib/prose-markdown.ts';
import { flushPendingAttrCommits } from './attr-commit';
import { $, setStatus, setStatusWithLink } from './dom';
import { getOrCreateDraftId, readMeta, updateMeta } from './draft.ts';
import { dirtyImageStates, flushDirtyImageEdits } from './image-edit';
import { getState } from './online-state.ts';
import { append as outboxAppend } from './outbox.ts';
import { markClean } from './page-title.ts';
import { hasPendingMarker } from './pending-uploads.ts';
import { awaitDrainSettled, tryDrain } from './sync.ts';
import { deduplicateTags, parseTagInput } from './tag-input.ts';
import { showToast } from './toast.ts';

interface SaveResponse {
  slug: string;
  inserted: boolean;
  updatedAt: string;
  date?: string;
}

/** A non-2xx response from the direct online POST. Carries the HTTP
 * status so the caller can distinguish a semantic 409 (stale-post
 * conflict — surface immediately) from a transport failure (fetch
 * rejects with a plain Error and no status — queue + retry). */
class SaveHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string
  ) {
    super(`save failed: ${status} ${body}`);
    this.name = 'SaveHttpError';
  }
}

async function postSavePost(payload: SavePostPayload): Promise<SaveResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (payload.lastSyncedAt) {
    headers['x-rkr-last-synced-at'] = payload.lastSyncedAt;
  }
  const res = await fetch('/admin/posts', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new SaveHttpError(res.status, await res.text());
  return (await res.json()) as SaveResponse;
}

/** Navigate to the saved permalink after a successful save. */
export async function handleSaveAndView(editor: Editor): Promise<void> {
  return handleSave(editor, { navigate: (u) => location.assign(u) });
}

export async function handleSave(
  editor: Editor,
  opts?: { navigate?: (url: string) => void }
): Promise<void> {
  // Flush any pending caption/alt commits so editor.getJSON() below
  // serialises the latest typed values, not the pre-debounce state.
  flushPendingAttrCommits();
  const slug = $<HTMLInputElement>('rkr-slug').value.trim();
  const title = $<HTMLInputElement>('rkr-title').value.trim();
  const subtitle = $<HTMLInputElement>('rkr-subtitle').value.trim();
  if (!title) {
    setStatus('title is required', true);
    return;
  }
  // Flush dirty image edits first: the saved markdown references
  // image ids whose ops must reach the server before the post does,
  // or the public site renders with stale ops.
  const dirtyCount = dirtyImageStates().length;
  if (dirtyCount > 0) {
    setStatus(`saving ${dirtyCount} image edit${dirtyCount === 1 ? '' : 's'}…`);
    const { ok, failed } = await flushDirtyImageEdits();
    if (failed > 0) {
      setStatus(`save aborted: ${failed}/${ok + failed} image edits failed to upload`, true);
      return;
    }
  }
  const json = editor.getJSON() as ProseDoc;
  const markdown = proseToMarkdown(json);
  const draftId = await getOrCreateDraftId();
  const meta = await readMeta(draftId);
  const payload: SavePostPayload = {
    // Empty slug → server slugifies the title to fill it in. Existing
    // posts carry the slug they were loaded with. Status is omitted
    // from the editor's save: the server preserves the existing
    // post's status (or defaults to 'draft' on insert), and the
    // /admin/posts list owns the per-row status flip.
    slug,
    title,
    ...(subtitle ? { subtitle } : {}),
    markdown,
    lastSyncedAt: meta?.lastSyncedAt,
    tags: deduplicateTags(
      parseTagInput((document.getElementById('rkr-tags') as HTMLInputElement | null)?.value ?? '')
    ),
    ...(() => {
      const d = (document.getElementById('rkr-date') as HTMLInputElement | null)?.value;
      return d ? { date: `${d}T00:00:00.000Z` } : {};
    })()
  };
  setStatus('saving…');
  // If any referenced image still has an `upload` entry queued in
  // the outbox, wait for that upload to drain first. Without this,
  // a direct POST here would write a post that references ids the
  // server can't resolve yet — the public render falls back to the
  // original dims and looks subtly wrong until the upload lands.
  // awaitDrainSettled queues on the leader lock so any in-flight
  // drain finishes before our pass starts.
  const referencedIds = collectFigureIds(editor);
  if (getState() !== 'offline' && (await hasPendingMarker(referencedIds))) {
    setStatus(`syncing ${referencedIds.length} image(s)…`);
    await awaitDrainSettled();
  }
  // Re-check after the drain settles. awaitDrainSettled returns once
  // the leader-elected drain reaches an idle/halted/conflict state,
  // but a partial drain (one id committed, another halted on a 4xx)
  // leaves some markers behind. If any are still present, fall through
  // to the offline-queue branch — POSTing now would write a post
  // referencing ids the server can't resolve.
  const uploadsStillPending = await hasPendingMarker(referencedIds);
  if (getState() !== 'offline' && !uploadsStillPending) {
    try {
      const result = await postSavePost(payload);
      // Echo the server-resolved slug back into the hidden input so
      // the next save's payload includes it.
      $<HTMLInputElement>('rkr-slug').value = result.slug;
      // Seed the date input from the server's resolved date so subsequent
      // saves preserve it (new posts get their date assigned here).
      if (result.date) {
        const dateEl = document.getElementById('rkr-date') as HTMLInputElement | null;
        if (dateEl && !dateEl.value) dateEl.value = result.date.slice(0, 10);
      }
      await updateMeta(draftId, { slug: result.slug, lastSyncedAt: result.updatedAt });
      // Flush the SW pages cache so the "view →" click (and any
      // subsequent /:slug navigation in this tab or another) doesn't
      // serve the pre-save HTML via the SWR cache. Best-effort —
      // anonymous browsers without a controlling SW just skip.
      navigator.serviceWorker?.controller?.postMessage({ type: 'rkr-pages-flush' });
      setStatusWithLink(`saved /${result.slug}`, `/${result.slug}`, 'view →');
      // Transient bottom-right toast — the status line is small and
      // muted; the toast is the "you can stop holding your breath"
      // signal. Keep the status line update too for screen readers
      // and the existing e2e assertions.
      showToast({
        kind: 'success',
        text: `Saved /${result.slug}`,
        action: { href: `/${result.slug}`, label: 'View →' }
      });
      markClean();
      opts?.navigate?.(`/${result.slug}`);
      return;
    } catch (err) {
      // A 409 here means the user is editing a STALE post (a newer
      // version exists server-side). The success-y "queued for sync"
      // toast would let them close the tab believing it's saved while
      // the conflict only surfaces later on drain (possibly in another
      // tab). Surface it NOW via the SAME affordance a drained 409
      // uses: queue the entry (so discardConflictedSave /
      // forceConflictedSave have something to act on) and let the
      // drain re-hit the 409 → drainSavePost throws
      // SavePostConflictError → sync publishes DrainStatus 'conflict'
      // → the badge shows it. Task 8 server idempotency makes the
      // immediate re-POST safe. The only difference from the old
      // behaviour is the toast: a conflict, not a cheerful "queued".
      if (err instanceof SaveHttpError && err.status === 409) {
        await queueConflictedSave(payload, draftId);
        return;
      }
      // Transport failure (fetch rejected / offline) or a transient
      // 5xx: preserve the existing behaviour — queue + the normal
      // "queued for sync" toast; the drain retries with backoff and
      // surfaces a persistent failure as 'halted' in the badge.
    }
  }
  await queueSavePost(payload, uploadsStillPending ? referencedIds.length : 0, draftId);
}

/** A 409 on the direct online POST: the post is stale. Queue the
 * entry so the existing conflict-resolution flow (discard / force,
 * driven off DrainStatus 'conflict') has something to act on, then
 * kick the drain — drainSavePost re-hits the 409, throws
 * SavePostConflictError, and sync.ts publishes 'conflict', exactly
 * as a drained conflict does. Deliberately NOT the success-y
 * "queued for sync" toast. */
async function queueConflictedSave(payload: SavePostPayload, draftId: string): Promise<void> {
  await outboxAppend({ op: 'savePost', payload, draftId });
  const msg = `conflict on /${payload.slug} — newer version on the server`;
  setStatus(msg);
  showToast({ kind: 'error', text: msg });
  void tryDrain();
}

async function queueSavePost(
  payload: SavePostPayload,
  pendingImages: number,
  draftId: string
): Promise<void> {
  // draftId distinguishes brand-new posts (slug:'') in coalescePending:
  // without it, two offline-composed posts both queue savePost with
  // slug:'' and the drain drops all but the highest seq.
  await outboxAppend({ op: 'savePost', payload, draftId });
  // Distinguish the "you're offline" case from the "online but an
  // upload is still draining" case — the second one points at a
  // partial drain (some referenced image's upload halted), which
  // the user should know about so they don't expect the post to
  // appear at /:slug yet.
  if (pendingImages > 0) {
    const msg = `queued /${payload.slug} — ${pendingImages} image(s) still syncing`;
    setStatus(msg);
    showToast({ kind: 'info', text: msg });
  } else {
    const msg = `queued /${payload.slug} for sync`;
    setStatus(msg);
    showToast({ kind: 'info', text: msg });
  }
  void tryDrain();
}

/** Walk the editor's ProseMirror state for `figure` nodes and
 * collect every `ids` attribute (comma-separated). Structural —
 * no regex over the rendered markdown, no DOM lookup, no
 * coupling to directive syntax. */
function collectFigureIds(editor: Editor): string[] {
  const ids = new Set<string>();
  editor.state.doc.descendants((node) => {
    if (node.type.name !== 'figure') return;
    const raw = (node.attrs as { ids?: string }).ids ?? '';
    for (const part of raw.split(',')) {
      const id = part.trim();
      if (id) ids.add(id);
    }
  });
  return [...ids];
}
