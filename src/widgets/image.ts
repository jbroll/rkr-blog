// Image widget. Renders `::image{#<id> alt="..."}` to a <picture> block
// with srcset entries for each (variant × format) the widget declares,
// using cache-friendly URLs `/img/<id>.<ophash>.<fmt>`.
//
// The widget's `variants` are the source of truth for srcset (spec §12).
// Image ingest currently writes the same defaults into each sidecar, so a
// `site-admin render` warms exactly these URLs. Custom per-image variant
// sets are a future enhancement.

import { escapeAttr } from '../lib/content.ts';
import { cacheKey } from '../lib/hash.ts';
import type { OutputFormat } from '../lib/render.ts';
import { read as sidecarRead } from '../lib/sidecar.ts';
import type {
  DirectiveNode,
  FallbackSpec,
  VariantSpec,
  Widget,
  WidgetCtx
} from '../lib/widgets.ts';

export const name = 'image';

export const variants: VariantSpec[] = [
  { w: 400, formats: ['webp', 'avif'] },
  { w: 800, formats: ['webp', 'avif'] },
  { w: 1600, formats: ['webp', 'avif'] }
];

export const fallback: FallbackSpec = { w: 1200, format: 'jpeg', quality: 85 };

const QUALITY_BY_FORMAT: Record<string, number> = {
  webp: 85,
  avif: 70,
  jpeg: 85,
  png: 0
};

/** Pull the id from a directive's attributes (handles both `id=…` and `#…`). */
function extractId(node: DirectiveNode): string | null {
  const attrs = node.attributes ?? {};
  const id = attrs.id;
  if (typeof id === 'string' && /^[0-9a-f]{6,64}$/.test(id)) return id;
  return null;
}

function extractAlt(node: DirectiveNode): string {
  const a = node.attributes?.alt;
  /* c8 ignore next -- remark-directive parses alt="..." as string; no test reaches the fallback */
  return typeof a === 'string' ? a : '';
}

async function render(node: DirectiveNode, ctx: WidgetCtx): Promise<string> {
  const id = extractId(node);
  if (!id) return '<!-- image: missing or invalid id -->';

  const sidecar = await sidecarRead(ctx.siteRoot, id);
  if (!sidecar) return `<!-- image: no sidecar for ${escapeAttr(id)} -->`;

  const alt = escapeAttr(extractAlt(node));
  const ops = sidecar.ops as Parameters<typeof cacheKey>[0]['ops'];

  // One <source> per format, srcset listing each width.
  const formats = uniq(variants.flatMap((v) => v.formats));
  const sources = formats.map((format) => {
    const entries = variants
      .filter((v) => v.formats.includes(format))
      .map((v) => {
        const ophash = cacheKey({
          originalId: id,
          ops,
          variant: { w: v.w },
          /* c8 ignore next -- ?? 85 fallback unreachable: every format we emit is in QUALITY_BY_FORMAT */
          output: { format, quality: QUALITY_BY_FORMAT[format] ?? 85 }
        });
        return `/img/${id}.${ophash}.${format} ${v.w}w`;
      });
    return `  <source type="image/${format}" srcset="${entries.join(', ')}"/>`;
  });

  // Fallback <img> uses the JPEG fallback variant.
  const fbHash = cacheKey({
    originalId: id,
    ops,
    variant: { w: fallback.w },
    output: { format: fallback.format as OutputFormat, quality: fallback.quality }
  });
  const fbUrl = `/img/${id}.${fbHash}.${fallback.format}`;

  return [
    `<picture>`,
    ...sources,
    `  <img src="${fbUrl}" alt="${alt}" loading="lazy"/>`,
    `</picture>`
  ].join('\n');
}

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

const widget: Widget = { name, variants, fallback, render };
export default widget;
