import assert from 'node:assert/strict';
import { test } from 'node:test';

import { paths, serverConfig, siteConfig, siteRoot } from '../../src/lib/config.ts';

test('siteRoot defaults to /var/www/site when SITE_ROOT is unset', () => {
  assert.equal(siteRoot({}), '/var/www/site');
  assert.equal(siteRoot({ SITE_ROOT: '/custom' }), '/custom');
});

test('paths derives all subpaths from SITE_ROOT', () => {
  const p = paths({ SITE_ROOT: '/x' });
  assert.equal(p.root, '/x');
  assert.equal(p.originals, '/x/originals');
  assert.equal(p.cacheImg, '/x/cache/img');
  assert.equal(p.contentPosts, '/x/content/posts');
  assert.equal(p.db, '/x/data/site.db');
});

test('serverConfig defaults port/host/logLevel', () => {
  const c = serverConfig({});
  assert.equal(c.port, 3000);
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.logLevel, 'info');
});

test('serverConfig honors PORT/HOST/LOG_LEVEL env', () => {
  const c = serverConfig({ PORT: '8081', HOST: '0.0.0.0', LOG_LEVEL: 'warn' });
  assert.equal(c.port, 8081);
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.logLevel, 'warn');
});

test('siteConfig: title defaults to "rkroll", tagline omitted when env unset', () => {
  const c = siteConfig({});
  assert.equal(c.title, 'rkroll');
  assert.equal(c.tagline, undefined);
});

test('siteConfig: SITE_TITLE / SITE_TAGLINE override defaults', () => {
  const c = siteConfig({ SITE_TITLE: 'My Photos', SITE_TAGLINE: 'images from the road' });
  assert.equal(c.title, 'My Photos');
  assert.equal(c.tagline, 'images from the road');
});
