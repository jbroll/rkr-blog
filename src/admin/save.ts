// Save flow: editor JSON → markdown → POST /admin/posts (online) or
// queue a `savePost` outbox entry (offline / network error).

import type { Editor } from '@tiptap/core';
import type { SavePostPayload } from '../lib/outbox-types.ts';
import { type ProseDoc, proseToMarkdown } from '../lib/prose-markdown.ts';
import { $, setStatus, setStatusWithLink } from './dom';
import { getOrCreateDraftId, readMeta, updateMeta } from './draft.ts';
import { dirtyImageStates, flushDirtyImageEdits } from './image-edit';
import { getState } from './online-state.ts';
import { append as outboxAppend, list as outboxList } from './outbox.ts';
import { markClean } from './page-title.ts';
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
  const referencedIds = extractFigureIds(markdown);
  if (getState() !== 'offline' && (await hasPendingUploadsFor(referencedIds))) {
    setStatus(`syncing ${referencedIds.length} image(s)…`);
    await awaitDrainSettled();
  }
  const uploadsStillPending = await hasPendingUploadsFor(referencedIds);
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
  await queueSavePost(payload);
}

async function queueSavePost(payload: SavePostPayload): Promise<void> {
  await outboxAppend({ op: 'savePost', payload });
  setStatus(`queued /${payload.slug} for sync`);
  void tryDrain();
}

/** Pull the comma-separated id list out of every `::figure{…ids=…}`
 * directive in the saved markdown. Returns deduped ids; empty when
 * the post has no figures. */
function extractFigureIds(markdown: string): string[] {
  const ids = new Set<string>();
  const re = /::figure\{[^}]*\bids=([^\s,}]+(?:,[^\s,}]+)*)/g;
  for (const match of markdown.matchAll(re)) {
    const list = match[1];
    if (!list) continue;
    for (const raw of list.split(',')) {
      const id = raw.trim();
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

async function hasPendingUploadsFor(ids: string[]): Promise<boolean> {
  if (ids.length === 0) return false;
  const entries = await outboxList();
  const idSet = new Set(ids);
  return entries.some((e) => e.op === 'upload' && idSet.has(e.payload.id));
}
