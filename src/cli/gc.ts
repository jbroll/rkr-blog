// `site-admin gc` — delete orphan cache entries + leaked tmp files.
//
// Walks every sidecar, builds the set of valid <id>.<ophash>.<fmt> filenames
// (from the cross product of its declared variants × outputs), then deletes
// every file in cache/img/ not in that set. Also sweeps `*.tmp` files left
// behind by crashed atomic-write paths in cache/img, bakes/, sidecars/, and
// originals/.tmp/. Idempotent: a second run is a no-op (zero deletions).

import fs from 'node:fs';
import path from 'node:path';

import { paths } from '../lib/config.ts';
import {
  listPosts,
  listSidecarIds,
  listSidecars,
  listVideoSidecarIds,
  scanPostForVideoIds
} from '../lib/posts.ts';
import {
  type DerivativeArgs,
  derivativeFilename,
  type Op,
  type Output,
  type OutputFormat,
  type Variant
} from '../lib/render.ts';
import { findExistingVideoOriginal } from '../lib/video.ts';
import { videoFilename } from '../lib/video-render.ts';
import { readVideoSidecar } from '../lib/video-sidecar.ts';

export default async function gcCmd(_argv: string[]): Promise<void> {
  const result = await runGc(paths().root);
  console.log(`gc: ${result.deleted} orphan(s) deleted (${result.kept} kept)`);
}

/** A `.tmp` file is sweepable once it is at least `minAgeMs` old. `mtimeMs` is
 * fractional (sub-ms) while `Date.now()` is truncated to whole ms, so a file
 * written "just now" can have an mtime a hair ABOVE a slightly-later truncated
 * now and be misread as a future file. Flooring mtime to whole ms aligns the
 * two clocks — without this, gc skipped freshly-written leftovers at
 * minAgeMs=0, which made `runGc` flaky under load. */
function tmpAgedOut(mtimeMs: number, minAgeMs: number): boolean {
  return Math.floor(mtimeMs) <= Date.now() - minAgeMs;
}

/** Exposed for tests. Returns counts.
 * @param tmpMinAgeMs Minimum age for a .tmp file to be deleted (default 10 min).
 *   Tests pass 0 to delete immediately. */
