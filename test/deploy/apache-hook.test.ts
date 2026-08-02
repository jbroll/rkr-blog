import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const HOOK = path.join(REPO, 'deploy/hooks/apache.build.post.sh');

/**
 * Run the vhost hook the way a real deploy does: SITE_ROOT lives only in a
 * site env file on disk, referenced via SITE_ENV_FILE + PROJECT_DIR — never
 * in the shell environment. `siteEnvContents` undefined means no site env
 * file's SITE_ROOT line at all (the file exists but is empty).
 */
function runHook(env: Record<string, string>, siteEnvContents: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vhost-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vhost-project-'));
  const siteEnvRelPath = 'deploy/sites/test-site.env';
  const siteEnvAbsPath = path.join(projectDir, siteEnvRelPath);
  fs.mkdirSync(path.dirname(siteEnvAbsPath), { recursive: true });
  fs.writeFileSync(siteEnvAbsPath, siteEnvContents);

  execFileSync('bash', [HOOK], {
    env: {
      PATH: process.env.PATH ?? '',
      TMP_DIR: tmp,
      FASTIFY_APP_DATA_PATH: '/var/www',
      FASTIFY_APP_BASE_PATH: '/opt',
      PROJECT_DIR: projectDir,
      SITE_ENV_FILE: siteEnvRelPath,
      ...env
    },
    encoding: 'utf8'
  });
  return fs.readFileSync(path.join(tmp, `${env.APP_NAME}.conf`), 'utf8');
}

/** Assert that runHook() fails with stderr matching `pattern`. */
function assertHookFails(
  env: Record<string, string>,
  siteEnvContents: string,
  pattern: RegExp
): void {
  assert.throws(
    () => runHook(env, siteEnvContents),
    (err: unknown) =>
      err instanceof Error && pattern.test((err as { stderr?: string }).stderr ?? '')
  );
}

const BASE = {
  APP_NAME: 'rkr-blog',
  DOMAIN_NAME: 'rkr-blog.rkroll.com',
  FASTIFY_APP_PORT: '3000'
};

test('vhost omits ServerAlias when no aliases are configured', () => {
  const conf = runHook(BASE, 'SITE_ROOT=/var/www/rkr-blog');
  assert.ok(!conf.includes('ServerAlias'));
  assert.ok(conf.includes('ServerName rkr-blog.rkroll.com'));
});

test('vhost declares each alias on both the :80 and :443 blocks', () => {
  const conf = runHook(
    {
      ...BASE,
      APP_NAME: 'stockademade',
      DOMAIN_NAME: 'stockademade.com',
      FASTIFY_APP_PORT: '3002',
      APACHE_SERVER_ALIASES: 'www.stockademade.com'
    },
    'SITE_ROOT=/var/www/stockademade'
  );
  const aliasLines = conf.match(/^\s*ServerAlias www\.stockademade\.com$/gm) ?? [];
  assert.equal(aliasLines.length, 2);
});

test('vhost redirects an alias host to the canonical domain over https', () => {
  const conf = runHook(
    {
      ...BASE,
      APP_NAME: 'stockademade',
      DOMAIN_NAME: 'stockademade.com',
      FASTIFY_APP_PORT: '3002',
      APACHE_SERVER_ALIASES: 'www.stockademade.com'
    },
    'SITE_ROOT=/var/www/stockademade'
  );
  assert.ok(conf.includes('RewriteCond %{HTTP_HOST} !^stockademade\\.com$ [NC]'));
  assert.ok(conf.includes('RewriteRule ^(.*)$ https://stockademade.com$1 [R=301,L]'));
});

test('hook rejects a SITE_ROOT that does not match APP_NAME', () => {
  assertHookFails(BASE, 'SITE_ROOT=/var/www/wrong-name', /SITE_ROOT/);
});

test('hook accepts a SITE_ROOT that matches APP_NAME', () => {
  const conf = runHook(BASE, 'SITE_ROOT=/var/www/rkr-blog');
  assert.ok(conf.includes('DocumentRoot /var/www/rkr-blog'));
});

test('hook accepts SITE_ROOT with trailing whitespace and ignores comments/other keys', () => {
  const conf = runHook(
    BASE,
    [
      '# comment line',
      'PUBLIC_BASE_URL=https://rkr-blog.rkroll.com',
      'SITE_ROOT=/var/www/rkr-blog   ',
      'OTHER=1'
    ].join('\n')
  );
  assert.ok(conf.includes('DocumentRoot /var/www/rkr-blog'));
});

test('hook rejects a site env file with no SITE_ROOT line at all', () => {
  assertHookFails(BASE, 'PUBLIC_BASE_URL=https://rkr-blog.rkroll.com', /SITE_ROOT/);
});

