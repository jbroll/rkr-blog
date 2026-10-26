// Stamps the deployed commit into a page. Callers pass the hash
// (serverAssets().hash), so this stays free of node-dependent imports.

import { BUILD_META_NAME } from '../lib/build-contract.ts';
import { escapeAttr } from '../lib/content.ts';

export function buildMetaTag(hash: string): string {
  return `<meta name="${BUILD_META_NAME}" content="${escapeAttr(hash)}"/>`;
}
