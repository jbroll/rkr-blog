// Per-op drainers: outbox entry → HTTP call. Registered by startup.ts.

import { extForMime } from '../lib/content-id.ts';
import type { OutboxEntry } from '../lib/outbox-types.ts';
import { readBlob } from './opfs.ts';
import { type Drainer, SavePostConflictError } from './sync.ts';

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
  const res = await fetch('/admin/upload', {
    method: 'POST',
    body: fd,
    headers: { 'x-rkr-outbox-seq': String(entry.seq) }
  });
  /* v8 ignore next 3 -- non-2xx server response; prod-only path */
  if (!res.ok) {
    throw new Error(`upload drain ${entry.seq}: ${res.status}`);
  }
  await res.json();
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
  const res = await fetch(`/admin/sidecar/${entry.payload.id}/commit`, {
    method: 'POST',
    headers: { 'x-rkr-outbox-seq': String(entry.seq) },
    body: fd
  });
  /* v8 ignore next 3 -- non-2xx server response; prod-only path */
  if (!res.ok) {
    throw new Error(`commitImageEdit drain ${entry.seq}: ${res.status}`);
  }
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
