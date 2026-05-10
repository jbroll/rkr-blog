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
  if (!res.ok) {
    throw new Error(`upload drain ${entry.seq}: ${res.status}`);
  }
  await res.json();
};

export const drainSetOps: Drainer = async (entry) => {
  if (entry.op !== 'setOps') return;
  const res = await fetch(`/admin/sidecar/${entry.payload.id}/ops`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rkr-outbox-seq': String(entry.seq) },
    body: JSON.stringify({ ops: entry.payload.ops, redoStack: entry.payload.redoStack })
  });
  if (!res.ok) {
    throw new Error(`setOps drain ${entry.seq}: ${res.status}`);
  }
};

export const drainBake: Drainer = async (entry, blob) => {
  if (entry.op !== 'bake') return;
  /* v8 ignore next 3 -- blob always present for bake entries */
  if (!blob) {
    throw new Error(`bake entry ${entry.seq} has no blob`);
  }
  const res = await fetch(`/admin/sidecar/${entry.payload.id}/bake`, {
    method: 'POST',
    headers: {
      'content-type': 'image/webp',
      'x-rkr-bake-ops-hash': entry.payload.opsHash,
      'x-rkr-outbox-seq': String(entry.seq)
    },
    body: blob
  });
  /* v8 ignore start -- 409 / 5xx paths exercised in prod, not e2e */
  if (!res.ok) {
    throw new Error(`bake drain ${entry.seq}: ${res.status}`);
  }
  /* v8 ignore stop */
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
  if (!res.ok) {
    throw new Error(`savePost drain ${entry.seq}: ${res.status}`);
  }
};
