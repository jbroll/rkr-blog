// rkroll carousel runtime: prev/next + dot indicators + keyboard nav.
// Scroll-snap drives the actual slide motion; this script only updates
// the dot indicator state and wires button clicks to scrollTo().
//
// No-ops on pages without .rkr-carousel elements.

export {};

interface CarouselState {
  root: HTMLElement;
  track: HTMLElement;
  slides: HTMLElement[];
  dots: HTMLButtonElement[];
  current: number;
}

function setupCarousel(root: HTMLElement): CarouselState | null {
  const track = root.querySelector<HTMLElement>('.rkr-carousel-track');
  if (!track) return null;
  const slides = Array.from(root.querySelectorAll<HTMLElement>('.rkr-carousel-slide'));
  const dots = Array.from(root.querySelectorAll<HTMLButtonElement>('.rkr-carousel-dot'));
  const prev = root.querySelector<HTMLButtonElement>('.rkr-carousel-prev');
  const next = root.querySelector<HTMLButtonElement>('.rkr-carousel-next');
  const playBtn = root.querySelector<HTMLButtonElement>('.rkr-carousel-play');
  if (slides.length === 0) return null;

  const state: CarouselState = { root, track, slides, dots, current: 0 };

  function scrollToIndex(idx: number, behavior: ScrollBehavior = 'smooth'): void {
    // Wrap around when autoplay drives off the end.
    const wrapped = idx < 0 ? state.slides.length - 1 : idx >= state.slides.length ? 0 : idx;
    const slide = state.slides[wrapped];
    if (!slide) return;
    state.track.scrollTo({ left: slide.offsetLeft, behavior });
  }

  function setActive(idx: number): void {
    state.current = idx;
    for (let i = 0; i < state.dots.length; i++) {
      const dot = state.dots[i];
      if (!dot) continue;
      if (i === idx) {
        dot.classList.add('is-active');
        dot.setAttribute('aria-current', 'true');
      } else {
        dot.classList.remove('is-active');
        dot.removeAttribute('aria-current');
      }
    }
  }

  prev?.addEventListener('click', () => scrollToIndex(state.current - 1));
  next?.addEventListener('click', () => scrollToIndex(state.current + 1));

  for (const dot of state.dots) {
    dot.addEventListener('click', () => {
      const target = Number(dot.dataset.target ?? '0');
      scrollToIndex(target);
    });
  }

  // Update active dot as the user swipes / scrolls. Use IntersectionObserver
  // on each slide; the most-visible one wins.
  const observer = new IntersectionObserver(
    (entries) => {
      let best: { idx: number; ratio: number } | null = null;
      for (const entry of entries) {
        const idx = Number((entry.target as HTMLElement).dataset.index ?? '0');
        if (!best || entry.intersectionRatio > best.ratio) {
          best = { idx, ratio: entry.intersectionRatio };
        }
      }
      if (best && best.ratio > 0) setActive(best.idx);
    },
    { root: track, threshold: [0.1, 0.5, 0.9] }
  );
  for (const slide of state.slides) observer.observe(slide);

  // Keyboard navigation when the carousel has focus.
  root.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      scrollToIndex(state.current - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      scrollToIndex(state.current + 1);
    }
  });

  // ---- Autoplay ------------------------------------------------------
  // WCAG 2.2.2: auto-advancing carousels must be pauseable. Default-off
  // when the user prefers reduced motion (autoplay still configurable
  // by the author, but we don't auto-start in that case).
  const autoplaySeconds = Number(root.dataset.autoplay ?? '0');
  if (autoplaySeconds > 0 && playBtn) {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let playing = false;

    function start(): void {
      if (playing || timer !== null) return;
      timer = setInterval(() => scrollToIndex(state.current + 1), autoplaySeconds * 1000);
      playing = true;
      playBtn?.setAttribute('aria-label', 'Pause slideshow');
      playBtn?.setAttribute('aria-pressed', 'true');
      if (playBtn) playBtn.textContent = '⏸';
    }
    function stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      playing = false;
      playBtn?.setAttribute('aria-label', 'Play slideshow');
      playBtn?.setAttribute('aria-pressed', 'false');
      if (playBtn) playBtn.textContent = '▶';
    }

    playBtn.addEventListener('click', () => (playing ? stop() : start()));

    // Pause on any user interaction with prev/next/dots — the user is
    // taking the wheel; don't fight them.
    for (const btn of [prev, next, ...dots]) {
      btn?.addEventListener('click', stop);
    }
    // Pause on hover/focus; resume not automatic (let the user opt in
    // via the play button to avoid surprise re-starts).
    root.addEventListener('mouseenter', stop);
    root.addEventListener('focusin', stop);
    // Pause when the tab is hidden.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop();
    });

    if (!reduced) start();
    else stop();
  }

  setActive(0);
  return state;
}

function init(): void {
  const carousels = document.querySelectorAll<HTMLElement>('.rkr-carousel');
  for (const c of carousels) setupCarousel(c);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
