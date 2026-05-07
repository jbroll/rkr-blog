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
import { listSidecars } from '../lib/posts.ts';
import {
  type DerivativeArgs,
  derivativeFilename,
  type Op,
  type Output,
  type OutputFormat,
  type Variant
} from '../lib/render.ts';

export default async function gcCmd(_argv: string[]): Promise<void> {
  const result = await runGc(paths().root);
  console.log(`gc: ${result.deleted} orphan(s) deleted (${result.kept} kept)`);
}

/** Exposed for tests. Returns counts. */
export async function runGc(siteRoot: string): Promise<{ deleted: number; kept: number }> {
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

  let deleted = 0;
  let kept = 0;

  // cache/img/: orphan derivatives + stale render tmp files.
  const cacheDir = path.join(siteRoot, 'cache', 'img');
  /* c8 ignore next 3 -- defensive guard; site-admin init always creates cache/img */
  if (fs.existsSync(cacheDir)) {
    for (const filename of fs.readdirSync(cacheDir)) {
      if (filename.endsWith('.tmp')) {
        fs.unlinkSync(path.join(cacheDir, filename));
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
  deleted += sweepTmp(path.join(siteRoot, 'bakes'));

  // sidecars/: flat dir. *.tmp from sidecar.write() crashes.
  deleted += sweepTmp(path.join(siteRoot, 'sidecars'));

  // originals/.tmp/ — ingestStream's staging dir. Anything in here
  // post-rename is a crashed ingest.
  const originalsTmp = path.join(siteRoot, 'originals', '.tmp');
  if (fs.existsSync(originalsTmp)) {
    for (const name of fs.readdirSync(originalsTmp)) {
      fs.unlinkSync(path.join(originalsTmp, name));
      deleted++;
    }
  }

  return { deleted, kept };
}

/** Recursive sweep of `*.tmp` files under `root`. Used for cleanup of
 * 2/2-prefix-sharded directories (bakes/) and the flat sidecars/.
 * Non-tmp files are ignored — gc doesn't decide bake content lifecycle. */
function sweepTmp(root: string): number {
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
        fs.unlinkSync(full);
        deleted++;
      }
    }
  }
  return deleted;
}
