// Shared helpers used by every multi-image widget (gallery, carousel,
// diptych/triptych) to parse `ids="…"` attributes, resolve them against
// the sidecar set, and avoid hammering the filesystem on every render.

import { listSidecarIds } from './posts.ts';
import type { WidgetCtx } from './widgets.ts';

const HEX_PREFIX = /^[0-9a-f]{6,64}$/;

/**
 * Parse the `ids="abc,def,012"` attribute. Returns an order-preserving,
 * deduplicated list of lowercased ids that pass the 6-64 hex regex.
 * Duplicate inputs (e.g. `ids="abc,abc"`) are coalesced to a single
 * entry so the same image isn't rendered twice and so the diptych /
 * triptych slot count guard can't be bypassed by repeating an id.
 */
export function extractImageIds(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of raw.split(',')) {
    const t = s.trim().toLowerCase();
    if (HEX_PREFIX.test(t) && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * Resolve each input id (full or prefix) to a full 64-char id. Inputs
 * that match nothing or match more than one sidecar are returned as
 * null placeholders — the renderer turns them into HTML comments so
 * authoring mistakes are visible.
 */
export function resolveIds(inputs: string[], known: string[]): (string | null)[] {
  return inputs.map((input) => {
    if (input.length === 64) return known.includes(input) ? input : null;
    const matches = known.filter((id) => id.startsWith(input));
    return matches.length === 1 ? (matches[0] ?? null) : null;
  });
}

/**
 * listSidecarIds() is a synchronous fs.readdirSync; calling it once per
 * widget render means N FS scans for a post with N image directives.
 * Memoize per WidgetCtx — one render of a post passes the same ctx to
 * every widget dispatch, so the cache lifetime is exactly one post.
 */
const knownIdsByCtx = new WeakMap<WidgetCtx, string[]>();
export function getKnownIds(ctx: WidgetCtx): string[] {
  let cached = knownIdsByCtx.get(ctx);
  if (!cached) {
    cached = listSidecarIds(ctx.siteRoot);
    knownIdsByCtx.set(ctx, cached);
  }
  return cached;
}
