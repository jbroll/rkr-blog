// Pin an existing post into OPFS for offline editing (spec-offline §6).

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

/** @public */
export interface PinResult {
  draftId: string;
  manifest: PinManifest;
  progress: PinProgress;
}

/** @public */
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
        /* v8 ignore next 3 -- server-error path */
        if (!r.ok) throw new Error(`original ${orig.id.slice(0, 8)}: ${r.status}`);
        await writeBlob(path, await r.blob());
        progress.fetched++;
      } catch {
        progress.failed++;
      }
    }
    onProgress?.({ ...progress });
  }

  // Parse before any side effects. A throw here must not leave
  // currentDraftId pointing at a half-written draft.
  const doc = markdownToProse(manifest.markdown);

  const draftId = crypto.randomUUID();
  const root = await readRoot();
  /* v8 ignore next 3 -- ensureSchema runs at startup */
  if (!root) {
    throw new Error('pin: _root.json missing — ensureSchema not called?');
  }
  // Body + meta first, currentDraftId flip last: a crash between
  // them orphans the new draft (eviction reclaims) rather than
  // leaving _root pointing at a missing file.
  await writeJson(`drafts/${draftId}.json`, doc);
  await updateMeta(draftId, {
    slug: manifest.slug,
    lastSyncedAt: manifest.lastModified,
    mode: 'pinned',
    refIds: manifest.sidecars.map((s) => s.id)
  });
  await writeRoot({ ...root, currentDraftId: draftId });

  return { draftId, manifest, progress };
}