test('hook reports a missing site env file honestly, not as "no SITE_ROOT= line"', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vhost-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vhost-project-'));
  const siteEnvRelPath = 'deploy/sites/does-not-exist.env';
  assert.throws(
    () =>
      execFileSync('bash', [HOOK], {
        env: {
          PATH: process.env.PATH ?? '',
          TMP_DIR: tmp,
          FASTIFY_APP_DATA_PATH: '/var/www',
          FASTIFY_APP_BASE_PATH: '/opt',
          PROJECT_DIR: projectDir,
          SITE_ENV_FILE: siteEnvRelPath,
          ...BASE
        },
        encoding: 'utf8'
      }),
    (err: unknown) => {
      const stderr = (err as { stderr?: string }).stderr ?? '';
      return /does not exist/.test(stderr) && !/has no SITE_ROOT= line/.test(stderr);
    }
  );
});

test('vhost redirect comment names the real domain, not a literal placeholder', () => {
  const conf = runHook(
    {
      ...BASE,
      APP_NAME: 'stockademade',
      DOMAIN_NAME: 'stockademade.com',
      FASTIFY_APP_PORT: '3002',
      APACHE_SERVER_ALIASES: 'www.stockademade.com'
    },
    'SITE_ROOT=/var/www/stockademade'
  );
  assert.ok(conf.includes('# Canonical host: send every alias to stockademade.com.'));
  const placeholder = ['$', '{DOMAIN_NAME}'].join('');
  assert.ok(!conf.includes(placeholder));
});

test('hook fails the way a real deploy would when SITE_ROOT is set only in the shell environment, not the site env file', () => {
  // This is the bug that shipped: deploy.sh sources <site>.conf but never
  // <site>.env, so the real deploy shell never has SITE_ROOT set — only the
  // site env file does. Passing it as a plain env var (as the old test did)
  // must NOT satisfy the guard.
  assertHookFails({ ...BASE, SITE_ROOT: '/var/www/rkr-blog' }, '', /SITE_ROOT/);
});

const SPLIT = {
  ...BASE,
  DOMAIN_NAME: 'roll-along.rkroll.com',
  APACHE_SERVER_ALIASES: 'rkr-blog.rkroll.com',
  APACHE_CANONICAL_REDIRECT: 'no',
  APACHE_ADMIN_HOST: 'rkr-blog.rkroll.com'
};

test('APACHE_CANONICAL_REDIRECT=no serves aliases directly instead of 301ing them', () => {
  const conf = runHook(SPLIT, 'SITE_ROOT=/var/www/rkr-blog');
  assert.ok(conf.includes('ServerAlias rkr-blog.rkroll.com'));
  assert.ok(!conf.includes('RewriteRule ^(.*)$ https://roll-along.rkroll.com$1 [R=301,L]'));
});

test('APACHE_ADMIN_HOST sends /admin and /login on any other host to the admin host', () => {
  const conf = runHook(SPLIT, 'SITE_ROOT=/var/www/rkr-blog');
  assert.ok(conf.includes('RewriteCond %{HTTP_HOST} !^rkr-blog\\.rkroll\\.com$ [NC]'));
  assert.ok(
    conf.includes(
      'RewriteRule ^(/(?:admin|login)(?:/.*)?)$ https://rkr-blog.rkroll.com$1 [R=308,L]'
    )
  );
});

test('the admin redirect is a 308 so a cross-host POST keeps its method and body', () => {
  const conf = runHook(SPLIT, 'SITE_ROOT=/var/www/rkr-blog');
  const rule = conf.split('\n').find((l) => l.includes('admin|login')) ?? '';
  assert.ok(rule.includes('[R=308,L]'), `expected 308, got: ${rule}`);
});

test('an admin host combined with the canonical redirect is rejected as a bounce loop', () => {
  assertHookFails(
    { ...SPLIT, APACHE_CANONICAL_REDIRECT: 'yes' },
    'SITE_ROOT=/var/www/rkr-blog',
    /bounce \/admin between the hosts/
  );
});

test('an admin host equal to DOMAIN_NAME is allowed alongside the canonical redirect', () => {
  const conf = runHook(
    { ...SPLIT, APACHE_CANONICAL_REDIRECT: 'yes', APACHE_ADMIN_HOST: 'roll-along.rkroll.com' },
    'SITE_ROOT=/var/www/rkr-blog'
  );
  assert.ok(conf.includes('RewriteRule ^(.*)$ https://roll-along.rkroll.com$1 [R=301,L]'));
});

test('the admin redirect precedes the image cache fast-path', () => {
  const conf = runHook(SPLIT, 'SITE_ROOT=/var/www/rkr-blog');
  assert.ok(conf.indexOf('admin|login') < conf.indexOf('RewriteRule ^/img/'));
});

test('no admin redirect is emitted when APACHE_ADMIN_HOST is unset', () => {
  const conf = runHook(BASE, 'SITE_ROOT=/var/www/rkr-blog');
  assert.ok(!conf.includes('admin|login'));
});
