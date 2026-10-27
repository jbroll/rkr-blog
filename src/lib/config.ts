// Runtime configuration. All paths derive from SITE_ROOT so the repo stays portable.

import fs from 'node:fs';
import path from 'node:path';
import { INGEST_RESIZE_BOUNDS } from '@rkr/image-edit';
import { writeFileAtomicSync } from './atomic-write.ts';
import { type OrgSiteFields, orgSiteConfig, pickOrgFields } from './site-org-settings.ts';

/** Bounds for the teaser word-limit setting. 0 disables truncation;
 * the upper bound is a sanity cap (a lede longer than this is not a
 * teaser). Mirrors the INGEST_RESIZE_BOUNDS clamp-at-read pattern. */
export const TEASER_WORDS_BOUNDS = { min: 0, max: 200 } as const;

export interface Paths {
  root: string;
  originals: string;
  sidecars: string;
  cache: string;
  cacheImg: string;
  /** Hash-addressed video originals, per-video sidecars, and the
   * derivative cache (mp4 + jpeg poster). Isolated from the image
   * pipeline's dirs so the two never share filenames. */
  originalsVideo: string;
  sidecarsVideo: string;
  cacheVideo: string;
  content: string;
  contentPosts: string;
  /** JSON page trees (experimental blocks format). One file per page,
   * written by `import-wp post --as-blocks` and `blocks-migrate`. */
  blocks: string;
  /** Tag-named JSON macro files for reusable blocks. Seeded by `init`
   * from the repo's macros/ directory; never overwritten once present. */
  macros: string;
  data: string;
  db: string;
  static: string;
  /** Per-site mutable config dir. Currently holds site.json (title /
   * tagline / theme). The admin UI's settings page writes here. */
  config: string;
  /** JSON file with the persisted blog-level settings. */
  siteConfigFile: string;
}

export interface ServerConfig {
  port: number;
  host: string;
  logLevel: string;
}

export interface SiteConfig extends OrgSiteFields {
  title: string;
  tagline?: string;
  /** Sidecar ID of the site-wide banner image, if set. */
  bannerImageId?: string;
  /** Persisted ingest-resize overrides. Undefined → use compile-time
   * defaults from image-constants.ts. Individual fields can be
   * missing; the resize helper merges them with DEFAULT_INGEST_RESIZE. */
  ingestResize?: PersistedIngestResize;
  /** Persisted video-ingest caps. Undefined → DEFAULT_VIDEO_CAPS.
   * Individual fields can be missing; resolveVideoCaps() merges them
   * with the defaults. */
  videoCaps?: VideoCaps;
  /** When true, the anonymous homepage features the top post as a
   * teaser (hero figure + first paragraph). Default off. */
  postTeaser?: boolean;
  /** When true, the full-bleed banner/hero image renders above the
   * site header instead of between the header and <main>. Default off. */
  bannerAboveHeader?: boolean;
  /** Max words in the teaser excerpt. Surfaced only when > 0; absent /
   * 0 means no truncation (full first paragraph). */
  teaserWords?: number;
  /** Email-notification verbosity for new comments. Default 'ham'. */
  commentNotify?: 'off' | 'ham' | 'queued' | 'all';
  /** Notification recipient address. Falls back to NOTIFY_TO env when absent. */
  notifyEmail?: string;
}

/** Blog-level defaults for the ingest-time downsample + re-encode
 * (see lib/ingest-resize.ts). Stored under `ingestResize` in
 * config/site.json; the admin settings UI edits these. All three
 * fields are independent: a missing field falls through to the
 * compile-time default in image-constants.ts. */
export interface PersistedIngestResize {
  maxDim?: number;
  scalePct?: number;
  webpQuality?: number;
}

/** Video-ingest caps. Persisted under `videoCaps` in config/site.json;
 * a missing field falls through to DEFAULT_VIDEO_CAPS. Mirrors
 * PersistedIngestResize's clamp-at-read pattern. */
export interface VideoCaps {
  /** Max accepted upload size in bytes. */
  maxBytes?: number;
  /** Max accepted source duration in ms. */
  maxDurationMs?: number;
  /** Max accepted source width in px (long edge). */
  maxWidth?: number;
}

/** Caller-side validation bounds for video caps. Out-of-range values
 * from persisted config snap to these at read time. */
