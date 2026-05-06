// Runtime configuration. All paths derive from SITE_ROOT so the repo stays portable.

import path from 'node:path';

export function siteRoot(env = process.env) {
  return env.SITE_ROOT || '/var/www/site';
}

export function paths(env = process.env) {
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

export function serverConfig(env = process.env) {
  return {
    port: Number(env.PORT || 3000),
    host: env.HOST || '127.0.0.1',
    logLevel: env.LOG_LEVEL || 'info'
  };
}
