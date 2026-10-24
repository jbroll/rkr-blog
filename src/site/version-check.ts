// Version check: poll /health and surface a reload banner when the
// deployed commit differs from the one this page was built from.
//
// The build stamps the commit hash into a <meta name="rkr-build">
// tag (see layout.ts siteHead). On a mismatch we render a small
// fixed banner with a "Reload" button instead of auto-reloading,
// so an in-progress edit isn't killed mid-keystroke.

const BUILD_META = 'rkr-build';
const CHECK_INTERVAL_MS = 60_000;

function buildHash(): string {
  const meta = document.querySelector(`meta[name="${BUILD_META}"]`);
  return meta?.getAttribute('content') ?? '';
}

async function fetchHash(): Promise<string | null> {
  try {
    const res = await fetch('/health', { cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as { gitHashShort?: string };
    return body.gitHashShort ?? null;
  } catch {
    return null;
  }
}

function showBanner(): void {
  if (document.getElementById('rkr-version-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'rkr-version-banner';
  banner.setAttribute('role', 'status');
  banner.style.cssText =
    'position:fixed;bottom:1rem;right:1rem;z-index:9999;padding:.6rem .9rem;' +
    'background:#1a4f7f;color:#fff;border-radius:.4rem;font:inherit;' +
    'box-shadow:0 2px 8px rgba(0,0,0,.25);display:flex;gap:.6rem;align-items:center';
  const text = document.createElement('span');
  text.textContent = 'A new version is available.';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Reload';
  btn.style.cssText =
    'border:1px solid #fff;background:transparent;color:#fff;border-radius:.3rem;' +
    'padding:.25rem .6rem;cursor:pointer;font:inherit';
  btn.addEventListener('click', () => location.reload());
  banner.append(text, btn);
  document.body.append(banner);
}

async function check(): Promise<void> {
  const current = buildHash();
  if (!current || current === 'unknown') return;
  const live = await fetchHash();
  if (live && live !== current) showBanner();
}

export function startVersionCheck(): void {
  void check();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check();
  });
  window.setInterval(() => void check(), CHECK_INTERVAL_MS);
}
