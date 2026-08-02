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
  assert.equal(c.FASTIFY_APP_PORT, '3002');
  assert.equal(c.APACHE_SERVER_ALIASES, 'www.stockademade.com');
});

const SITES = ['rkr-blog', 'stockademade'];

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
