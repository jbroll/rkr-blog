// Pre-warm derivative renders after /admin/posts saves a post.
// Walks the markdown for image refs, reads each sidecar, enqueues
// one render job per (variant × output). The jobs table dedups by
// cache_key, so a re-save of an unchanged post is effectively a
// no-op. Worker concurrency = 1 + the live-render gauge in jobs.ts
// keep this from contending with live /img requests.

import type { Db } from '../lib/db.ts';
import { cacheKey } from '../lib/hash.ts';
import { enqueue } from '../lib/jobs.ts';
import { listSidecarIds, scanPostForImageIds } from '../lib/posts.ts';
import type { DerivativeArgs, Op, OutputFormat } from '../lib/render.ts';
import { read as sidecarRead } from '../lib/sidecar.ts';

export async function prewarmVariants(db: Db, siteRoot: string, markdown: string): Promise<void> {
  const knownIds = new Set(listSidecarIds(siteRoot));
  const refIds = scanPostForImageIds(markdown, knownIds);
  for (const id of refIds) {
    const sc = await sidecarRead(siteRoot, id);
    if (!sc) continue;
    for (const variant of sc.variants) {
      for (const output of sc.outputs) {
        const v = { w: variant.w, h: variant.h, fit: variant.fit } as DerivativeArgs['variant'];
        const o = {
          format: output.format as OutputFormat,
          quality: output.quality
        } as DerivativeArgs['output'];
        const args: DerivativeArgs & { siteRoot: string } = {
          originalId: id,
          ops: sc.ops as Op[],
          variant: v,
          output: o,
          siteRoot
        };
        const ck = cacheKey({
          originalId: id,
          ops: sc.ops as never,
          variant: v as never,
          output: o as never
        });
        enqueue(db, { kind: 'render', payload: args, cacheKey: ck });
      }
    }
  }
}
