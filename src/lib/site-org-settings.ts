// Site settings added for organization sites. Kept apart from config.ts
// so that file stays under the size cap; PersistedSiteConfig and
// SiteConfig both extend OrgSiteFields.

import type { Db } from './db.ts';
import { type IndexedPost, readIndexedPostBySlug } from './post-index.ts';

export const SOCIAL_PLATFORMS = [
  'facebook',
  'instagram',
  'youtube',
  'mastodon',
  'bluesky',
  'email'
] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export interface NavLink {
  label: string;
  href: string;
}

export interface SocialLink {
  platform: SocialPlatform;
  /** An `email` entry holds a mailto: address. */
  url: string;
}

export interface Announcement {
  text: string;
  href?: string;
  on: boolean;
}

export interface Campaign {
  goal: number;
  raised: number;
}

export interface OrgSiteFields {
  /** Slug of the page `/` renders instead of the post index. */
  homePage?: string;
  /** Image id of the header logo. */
  logo?: string;
  /** Header links. While set, the header drops Home, About and Login. */
  menu?: NavLink[];
  cta?: NavLink;
  social?: SocialLink[];
  announcement?: Announcement;
  /** Figures shown by progress blocks with `source: "site"`. */
  campaign?: Campaign;
}

const VALID_SLUG = /^[a-z0-9-]*$/;
const IMAGE_ID = /^(?:[0-9a-f]{64})?$/;
export const MAX_MENU_ITEMS = 12;
export const MAX_SOCIAL_LINKS = 12;
export const MAX_LABEL = 60;
const MAX_URL = 2048;
export const MAX_ANNOUNCEMENT = 300;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim().length <= max ? v.trim() : null;

function pickLink(raw: unknown): NavLink | null {
  if (!isRecord(raw)) return null;
  const label = str(raw.label, MAX_LABEL);
  const href = str(raw.href, MAX_URL);
  return label && href ? { label, href } : null;
}

function pickSocial(raw: unknown): SocialLink | null {
  if (!isRecord(raw)) return null;
  const platform = SOCIAL_PLATFORMS.find((p) => p === raw.platform);
  const url = str(raw.url, MAX_URL);
  if (!platform || !url) return null;
  if (platform === 'email' && !/^mailto:/i.test(url)) return null;
  return { platform, url };
}

function pickList<T>(raw: unknown, pick: (v: unknown) => T | null, max: number): T[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .map(pick)
    .filter((v): v is T => v !== null)
    .slice(0, max);
}

function pickCta(raw: unknown): NavLink | undefined {
  if (isRecord(raw) && raw.label === '' && raw.href === '') return { label: '', href: '' };
  return pickLink(raw) ?? undefined;
}

function pickAnnouncement(raw: unknown): Announcement | undefined {
  if (!isRecord(raw) || typeof raw.on !== 'boolean') return undefined;
  const text = str(raw.text, MAX_ANNOUNCEMENT);
  if (text === null) return undefined;
  const href = str(raw.href, MAX_URL);
  return href ? { text, href, on: raw.on } : { text, on: raw.on };
}

const wholeNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;

function pickCampaign(raw: unknown): Campaign | undefined {
  if (!isRecord(raw)) return undefined;
  const goal = wholeNumber(raw.goal);
  const raised = wholeNumber(raw.raised);
  return goal !== null && raised !== null ? { goal, raised } : undefined;
}

/** Cleared values (empty string, empty list, empty CTA pair, announcement
 * switched off, a zero goal) are kept so a clear overwrites the stored one;
 * orgSiteConfig drops them when the runtime config is built. */
export function pickOrgFields(raw: Record<string, unknown>): OrgSiteFields {
  const out: OrgSiteFields = {};
  if (typeof raw.homePage === 'string' && VALID_SLUG.test(raw.homePage)) {
    out.homePage = raw.homePage;
  }
  if (typeof raw.logo === 'string' && IMAGE_ID.test(raw.logo)) out.logo = raw.logo;
  const menu = pickList(raw.menu, pickLink, MAX_MENU_ITEMS);
  if (menu) out.menu = menu;
  const cta = pickCta(raw.cta);
  if (cta) out.cta = cta;
  const social = pickList(raw.social, pickSocial, MAX_SOCIAL_LINKS);
  if (social) out.social = social;
  const announcement = pickAnnouncement(raw.announcement);
  if (announcement) out.announcement = announcement;
  const campaign = pickCampaign(raw.campaign);
  if (campaign) out.campaign = campaign;
  return out;
}

export function orgSiteConfig(persisted: OrgSiteFields): OrgSiteFields {
  const out: OrgSiteFields = {};
  if (persisted.homePage) out.homePage = persisted.homePage;
  if (persisted.logo) out.logo = persisted.logo;
  if (persisted.menu?.length) out.menu = persisted.menu;
  if (persisted.cta?.label) out.cta = persisted.cta;
  if (persisted.social?.length) out.social = persisted.social;
  if (persisted.announcement?.on && persisted.announcement.text) {
    out.announcement = persisted.announcement;
  }
  if (persisted.campaign?.goal) out.campaign = persisted.campaign;
  return out;
}

/** The published page `site.homePage` names, or null when it is unset,
 * missing, a draft, or a post. */
export function homePageRow(db: Db, site: OrgSiteFields): IndexedPost | null {
  if (!site.homePage) return null;
  const row = readIndexedPostBySlug(db, site.homePage);
  return row && row.kind === 'page' && row.status === 'published' ? row : null;
}
