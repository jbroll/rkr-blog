// Pin an existing post to OPFS so the author can edit it offline
// (spec-offline §6 + §7). Two-step flow:
//
//   1. GET /admin/post-bundle/:slug?manifest=1 → small JSON listing
//      sidecars + originals + post body.
//   2. For each sidecar: write opfs://sidecars/<id>.json.
//      For each original: skip-if-already-cached, else fetch
//      GET /admin/original/:id → opfs://originals/<id>.<ext>.
//
// The draft is materialised as a fresh draftId pointing at the
// markdown body. handleSave's existing path (phase 1g) then does
// the right thing online or offline; the X-Rkr-Last-Synced-At
// header carries the manifest's lastModified so the server's
// optimistic-concurrency guard (phase 1k) protects against another
// device editing in the meantime.

import { markdownToProse } from '../lib/prose-markdown.ts';
import type { Sidecar } from '../lib/sidecar-types.ts';
import { updateMeta } from './draft.ts';
import { readBlob, writeBlob, writeJson } from './opfs.ts';
import { readRoot, writeRoot } from './opfs-schema.ts';

/** @public */
export interface PinManifest {
  slug: string;
  title: string;
  status: string;
  date?: string;
  lastModified: string;
  markdown: string;
  originals: { id: string; ext: string; bytes: number }[];
  sidecars: { id: string; json: Sidecar }[];
}

/** @public */
export interface PinProgress {
  total: number;
  fetched: number;
  skipped: number;
  failed: number;
}

/** Result of a successful pin: the new draftId now points at the
 * post and is the SPA's currentDraftId. The caller (toolbar) loads
 * the editor with the parsed TipTap doc — handleSave's existing
 * path drains it normally on edit.
 * @public */
export interface PinResult {
  draftId: string;
  manifest: PinManifest;
  progress: PinProgress;
}

/** Pull a post bundle into OPFS. Marks it `mode: pinned` in meta so
 * eviction (phase 3) leaves it alone. Existing originals are
 * skipped (idempotent re-pin). Failed originals don't abort the
 * pin — the per-image-retry status is reported via onProgress so
 * the UI can surface partials.
 * @public */
export async function pinPost(
  slug: string,
  onProgress?: (p: PinProgress) => void
): Promise<PinResult> {
  const res = await fetch(`/admin/post-bundle/${slug}?manifest=1`);
  if (!res.ok) throw new Error(`pin fetch ${res.status}`);
  const manifest = (await res.json()) as PinManifest;

  for (const sc of manifest.sidecars) {
    await writeJson(`sidecars/${sc.id}.json`, sc.json);
  }

  const total = manifest.originals.length;
  const progress: PinProgress = { total, fetched: 0, skipped: 0, failed: 0 };
  for (const orig of manifest.originals) {
    const path = `originals/${orig.id}.${orig.ext}`;
    const existing = await readBlob(path);
    if (existing) {
      progress.skipped++;
    } else {
      try {
        const r = await fetch(`/admin/original/${orig.id}`);
        /* v8 ignore next 3 -- server-error path; happy path is 200 */
        if (!r.ok) throw new Error(`original ${orig.id.slice(0, 8)}: ${r.status}`);
        await writeBlob(path, await r.blob());
        progress.fetched++;
      } catch {
        progress.failed++;
      }
    }
    onProgress?.({ ...progress });
  }

  // Create a fresh draftId for this pin. Bumping currentDraftId
  // means the next mount restores THIS post. Keeps the single-
  // draft-session model from phase 1h intact; phase 3 storage panel
  // adds the multi-draft list.
  const draftId = crypto.randomUUID();
  const root = await readRoot();
  /* v8 ignore next 3 -- ensureSchema runs at startup; missing root
     would mean a corrupted OPFS, not a normal flow */
  if (!root) {
    throw new Error('pin: _root.json missing — ensureSchema not called?');
  }
  await writeRoot({ ...root, currentDraftId: draftId });

  // Serialize the parsed prose doc as drafts/<id>.json so the next
  // mount restores the post body. updateMeta stamps slug +
  // lastSyncedAt so handleSave's optimistic-concurrency header is
  // accurate from the first edit.
  const doc = markdownToProse(manifest.markdown);
  await writeJson(`drafts/${draftId}.json`, doc);
  await updateMeta(draftId, {
    slug: manifest.slug,
    lastSyncedAt: manifest.lastModified,
    mode: 'pinned',
    refIds: manifest.sidecars.map((s) => s.id)
  });

  return { draftId, manifest, progress };
}
