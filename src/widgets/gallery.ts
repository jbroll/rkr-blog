// Gallery widget. Multi-image layouts that share the same picture/srcset
// machinery as the single-image widget. Layout is selected by the `layout`
// attribute; CSS in static/site.css implements each variant.
//
// Directive (leaf form, MVP):
//   ::gallery{ids="abc,def,012" layout=justified caption="Optional"}
//
// `ids` is a comma-separated list of 6-64 hex strings. Each is resolved
// against $SITE_ROOT/sidecars/ — exact match preferred, otherwise unique
// prefix. Ambiguous or unmatched ids are skipped with an HTML comment.
//
// Future container form for per-item captions:
//   :::gallery{layout=masonry}
//   ::image{#abc caption="First"}
//   ::image{#def caption="Second"}
//   :::

import { escapeAttr, escapeText } from '../lib/content.ts';
import { type Sidecar, read as sidecarRead } from '../lib/sidecar.ts';
import {
  extractImageIdsAndAlts,
  getKnownIds,
  indent,
  pictureAspect,
  renderPicture,
  resolveIds
} from '../lib/widget-helpers.ts';
import type {
  DirectiveNode,
  FallbackSpec,
  VariantSpec,
  Widget,
  WidgetCtx
} from '../lib/widgets.ts';

export const name = 'gallery';

// Each item in the gallery uses these variants. Smaller than the single-
// image widget (galleries show many at once, prioritise grid load over
// per-image fidelity). Browsers pick the largest variant fitting the
// rendered cell width via srcset.
export const variants: VariantSpec[] = [
  { w: 320, formats: ['webp', 'avif'] },
  { w: 640, formats: ['webp', 'avif'] },
  { w: 1200, formats: ['webp', 'avif'] }
];

export const fallback: FallbackSpec = { w: 800, format: 'jpeg', quality: 82 };

const VALID_LAYOUTS = new Set(['justified', 'masonry', 'matrix']);
type Layout = 'justified' | 'masonry' | 'matrix';

function extractLayout(node: DirectiveNode): Layout {
  const l = node.attributes?.layout;
  if (typeof l !== 'string' || !VALID_LAYOUTS.has(l)) return 'justified';
  return l as Layout;
}

function extractCaption(node: DirectiveNode): string | null {
  const c = node.attributes?.caption;
  return typeof c === 'string' && c.length > 0 ? c : null;
}

interface ItemRender {
  id: string;
  sidecar: Sidecar;
  /** Pre-escaped alt text (escapeAttr). Empty string is the decorative default. */
  alt: string;
}

function renderItem(item: ItemRender): string {
  const picture = indent(
    renderPicture({
      id: item.id,
      sidecar: item.sidecar,
      variants,
      fallback,
      alt: item.alt
    }),
    '    '
  );
  return [
    `  <figure class="rkr-gallery-item" style="--aspect:${pictureAspect(item.sidecar)};">`,
    picture,
    '  </figure>'
  ].join('\n');
}

async function render(node: DirectiveNode, ctx: WidgetCtx): Promise<string> {
  const inputs = extractImageIdsAndAlts(node.attributes?.ids, node.attributes?.alts);
  if (inputs.length === 0) {
    return '<!-- gallery: no valid ids -->';
  }
  const layout = extractLayout(node);
  const caption = extractCaption(node);

  const known = getKnownIds(ctx);
  const resolved = resolveIds(
    inputs.map((p) => p.id),
    known
  );

  const items: ItemRender[] = [];
  const missingComments: string[] = [];
  for (let i = 0; i < resolved.length; i++) {
    const id = resolved[i];
    const inputId = inputs[i]?.id ?? '';
    const alt = escapeAttr(inputs[i]?.alt ?? '');
    if (!id) {
      missingComments.push(`<!-- gallery: no match for "${escapeAttr(inputId)}" -->`);
      continue;
    }
    const sidecar = await sidecarRead(ctx.siteRoot, id);
    if (!sidecar) {
      missingComments.push(`<!-- gallery: no sidecar for ${escapeAttr(id)} -->`);
      continue;
    }
    items.push({ id, sidecar, alt });
  }

  if (items.length === 0) {
    return missingComments.join('\n') || '<!-- gallery: no items resolved -->';
  }

  const cls = `rkr-gallery rkr-gallery-${layout}`;
  const itemsHtml = items.map(renderItem).join('\n');
  const captionHtml = caption ? `\n  <figcaption>${escapeText(caption)}</figcaption>` : '';
  const missingHtml = missingComments.length > 0 ? `\n${missingComments.join('\n')}` : '';

  return `<figure class="${cls}">${missingHtml}
${itemsHtml}${captionHtml}
</figure>`;
}

const widget: Widget = { name, variants, fallback, render };
export default widget;
