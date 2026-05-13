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

interface SaveResponse {
  slug: string;
  inserted: boolean;
  updatedAt: string;
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
  if (!res.ok) throw new Error(`save failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as SaveResponse;
}

export async function handleSave(editor: Editor): Promise<void> {
  // Flush any pending caption/alt commits so editor.getJSON() below
  // serialises the latest typed values, not the pre-debounce state.
  flushPendingAttrCommits();
  const slug = $<HTMLInputElement>('rkr-slug').value.trim();
  const title = $<HTMLInputElement>('rkr-title').value.trim();
  const subtitle = $<HTMLInputElement>('rkr-subtitle').value.trim();
  if (!title) {
    setStatus('title is required');
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
      setStatus(`save aborted: ${failed}/${ok + failed} image edits failed to upload`);
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
    lastSyncedAt: meta?.lastSyncedAt
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
      await updateMeta(draftId, { slug: result.slug, lastSyncedAt: result.updatedAt });
      // Flush the SW pages cache so the "view →" click (and any
      // subsequent /:slug navigation in this tab or another) doesn't
      // serve the pre-save HTML via the SWR cache. Best-effort —
      // anonymous browsers without a controlling SW just skip.
      navigator.serviceWorker?.controller?.postMessage({ type: 'rkr-pages-flush' });
      setStatusWithLink(`saved /${result.slug}`, `/${result.slug}`, 'view →');
      markClean();
      return;
    } catch {
      // Fall through to the outbox queue. A 409 conflict on the
      // online attempt also lands here; drainSavePost will hit the
      // same 409 on drain and surface it via DrainStatus 'conflict'.
    }
  }
  await queueSavePost(payload, uploadsStillPending ? referencedIds.length : 0);
}

async function queueSavePost(payload: SavePostPayload, pendingImages: number): Promise<void> {
  await outboxAppend({ op: 'savePost', payload });
  // Distinguish the "you're offline" case from the "online but an
  // upload is still draining" case — the second one points at a
  // partial drain (some referenced image's upload halted), which
  // the user should know about so they don't expect the post to
  // appear at /:slug yet.
  if (pendingImages > 0) {
    setStatus(`queued /${payload.slug} — ${pendingImages} image(s) still syncing`);
  } else {
    setStatus(`queued /${payload.slug} for sync`);
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
