import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..', '..');

/** Source a site config in a clean shell and return its exported vars. */
function loadConfig(relPath: string): Record<string, string> {
  const out = execFileSync(
    'bash',
    ['-c', `set -a; source "$1"; set +a; env`, '--', path.join(REPO, relPath)],
    { encoding: 'utf8', cwd: REPO }
  );
  const vars: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) vars[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return vars;
}

test('rkr-blog site config exports the expected identity', () => {
  const c = loadConfig('deploy/sites/rkr-blog.conf');
  assert.equal(c.APP_NAME, 'rkr-blog');
  assert.equal(c.DOMAIN_NAME, 'rkr-blog.rkroll.com');
  assert.equal(c.REMOTE_HOST, 'rkr-blog.rkroll.com');
  assert.equal(c.FASTIFY_APP_PORT, '3000');
  assert.equal(c.SITE_ENV_FILE, 'deploy/sites/rkr-blog.env');
  assert.equal(c.FASTIFY_APP_SECRETS_FILE, 'deploy/secrets/rkr-blog.secrets.env');
});

test('rkr-blog site config inherits shared settings from common.conf', () => {
  const c = loadConfig('deploy/sites/rkr-blog.conf');
  assert.equal(c.DEPLOY_TYPES, 'letsencrypt apache fastify_app');
  assert.equal(c.REMOTE_USER, 'john');
  assert.equal(c.FASTIFY_APP_USER, 'www-data');
  assert.equal(c.FASTIFY_APP_BASE_PATH, '/opt');
  assert.equal(c.FASTIFY_APP_DATA_PATH, '/var/www');
});

test('root deploy.conf shim resolves to the rkr-blog site', () => {
  const c = loadConfig('deploy.conf');
  assert.equal(c.APP_NAME, 'rkr-blog');
  assert.equal(c.FASTIFY_APP_PORT, '3000');
});
