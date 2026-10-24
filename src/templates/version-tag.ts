// Server-only helpers that stamp the deployed commit. Kept free of
// node-dependent imports so the browser bundle (which type-checks
// templates via preview-page.ts) never pulls build-info.ts into its
// type program. Callers pass the hash (serverAssets().hash).

import { escapeAttr } from '../lib/content.ts';

export function buildMetaTag(hash: string): string {
  return `<meta name="rkr-build" content="${escapeAttr(hash)}"/>`;
}
