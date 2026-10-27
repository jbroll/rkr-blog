// Close button for the announcement bar (templates/site-nav.ts). The
// dismissed bar's key is remembered, so the same text stays hidden and a
// new one shows again.

const STORAGE_KEY = 'rkr-announce-dismissed';

function readDismissed(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function remember(key: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // Storage blocked: the bar closes for this page view only.
  }
}

for (const bar of document.querySelectorAll<HTMLElement>('.rkr-announce[data-rkr-announce]')) {
  const key = bar.dataset.rkrAnnounce ?? '';
  if (readDismissed() === key) {
    bar.hidden = true;
    continue;
  }
  const close = bar.querySelector<HTMLButtonElement>('.rkr-announce-close');
  if (!close) continue;
  close.hidden = false;
  close.addEventListener('click', () => {
    bar.hidden = true;
    remember(key);
  });
}
