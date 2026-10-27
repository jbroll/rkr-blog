// Resolves the AssetCtx templates need. The only place themeName() +
// resolveGitHash() are read for rendering, so templates stay pure and
// bundle into the admin build.

import type { AssetCtx } from '../templates/layout.ts';
import { shortGitHash } from './build-info.ts';
import { siteThemeFile, themeName } from './themes.ts';

export function serverAssets(base = '/static'): AssetCtx {
  const theme = themeName();
  const ctx: AssetCtx = { theme, hash: shortGitHash(), base };
  if (siteThemeFile(theme)) {
    ctx.themeHref = `${base === '/static' ? '' : '/admin'}/site-theme/${theme}.css`;
  }
  return ctx;
}
