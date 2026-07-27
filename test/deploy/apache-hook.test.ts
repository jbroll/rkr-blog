import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const HOOK = path.join(REPO, 'deploy/hooks/apache.build.post.sh');

/** Run the vhost hook with the given env and return the generated config. */
function runHook(env: Record<string, string>): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vhost-'));
  execFileSync('bash', [HOOK], {
    env: {
      PATH: process.env.PATH ?? '',
      TMP_DIR: tmp,
      FASTIFY_APP_DATA_PATH: '/var/www',
      FASTIFY_APP_BASE_PATH: '/opt',
      ...env
    },
    encoding: 'utf8'
  });
  return fs.readFileSync(path.join(tmp, `${env.APP_NAME}.conf`), 'utf8');
}

const BASE = {
  APP_NAME: 'rkr-blog',
  DOMAIN_NAME: 'rkr-blog.rkroll.com',
  FASTIFY_APP_PORT: '3000',
  SITE_ROOT: '/var/www/rkr-blog'
};

test('vhost omits ServerAlias when no aliases are configured', () => {
  const conf = runHook(BASE);
  assert.ok(!conf.includes('ServerAlias'));
  assert.ok(conf.includes('ServerName rkr-blog.rkroll.com'));
});

test('vhost declares each alias on both the :80 and :443 blocks', () => {
  const conf = runHook({
    ...BASE,
    APP_NAME: 'stockademade',
    DOMAIN_NAME: 'stockademade.com',
    SITE_ROOT: '/var/www/stockademade',
    FASTIFY_APP_PORT: '3002',
    APACHE_SERVER_ALIASES: 'www.stockademade.com'
  });
  const aliasLines = conf.match(/^\s*ServerAlias www\.stockademade\.com$/gm) ?? [];
  assert.equal(aliasLines.length, 2);
});

test('vhost redirects an alias host to the canonical domain over https', () => {
  const conf = runHook({
    ...BASE,
    APP_NAME: 'stockademade',
    DOMAIN_NAME: 'stockademade.com',
    SITE_ROOT: '/var/www/stockademade',
    FASTIFY_APP_PORT: '3002',
    APACHE_SERVER_ALIASES: 'www.stockademade.com'
  });
  assert.ok(conf.includes('RewriteCond %{HTTP_HOST} !^stockademade\\.com$ [NC]'));
  assert.ok(conf.includes('RewriteRule ^(.*)$ https://stockademade.com$1 [R=301,L]'));
});
