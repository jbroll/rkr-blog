// Carousel widget. One slide visible at a time with prev/next navigation
// and a dot indicator strip. Scroll-snap drives the actual scrolling so
// touch swipe works for free; src/site/carousel.ts handles the buttons,
// dots, and keyboard navigation.
//
// Directive (leaf form, MVP):
//   ::carousel{ids="abc,def,012" caption="Optional"}
//
// Per-item captions arrive with the future container directive form
// (`:::carousel{...}` enclosing `::image{...}` children).

import { escapeAttr, escapeText } from '../lib/content.ts';
import { cacheKey } from '../lib/hash.ts';
import type { OutputFormat } from '../lib/render.ts';
import { type Sidecar, read as sidecarRead } from '../lib/sidecar.ts';
import { extractImageIds, getKnownIds, resolveIds } from '../lib/widget-helpers.ts';
import type {
  DirectiveNode,
  FallbackSpec,
  VariantSpec,
  Widget,
  WidgetCtx
} from '../lib/widgets.ts';

export const name = 'carousel';

// Carousels show one image at a time at near-content width — use the same
// variant set as the single-image widget rather than the smaller gallery
// thumbs.
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

function extractCaption(node: DirectiveNode): string | null {
  const c = node.attributes?.caption;
  return typeof c === 'string' && c.length > 0 ? c : null;
}

/**
 * Optional autoplay interval in seconds. Floors invalid values to 0
 * (no autoplay). Capped at 60s to avoid surprise — author meant
 * milliseconds or made a typo.
 */
function extractAutoplay(node: DirectiveNode): number {
  const raw = node.attributes?.autoplay;
  if (typeof raw !== 'string') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(60, Math.floor(n));
}

interface SlideRender {
  id: string;
  sidecar: Sidecar;
  index: number;
}

function renderSlide(slide: SlideRender): string {
  const { id, sidecar, index } = slide;
  const ops = sidecar.ops as Parameters<typeof cacheKey>[0]['ops'];
  const w = sidecar.metadata.width ?? 1;
  const h = sidecar.metadata.height ?? 1;
  const aspect = (w / h).toFixed(4);

  const formats = uniq(variants.flatMap((v) => v.formats));
  const sources = formats.map((format) => {
    const entries = variants
      .filter((v) => v.formats.includes(format))
      .map((v) => {
        const ophash = cacheKey({
          originalId: id,
          ops,
          variant: { w: v.w },
          /* c8 ignore next -- ?? 85 fallback unreachable */
          output: { format, quality: QUALITY_BY_FORMAT[format] ?? 85 }
        });
        return `/img/${id}.${ophash}.${format} ${v.w}w`;
      });
    return `      <source type="image/${format}" srcset="${entries.join(', ')}"/>`;
  });

  const fbHash = cacheKey({
    originalId: id,
    ops,
    variant: { w: fallback.w },
    output: { format: fallback.format as OutputFormat, quality: fallback.quality }
  });
  const fbUrl = `/img/${id}.${fbHash}.${fallback.format}`;

  return [
    `  <figure class="rkr-carousel-slide" data-index="${index}" style="--aspect:${aspect};">`,
    `    <picture>`,
    ...sources,
    `      <img src="${fbUrl}" alt="" loading="lazy"/>`,
    `    </picture>`,
    `  </figure>`
  ].join('\n');
}

async function render(node: DirectiveNode, ctx: WidgetCtx): Promise<string> {
  const inputs = extractImageIds(node.attributes?.ids);
  if (inputs.length === 0) {
    return '<!-- carousel: no valid ids -->';
  }
  const caption = extractCaption(node);
  const autoplay = extractAutoplay(node);

  const known = getKnownIds(ctx);
  const resolved = resolveIds(inputs, known);

  const slides: SlideRender[] = [];
  const missingComments: string[] = [];
  for (let i = 0; i < resolved.length; i++) {
    const id = resolved[i];
    if (!id) {
      missingComments.push(`<!-- carousel: no match for "${escapeAttr(inputs[i] ?? '')}" -->`);
      continue;
    }
    const sidecar = await sidecarRead(ctx.siteRoot, id);
    if (!sidecar) {
      missingComments.push(`<!-- carousel: no sidecar for ${escapeAttr(id)} -->`);
      continue;
    }
    slides.push({ id, sidecar, index: slides.length });
  }

  if (slides.length === 0) {
    return missingComments.join('\n') || '<!-- carousel: no slides resolved -->';
  }

  const slidesHtml = slides.map(renderSlide).join('\n');
  const dotsHtml = slides
    .map(
      (s) =>
        `    <button type="button" class="rkr-carousel-dot" data-target="${s.index}" aria-label="Slide ${s.index + 1}"></button>`
    )
    .join('\n');
  const captionHtml = caption ? `\n  <figcaption>${escapeText(caption)}</figcaption>` : '';
  const missingHtml = missingComments.length > 0 ? `\n${missingComments.join('\n')}` : '';
  // WCAG 2.2.2: any auto-advancing carousel must include a pause control.
  const playPauseHtml = autoplay
    ? `    <button type="button" class="rkr-carousel-play" aria-label="Pause slideshow" aria-pressed="true">⏸</button>\n`
    : '';
  const autoplayAttr = autoplay ? ` data-autoplay="${autoplay}"` : '';

  return `<figure class="rkr-carousel" tabindex="0" aria-roledescription="carousel"${autoplayAttr}>${missingHtml}
  <div class="rkr-carousel-track" role="list">
${slidesHtml}
  </div>
  <nav class="rkr-carousel-nav" aria-label="Carousel controls">
    <button type="button" class="rkr-carousel-prev" aria-label="Previous slide">&larr;</button>
    <div class="rkr-carousel-dots" role="tablist">
${dotsHtml}
    </div>
${playPauseHtml}    <button type="button" class="rkr-carousel-next" aria-label="Next slide">&rarr;</button>
  </nav>${captionHtml}
</figure>`;
}

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

const widget: Widget = { name, variants, fallback, render };
export default widget;
