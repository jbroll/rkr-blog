// Save flow: serialize the editor JSON to markdown, flush any dirty
// per-image edits, then POST /admin/posts. The toolbar's Save button
// is the only entry point; e2e/editor-flow.spec.ts asserts on the
// status text it produces.

import type { Editor } from '@tiptap/core';

import { type ProseDoc, proseToMarkdown } from '../lib/prose-markdown.ts';
import { $, setStatus } from './dom';
import { dirtyImageStates, flushDirtyImageEdits } from './image-edit';

interface SaveResponse {
  slug: string;
  inserted: boolean;
}

async function savePost(payload: {
  slug: string;
  title: string;
  status: 'draft' | 'published';
  markdown: string;
}): Promise<SaveResponse> {
  const res = await fetch('/admin/posts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
  // Uses the same code path the per-image Save button uses, so failures
  // leave the image state dirty and the user can retry.
  const dirtyCount = dirtyImageStates().length;
  if (dirtyCount > 0) {
    setStatus(`saving ${dirtyCount} image edit${dirtyCount === 1 ? '' : 's'}…`);
    const { ok, failed } = await flushDirtyImageEdits();
    if (failed > 0) {
      setStatus(`save aborted: ${failed}/${ok + failed} image edits failed to upload`);
      return;
    }
  }
  setStatus('saving…');
  try {
    const json = editor.getJSON() as ProseDoc;
    const markdown = proseToMarkdown(json);
    const result = await savePost({ slug, title, status, markdown });
    setStatus(`saved /${result.slug}`);
  } catch (err) {
    setStatus(`save error: ${(err as Error).message}`);
  }
}
