// Header settings resolved for one public render: the logo goes through
// the image pipeline, everything else is copied from the site config.

import type { SiteNavChrome } from '../templates/site-nav.ts';
import { fallback, variants } from '../widgets/figure.ts';
import { buildImageMap } from './image-map-fs.ts';
import type { OrgSiteFields } from './site-org-settings.ts';
import { renderPicture } from './widget-helpers.ts';

interface ChromeLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

// A logo never needs the wide figure variants; these are a subset of the
// ones every sidecar declares, so /img serves them.
const LOGO_VARIANTS = variants.filter((v) => v.w <= 640);

/** `<picture>` for the logo, or undefined when unset or the image is gone.
 * Alt is empty: the surrounding home link carries the site title. */
export async function renderLogoHtml(
  siteRoot: string,
  logoId: string | undefined,
  log: ChromeLogger
): Promise<string | undefined> {
  if (!logoId) return undefined;
  const images = await buildImageMap(
    siteRoot,
    { type: 'leafDirective', name: 'figure', attributes: { ids: logoId } },
    { log }
  );
  const src = images.get(logoId);
  if (!src) return undefined;
  return renderPicture({ src, variants: LOGO_VARIANTS, fallback, alt: '', loading: 'eager' });
}

export async function loadChrome(
  siteRoot: string,
  site: OrgSiteFields,
  log: ChromeLogger
): Promise<SiteNavChrome> {
  const out: SiteNavChrome = {};
  const logoHtml = await renderLogoHtml(siteRoot, site.logo, log);
  if (logoHtml) out.logoHtml = logoHtml;
  if (site.menu) out.menu = site.menu;
  if (site.cta) out.cta = site.cta;
  if (site.social) out.social = site.social;
  if (site.announcement) out.announcement = site.announcement;
  return out;
}
