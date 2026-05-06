// Runtime configuration. All paths derive from SITE_ROOT so the repo stays portable.

import path from 'node:path';

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
