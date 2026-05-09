// Save flow: serialize the editor JSON to markdown, flush any dirty
// per-image edits, then POST /admin/posts. Online-first: try the
// network; on offline / network failure, queue a `savePost` outbox
// entry and let sync.ts drain it on reconnect (spec-offline §5).
//
// The toolbar's Save button is the only entry point; e2e/editor-flow.
// spec.ts asserts on the status text it produces.

import type { Editor } from '@tiptap/core';
import type { SavePostPayload } from '../lib/outbox-types.ts';
import { type ProseDoc, proseToMarkdown } from '../lib/prose-markdown.ts';
import { $, setStatus } from './dom';
import { getOrCreateDraftId, readMeta, updateMeta } from './draft.ts';
import { dirtyImageStates, flushDirtyImageEdits } from './image-edit';
import { getState } from './online-state.ts';
import { append as outboxAppend } from './outbox.ts';
import { tryDrain } from './sync.ts';

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
  const status = $<HTMLSelectElement>('rkr-status').value as 'draft' | 'published';
  if (!slug || !title) {
    setStatus('slug and title are required');
    return;
  }
  // Flush any dirty image edits BEFORE writing the post. Without this,
  // the saved markdown would reference image ids whose server-side ops
  // are stale relative to what the user just edited — silent data loss.
  // Uses the same code path the per-image Save button uses, so when
  // saveImageEdits queues offline-mode setOps/bake the seq order
  // guarantees those drain before the savePost.
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
  // Pull lastSyncedAt from the draft meta so the server can detect a
  // concurrent edit (spec-offline §6). When the meta has no
  // lastSyncedAt yet (fresh post that's never been synced), the
  // header is omitted and the server accepts unconditionally.
  const draftId = await getOrCreateDraftId();
  const meta = await readMeta(draftId);
  const payload: SavePostPayload = {
    slug,
    title,
    status,
    markdown,
    lastSyncedAt: meta?.lastSyncedAt
  };
  setStatus('saving…');
  if (getState() !== 'offline') {
    try {
      const result = await postSavePost(payload);
      // Stamp the new server-known updated_at into the draft meta so
      // the next save sends an accurate header.
      await updateMeta(draftId, { slug, lastSyncedAt: result.updatedAt });
      setStatus(`saved /${result.slug}`);
      return;
    } catch {
      /* fall through to outbox queue on network failure */
    }
  }
  await queueSavePost(payload);
}

async function queueSavePost(payload: SavePostPayload): Promise<void> {
  await outboxAppend({ op: 'savePost', payload });
  setStatus(`queued /${payload.slug} for sync`);
  void tryDrain();
}
