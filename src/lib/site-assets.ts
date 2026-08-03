// Resolves the AssetCtx templates need. The only place themeName() +
// resolveGitHash() are read for rendering, so templates stay pure and
// bundle into the admin build.

import type { AssetCtx } from '../templates/layout.ts';
import { resolveGitHash } from './build-info.ts';
import { themeName } from './config.ts';

export function serverAssets(base = '/static'): AssetCtx {
  return { theme: themeName(), hash: resolveGitHash().slice(0, 12), base };
}