export const VIDEO_CAPS_BOUNDS = {
  maxBytes: { min: 1, max: 2 * 1024 * 1024 * 1024 },
  maxDurationMs: { min: 1000, max: 600000 },
  maxWidth: { min: 320, max: 7680 }
} as const;

/** Defaults applied when config/site.json omits videoCaps. */
export const DEFAULT_VIDEO_CAPS = {
  maxBytes: 500 * 1024 * 1024,
  maxDurationMs: 300_000,
  maxWidth: 1920
} as const;

/** Schema of `<siteRoot>/config/site.json`. All fields optional — a
 * missing field falls through to the env var, then to a hard-coded
 * default. The admin settings UI rewrites this file. */
export interface PersistedSiteConfig extends OrgSiteFields {
  title?: string;
  tagline?: string;
  theme?: string;
  ingestResize?: PersistedIngestResize;
  /** Video-ingest caps. Admin-editable like ingestResize. */
  videoCaps?: VideoCaps;
  /** Sidecar ID of the site-wide banner image. */
  bannerImageId?: string;
  /** Feature the top post on the anonymous homepage as a teaser. */
  postTeaser?: boolean;
  /** Render the banner/hero above the site header. */
  bannerAboveHeader?: boolean;
  /** Max words in the teaser excerpt (0 / absent = no truncation). */
  teaserWords?: number;
  /** Email-notification verbosity for new comments. */
  commentNotify?: 'off' | 'ham' | 'queued' | 'all';
  /** Notification recipient address. Falls back to NOTIFY_TO env when absent. */
  notifyEmail?: string;
}

/** Read the persisted blog-level config. Returns an empty object when
 * the file is missing or unreadable; siteConfig / themeName (themes.ts)
 * then fall through to env vars. Parse errors are logged once but not thrown —
 * a malformed file shouldn't take the site down. */
export function readPersistedSiteConfig(env: Env = process.env): PersistedSiteConfig {
  const p = paths(env).siteConfigFile;
  if (!fs.existsSync(p)) return {};
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return pickPersistedFields(parsed);
  } catch (err) {
    /* c8 ignore start -- diagnostic-only; tested via the JSON-broken e2e path */
    process.stderr.write(
      `[rkroll] failed to read ${p}: ${(err as Error).message}; falling back to env\n`
    );
    return {};
    /* c8 ignore stop */
  }
}

/** Type guard + field extractor so a malformed file (extra keys, wrong
 * types) doesn't bleed bad values into the running site. */
function pickPersistedFields(raw: unknown): PersistedSiteConfig {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: PersistedSiteConfig = { ...pickOrgFields(r) };
  if (typeof r.title === 'string') out.title = r.title;
  if (typeof r.tagline === 'string') out.tagline = r.tagline;
  if (typeof r.theme === 'string') out.theme = r.theme;
  if (typeof r.bannerImageId === 'string') out.bannerImageId = r.bannerImageId;
  if (typeof r.postTeaser === 'boolean') out.postTeaser = r.postTeaser;
  if (typeof r.bannerAboveHeader === 'boolean') out.bannerAboveHeader = r.bannerAboveHeader;
  const tw = clampInt(r.teaserWords, TEASER_WORDS_BOUNDS);
  if (tw !== undefined) out.teaserWords = tw;
  if (
    r.commentNotify === 'off' ||
    r.commentNotify === 'ham' ||
    r.commentNotify === 'queued' ||
    r.commentNotify === 'all'
  ) {
    out.commentNotify = r.commentNotify;
  }
  if (typeof r.notifyEmail === 'string' && (r.notifyEmail === '' || isValidEmail(r.notifyEmail))) {
    out.notifyEmail = r.notifyEmail;
  }
  const ingest = pickPersistedIngestResize(r.ingestResize);
  if (ingest) out.ingestResize = ingest;
  const caps = pickPersistedVideoCaps(r.videoCaps);
  if (caps) out.videoCaps = caps;
  return out;
}

/** Validate + clamp ingestResize knobs at read time. Anything outside
 * INGEST_RESIZE_BOUNDS snaps to the nearest bound (mirrors the same
 * clamp the resize helper applies internally), and non-numeric values
 * are dropped entirely so they fall back to compile-time defaults. */
