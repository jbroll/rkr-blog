import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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

/**
 * Read a KEY= line from a site .env file the way production reads it:
 * deploy/hooks/*.build.post.sh grep the file as data — nothing sources it.
 * `set -a; source` (bash) strips quotes that grep+cut leave in place, so a
 * value like SITE_ROOT="/var/www/x" can pass a bash-sourced assertion and
 * still fail the hook. Mirrors the parse in apache.build.post.sh /
 * fastify_app.build.post.sh: last match wins, trailing whitespace trimmed.
 */
function readEnvKeyAsHookWould(relPath: string, key: string): string | undefined {
  const contents = fs.readFileSync(path.join(REPO, relPath), 'utf8');
  const re = new RegExp(`^${key}=(.*)$`, 'm');
  let value: string | undefined;
  for (const line of contents.split('\n')) {
    const m = line.match(re);
    if (m?.[1] !== undefined) value = m[1].replace(/[ \t]+$/, '');
  }
  return value;
}

test('rkr-blog site config exports the expected identity', () => {
  const c = loadConfig('deploy/sites/rkr-blog.conf');
  assert.equal(c.APP_NAME, 'rkr-blog');
  assert.equal(c.DOMAIN_NAME, 'roll-along.rkroll.com');
  assert.equal(c.REMOTE_HOST, 'rkr-blog.rkroll.com');
  assert.equal(c.FASTIFY_APP_PORT, '3000');
  assert.equal(c.SITE_ENV_FILE, 'deploy/sites/rkr-blog.env');
  assert.equal(c.FASTIFY_APP_SECRETS_FILE, 'deploy/secrets/rkr-blog.secrets.env');
  assert.equal(c.APACHE_SERVER_ALIASES, 'rkr-blog.rkroll.com');
  assert.equal(c.APACHE_CANONICAL_REDIRECT, 'no');
  assert.equal(c.APACHE_ADMIN_HOST, 'rkr-blog.rkroll.com');
});

test('the admin host is served by the vhost that pins it', () => {
  const c = loadConfig('deploy/sites/rkr-blog.conf');
  const served = [c.DOMAIN_NAME, ...(c.APACHE_SERVER_ALIASES ?? '').split(/\s+/)];
  assert.ok(
    served.includes(c.APACHE_ADMIN_HOST as string),
    'APACHE_ADMIN_HOST must be the domain or one of its aliases, or the cert will not cover it'
  );
});

test('ADMIN_BASE_URL matches the hostname Apache pins /admin to', () => {
  const c = loadConfig('deploy/sites/rkr-blog.conf');
  const adminBase = readEnvKeyAsHookWould('deploy/sites/rkr-blog.env', 'ADMIN_BASE_URL');
  assert.equal(adminBase, `https://${c.APACHE_ADMIN_HOST}`);
});

test('PUBLIC_BASE_URL matches the canonical domain', () => {
  const c = loadConfig('deploy/sites/rkr-blog.conf');
  const publicBase = readEnvKeyAsHookWould('deploy/sites/rkr-blog.env', 'PUBLIC_BASE_URL');
  assert.equal(publicBase, `https://${c.DOMAIN_NAME}`);
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

test('stockademade site config uses the apex domain with a www alias', () => {
  const c = loadConfig('deploy/sites/stockademade.conf');
  assert.equal(c.APP_NAME, 'stockademade');
  assert.equal(c.DOMAIN_NAME, 'stockademade.com');
  assert.equal(c.FASTIFY_APP_PORT, '3004');
  assert.equal(c.APACHE_SERVER_ALIASES, 'www.stockademade.com');
});

test('the image-editor PWA is opted into by rkr-blog alone', () => {
  assert.equal(loadConfig('deploy/sites/rkr-blog.conf').DEPLOY_IMAGE_EDITOR, 'yes');
  assert.equal(loadConfig('deploy/sites/stockademade.conf').DEPLOY_IMAGE_EDITOR, undefined);
});

test('code site config uses the site domain with no aliases', () => {
  const c = loadConfig('deploy/sites/code.conf');
  assert.equal(c.APP_NAME, 'code');
  assert.equal(c.DOMAIN_NAME, 'code.rkroll.com');
  assert.equal(c.FASTIFY_APP_PORT, '3005');
  assert.equal(c.SITE_ENV_FILE, 'deploy/sites/code.env');
  assert.equal(c.FASTIFY_APP_SECRETS_FILE, 'deploy/secrets/code.secrets.env');
  assert.equal(c.APACHE_SERVER_ALIASES, undefined);
  assert.equal(c.APACHE_ADMIN_HOST, undefined);
});

test('code PUBLIC_BASE_URL matches the canonical domain', () => {
  const c = loadConfig('deploy/sites/code.conf');
  const publicBase = readEnvKeyAsHookWould('deploy/sites/code.env', 'PUBLIC_BASE_URL');
  assert.equal(publicBase, `https://${c.DOMAIN_NAME}`);
});

const SITES = ['rkr-blog', 'stockademade', 'code'];

test('every site config uses a distinct port, app name, env file, secrets file, and domain', () => {
  const sites = SITES.map((s) => loadConfig(`deploy/sites/${s}.conf`));
  const ports = sites.map((c) => c.FASTIFY_APP_PORT);
  const names = sites.map((c) => c.APP_NAME);
  const siteEnvFiles = sites.map((c) => c.SITE_ENV_FILE);
  const secretsFiles = sites.map((c) => c.FASTIFY_APP_SECRETS_FILE);
  const domains = sites.map((c) => c.DOMAIN_NAME);
  assert.equal(new Set(ports).size, SITES.length);
  assert.equal(new Set(names).size, SITES.length);
  assert.equal(new Set(siteEnvFiles).size, SITES.length);
  assert.equal(new Set(secretsFiles).size, SITES.length);
  assert.equal(new Set(domains).size, SITES.length);
});

test('no hostname is claimed by two vhosts', () => {
  const hostnames = SITES.flatMap((s) => {
    const c = loadConfig(`deploy/sites/${s}.conf`);
    return [c.DOMAIN_NAME, ...(c.APACHE_SERVER_ALIASES ?? '').split(/\s+/).filter(Boolean)];
  });
  assert.equal(new Set(hostnames).size, hostnames.length);
});

test('every site env file sets SITE_ROOT to /var/www/<APP_NAME>, parsed the way the hooks parse it', () => {
  for (const site of SITES) {
    const siteRoot = readEnvKeyAsHookWould(`deploy/sites/${site}.env`, 'SITE_ROOT');
    assert.equal(siteRoot, `/var/www/${site}`);
  }
});
