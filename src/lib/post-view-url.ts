// Public URL to visit after saving a post with the given slug.
// System posts that have no public /:slug page route to the most
// useful alternative: _about has /about, _site-banner is embedded on
// every page so it routes to the home page.

export function postViewUrl(slug: string): string {
  if (slug === '_about') return '/about';
  if (slug === '_site-banner') return '/';
  return `/${encodeURIComponent(slug)}`;
}