export async function runGc(
  siteRoot: string,
  { tmpMinAgeMs = 10 * 60 * 1000 }: { tmpMinAgeMs?: number } = {}
): Promise<{ deleted: number; kept: number }> {
  const valid = new Set<string>();
  for (const s of await listSidecars(siteRoot)) {
    for (const v of s.variants) {
      const variant: Variant = {
        ...(v.w !== undefined ? { w: v.w } : {}),
        ...(v.h !== undefined ? { h: v.h } : {}),
        ...(v.fit !== undefined ? { fit: v.fit as Variant['fit'] } : {})
      };
      for (const o of s.outputs) {
        const output: Output = {
          format: o.format as OutputFormat,
          ...(o.quality !== undefined ? { quality: o.quality } : {})
        };
        const args: DerivativeArgs = {
          originalId: s.original,
          ops: s.ops as Op[],
          variant,
          output
        };
        valid.add(derivativeFilename(args));
      }
    }
  }

  // Video cache validity: one mp4 + one jpg per video sidecar.
  const validVideo = new Set<string>();
  for (const vid of listVideoSidecarIds(siteRoot)) {
    const sc = await readVideoSidecar(siteRoot, vid);
    if (!sc) continue;
    validVideo.add(videoFilename(vid, sc.ops, false));
    validVideo.add(videoFilename(vid, sc.ops, true, sc.poster.timeMs));
  }

  let deleted = 0;
  let kept = 0;

  // cache/img/: orphan derivatives + stale render tmp files.
  const cacheDir = path.join(siteRoot, 'cache', 'img');
  /* c8 ignore next 3 -- defensive guard; site-admin init always creates cache/img */
  if (fs.existsSync(cacheDir)) {
    for (const filename of fs.readdirSync(cacheDir)) {
      if (filename.endsWith('.tmp')) {
        const p = path.join(cacheDir, filename);
        const stat = fs.statSync(p, { throwIfNoEntry: false });
        if (!stat || !tmpAgedOut(stat.mtimeMs, tmpMinAgeMs)) continue;
        fs.unlinkSync(p);
        deleted++;
        continue;
      }
      if (valid.has(filename)) {
        kept++;
      } else {
        fs.unlinkSync(path.join(cacheDir, filename));
        deleted++;
      }
    }
  }

  // bakes/<aa>/<bb>/<id>.webp + leaked *.tmp from /admin/sidecar/:id/bake.
  // Bake files are reproducible (the editor re-uploads on Save), so a
  // stale .tmp is pure cleanup; the .webp files themselves stay and
  // are not gc'd here — they're cheap and the editor doesn't enumerate
  // valid bakes.
  deleted += sweepTmp(path.join(siteRoot, 'bakes'), tmpMinAgeMs);

  // sidecars/: flat dir. *.tmp from sidecar.write() crashes.
  deleted += sweepTmp(path.join(siteRoot, 'sidecars'), tmpMinAgeMs);

  // originals/.tmp/ — ingestStream's staging dir. Anything in here
  // post-rename is a crashed ingest.
  const originalsTmp = path.join(siteRoot, 'originals', '.tmp');
  if (fs.existsSync(originalsTmp)) {
    for (const name of fs.readdirSync(originalsTmp)) {
      const p = path.join(originalsTmp, name);
      const stat = fs.statSync(p, { throwIfNoEntry: false });
      if (!stat || !tmpAgedOut(stat.mtimeMs, tmpMinAgeMs)) continue;
      fs.unlinkSync(p);
      deleted++;
    }
  }

  // cache/video/: video derivatives + stale tmp files.
  const cacheVideoDir = path.join(siteRoot, 'cache', 'video');
  if (fs.existsSync(cacheVideoDir)) {
    for (const filename of fs.readdirSync(cacheVideoDir)) {
      if (filename.endsWith('.tmp')) {
        const p = path.join(cacheVideoDir, filename);
        const stat = fs.statSync(p, { throwIfNoEntry: false });
        if (!stat || !tmpAgedOut(stat.mtimeMs, tmpMinAgeMs)) continue;
        fs.unlinkSync(p);
        deleted++;
        continue;
      }
      if (validVideo.has(filename)) {
        kept++;
      } else {
        fs.unlinkSync(path.join(cacheVideoDir, filename));
        deleted++;
      }
    }
  }

  // sidecars/videos/*.tmp + originals/videos/.tmp sweeps.
  deleted += sweepTmp(path.join(siteRoot, 'sidecars', 'videos'), tmpMinAgeMs);
  const originalsVideoTmp = path.join(siteRoot, 'originals', 'videos', '.tmp');
  if (fs.existsSync(originalsVideoTmp)) {
    for (const name of fs.readdirSync(originalsVideoTmp)) {
      const p = path.join(originalsVideoTmp, name);
      const stat = fs.statSync(p, { throwIfNoEntry: false });
      if (!stat || !tmpAgedOut(stat.mtimeMs, tmpMinAgeMs)) continue;
      fs.unlinkSync(p);
      deleted++;
    }
  }

  // Orphaned video originals + sidecars: delete when no post references the id.
  {
    const posts = listPosts(siteRoot);
    const knownVideoIds = new Set(listVideoSidecarIds(siteRoot));
    const referenced = new Set<string>();
    for (const post of posts) {
      for (const id of scanPostForVideoIds(post.body, knownVideoIds)) referenced.add(id);
    }
    for (const vid of knownVideoIds) {
      if (referenced.has(vid)) continue;
      // Delete sidecar.
      const sidecarPath = path.join(siteRoot, 'sidecars', 'videos', `${vid}.json`);
      if (fs.existsSync(sidecarPath)) {
        fs.unlinkSync(sidecarPath);
        deleted++;
      }
      // Delete original file(s) across candidate exts.
      const orig = await findExistingVideoOriginal(siteRoot, vid);
      if (orig) {
        fs.unlinkSync(orig.path);
        deleted++;
        // Remove empty shard dirs (best-effort).
        try {
          const dir = path.dirname(orig.path);
          if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
          const parent = path.dirname(dir);
          if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
        } catch {
          /* ignore */
        }
      }
    }
  }

  // Orphaned image originals: delete originals/<aa>/<bb>/<id>.<ext> when no sidecar references the id.
  {
    const knownIds = new Set(listSidecarIds(siteRoot));
    const originalsRoot = path.join(siteRoot, 'originals');
    if (fs.existsSync(originalsRoot)) {
      const stack: string[] = [originalsRoot];
      while (stack.length > 0) {
        const dir = stack.pop() as string;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            // Skip tmp and videos subdirs — handled elsewhere.
            if (entry.name === '.tmp' || entry.name === 'videos') continue;
            stack.push(full);
          } else if (entry.isFile()) {
            const id = entry.name.split('.')[0] as string;
            if (!/^[0-9a-f]{64}$/.test(id)) continue;
            if (!knownIds.has(id)) {
              fs.unlinkSync(full);
              deleted++;
            }
          }
        }
      }
      // Best-effort empty shard cleanup.
      for (const aa of fs.readdirSync(originalsRoot)) {
        if (aa === '.tmp' || aa === 'videos') continue;
        const aaPath = path.join(originalsRoot, aa);
        if (!fs.statSync(aaPath, { throwIfNoEntry: false })?.isDirectory()) continue;
        for (const bb of fs.readdirSync(aaPath)) {
          const bbPath = path.join(aaPath, bb);
          try {
            if (fs.readdirSync(bbPath).length === 0) fs.rmdirSync(bbPath);
          } catch {
            /* ignore */
          }
        }
        try {
          if (fs.readdirSync(aaPath).length === 0) fs.rmdirSync(aaPath);
        } catch {
          /* ignore */
        }
      }
    }
  }

  return { deleted, kept };
}

/** Recursive sweep of `*.tmp` files under `root`. Used for cleanup of
 * 2/2-prefix-sharded directories (bakes/) and the flat sidecars/.
 * Non-tmp files are ignored — gc doesn't decide bake content lifecycle.
 * Only deletes files older than `minAgeMs` to avoid racing live writes. */
function sweepTmp(root: string, minAgeMs: number): number {
  if (!fs.existsSync(root)) return 0;
  let deleted = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.tmp')) {
        const stat = fs.statSync(full, { throwIfNoEntry: false });
        if (!stat || !tmpAgedOut(stat.mtimeMs, minAgeMs)) continue;
        fs.unlinkSync(full);
        deleted++;
      }
    }
  }
  return deleted;
}
