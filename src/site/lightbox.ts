// rkroll lightbox: PhotoSwipe v5, mounted on the public post pages.
//
// The renderer (lib/widget-helpers.ts) wraps every figure-cell <picture>
// in an `<a href data-pswp-width data-pswp-height>` already, so this
// module is just the initialization shim — PhotoSwipe handles the click
// hijack, focus trap, ESC + click-outside dismissal, swipe/pinch
// gestures, keyboard nav, and aria-modal semantics natively.
//
// We group slides per `<figure>` so a multi-image gallery / carousel /
// diptych / triptych shows arrows and "1 / N" counter; single-image
// figures just open the one slide. Inline figures render as `<span>`
// (not `<figure>`) so the `figure.rkr-figure` selector skips them
// — preserves the prior "skip inline" behavior.
//
// Captions: when a cell carries authored caption text, we read it back
// from the per-cell wrapper at slide-mount time and inject it into
// PhotoSwipe's UI via the standard uiRegister API.

import 'photoswipe/style.css';
import PhotoSwipeLightbox from 'photoswipe/lightbox';

function init(): void {
  // Pages with no figures (the index, posts that are pure prose) skip
  // PhotoSwipe entirely — saves ~20KB of script execution that would
  // bind no listeners anyway.
  const figures = document.querySelectorAll('figure.rkr-figure');
  if (figures.length === 0) return;

  // One Lightbox instance per page. The gallery selector groups by
  // `<figure>` element; `children` selector picks every PhotoSwipe-
  // ready anchor inside (renderPicture's lightbox=true wrapper). For
  // a single-image figure this still works — PhotoSwipe just doesn't
  // show the prev/next chrome when the slide list has one entry.
  const lightbox = new PhotoSwipeLightbox({
    gallery: 'figure.rkr-figure',
    children: 'a[data-pswp-width]',
    pswpModule: () => import('photoswipe')
  });

  // Caption support: each anchor sits inside a `<div class="rkr-figure-cell">`
  // followed by an authored caption text node (when set). On slide mount
  // we look the caption up via the source anchor's parent and inject
  // it as a <p> in PhotoSwipe's UI region.
  lightbox.on('uiRegister', () => {
    /* c8 ignore start -- runtime UI registration; verified via e2e */
    lightbox.pswp?.ui?.registerElement({
      name: 'caption',
      order: 9,
      isButton: false,
      appendTo: 'root',
      html: '',
      onInit: (el) => {
        el.classList.add('rkr-pswp-caption');
        lightbox.pswp?.on('change', () => {
          const slide = lightbox.pswp?.currSlide?.data.element as HTMLElement | undefined;
          const cell = slide?.closest('.rkr-figure-cell');
          // Caption text lives as a trailing text node inside the cell
          // (renderCell appends `\n${escapeText(caption)}` after the
          // <picture>); pick it up via textContent minus the picture's
          // alt so we don't echo image text.
          const text = readCaption(cell);
          el.textContent = text;
          el.style.display = text ? '' : 'none';
        });
      }
    });
    /* c8 ignore stop */
  });

  lightbox.init();
}

function readCaption(cell: Element | null | undefined): string {
  if (!cell) return '';
  // The cell layout is `<a><picture/></a>` followed by an optional
  // trailing text node. Pull child text nodes (skipping element
  // children — the anchor's contents are the picture, not the
  // caption) and concatenate.
  let out = '';
  for (const node of Array.from(cell.childNodes)) {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      out += node.textContent ?? '';
    }
  }
  return out.trim();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
