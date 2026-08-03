// The site chrome the published-form preview needs (title, tagline,
// theme, build hash). None of it is in OPFS, so the editor snapshots
// it from its own server-rendered shell whenever it loads online.

import { readJson, writeJson } from './opfs.ts';
import { OPFS_DIRS } from './opfs-schema.ts';

const SNAPSHOT_PATH = `${OPFS_DIRS.META}/_site.json`;

/** @public */
export interface SiteSnapshot {
  title: string;
  tagline?: string;
  theme: string;
  hash: string;
}

/** Read the values back off the shell's own head + header rather than
 * adding an endpoint: the server already rendered them here. */
export function captureSiteSnapshot(doc: Document): SiteSnapshot | null {
  const title = doc.querySelector('.rkr-site-title a')?.textContent?.trim();
  if (!title) return null;
  const tagline = doc.querySelector('.rkr-site-tagline')?.textContent?.trim();
  let theme = 'default';
  let hash = 'unknown';
  for (const link of doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
    const m = /\/themes\/([a-z0-9-]+)\.css\?v=([^"&]+)$/.exec(link.getAttribute('href') ?? '');
    if (!m) continue;
    hash = m[2] as string;
    if (m[1] !== 'default') theme = m[1] as string;
  }
  return { title, ...(tagline ? { tagline } : {}), theme, hash };
}

export async function saveSiteSnapshot(snap: SiteSnapshot): Promise<void> {
  await writeJson(SNAPSHOT_PATH, snap);
}

export async function readSiteSnapshot(): Promise<SiteSnapshot | null> {
  return readJson<SiteSnapshot>(SNAPSHOT_PATH);
}
