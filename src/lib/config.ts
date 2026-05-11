// Runtime configuration. All paths derive from SITE_ROOT so the repo stays portable.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
}

export interface ServerConfig {
  port: number;
  host: string;
  logLevel: string;
}

export interface SiteConfig {
  title: string;
  tagline?: string;
}

export function siteConfig(env: Env = process.env): SiteConfig {
  const out: SiteConfig = { title: env.SITE_TITLE || 'rkroll' };
  if (env.SITE_TAGLINE) out.tagline = env.SITE_TAGLINE;
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
    static: path.join(root, 'static')
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

/** Active theme name. SITE_THEME picks from `static/themes/<name>.css`;
 * default is `default`. Unknown names fall back to default with a one-
 * shot stderr warning so the operator notices. Memoised so the warning
 * fires at most once per process. */
export function themeName(env: Env = process.env): string {
  if (resolvedThemeName !== null) return resolvedThemeName;
  const requested = env.SITE_THEME || 'default';
  if (!VALID_THEME_NAME.test(requested)) {
    process.stderr.write(
      `[rkroll] SITE_THEME="${requested}" rejected (must match ${VALID_THEME_NAME.source}); using default\n`
    );
    resolvedThemeName = 'default';
    return resolvedThemeName;
  }
  const themePath = path.join(repoThemesDir(), `${requested}.css`);
  if (!fs.existsSync(themePath)) {
    /* c8 ignore start -- production warning path; default theme exists in tests */
    process.stderr.write(
      `[rkroll] SITE_THEME="${requested}" not found at ${themePath}; using default\n`
    );
    resolvedThemeName = 'default';
    return resolvedThemeName;
    /* c8 ignore stop */
  }
  resolvedThemeName = requested;
  return resolvedThemeName;
}

/** Reset the memoised theme. Tests only — production resolves once
 * per process. */
export function _resetThemeNameCache(): void {
  resolvedThemeName = null;
}