function pickPersistedIngestResize(raw: unknown): PersistedIngestResize | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: PersistedIngestResize = {};
  const md = clampInt(r.maxDim, INGEST_RESIZE_BOUNDS.maxDim);
  if (md !== undefined) out.maxDim = md;
  const sp = clampInt(r.scalePct, INGEST_RESIZE_BOUNDS.scalePct);
  if (sp !== undefined) out.scalePct = sp;
  const wq = clampInt(r.webpQuality, INGEST_RESIZE_BOUNDS.webpQuality);
  if (wq !== undefined) out.webpQuality = wq;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Validate + clamp videoCaps knobs at read time. Anything outside
 * VIDEO_CAPS_BOUNDS snaps to the nearest bound, and non-numeric
 * values are dropped so they fall back to DEFAULT_VIDEO_CAPS. */
function pickPersistedVideoCaps(raw: unknown): VideoCaps | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: VideoCaps = {};
  const mb = clampInt(r.maxBytes, VIDEO_CAPS_BOUNDS.maxBytes);
  if (mb !== undefined) out.maxBytes = mb;
  const md = clampInt(r.maxDurationMs, VIDEO_CAPS_BOUNDS.maxDurationMs);
  if (md !== undefined) out.maxDurationMs = md;
  const mw = clampInt(r.maxWidth, VIDEO_CAPS_BOUNDS.maxWidth);
  if (mw !== undefined) out.maxWidth = mw;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function isValidEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

function clampInt(v: unknown, bounds: { min: number; max: number }): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.max(bounds.min, Math.min(bounds.max, Math.round(v)));
}

let writes = 0;

/** Persist the blog-level config. Read-modify-writes the JSON file so
 * a partial update from the admin UI keeps fields it didn't change.
 * Nested ingestResize merges per-field (a patch with maxDim only
 * preserves the existing scalePct / webpQuality). Creates the config
 * dir if missing. */
export function writePersistedSiteConfig(
  patch: PersistedSiteConfig,
  env: Env = process.env
): PersistedSiteConfig {
  const current = readPersistedSiteConfig(env);
  const sanitized = pickPersistedFields(patch);
  const next: PersistedSiteConfig = { ...current, ...sanitized };
  if (sanitized.ingestResize || current.ingestResize) {
    next.ingestResize = { ...current.ingestResize, ...sanitized.ingestResize };
  }
  if (sanitized.videoCaps || current.videoCaps) {
    next.videoCaps = { ...current.videoCaps, ...sanitized.videoCaps };
  }
  const p = paths(env).siteConfigFile;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  writeFileAtomicSync(p, `${JSON.stringify(next, null, 2)}\n`);
  writes += 1;
  return next;
}

/** Count of settings writes in this process; lets caches built from
 * site.json (themes.ts) notice a change. */
export function siteConfigWrites(): number {
  return writes;
}

export function siteConfig(env: Env = process.env): SiteConfig {
  const persisted = readPersistedSiteConfig(env);
  const title = persisted.title || env.SITE_TITLE || 'rkroll';
  const tagline = persisted.tagline ?? env.SITE_TAGLINE;
  const out: SiteConfig = { title, ...orgSiteConfig(persisted) };
  if (tagline) out.tagline = tagline;
  if (persisted.ingestResize) out.ingestResize = persisted.ingestResize;
  if (persisted.videoCaps) out.videoCaps = persisted.videoCaps;
  if (persisted.bannerImageId) out.bannerImageId = persisted.bannerImageId;
  if (persisted.postTeaser) out.postTeaser = true;
  if (persisted.bannerAboveHeader) out.bannerAboveHeader = true;
  if (persisted.teaserWords && persisted.teaserWords > 0) out.teaserWords = persisted.teaserWords;
  if (persisted.commentNotify) out.commentNotify = persisted.commentNotify;
  const notifyEmail = persisted.notifyEmail || env.NOTIFY_TO;
  if (notifyEmail) out.notifyEmail = notifyEmail;
  return out;
}

type Env = NodeJS.ProcessEnv;

export function siteRoot(env: Env = process.env): string {
  return env.SITE_ROOT || '/var/www/site';
}

