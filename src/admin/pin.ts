// Pin an existing post into OPFS for offline editing (spec-offline §6).

import { markdownToProse } from '../lib/prose-markdown.ts';
import type { Sidecar } from '../lib/sidecar-types.ts';
import { readMeta, updateMeta } from './draft.ts';
import { listDir, readBlob, writeBlob, writeJson } from './opfs.ts';
import { mutateRoot, OPFS_DIRS } from './opfs-schema.ts';

const META_DIR = OPFS_DIRS.META;

/** @public */
export interface PinManifest {
  slug: string;
  title: string;
  /** Optional secondary heading; only carried when the post has one. */
  subtitle?: string;
  status: string;
  date?: string;
  lastModified: string;
  markdown: string;
  originals: { id: string; ext: string; bytes: number }[];
  sidecars: { id: string; json: Sidecar }[];
  /** Tag names attached to the post; empty array when untagged. */
  tags?: string[];
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
  // Body + meta first, currentDraftId flip last: a crash between
  // them orphans the new draft (eviction reclaims) rather than
  // leaving _root pointing at a missing file. Only the final flip
  // moves under ROOT_LOCK (mutateRoot) — the body/meta writes above
  // it keep their ordering.
  await writeJson(`drafts/${draftId}.json`, doc);
  await updateMeta(draftId, {
    slug: manifest.slug,
    lastSyncedAt: manifest.lastModified,
    mode: 'pinned',
    refIds: manifest.sidecars.map((s) => s.id)
  });
  await mutateRoot((root) => ({ ...root, currentDraftId: draftId }));

  return { draftId, manifest, progress };
}

/** Set of slugs whose draft meta is currently `mode: 'pinned'`.
 * Used by the admin posts list to render the pin button's pressed
 * state on page load. */
export async function pinnedSlugs(): Promise<Set<string>> {
  const slugs = new Set<string>();
  for (const fname of await listDir(META_DIR)) {
    if (!fname.endsWith('.json')) continue;
    const draftId = fname.replace(/\.json$/, '');
    const meta = await readMeta(draftId);
    if (meta?.slug && meta.mode === 'pinned') slugs.add(meta.slug);
  }
  return slugs;
}

/** Flip every meta whose slug matches AND mode is 'pinned' back to
 * 'cached'. The data stays in OPFS — eviction reclaims it on the
 * next sweep — so re-pinning a recently-unpinned post is fast (the
 * originals are still local). Returns the count flipped so the
 * caller can update its status line. */
export async function unpinSlug(slug: string): Promise<number> {
  let flipped = 0;
  for (const fname of await listDir(META_DIR)) {
    if (!fname.endsWith('.json')) continue;
    const draftId = fname.replace(/\.json$/, '');
    const meta = await readMeta(draftId);
    if (meta?.slug === slug && meta.mode === 'pinned') {
      await updateMeta(draftId, { mode: 'cached' });
      flipped++;
    }
  }
  return flipped;
}
