// Capped indefinite retry on /img cache-miss. The server returns 202
// while the render worker is busy; the browser fires `error` because
// 202 isn't a valid image. We retry forever — capped at 10s per
// attempt — until the image succeeds, the element is removed, or the
// tab goes hidden (resume on visible).

const BACKOFF_MS = [500, 1500, 3000, 6000, 10000] as const;
const MAX_BACKOFF_MS = 10_000;
const JITTER = 0.2;

function jittered(ms: number): number {
  const range = ms * JITTER;
  return ms + (Math.random() * 2 - 1) * range;
}

function nextDelay(attempt: number): number {
  const base = BACKOFF_MS[attempt] ?? MAX_BACKOFF_MS;
  return jittered(base);
}

function retrySrc(currentSrc: string, attempt: number): string | null {
  try {
    const url = new URL(currentSrc, location.href);
    url.searchParams.set('rkr_retry', String(attempt));
    return url.toString();
  } catch {
    return null;
  }
}

export function instrument(img: HTMLImageElement): void {
  let attempt = 0;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingSrc: string | null = null;
  let detached = false;

  const cancel = (): void => {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  };

  const apply = (): void => {
    pendingTimer = null;
    if (detached || !pendingSrc) return;
    img.src = pendingSrc;
    pendingSrc = null;
  };

  const onError = (): void => {
    if (detached) return;
    attempt += 1;
    const next = retrySrc(img.src, attempt);
    if (!next) {
      img.dataset.rkrFailed = 'true';
      detach();
      return;
    }
    pendingSrc = next;
    if (document.visibilityState === 'hidden') {
      // Wait for visibility before kicking off the next attempt.
      return;
    }
    pendingTimer = setTimeout(apply, nextDelay(attempt - 1));
  };

  const onLoad = (): void => {
    // Reset the counter so a later failure (e.g. CDN flake on
    // re-fetch after `src` reassignment elsewhere) gets the full
    // retry budget rather than the leftover from the prior load.
    attempt = 0;
  };

  const onVisibility = (): void => {
    if (document.visibilityState === 'visible' && pendingSrc && pendingTimer === null) {
      pendingTimer = setTimeout(apply, nextDelay(Math.max(0, attempt - 1)));
    } else if (document.visibilityState === 'hidden') {
      cancel();
    }
  };

  const observer = new MutationObserver(() => {
    if (!img.isConnected) detach();
  });

  function detach(): void {
    detached = true;
    cancel();
    img.removeEventListener('error', onError);
    img.removeEventListener('load', onLoad);
    document.removeEventListener('visibilitychange', onVisibility);
    observer.disconnect();
  }

  img.addEventListener('error', onError);
  img.addEventListener('load', onLoad);
  document.addEventListener('visibilitychange', onVisibility);
  // Watch the parent for removal so we can clean up.
  if (img.parentNode) {
    observer.observe(img.parentNode, { childList: true, subtree: true });
  }
}

function init(): void {
  for (const img of document.querySelectorAll<HTMLImageElement>('img')) {
    instrument(img);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
