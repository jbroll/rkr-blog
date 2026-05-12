// Runtime configuration. All paths derive from SITE_ROOT so the repo stays portable.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { INGEST_RESIZE_BOUNDS } from './image-constants.ts';

export interface Paths {
  root: string;
  originals: string;
  sidecars: string;
  cache: string;
  cacheImg: string;
  content: string;
  contentPosts: string;
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

export interface SiteConfig {
  title: string;
  tagline?: string;
  /** Persisted ingest-resize overrides. Undefined → use compile-time
   * defaults from image-constants.ts. Individual fields can be
   * missing; the resize helper merges them with DEFAULT_INGEST_RESIZE. */
  ingestResize?: PersistedIngestResize;
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

/** Schema of `<siteRoot>/config/site.json`. All fields optional — a
 * missing field falls through to the env var, then to a hard-coded
 * default. The admin settings UI rewrites this file. */
export interface PersistedSiteConfig {
  title?: string;
  tagline?: string;
  theme?: string;
  ingestResize?: PersistedIngestResize;
}

/** Read the persisted blog-level config. Returns an empty object when
 * the file is missing or unreadable; siteConfig / themeName then fall
 * through to env vars. Parse errors are logged once but not thrown —
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
  const out: PersistedSiteConfig = {};
  if (typeof r.title === 'string') out.title = r.title;
  if (typeof r.tagline === 'string') out.tagline = r.tagline;
  if (typeof r.theme === 'string') out.theme = r.theme;
  const ingest = pickPersistedIngestResize(r.ingestResize);
  if (ingest) out.ingestResize = ingest;
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

function clampInt(v: unknown, bounds: { min: number; max: number }): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.max(bounds.min, Math.min(bounds.max, Math.round(v)));
}

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
  const p = paths(env).siteConfigFile;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  // Drop the theme-name memoisation so the next call sees the new value.
  resolvedThemeName = null;
  return next;
}

export function siteConfig(env: Env = process.env): SiteConfig {
  const persisted = readPersistedSiteConfig(env);
  const title = persisted.title || env.SITE_TITLE || 'rkroll';
  const tagline = persisted.tagline ?? env.SITE_TAGLINE;
  const out: SiteConfig = { title };
  if (tagline) out.tagline = tagline;
  if (persisted.ingestResize) out.ingestResize = persisted.ingestResize;
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
    content: path.join(root, 'content'),
    contentPosts: path.join(root, 'content', 'posts'),
    data: path.join(root, 'data'),
    db: path.join(root, 'data', 'site.db'),
    static: path.join(root, 'static'),
    config: path.join(root, 'config'),
    siteConfigFile: path.join(root, 'config', 'site.json')
  };
}

export function serverConfig(env: Env = process.env): ServerConfig {
  return {
    port: Number(env.PORT || 3000),
    host: env.HOST || '127.0.0.1',
    logLevel: env.LOG_LEVEL || 'info'
  };
}

/** Repo's static/themes directory. Used to validate SITE_THEME at
 * resolve time so an unknown theme name falls back to default with
 * a one-shot warning rather than 404ing the stylesheet. */
function repoThemesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/lib → ../../static/themes
  return path.resolve(here, '..', '..', 'static', 'themes');
}

const VALID_THEME_NAME = /^[a-z][a-z0-9-]*$/;
let resolvedThemeName: string | null = null;

/** Active theme name. Precedence: `config/site.json#theme` > SITE_THEME
 * env > `default`. Unknown / invalid names fall back to default with a
 * one-shot stderr warning so the operator notices. Memoised across
 * calls; writePersistedSiteConfig() resets the cache so an admin-UI
 * edit takes effect without a restart. */
export function themeName(env: Env = process.env): string {
  if (resolvedThemeName !== null) return resolvedThemeName;
  const persisted = readPersistedSiteConfig(env).theme;
  const requested = persisted || env.SITE_THEME || 'default';
  if (!VALID_THEME_NAME.test(requested)) {
    process.stderr.write(
      `[rkroll] theme="${requested}" rejected (must match ${VALID_THEME_NAME.source}); using default\n`
    );
    resolvedThemeName = 'default';
    return resolvedThemeName;
  }
  const themePath = path.join(repoThemesDir(), `${requested}.css`);
  if (!fs.existsSync(themePath)) {
    process.stderr.write(
      `[rkroll] theme="${requested}" not found at ${themePath}; using default\n`
    );
    resolvedThemeName = 'default';
    return resolvedThemeName;
  }
  resolvedThemeName = requested;
  return resolvedThemeName;
}

/** Enumerate themes available on disk (`static/themes/*.css`). Drives
 * the future select-menu UI; sorted with `default` first, then the
 * rest alphabetically, so the picker reads naturally. */
export function listAvailableThemes(): string[] {
  const dir = repoThemesDir();
  /* c8 ignore start -- defensive: repo always ships at least default.css */
  if (!fs.existsSync(dir)) return ['default'];
  /* c8 ignore stop */
  const names = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.css'))
    .map((f) => f.slice(0, -'.css'.length))
    .filter((n) => VALID_THEME_NAME.test(n));
  const rest = names.filter((n) => n !== 'default').sort();
  return ['default', ...rest];
}

/** Reset the memoised theme. Tests only — production resolves once
 * per process. */
export function _resetThemeNameCache(): void {
  resolvedThemeName = null;
}
