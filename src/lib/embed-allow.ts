// The one list of hosts an `embed` block may frame. The renderer checks
// URLs against it and the public CSP's `frame-src` is built from it.

const MAPS_EMBED_PATH = '/maps/embed';

export const EMBED_FRAME_SRC =
  'https://docs.google.com https://www.youtube-nocookie.com https://player.vimeo.com https://www.google.com/maps/embed https://www.google.com/maps/embed/';

function parseHttps(url: string): URL | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

export function embedAllowed(url: string): boolean {
  const u = parseHttps(url);
  if (!u || u.username || u.password || u.port) return false;
  switch (u.hostname) {
    case 'docs.google.com':
    case 'www.youtube-nocookie.com':
    case 'player.vimeo.com':
      return true;
    case 'www.google.com':
      return u.pathname === MAPS_EMBED_PATH || u.pathname.startsWith(`${MAPS_EMBED_PATH}/`);
    default:
      return false;
  }
}

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const VIDEO_ID = /^[\w-]+$/;

function rewrite(u: URL): string | null {
  const first = u.pathname.split('/')[1] ?? '';
  const id = u.pathname.split('/')[2] ?? '';
  if (YOUTUBE_HOSTS.has(u.hostname)) {
    const v =
      u.pathname === '/watch' ? (u.searchParams.get('v') ?? '') : first === 'embed' ? id : '';
    return VIDEO_ID.test(v) ? `https://www.youtube-nocookie.com/embed/${v}` : null;
  }
  if (u.hostname === 'youtu.be') {
    return VIDEO_ID.test(first) ? `https://www.youtube-nocookie.com/embed/${first}` : null;
  }
  if (u.hostname === 'vimeo.com' || u.hostname === 'www.vimeo.com') {
    return /^\d+$/.test(first) ? `https://player.vimeo.com/video/${first}` : null;
  }
  if (u.hostname === 'docs.google.com' && /\/forms\/.+\/viewform$/.test(u.pathname)) {
    u.searchParams.set('embedded', 'true');
    u.hash = '';
    return u.toString();
  }
  return null;
}

/** An embeddable URL for a pasted share link, or null when the result is
 * not on the allowlist. */
export function toEmbedUrl(url: string): string | null {
  const u = parseHttps(url.trim());
  if (!u) return null;
  const out = rewrite(u) ?? u.toString();
  return embedAllowed(out) ? out : null;
}
