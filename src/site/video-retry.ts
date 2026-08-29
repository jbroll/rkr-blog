// Capped indefinite retry on /video cache-miss. The server returns 202
// while the render worker is busy; the browser fires `error` because
// 202 isn't a playable media response. We retry forever — capped at
// 10s per attempt — until the media loads, the element is removed, or
// the tab goes hidden (resume on visible). The poster is retried along
// with the src: both files land in one render, so a 202 on either
// means the whole derivative is still warming up.

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

function retryUrl(currentUrl: string, attempt: number): string | null {
  try {
    const url = new URL(currentUrl, location.href);
    url.searchParams.set('rkr_retry', String(attempt));
    return url.toString();
  } catch {
    return null;
  }
}

/** Only retry URLs this script owns — a src/poster pointing anywhere
 * else (a same-page anchor, a third-party embed) must never be
 * re-fetched with our retry param. */
function isDerivativeUrl(currentUrl: string): boolean {
  try {
    return new URL(currentUrl, location.href).pathname.startsWith('/video/');
  } catch {
    return false;
  }
}

export function instrumentVideo(video: HTMLVideoElement): void {
  let attempt = 0;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingSrc: string | null = null;
  let pendingPoster: string | null = null;
  let detached = false;

  const cancel = (): void => {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  };

  const apply = (): void => {
    pendingTimer = null;
    if (detached) return;
    if (pendingSrc !== null) {
      video.src = pendingSrc;
      pendingSrc = null;
    }
    if (pendingPoster !== null) {
      video.poster = pendingPoster;
      pendingPoster = null;
    }
  };

  const onError = (): void => {
    if (detached) return;
    attempt += 1;
    const nextSrc = video.src && isDerivativeUrl(video.src) ? retryUrl(video.src, attempt) : null;
    const nextPoster =
      video.poster && isDerivativeUrl(video.poster) ? retryUrl(video.poster, attempt) : null;
    if (!nextSrc && !nextPoster) {
      video.dataset.rkrFailed = 'true';
      detach();
      return;
    }
    pendingSrc = nextSrc;
    pendingPoster = nextPoster;
    if (document.visibilityState === 'hidden') {
      // Wait for visibility before kicking off the next attempt.
      return;
    }
    pendingTimer = setTimeout(apply, nextDelay(attempt - 1));
  };

  const onLoaded = (): void => {
    // Reset the counter so a later failure (e.g. CDN flake on
    // re-fetch after `src` reassignment elsewhere) gets the full
    // retry budget rather than the leftover from the prior load.
    attempt = 0;
  };

  const onVisibility = (): void => {
    if (
      document.visibilityState === 'visible' &&
      (pendingSrc !== null || pendingPoster !== null) &&
      pendingTimer === null
    ) {
      pendingTimer = setTimeout(apply, nextDelay(Math.max(0, attempt - 1)));
    } else if (document.visibilityState === 'hidden') {
      cancel();
    }
  };

  const observer = new MutationObserver(() => {
    if (!video.isConnected) detach();
  });

  function detach(): void {
    detached = true;
    cancel();
    video.removeEventListener('error', onError);
    video.removeEventListener('loadeddata', onLoaded);
    document.removeEventListener('visibilitychange', onVisibility);
    observer.disconnect();
  }

  video.addEventListener('error', onError);
  video.addEventListener('loadeddata', onLoaded);
  document.addEventListener('visibilitychange', onVisibility);
  // Watch the parent for removal so we can clean up.
  if (video.parentNode) {
    observer.observe(video.parentNode, { childList: true, subtree: true });
  }
}

function init(): void {
  for (const video of document.querySelectorAll<HTMLVideoElement>('video')) {
    instrumentVideo(video);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
