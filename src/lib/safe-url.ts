// URL-scheme guard, separated from content.ts so the admin browser bundle
// can pull it in without dragging content.ts's remark + render pipeline.

/** URL schemes safe to render in markdown links. Anything else (including
 * `javascript:`, `data:`, `vbscript:`, `file:`) is replaced with `#` so a
 * pasted or typo'd URL can't fire an XSS payload on click. Site-relative
 * (`/`, `#`, `.`) and protocol-relative (`//`) URLs pass through. */
const SAFE_LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

export function safeLinkUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed === '') return '#';
  // Site-relative / fragment / protocol-relative — no scheme to check.
  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('?') ||
    trimmed.startsWith('.')
  ) {
    return trimmed;
  }
  // First colon decides: anything before it that doesn't contain
  // a path-like character is a scheme.
  const colon = trimmed.indexOf(':');
  if (colon === -1) return trimmed;
  const head = trimmed.slice(0, colon);
  if (/[/?#]/.test(head)) return trimmed; // colon is past the path start
  const scheme = `${head.toLowerCase()}:`;
  return SAFE_LINK_SCHEMES.has(scheme) ? trimmed : '#';
}
