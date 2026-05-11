// Save flow: editor JSON → markdown → POST /admin/posts (online) or
// queue a `savePost` outbox entry (offline / network error).

import type { Editor } from '@tiptap/core';
import type { SavePostPayload } from '../lib/outbox-types.ts';
import { type ProseDoc, proseToMarkdown } from '../lib/prose-markdown.ts';
import { $, setStatus, setStatusWithLink } from './dom';
import { getOrCreateDraftId, readMeta, updateMeta } from './draft.ts';
import { dirtyImageStates, flushDirtyImageEdits } from './image-edit';
import { getState } from './online-state.ts';
import { append as outboxAppend } from './outbox.ts';
import { markClean } from './page-title.ts';
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
  const subtitle = $<HTMLInputElement>('rkr-subtitle').value.trim();
  const status = $<HTMLSelectElement>('rkr-status').value as 'draft' | 'published';
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
    // posts carry the slug they were loaded with.
    slug,
    title,
    ...(subtitle ? { subtitle } : {}),
    status,
    markdown,
    lastSyncedAt: meta?.lastSyncedAt
  };
  setStatus('saving…');
  if (getState() !== 'offline') {
    try {
      const result = await postSavePost(payload);
      // Echo the server-resolved slug back into the hidden input so
      // the Copy-link button + next save's payload pick it up.
      $<HTMLInputElement>('rkr-slug').value = result.slug;
      window.dispatchEvent(new CustomEvent('rkr-slug-changed'));
      await updateMeta(draftId, { slug: result.slug, lastSyncedAt: result.updatedAt });
      // Status carries a permalink so the author can verify the
      // rendered post in one click; markClean drops the dirty dot
      // from the browser tab title.
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
