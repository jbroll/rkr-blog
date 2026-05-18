// Shared helpers used by every multi-image widget (gallery, carousel,
// diptych/triptych) to parse `ids="…"` attributes, resolve them against
// the sidecar set, and avoid hammering the filesystem on every render.
// Also exports the responsive <picture> renderer that the single-image
// and multi-image widgets all share — keeping the cache-key + srcset
// machinery in exactly one place.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import sharp from 'sharp';

import { cacheKey } from './hash.ts';
import { SHARP_PIXEL_LIMIT } from './image-constants.ts';
import { bakePath, imageInfo } from './originals.ts';
import { resamplePerspective } from './perspective-resample.ts';
import { listSidecarIds } from './posts.ts';
import { applyOp, type Op, type OutputFormat } from './render.ts';
import type { Sidecar } from './sidecar-types.ts';
import type { FallbackSpec, VariantSpec, WidgetCtx } from './widgets.ts';

const HEX_PREFIX = /^[0-9a-f]{6,64}$/;

/** Cap caption / alt length on widget render. Sidecar storage is
 * unbounded, but a 10 MB caption would render as a 10 MB <figcaption>
 * — that's neither useful nor accidental. Truncate with an ellipsis
 * so the rendered output stays bounded and the author can fix the
 * source. */
const MAX_CAPTION_LEN = 4096;
const MAX_ALT_LEN = 4096;

function clampCaption(s: unknown): string {
  if (typeof s !== 'string') return '';
  return s.length > MAX_CAPTION_LEN ? `${s.slice(0, MAX_CAPTION_LEN - 1)}…` : s;
}

export function clampAlt(s: unknown): string {
  if (typeof s !== 'string') return '';
  return s.length > MAX_ALT_LEN ? `${s.slice(0, MAX_ALT_LEN - 1)}…` : s;
}

/** Read a directive's `caption` attribute, clamped to MAX_CAPTION_LEN.
 * Returns null when the caption is unset or empty so the renderer
 * can omit the `<figcaption>` element entirely. */
export function extractDirectiveCaption(node: {
  attributes?: Record<string, string | null | undefined>;
}): string | null {
  const c = node.attributes?.caption;
  if (typeof c !== 'string' || c.length === 0) return null;
  return clampCaption(c);
}

export interface IdAndAlt {
  id: string;
  /** Raw alt text, NOT escaped — caller passes through escapeAttr
   * before interpolating into HTML. Empty string means "no alt
   * authored", which renders as `alt=""` (decorative default). */
  alt: string;
}

/** Split a comma-separated alts string, respecting \, escapes. */
export function splitAlts(s: string): string[] {
  return s.split(/(?<!\\),/).map((a) => a.replace(/\\,/g, ',').trim());
}

/** Join an alts array, escaping any commas inside individual values. */
export function joinAlts(alts: string[]): string {
  return alts.map((a) => a.replace(/,/g, '\\,')).join(',');
}

/**
 * Parse the `ids="abc,def,012"` attribute alongside the optional
 * parallel `alts="…"` attribute. Returns an order-preserving,
 * deduplicated list of {id, alt} pairs:
 *
 * - Each id is trimmed, lowercased, and must match the 6-64 hex regex.
 * - Duplicate ids (`ids="abc,abc"`) coalesce to a single entry; the
 *   first occurrence wins, so the same image isn't rendered twice and
 *   the diptych/triptych slot count guard can't be bypassed.
 * - Each surviving id is paired with the alt at its original comma-
 *   separated position. Whitespace-trimmed; empty entries map to
 *   empty alts (the safe-decorative default).
 *
 * Caveat: this format can't carry a comma inside any individual alt.
 * The spec's `:::gallery{...}` container directive form is the path
 * for that case (DEFERRED.md → "Per-image alt for galleries").
 */
