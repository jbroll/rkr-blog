"use strict";
// rkroll lightbox: click any .rkr-figure image (other than inline) to
// enlarge in a fullscreen overlay. ESC or click-outside dismisses.
// Pure DOM, no framework, single self-executing module.
//
// Loaded by post.ts and index.ts via <script type="module" defer>.
// No-ops on pages with no figures, so it's safe to include globally.
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
function attachStyles() {
    if (document.getElementById('rkr-lightbox-style'))
        return;
    const style = document.createElement('style');
    style.id = 'rkr-lightbox-style';
    style.textContent = STYLE;
    document.head.appendChild(style);
}
function makeOverlay() {
    const el = document.createElement('div');
    el.className = 'rkr-lightbox-overlay';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-hidden', 'true');
    const img = document.createElement('img');
    img.alt = '';
    el.appendChild(img);
    const caption = document.createElement('figcaption');
    caption.style.display = 'none';
    el.appendChild(caption);
    document.body.appendChild(el);
    return { el, img, caption };
}
function closeOverlay(el) {
    el.classList.remove('is-open');
    el.setAttribute('aria-hidden', 'true');
}
function openOverlay(el, img, caption, args) {
    img.src = args.src;
    img.alt = args.alt;
    if (args.caption) {
        caption.textContent = args.caption;
        caption.style.display = '';
    }
    else {
        caption.textContent = '';
        caption.style.display = 'none';
    }
    el.classList.add('is-open');
    el.setAttribute('aria-hidden', 'false');
}
function captionFor(figure) {
    const cap = figure.querySelector('figcaption');
    return cap?.textContent?.trim() || null;
}
function init() {
    // Pages with no figures (e.g. the index) don't need any of this.
    const figures = document.querySelectorAll('.rkr-figure:not(.rkr-pos-inline)');
    if (figures.length === 0)
        return;
    attachStyles();
    const { el, img: overlayImg, caption: overlayCap } = makeOverlay();
    el.addEventListener('click', () => closeOverlay(el));
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && el.classList.contains('is-open')) {
            closeOverlay(el);
        }
    });
    for (const figure of figures) {
        const img = figure.querySelector('img');
        if (!img)
            continue;
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
}
else {
    init();
}
//# sourceMappingURL=lightbox.js.map