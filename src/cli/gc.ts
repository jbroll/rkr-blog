// `site-admin gc` — delete orphan cache entries.
//
// Walks every sidecar, builds the set of valid <id>.<ophash>.<fmt> filenames
// (from the cross product of its declared variants × outputs), then deletes
// every file in cache/img/ not in that set. Idempotent: a second run is a
// no-op (zero deletions).

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

  const cacheDir = path.join(siteRoot, 'cache', 'img');
  /* c8 ignore next 3 -- defensive guard; site-admin init always creates cache/img */
  if (!fs.existsSync(cacheDir)) {
    return { deleted: 0, kept: 0 };
  }

  let deleted = 0;
  let kept = 0;
  for (const filename of fs.readdirSync(cacheDir)) {
    if (filename.endsWith('.tmp')) {
      // Stale temp from a crashed render — always remove.
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
  return { deleted, kept };
}
