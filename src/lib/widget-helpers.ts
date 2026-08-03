// Attribute parsing (`ids="…"`, alts, captions) plus the responsive
// <picture> renderer every image widget shares. Pure string work: the
// URLs and dimensions come from the ImageSource the caller hands in.

import type { ImageSource } from './image-map.ts';
import type { FallbackSpec, VariantSpec } from './widgets.ts';

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

// ---- responsive picture rendering --------------------------------------

const QUALITY_BY_FORMAT: Record<string, number> = {
  webp: 85,
  avif: 70,
  jpeg: 85,
  png: 0
};

export interface PictureArgs {
  src: ImageSource;
  variants: VariantSpec[];
  fallback: FallbackSpec;
  /** Alt text. Already-escaped or plain string; inlined verbatim. */
  alt?: string;
  loading?: 'lazy' | 'eager';
  /** Wrap in the PhotoSwipe anchor (href + data-pswp-* dimensions). */
  lightbox?: boolean;
}

/**
 * Render the responsive `<picture>` block for one image. One `<source>`
 * per format with srcset entries for each declared variant width, plus
 * a JPEG `<img>` fallback. Output has no leading indent — callers wrap
 * it in their own figure / slide / cell shell and indent as needed.
 */
export function renderPicture(args: PictureArgs): string {
  const { src, variants, fallback, alt = '', loading = 'lazy', lightbox = false } = args;

  const fbUrl = src.urlFor(fallback.w, fallback.format, fallback.quality);
  const formats = unique(variants.flatMap((v) => v.formats));
  const sources: string[] = [];
  const distinct = new Set<string>([fbUrl]);
  for (const format of formats) {
    const entries = variants
      .filter((v) => v.formats.includes(format))
      .map((v) => {
        /* c8 ignore next -- ?? 85 unreachable: every format is in QUALITY_BY_FORMAT */
        const url = src.urlFor(v.w, format, QUALITY_BY_FORMAT[format] ?? 85);
        distinct.add(url);
        return `${url} ${v.w}w`;
      });
    sources.push(`<source type="image/${format}" srcset="${entries.join(', ')}"/>`);
  }

  // A client-side map hands back one blob: URL for every candidate;
  // a srcset of identical URLs is noise, so collapse to the <img>.
  const pictureBlock =
    distinct.size === 1
      ? `<picture>\n<img src="${fbUrl}" alt="${alt}" loading="${loading}" decoding="async"/>\n</picture>`
      : [
          '<picture>',
          ...sources,
          `<img src="${fbUrl}" alt="${alt}" loading="${loading}" decoding="async"/>`,
          '</picture>'
        ].join('\n');

  if (!lightbox) return pictureBlock;
  return wrapLightboxAnchor(pictureBlock, { src, variants, alt });
}

/** Wrap a `<picture>` block in the PhotoSwipe-compatible anchor. The
 * href targets the largest configured variant in webp (PhotoSwipe will
 * load this same URL into its slide); the data-pswp-* attributes carry
 * the actual served pixel dimensions, capped by the variant width and
 * the original's recorded width — sharp's "fit: inside" never enlarges,
 * so a smaller original wins. */
function wrapLightboxAnchor(
  pictureBlock: string,
  ctx: { src: ImageSource; variants: VariantSpec[]; alt: string }
): string {
  const { src, variants, alt } = ctx;
  const widest = variants.reduce((acc, v) => (v.w > acc.w ? v : acc), variants[0] as VariantSpec);
  /* c8 ignore next -- 'webp' is in widest.formats for every figure-widget variant */
  const lbFormat = widest.formats.includes('webp') ? 'webp' : (widest.formats[0] as string);
  /* c8 ignore next -- ?? 85 unreachable: every format is in QUALITY_BY_FORMAT */
  const lbUrl = src.urlFor(widest.w, lbFormat, QUALITY_BY_FORMAT[lbFormat] ?? 85);

  const srcW = src.width || widest.w;
  const srcH = src.height || Math.round(widest.w / 1.5);
  const lbW = Math.min(widest.w, srcW);
  const lbH = Math.max(1, Math.round(lbW * (srcH / srcW)));

  return [
    `<a href="${lbUrl}" data-pswp-width="${lbW}" data-pswp-height="${lbH}" target="_blank" rel="noopener" aria-label="Enlarge image${alt ? `: ${alt}` : ''}">`,
    pictureBlock,
    '</a>'
  ].join('\n');
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
