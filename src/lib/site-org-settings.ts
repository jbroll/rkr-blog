// Site settings added for organization sites. Kept apart from config.ts
// so that file stays under the size cap; PersistedSiteConfig and
// SiteConfig both extend OrgSiteFields.

import type { Db } from './db.ts';
import { type IndexedPost, readIndexedPostBySlug } from './post-index.ts';

export interface OrgSiteFields {
  /** Slug of the page `/` renders instead of the post index. */
  homePage?: string;
}

const VALID_SLUG = /^[a-z0-9-]*$/;

/** Empty string is kept so a cleared choice overwrites the stored one;
 * orgSiteConfig drops it when the runtime config is built. */
export function pickOrgFields(raw: Record<string, unknown>): OrgSiteFields {
  const out: OrgSiteFields = {};
  if (typeof raw.homePage === 'string' && VALID_SLUG.test(raw.homePage)) {
    out.homePage = raw.homePage;
  }
  return out;
}

export function orgSiteConfig(persisted: OrgSiteFields): OrgSiteFields {
  const out: OrgSiteFields = {};
  if (persisted.homePage) out.homePage = persisted.homePage;
  return out;
}

/** The published page `site.homePage` names, or null when it is unset,
 * missing, a draft, or a post. */
export function homePageRow(db: Db, site: OrgSiteFields): IndexedPost | null {
  if (!site.homePage) return null;
  const row = readIndexedPostBySlug(db, site.homePage);
  return row && row.kind === 'page' && row.status === 'published' ? row : null;
}
