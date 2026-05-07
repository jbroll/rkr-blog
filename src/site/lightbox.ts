// rkroll lightbox: click any .rkr-figure image (other than inline) to
// enlarge in a fullscreen overlay. ESC or click-outside dismisses.
// Pure DOM, no framework, single self-executing module.
//
// Loaded by post.ts and index.ts via <script type="module" defer>.
// No-ops on pages with no figures, so it's safe to include globally.
//
// Accessibility (WCAG 2.1.2 / dialog pattern):
//   - role=dialog + aria-modal=true announce the overlay to screen readers
//   - the overlay is `tabindex=-1` and we focus it on open
//   - we trap Tab inside the overlay so focus can't escape behind it
//   - the previously-focused element is captured and restored on close

export {};

const STYLE = `
.rkr-lightbox-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.92);
  display: none; align-items: center; justify-content: center;
  z-index: 9999; cursor: zoom-out; padding: 2vh 2vw;
  opacity: 0; transition: opacity 120ms ease-out;
}
.rkr-lightbox-overlay.is-open { display: flex; opacity: 1; }
.rkr-lightbox-overlay img {
  max-width: 96vw; max-height: 92vh;
  box-shadow: 0 4px 30px rgba(0,0,0,0.6);
  border-radius: 4px;
}
.rkr-lightbox-overlay figcaption {
  position: absolute; bottom: 0; left: 0; right: 0;
  padding: 0.75rem 1rem; background: rgba(0,0,0,0.55);
  color: #fff; text-align: center; font-size: 0.9rem;
  font-style: italic;
}
.rkr-figure:not(.rkr-pos-inline) img { cursor: zoom-in; }
`;

interface OpenArgs {
  src: string;
  alt: string;
  caption: string | null;
}

function attachStyles(): void {
  if (document.getElementById('rkr-lightbox-style')) return;
  const style = document.createElement('style');
  style.id = 'rkr-lightbox-style';
  style.textContent = STYLE;
  document.head.appendChild(style);
}

function makeOverlay(): {
  el: HTMLDivElement;
  img: HTMLImageElement;
  caption: HTMLElement;
} {
  const el = document.createElement('div');
  el.className = 'rkr-lightbox-overlay';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-hidden', 'true');
  el.tabIndex = -1; // focusable target for openOverlay()

  const img = document.createElement('img');
  img.alt = '';
  el.appendChild(img);

  const caption = document.createElement('figcaption');
  caption.style.display = 'none';
  el.appendChild(caption);

  document.body.appendChild(el);
  return { el, img, caption };
}

let previousFocus: HTMLElement | null = null;

function closeOverlay(el: HTMLElement): void {
  el.classList.remove('is-open');
  el.setAttribute('aria-hidden', 'true');
  // Restore focus to the element that was focused before we opened.
  if (previousFocus && document.contains(previousFocus)) {
    previousFocus.focus({ preventScroll: true });
  }
  previousFocus = null;
}

function openOverlay(
  el: HTMLDivElement,
  img: HTMLImageElement,
  caption: HTMLElement,
  args: OpenArgs
): void {
  previousFocus = (document.activeElement as HTMLElement | null) ?? null;
  img.src = args.src;
  img.alt = args.alt;
  if (args.caption) {
    caption.textContent = args.caption;
    caption.style.display = '';
  } else {
    caption.textContent = '';
    caption.style.display = 'none';
  }
  el.classList.add('is-open');
  el.setAttribute('aria-hidden', 'false');
  // Move focus into the dialog so Tab cycles and screen readers announce.
  el.focus({ preventScroll: true });
}

function captionFor(figure: HTMLElement): string | null {
  const cap = figure.querySelector('figcaption');
  return cap?.textContent?.trim() || null;
}

function init(): void {
  // Pages with no figures (e.g. the index) don't need any of this.
  const figures = document.querySelectorAll<HTMLElement>('.rkr-figure:not(.rkr-pos-inline)');
  if (figures.length === 0) return;

  attachStyles();
  const { el, img: overlayImg, caption: overlayCap } = makeOverlay();

  el.addEventListener('click', () => closeOverlay(el));
  document.addEventListener('keydown', (e) => {
    if (!el.classList.contains('is-open')) return;
    if (e.key === 'Escape') {
      closeOverlay(el);
    } else if (e.key === 'Tab') {
      // Focus trap: only the overlay itself is focusable inside, so Tab
      // and Shift+Tab both keep focus on it. Prevents focus from leaking
      // back to the article behind.
      e.preventDefault();
      el.focus({ preventScroll: true });
    }
  });

  for (const figure of figures) {
    const img = figure.querySelector('img');
    if (!img) continue;
    img.addEventListener('click', (e) => {
      e.stopPropagation();
      openOverlay(el, overlayImg, overlayCap, {
        src: img.currentSrc || img.src,
        alt: img.alt,
        caption: captionFor(figure)
      });
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
