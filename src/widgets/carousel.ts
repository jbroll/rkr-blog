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
import { type Sidecar, read as sidecarRead } from '../lib/sidecar.ts';
import {
  extractDirectiveCaption,
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
  /** Pre-escaped alt text. Empty = decorative default. */
  alt: string;
}

function renderSlide(slide: SlideRender): string {
  const picture = indent(
    renderPicture({
      id: slide.id,
      sidecar: slide.sidecar,
      variants,
      fallback,
      alt: slide.alt
    }),
    '    '
  );
  return [
    `  <figure class="rkr-carousel-slide" data-index="${slide.index}" style="--aspect:${pictureAspect(slide.sidecar)};">`,
    picture,
    '  </figure>'
  ].join('\n');
}

async function render(node: DirectiveNode, ctx: WidgetCtx): Promise<string> {
  const inputs = extractImageIdsAndAlts(node.attributes?.ids, node.attributes?.alts);
  if (inputs.length === 0) {
    return '<!-- carousel: no valid ids -->';
  }
  const caption = extractDirectiveCaption(node);
  const autoplay = extractAutoplay(node);

  const known = getKnownIds(ctx);
  const resolved = resolveIds(
    inputs.map((p) => p.id),
    known
  );

  const slides: SlideRender[] = [];
  const missingComments: string[] = [];
  for (let i = 0; i < resolved.length; i++) {
    const id = resolved[i];
    const inputId = inputs[i]?.id ?? '';
    const alt = escapeAttr(inputs[i]?.alt ?? '');
    if (!id) {
      missingComments.push(`<!-- carousel: no match for "${escapeAttr(inputId)}" -->`);
      continue;
    }
    const sidecar = await sidecarRead(ctx.siteRoot, id);
    if (!sidecar) {
      missingComments.push(`<!-- carousel: no sidecar for ${escapeAttr(id)} -->`);
      continue;
    }
    slides.push({ id, sidecar, index: slides.length, alt });
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

const widget: Widget = { name, variants, fallback, render };
export default widget;
