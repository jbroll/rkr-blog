// Image widget. Renders `::image{#<id> alt="..."}` to a <picture> block
// with srcset entries for each (variant × format) the widget declares,
// using cache-friendly URLs `/img/<id>.<ophash>.<fmt>`.
//
// The widget's `variants` are the source of truth for srcset (spec.md §9).
// Image ingest currently writes the same defaults into each sidecar, so a
// `site-admin render` warms exactly these URLs. Custom per-image variant
// sets are a future enhancement.

import { escapeAttr, escapeText } from '../lib/content.ts';
import { read as sidecarRead } from '../lib/sidecar.ts';
import { indent, renderPicture } from '../lib/widget-helpers.ts';
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

function extractCaption(node: DirectiveNode): string | null {
  const c = node.attributes?.caption;
  return typeof c === 'string' && c.length > 0 ? c : null;
}

const VALID_POSITIONS = new Set(['default', 'full', 'left', 'right', 'inline']);
type ImagePosition = 'default' | 'full' | 'left' | 'right' | 'inline';

function extractPosition(node: DirectiveNode): ImagePosition {
  const p = node.attributes?.position;
  if (typeof p !== 'string' || !VALID_POSITIONS.has(p)) return 'default';
  return p as ImagePosition;
}

async function render(node: DirectiveNode, ctx: WidgetCtx): Promise<string> {
  const id = extractId(node);
  if (!id) return '<!-- image: missing or invalid id -->';

  const sidecar = await sidecarRead(ctx.siteRoot, id);
  if (!sidecar) return `<!-- image: no sidecar for ${escapeAttr(id)} -->`;

  const alt = escapeAttr(extractAlt(node));
  const caption = extractCaption(node);
  const position = extractPosition(node);

  const picture = indent(renderPicture({ id, sidecar, variants, fallback, alt }), '  ');

  // Position class; CSS in static/site.css implements each variant.
  // Always emit a <figure> so the position class has a single host element
  // (also gives consistent semantics whether or not a caption is set).
  const figureClass = `rkr-figure rkr-pos-${position}`;
  const captionBlock = caption ? `\n  <figcaption>${escapeText(caption)}</figcaption>` : '';
  return `<figure class="${figureClass}">\n${picture}${captionBlock}\n</figure>`;
}

const widget: Widget = { name, variants, fallback, render };
export default widget;
