// Per-op drainers: outbox entry → HTTP call. Registered by startup.ts.

import { extForMime } from '../lib/content-id.ts';
import type { OutboxEntry } from '../lib/outbox-types.ts';
import { readBlob } from './opfs.ts';
import { clearPendingUpload } from './pending-uploads.ts';
import { type Drainer, SavePostConflictError } from './sync.ts';

/** Shared POST + outbox-seq header + non-2xx → throw with a
 * standard "<op> drain <seq>: <status>" message. Used by the
 * FormData-bodied drainers (upload, commitImageEdit). savePost
 * stays specialized because its 409 path branches before the
 * non-ok check. */
async function postFormDrain(
  op: string,
  url: string,
  body: FormData,
  seq: number
): Promise<Response> {
  const res = await fetch(url, {
    method: 'POST',
    body,
    headers: { 'x-rkr-outbox-seq': String(seq) }
  });
  /* v8 ignore next 3 -- non-2xx server response; prod-only path */
  if (!res.ok) {
    throw new Error(`${op} drain ${seq}: ${res.status}`);
  }
  return res;
}

export const drainUpload: Drainer = async (entry, _blobIgnored) => {
  if (entry.op !== 'upload') return;
  // queueUpload writes the canonical local copy to originals/ for
  // offline preview; reading from there avoids a redundant
  // outbox-blob.
  const ext = extForMime(entry.payload.mimeType);
  const blob = await readBlob(`originals/${entry.payload.id}.${ext}`);
  /* v8 ignore next 3 -- queueUpload's writeBlob ran before append */
  if (!blob) {
    throw new Error(
      `upload drain ${entry.seq}: blob missing at originals/${entry.payload.id}.${ext}`
    );
  }
  const fd = new FormData();
  fd.append('file', blob, entry.payload.filename);
  const res = await postFormDrain('upload', '/admin/upload', fd, entry.seq);
  await res.json();
  // Clear the save-guard marker — server now has the bytes.
  await clearPendingUpload(entry.payload.id);
};

export const drainCommitImageEdit: Drainer = async (entry, blob) => {
  if (entry.op !== 'commitImageEdit') return;
  const fd = new FormData();
  fd.append('ops', JSON.stringify({ ops: entry.payload.ops, redoStack: entry.payload.redoStack }));
  if (entry.payload.hasBake) {
    /* v8 ignore next 3 -- blob always present when hasBake is true */
    if (!blob) {
      throw new Error(`commitImageEdit entry ${entry.seq} hasBake=true but no blob`);
    }
    fd.append('bake', blob, `${entry.payload.id}.webp`);
  }
  await postFormDrain(
    'commitImageEdit',
    `/admin/sidecar/${entry.payload.id}/commit`,
    fd,
    entry.seq
  );
};

export const drainSavePost: Drainer = async (entry: OutboxEntry) => {
  if (entry.op !== 'savePost') return;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-rkr-outbox-seq': String(entry.seq)
  };
  if (entry.payload.lastSyncedAt) {
    headers['x-rkr-last-synced-at'] = entry.payload.lastSyncedAt;
  }
  const res = await fetch('/admin/posts', {
    method: 'POST',
    headers,
    body: JSON.stringify(entry.payload)
  });
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as {
      slug?: string;
      serverUpdatedAt?: string;
      clientLastSyncedAt?: string;
    };
    throw new SavePostConflictError({
      slug: body.slug ?? entry.payload.slug,
      seq: entry.seq,
      serverUpdatedAt: body.serverUpdatedAt ?? '',
      clientLastSyncedAt: body.clientLastSyncedAt ?? entry.payload.lastSyncedAt ?? ''
    });
  }
  /* v8 ignore next 3 -- non-2xx, non-409 server response; prod-only */
  if (!res.ok) {
    throw new Error(`savePost drain ${entry.seq}: ${res.status}`);
  }
};
