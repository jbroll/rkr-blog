// Shared helpers used by every multi-image widget (gallery, carousel,
// diptych/triptych) to parse `ids="…"` attributes, resolve them against
// the sidecar set, and avoid hammering the filesystem on every render.
// Also exports the responsive <picture> renderer that the single-image
// and multi-image widgets all share — keeping the cache-key + srcset
// machinery in exactly one place.

import { cacheKey } from './hash.ts';
import { listSidecarIds } from './posts.ts';
import type { OutputFormat } from './render.ts';
import type { Sidecar } from './sidecar.ts';
import type { FallbackSpec, VariantSpec, WidgetCtx } from './widgets.ts';

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

// ---- responsive picture rendering --------------------------------------

const QUALITY_BY_FORMAT: Record<string, number> = {
  webp: 85,
  avif: 70,
  jpeg: 85,
  png: 0
};

export interface PictureArgs {
  id: string;
  sidecar: Sidecar;
  variants: VariantSpec[];
  fallback: FallbackSpec;
  /** Alt text. Already-escaped or plain string; renderPicture inlines verbatim. */
  alt?: string;
  /** loading attribute; default 'lazy'. */
  loading?: 'lazy' | 'eager';
}

/**
 * Render the responsive `<picture>` block for one image. One `<source>`
 * per format with srcset entries for each declared variant width, plus
 * a JPEG `<img>` fallback. Output has no leading indent — callers wrap
 * it in their own figure / slide / cell shell and indent as needed.
 */
export function renderPicture(args: PictureArgs): string {
  const { id, sidecar, variants, fallback, alt = '', loading = 'lazy' } = args;
  const ops = sidecar.ops as Parameters<typeof cacheKey>[0]['ops'];

  const formats = unique(variants.flatMap((v) => v.formats));
  const sources = formats.map((format) => {
    const entries = variants
      .filter((v) => v.formats.includes(format))
      .map((v) => {
        const oph = cacheKey({
          originalId: id,
          ops,
          variant: { w: v.w },
          /* c8 ignore next -- ?? 85 unreachable: every format is in QUALITY_BY_FORMAT */
          output: { format, quality: QUALITY_BY_FORMAT[format] ?? 85 }
        });
        return `/img/${id}.${oph}.${format} ${v.w}w`;
      });
    return `<source type="image/${format}" srcset="${entries.join(', ')}"/>`;
  });

  const fbHash = cacheKey({
    originalId: id,
    ops,
    variant: { w: fallback.w },
    output: { format: fallback.format as OutputFormat, quality: fallback.quality }
  });
  const fbUrl = `/img/${id}.${fbHash}.${fallback.format}`;

  return [
    '<picture>',
    ...sources,
    `<img src="${fbUrl}" alt="${alt}" loading="${loading}"/>`,
    '</picture>'
  ].join('\n');
}

/** Aspect ratio (w/h) as a 4-decimal string from sidecar metadata.
 * Used in the `--aspect` CSS variable on gallery/carousel/diptych cells. */
export function pictureAspect(sidecar: Sidecar): string {
  const w = sidecar.metadata.width ?? 1;
  const h = sidecar.metadata.height ?? 1;
  return (w / h).toFixed(4);
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

/** Indent every line of a multi-line string by the given prefix. */
export function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}
