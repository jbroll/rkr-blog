const ATTEMPTS = 3;
const BACKOFF_MS = [500, 2000, 8000] as const;
const JITTER = 0.2;

function jittered(ms: number): number {
  const range = ms * JITTER;
  return ms + (Math.random() * 2 - 1) * range;
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
  const onError = (): void => {
    if (attempt >= ATTEMPTS) {
      img.dataset.rkrFailed = 'true';
      img.removeEventListener('error', onError);
      return;
    }
    attempt += 1;
    const next = retrySrc(img.src, attempt);
    if (!next) {
      img.dataset.rkrFailed = 'true';
      img.removeEventListener('error', onError);
      return;
    }
    const delay = jittered(BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!);
    setTimeout(() => {
      img.src = next;
    }, delay);
  };
  img.addEventListener('error', onError);
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
