// Diptych / triptych widgets. Two- or three-image side-by-side layouts
// for art-directed pairings (before/after, two angles, panel triptychs).
// Uses CSS grid with equal-width columns; each cell keeps its natural
// aspect ratio. No JavaScript.
//
// Directives (leaf form, MVP):
//   ::diptych{ids="abc,def" caption="Optional"}
//   ::triptych{ids="abc,def,012" caption="Optional"}
//
// Same id resolution rules as gallery/carousel: 6-64 hex chars, exact
// or unique-prefix match against $SITE_ROOT/sidecars/.

import { escapeAttr, escapeText } from '../lib/content.ts';
import { type Sidecar, read as sidecarRead } from '../lib/sidecar.ts';
import {
  extractImageIds,
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

// Shared variants: roughly half the content column for diptych, a third
// for triptych — but the same set works for both since browsers pick by
// rendered cell width via srcset.
export const variants: VariantSpec[] = [
  { w: 320, formats: ['webp', 'avif'] },
  { w: 640, formats: ['webp', 'avif'] },
  { w: 1200, formats: ['webp', 'avif'] }
];

export const fallback: FallbackSpec = { w: 800, format: 'jpeg', quality: 82 };

function extractCaption(node: DirectiveNode): string | null {
  const c = node.attributes?.caption;
  return typeof c === 'string' && c.length > 0 ? c : null;
}

interface ItemRender {
  id: string;
  sidecar: Sidecar;
}

function renderItem(item: ItemRender): string {
  const picture = indent(
    renderPicture({ id: item.id, sidecar: item.sidecar, variants, fallback }),
    '    '
  );
  return [
    `  <figure style="--aspect:${pictureAspect(item.sidecar)};">`,
    picture,
    '  </figure>'
  ].join('\n');
}

interface PanelSpec {
  /** Directive name and CSS class suffix: 'diptych' | 'triptych'. */
  kind: 'diptych' | 'triptych';
  /** Required count of resolved items. Extras are ignored with a comment. */
  count: 2 | 3;
}

function makeRender(spec: PanelSpec) {
  return async function render(node: DirectiveNode, ctx: WidgetCtx): Promise<string> {
    const inputs = extractImageIds(node.attributes?.ids);
    if (inputs.length === 0) {
      return `<!-- ${spec.kind}: no valid ids -->`;
    }
    const caption = extractCaption(node);

    // Truncate excess inputs early so we don't churn through resolution
    // for slots we'd just throw away. Surface the truncation as a comment.
    const overflowComments: string[] = [];
    let trimmed = inputs;
    if (inputs.length > spec.count) {
      overflowComments.push(
        `<!-- ${spec.kind}: ignoring ${inputs.length - spec.count} extra id(s) past slot ${spec.count} -->`
      );
      trimmed = inputs.slice(0, spec.count);
    }

    const known = getKnownIds(ctx);
    const resolved = resolveIds(trimmed, known);

    const items: ItemRender[] = [];
    const missingComments: string[] = [];
    for (let i = 0; i < resolved.length; i++) {
      const id = resolved[i];
      if (!id) {
        missingComments.push(
          `<!-- ${spec.kind}: no match for "${escapeAttr(trimmed[i] ?? '')}" -->`
        );
        continue;
      }
      const sidecar = await sidecarRead(ctx.siteRoot, id);
      if (!sidecar) {
        missingComments.push(`<!-- ${spec.kind}: no sidecar for ${escapeAttr(id)} -->`);
        continue;
      }
      items.push({ id, sidecar });
    }

    const allComments = [...overflowComments, ...missingComments];
    if (items.length === 0) {
      return allComments.join('\n') || `<!-- ${spec.kind}: no items resolved -->`;
    }

    const cls = `rkr-${spec.kind}`;
    const itemsHtml = items.map(renderItem).join('\n');
    const captionHtml = caption ? `\n  <figcaption>${escapeText(caption)}</figcaption>` : '';
    const commentsHtml = allComments.length > 0 ? `\n${allComments.join('\n')}` : '';

    return `<figure class="${cls}">${commentsHtml}
${itemsHtml}${captionHtml}
</figure>`;
  };
}

export const diptychWidget: Widget = {
  name: 'diptych',
  variants,
  fallback,
  render: makeRender({ kind: 'diptych', count: 2 })
};

export const triptychWidget: Widget = {
  name: 'triptych',
  variants,
  fallback,
  render: makeRender({ kind: 'triptych', count: 3 })
};
