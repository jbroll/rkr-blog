// Pre-warm derivative renders for a saved blocks page.
//
// Collects media references from figure/video leaves (their `slots.ids`)
// and from figure/video directives embedded in text leaves' markdown,
// reads each sidecar, and enqueues one render job per
// (variant × output). The jobs table dedups by cache_key, so a re-save
// of an unchanged page is effectively a no-op. Worker concurrency = 1 +
// the live-render gauge in jobs.ts keep this from contending with live
// /img requests.
//
// Media referenced only from a macro definition is not pre-warmed: the
// saved tree holds the macro instance, not its expanded leaves, and the
// scan is deliberately a best-effort warm-up rather than a render.

import type { BlockNode, BlockTree, ContainerNode } from '../lib/blocks.ts';
import type { Db } from '../lib/db.ts';
import { readGridSlots } from '../lib/grid.ts';
import { cacheKey } from '../lib/hash.ts';
import { enqueue } from '../lib/jobs.ts';
import {
  listSidecarIds,
  listVideoSidecarIds,
  scanPostForImageIds,
  scanPostForVideoIds
} from '../lib/posts.ts';
import type { DerivativeArgs, Op, OutputFormat } from '../lib/render.ts';
import { read as sidecarRead } from '../lib/sidecar.ts';
import { videoCachePaths } from '../lib/video-render.ts';
import { readVideoSidecar } from '../lib/video-sidecar.ts';

/** Flatten every string that may carry a media id into one scan text:
 * slot ids from figure/video leaves, band backgrounds, and markdown
 * from text leaves. */
function collectMediaRefs(tree: BlockTree): string {
  const parts: string[] = [];
  const walk = (node: BlockNode): void => {
    if (node.type === 'text') {
      const markdown =
        node.markdown ?? (typeof node.slots?.markdown === 'string' ? node.slots.markdown : '');
      if (markdown) parts.push(markdown);
    }
    if ((node.type === 'figure' || node.type === 'video') && typeof node.slots?.ids === 'string') {
      parts.push(node.slots.ids);
    }
    if (node.type === 'grid') {
      const { bg } = readGridSlots(node.slots);
      if (bg) parts.push(bg);
    }
    if (node.type === 'macro') return;
    const kids = (node as ContainerNode).children ?? [];
    for (const kid of kids) walk(kid);
  };
  for (const node of tree.body) walk(node);
  return parts.join('\n');
}

export async function prewarmBlockTree(db: Db, siteRoot: string, tree: BlockTree): Promise<void> {
  const refs = collectMediaRefs(tree);

  const knownIds = new Set(listSidecarIds(siteRoot));
  const refIds = scanPostForImageIds(refs, knownIds);
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

  const knownVideoIds = new Set(listVideoSidecarIds(siteRoot));
  const videoRefIds = scanPostForVideoIds(refs, knownVideoIds);
  for (const id of videoRefIds) {
    const sc = await readVideoSidecar(siteRoot, id);
    if (!sc) continue;
    const paths = videoCachePaths(siteRoot, id, sc.ops, sc.poster.timeMs);
    enqueue(db, {
      kind: 'renderVideo',
      payload: { originalId: id, ops: sc.ops, posterTimeMs: sc.poster.timeMs, siteRoot },
      cacheKey: paths.videoOphash
    });
  }
}