export function paths(env: Env = process.env): Paths {
  const root = siteRoot(env);
  return {
    root,
    originals: path.join(root, 'originals'),
    sidecars: path.join(root, 'sidecars'),
    cache: path.join(root, 'cache'),
    cacheImg: path.join(root, 'cache', 'img'),
    originalsVideo: path.join(root, 'originals', 'videos'),
    sidecarsVideo: path.join(root, 'sidecars', 'videos'),
    cacheVideo: path.join(root, 'cache', 'video'),
    content: path.join(root, 'content'),
    contentPosts: path.join(root, 'content', 'posts'),
    blocks: path.join(root, 'content', 'blocks'),
    macros: path.join(root, 'macros'),
    data: path.join(root, 'data'),
    db: path.join(root, 'data', 'site.db'),
    static: path.join(root, 'static'),
    config: path.join(root, 'config'),
    siteConfigFile: path.join(root, 'config', 'site.json')
  };
}

/** Fully-resolved video caps for a site: persisted overrides merged
 * over DEFAULT_VIDEO_CAPS. Persisted values were already clamped at
 * read time by pickPersistedVideoCaps, so no re-clamp is needed. */
export function resolveVideoCaps(siteRoot: string): Required<VideoCaps> {
  const persisted = readPersistedSiteConfig({ SITE_ROOT: siteRoot }).videoCaps;
  return {
    maxBytes: persisted?.maxBytes ?? DEFAULT_VIDEO_CAPS.maxBytes,
    maxDurationMs: persisted?.maxDurationMs ?? DEFAULT_VIDEO_CAPS.maxDurationMs,
    maxWidth: persisted?.maxWidth ?? DEFAULT_VIDEO_CAPS.maxWidth
  };
}

/** Origin visitors see. Canonical for permalinks and comment notifications. */
export function publicBaseUrl(env: Env = process.env): string | undefined {
  return stripTrailingSlash(env.PUBLIC_BASE_URL);
}

/** Origin the admin UI and every OAuth `redirect_uri` live on.
 *
 * Split from publicBaseUrl so a site can serve readers on one hostname while
 * sign-in stays on another: the OAuth state cookie is host-only, so a flow
 * that starts on the public host and returns to the admin host loses it.
 * Defaults to the public origin — only a split deployment sets ADMIN_BASE_URL. */
export function adminBaseUrl(env: Env = process.env): string | undefined {
  return stripTrailingSlash(env.ADMIN_BASE_URL) ?? publicBaseUrl(env);
}

/** Origins allowed to make any state-changing request, /admin included. */
export function csrfAllowedOrigins(env: Env = process.env): string[] {
  const admin = adminBaseUrl(env);
  return admin ? [new URL(admin).origin] : [];
}

/** Origins allowed only outside /admin: the reader-facing host, and only
 * when it is a different origin from the admin host. */
export function csrfPublicOnlyOrigins(env: Env = process.env): string[] {
  const url = publicBaseUrl(env);
  if (!url) return [];
  const origin = new URL(url).origin;
  return csrfAllowedOrigins(env).includes(origin) ? [] : [origin];
}

/** Whether the Google Drive picker integration routes are registered.
 * Mirrors the gate in server.ts: without a client id + secret and a
 * base URL to build the OAuth redirect_uri from, the
 * /admin/integrations/gdrive/* routes stay unregistered and hit the
 * 404 handler. The settings page uses this to offer a setup hint
 * instead of a dead Connect link. */
export function gdriveOAuthConfigured(env: Env = process.env): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && adminBaseUrl(env));
}

/** Whether the OneDrive picker integration routes are registered.
 * Same shape as gdriveOAuthConfigured — MICROSOFT_CLIENT_ID +
 * MICROSOFT_CLIENT_SECRET plus a base URL. */
export function onedriveOAuthConfigured(env: Env = process.env): boolean {
  return !!(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET && adminBaseUrl(env));
}

/** Whether the Google Photos picking integration routes are registered.
 * Same Google OAuth client as Drive (no new secrets) — the grant just
 * carries the Photos Picker scope instead. */
export function gphotosOAuthConfigured(env: Env = process.env): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && adminBaseUrl(env));
}

function stripTrailingSlash(v: string | undefined): string | undefined {
  if (!v) return undefined;
  return v.replace(/\/+$/, '');
}

export function serverConfig(env: Env = process.env): ServerConfig {
  return {
    port: Number(env.PORT || 3000),
    host: env.HOST || '127.0.0.1',
    logLevel: env.LOG_LEVEL || 'info'
  };
}
