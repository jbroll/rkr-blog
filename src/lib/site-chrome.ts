// Header settings resolved for one public render: the logo goes through
// the image pipeline, everything else is copied from the site config.

import fs from 'node:fs';
import path from 'node:path';

import type { SiteNavChrome } from '../templates/site-nav.ts';
import figureWidget, { fallback, variants } from '../widgets/figure.ts';
import videoWidget from '../widgets/video.ts';
import { readBlockPage } from './block-pages.ts';
import { prepareBlockRender } from './block-post-render.ts';
import { renderBlockTree } from './blocks-render.ts';
import { siteConfigWrites } from './config.ts';
import { imageSourceById } from './image-map-fs.ts';
import type { Campaign, OrgSiteFields } from './site-org-settings.ts';
import { buildVideoMap } from './video-map-fs.ts';
import { renderPicture } from './widget-helpers.ts';
import { WidgetRegistry } from './widgets.ts';

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
  const src = await imageSourceById(siteRoot, logoId, { log });
  if (!src) return undefined;
  return renderPicture({ src, variants: LOGO_VARIANTS, fallback, alt: '', loading: 'eager' });
}

const FOOTER_SLUG = '_footer';

// Bounds staleness from changes the key cannot see: in-place macro edits
// and image sidecars.
const FOOTER_MAX_AGE_MS = 60_000;

interface FooterEntry {
  key: string;
  at: number;
  html: string | undefined;
}

const footerCache = new Map<string, FooterEntry>();
let footerWidgets: WidgetRegistry | undefined;

const statKey = (file: string): string => {
  try {
    const s = fs.statSync(file);
    return `${s.mtimeMs}:${s.size}:${s.ino}`;
  } catch {
    return 'none';
  }
};

async function renderFooter(
  siteRoot: string,
  log: ChromeLogger,
  campaign: Campaign | undefined
): Promise<string | undefined> {
  const page = readBlockPage(siteRoot, FOOTER_SLUG);
  if (page?.fields.status !== 'published') return undefined;
  if (!footerWidgets) {
    footerWidgets = new WidgetRegistry();
    footerWidgets.register(figureWidget);
    footerWidgets.register(videoWidget);
  }
  const deps = { widgets: footerWidgets, videos: await buildVideoMap(siteRoot), log };
  const { ctx, macroLib } = await prepareBlockRender(siteRoot, page.tree, deps);
  return renderBlockTree(page.tree, ctx, macroLib, { campaign });
}

/** Rendered `_footer` page, or undefined when it is absent or a draft. Every
 * public page asks, so the result is reused until the file, the macros
 * directory or the site settings change; an unchanged footer costs two stats. */
async function renderFooterHtml(
  siteRoot: string,
  log: ChromeLogger,
  campaign: Campaign | undefined
): Promise<string | undefined> {
  const key = [
    statKey(path.join(siteRoot, 'content', 'blocks', `${FOOTER_SLUG}.json`)),
    statKey(path.join(siteRoot, 'macros')),
    siteConfigWrites()
  ].join('|');
  const hit = footerCache.get(siteRoot);
  const now = Date.now();
  if (hit?.key === key && now - hit.at < FOOTER_MAX_AGE_MS) return hit.html;
  const html = await renderFooter(siteRoot, log, campaign);
  footerCache.set(siteRoot, { key, at: now, html });
  return html;
}

async function safeFooterHtml(
  siteRoot: string,
  log: ChromeLogger,
  campaign: Campaign | undefined
): Promise<string | undefined> {
  try {
    return await renderFooterHtml(siteRoot, log, campaign);
  } catch (err) {
    log.warn({ err }, 'footer render failed; using the default footer');
    return undefined;
  }
}

export async function loadChrome(
  siteRoot: string,
  site: OrgSiteFields,
  log: ChromeLogger
): Promise<SiteNavChrome> {
  const out: SiteNavChrome = {};
  const footerHtml = await safeFooterHtml(siteRoot, log, site.campaign);
  if (footerHtml) out.footerHtml = footerHtml;
  const logoHtml = await renderLogoHtml(siteRoot, site.logo, log);
  if (logoHtml) out.logoHtml = logoHtml;
  if (site.menu) out.menu = site.menu;
  if (site.cta) out.cta = site.cta;
  if (site.social) out.social = site.social;
  if (site.announcement) out.announcement = site.announcement;
  return out;
}