export function extractImageIdsAndAlts(idsRaw: unknown, altsRaw: unknown): IdAndAlt[] {
  if (typeof idsRaw !== 'string') return [];
  const altsList = typeof altsRaw === 'string' ? splitAlts(altsRaw) : [];
  const seen = new Set<string>();
  const out: IdAndAlt[] = [];
  const splits = idsRaw.split(',');
  for (let i = 0; i < splits.length; i++) {
    const t = splits[i]?.trim().toLowerCase() ?? '';
    if (HEX_PREFIX.test(t) && !seen.has(t)) {
      seen.add(t);
      out.push({ id: t, alt: clampAlt(altsList[i] ?? '') });
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
  /** Site root for filesystem reads (the bake / original files). */
  siteRoot: string;
  id: string;
  sidecar: Sidecar;
  variants: VariantSpec[];
  fallback: FallbackSpec;
  /** Alt text. Already-escaped or plain string; renderPicture inlines verbatim. */
  alt?: string;
  /** loading attribute; default 'lazy'. */
  loading?: 'lazy' | 'eager';
  /** When true, wrap the <picture> in an <a href> pointing at the
   * largest variant + dimensional data attributes that PhotoSwipe's
   * Lightbox plugin reads (data-pswp-width, data-pswp-height). The
   * anchor doubles as a no-JS fallback (target=_blank to the same
   * derivative) so the image is still reachable when JS is off. */
  lightbox?: boolean;
}

/**
 * Render the responsive `<picture>` block for one image. One `<source>`
 * per format with srcset entries for each declared variant width, plus
 * a JPEG `<img>` fallback. Output has no leading indent — callers wrap
 * it in their own figure / slide / cell shell and indent as needed.
 */
export async function renderPicture(args: PictureArgs): Promise<string> {
  const {
    siteRoot,
    id,
    sidecar,
    variants,
    fallback,
    alt = '',
    loading = 'lazy',
    lightbox = false
  } = args;
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

  const pictureBlock = [
    '<picture>',
    ...sources,
    `<img src="${fbUrl}" alt="${alt}" loading="${loading}" decoding="async"/>`,
    '</picture>'
  ].join('\n');

  if (!lightbox) return pictureBlock;
  const dims = await imageDimensions(siteRoot, id, sidecar);
  return wrapLightboxAnchor(pictureBlock, { id, variants, alt, ops, dims });
}

/** Wrap a `<picture>` block in the PhotoSwipe-compatible anchor. The
 * href targets the largest configured variant in webp (PhotoSwipe will
 * load this same URL into its slide); the data-pswp-* attributes carry
 * the actual served pixel dimensions, capped by the variant width and
 * the original's recorded width — sharp's "fit: inside" never enlarges,
 * so a smaller original wins. */
function wrapLightboxAnchor(
  pictureBlock: string,
  ctx: {
    id: string;
    variants: VariantSpec[];
    alt: string;
    ops: Parameters<typeof cacheKey>[0]['ops'];
    dims: { width: number; height: number };
  }
): string {
  const { id, variants, alt, ops, dims } = ctx;
  const widest = variants.reduce((acc, v) => (v.w > acc.w ? v : acc), variants[0] as VariantSpec);
  // Prefer webp for the lightbox target — it's the format every modern
  // browser supports and the smallest-bytes choice for photographic
  // content (the typical lightbox payload).
  const lbFormat: OutputFormat =
    /* c8 ignore next -- 'webp' is in widest.formats for every figure-widget variant */
    widest.formats.includes('webp') ? 'webp' : (widest.formats[0] as OutputFormat);
  const lbHash = cacheKey({
    originalId: id,
    ops,
    variant: { w: widest.w },
    /* c8 ignore next -- ?? 85 unreachable: every format is in QUALITY_BY_FORMAT */
    output: { format: lbFormat, quality: QUALITY_BY_FORMAT[lbFormat] ?? 85 }
  });
  const lbUrl = `/img/${id}.${lbHash}.${lbFormat}`;

  const srcW = dims.width || widest.w;
  const srcH = dims.height || Math.round(widest.w / 1.5);
  const lbW = Math.min(widest.w, srcW);
  const lbH = Math.max(1, Math.round(lbW * (srcH / srcW)));

  return [
    `<a href="${lbUrl}" data-pswp-width="${lbW}" data-pswp-height="${lbH}" target="_blank" rel="noopener" aria-label="Enlarge image${alt ? `: ${alt}` : ''}">`,
    pictureBlock,
    '</a>'
  ].join('\n');
}

/** Read the actual on-disk dimensions of the image the renderer will
 * serve: the bake when ops are applied and the bake exists; the
 * original otherwise. The file IS the source of truth — recording dims
 * elsewhere is a synchronization problem we don't need. The brief
 * in-flight window (ops just changed, bake not yet uploaded) falls
 * back to sidecar.metadata; layout will be very slightly off until
 * the bake lands. */
export async function imageDimensions(
  siteRoot: string,
  id: string,
  sidecar: Sidecar
): Promise<{ width: number; height: number }> {
  const ops = sidecar.ops ?? [];
  if (ops.length === 0) {
    const info = await imageInfo(siteRoot, id);
    return { width: info?.width ?? 1, height: info?.height ?? 1 };
  }
  // Ops present: the post-ops bake on disk IS the source of truth
  // for dims (file == truth). If missing, recreate it server-side
  // from the original + ops via sharp. ensureBake throws for the
  // perspective branch sharp can't handle, surfaced upstream so the
  // operator notices instead of getting silent wrong dims.
  return ensureBake(siteRoot, id, sidecar);
}

/** Return the bake's on-disk dimensions, recreating the file from
 * the original + ops when missing. All op kinds — including
 * perspective — are recreatable: sharp handles crop/rotate/flip/
 * resample directly; perspective uses a pure-JS resampler (see
 * src/lib/perspective-resample.ts) that mirrors the editor's WebGL
 * pipeline pixel-for-pixel.
 *
 * Net effect: any sidecar with ops + no bake self-heals on first
 * request, and the served pixels match what the editor would have
 * baked. File-as-truth holds. */
async function ensureBake(
  siteRoot: string,
  id: string,
  sidecar: Sidecar
): Promise<{ width: number; height: number }> {
  const bp = bakePath(siteRoot, id);
  try {
    const meta = await sharp(bp).metadata();
    if (meta.width && meta.height) return { width: meta.width, height: meta.height };
  } catch {
    /* missing or unreadable; recreate below */
  }
  const ops = (sidecar.ops ?? []) as Op[];
  const info = await imageInfo(siteRoot, id);
  if (!info) {
    throw new Error(`widget-helpers: original missing for ${id.slice(0, 8)}…`);
  }
  const pipeline = await applyOpsWithPerspective(info.path, ops);
  await fs.promises.mkdir(path.dirname(bp), { recursive: true });
  const tmp = `${bp}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await pipeline.webp({ quality: 90 }).toFile(tmp);
    await fs.promises.rename(tmp, bp);
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
  // biome-ignore lint/suspicious/noConsole: surface to fly logs when self-healing pre-migration sidecars
  console.warn(`widget-helpers: recreated missing bake for ${id.slice(0, 8)}…`);
  const meta = await sharp(bp).metadata();
  return { width: meta.width ?? 1, height: meta.height ?? 1 };
}

/** Chain ops through sharp, handling perspective with a pure-JS
 * detour. Non-perspective ops compose via the standard sharp chain
 * (applyOp); a perspective op materializes the current pipeline to
 * raw RGBA, runs the JS resampler, then restarts the chain from the
 * resampled buffer. Multiple perspective ops in a row work fine,
 * just with one materialization per op. */
async function applyOpsWithPerspective(srcPath: string, ops: readonly Op[]): Promise<sharp.Sharp> {
  let pipeline: sharp.Sharp = sharp(srcPath, {
    failOn: 'error',
    limitInputPixels: SHARP_PIXEL_LIMIT
  });
  for (const op of ops) {
    if (op.type === 'perspective') {
      const { data, info } = await pipeline
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const result = resamplePerspective(data, info.width, info.height, op);
      if (!result) {
        throw new Error(`widget-helpers: malformed perspective op (corners or homography)`);
      }
      pipeline = sharp(result.buffer, {
        raw: { width: result.width, height: result.height, channels: 4 },
        limitInputPixels: SHARP_PIXEL_LIMIT
      });
    } else {
      pipeline = applyOp(pipeline, op);
    }
  }
  return pipeline;
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
