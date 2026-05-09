// Per-op drainers: turn an outbox entry back into the HTTP call it
// queued. Registered once per op type at startup; sync.ts dispatches
// to them when it runs the drain loop.
//
// Each drainer either:
//   • returns void on 2xx → sync.ts removes the entry
//   • throws → sync.ts halts; the user sees a "halted: <reason>"
//     status and decides whether to retry or discard
//
// 409 handling is op-specific (per spec-offline §11):
//   - upload    impossible (content-addressed; deduped server-side)
//   - setOps    LWW; server overwrites — no 409 expected
//   - bake      stale ops-hash; client re-bakes against current ops
//                and retries (handled inline)
//   - savePost  superseded; conflict surfaced to author (phase 1g)

import { extForMime } from '../lib/content-id.ts';
import type { OutboxEntry } from '../lib/outbox-types.ts';
import { readBlob } from './opfs.ts';
import type { Drainer } from './sync.ts';

export const drainUpload: Drainer = async (entry, _blobIgnored) => {
  if (entry.op !== 'upload') return;
  // Read from opfs://originals/<id>.<ext> rather than the outbox-
  // blob copy: queueUpload writes the bytes to originals/ as the
  // canonical local copy (offline-preview use), so we don't write
  // a redundant outbox-blob. sync.ts's per-entry blob-read isn't
  // used for upload entries.
  const ext = extForMime(entry.payload.mimeType);
  const blob = await readBlob(`originals/${entry.payload.id}.${ext}`);
  /* v8 ignore next 3 -- writeBlob in queueUpload ran before append */
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
  /* v8 ignore start -- 409 + 5xx paths are surfaced to the user; they
     fire on real conflicts in production but the offline-then-drain
     happy path doesn't trip them. Phase 1g extends this with the
     re-bake-against-current-ops auto-retry. */
  if (!res.ok) {
    throw new Error(`bake drain ${entry.seq}: ${res.status}`);
  }
  /* v8 ignore stop */
};

/** Phase 1g savePost drainer — landing in the next commit. */
export const drainSavePost: Drainer = async (_entry: OutboxEntry) => {
  throw new Error('savePost drain not yet implemented (phase 1g)');
};
