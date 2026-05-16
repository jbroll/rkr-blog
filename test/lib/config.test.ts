import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, type TestContext, test } from 'node:test';

import {
  _resetThemeNameCache,
  listAvailableThemes,
  paths,
  readPersistedSiteConfig,
  serverConfig,
  siteConfig,
  siteRoot,
  themeName,
  writePersistedSiteConfig
} from '../../src/lib/config.ts';

// themeName() memoises within the process so the warning fires once;
// reset between tests that probe the env-driven branches.
afterEach(() => {
  _resetThemeNameCache();
});

function freshRoot(t: TestContext): { root: string; env: NodeJS.ProcessEnv } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-cfg-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, env: { SITE_ROOT: root } };
}

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

test('themeName: defaults to "default"', () => {
  assert.equal(themeName({}), 'default');
});

test('themeName: SITE_THEME=default resolves to default (round-trip)', () => {
  assert.equal(themeName({ SITE_THEME: 'default' }), 'default');
});

test('themeName: rejects unsafe names with a fallback to default', (t) => {
  // Suppress the stderr warning so the test output stays readable.
  const writes: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  assert.equal(themeName({ SITE_THEME: '../../etc/passwd' }), 'default');
  assert.ok(
    writes.some((s) => s.includes('rejected')),
    'expected a "rejected" warning on stderr'
  );
});

test('themeName: memoises across calls in a process', () => {
  // First call with custom env wins; second call ignores a different env.
  assert.equal(themeName({ SITE_THEME: 'default' }), 'default');
  assert.equal(themeName({ SITE_THEME: 'whatever-other' }), 'default');
});

test('paths: includes config dir + siteConfigFile', () => {
  const p = paths({ SITE_ROOT: '/x' });
  assert.equal(p.config, '/x/config');
  assert.equal(p.siteConfigFile, '/x/config/site.json');
});

test('readPersistedSiteConfig: missing file → empty object', (t) => {
  const { env } = freshRoot(t);
  assert.deepEqual(readPersistedSiteConfig(env), {});
});

test('readPersistedSiteConfig: parses title/tagline/theme; rejects extras', (t) => {
  const { root, env } = freshRoot(t);
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'config', 'site.json'),
    JSON.stringify({
      title: 'My Site',
      tagline: 'photos',
      theme: 'papermod',
      // Garbage fields are silently dropped — the type guard wins.
      malicious: '<script>',
      title_typo: 'oops'
    })
  );
  assert.deepEqual(readPersistedSiteConfig(env), {
    title: 'My Site',
    tagline: 'photos',
    theme: 'papermod'
  });
});

test('readPersistedSiteConfig: rejects wrong types per field', (t) => {
  const { root, env } = freshRoot(t);
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'config', 'site.json'),
    JSON.stringify({ title: 42, tagline: ['nope'], theme: { obj: 'no' } })
  );
  // All three fields fail the typeof === 'string' check → empty result.
  assert.deepEqual(readPersistedSiteConfig(env), {});
});

test('readPersistedSiteConfig: malformed JSON → empty, no throw', (t) => {
  const { root, env } = freshRoot(t);
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'site.json'), '{not json');
  assert.deepEqual(readPersistedSiteConfig(env), {});
});

test('writePersistedSiteConfig: creates config dir + merges partial updates', (t) => {
  const { root, env } = freshRoot(t);
  // Initial: nothing on disk. Write title only.
  writePersistedSiteConfig({ title: 'First' }, env);
  let p = readPersistedSiteConfig(env);
  assert.equal(p.title, 'First');
  assert.equal(p.tagline, undefined);
  // Partial update keeps the prior title.
  writePersistedSiteConfig({ tagline: 'subtitle' }, env);
  p = readPersistedSiteConfig(env);
  assert.equal(p.title, 'First');
  assert.equal(p.tagline, 'subtitle');
  // Theme too.
  writePersistedSiteConfig({ theme: 'papermod' }, env);
  p = readPersistedSiteConfig(env);
  assert.equal(p.title, 'First');
  assert.equal(p.tagline, 'subtitle');
  assert.equal(p.theme, 'papermod');
  // File is pretty-printed for human-edit-friendliness.
  const raw = fs.readFileSync(path.join(root, 'config', 'site.json'), 'utf8');
  assert.match(raw, /\n {2}"title": "First"/);
});

test('siteConfig: file overrides env, env overrides default', (t) => {
  const { root, env } = freshRoot(t);
  // No file, no env → default.
  assert.deepEqual(siteConfig(env), { title: 'rkroll' });
  // Env only.
  assert.deepEqual(siteConfig({ ...env, SITE_TITLE: 'From Env' }), { title: 'From Env' });
  // File overrides env.
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'config', 'site.json'),
    JSON.stringify({ title: 'From File', tagline: 'tag' })
  );
  assert.deepEqual(siteConfig({ ...env, SITE_TITLE: 'From Env', SITE_TAGLINE: 'envtag' }), {
    title: 'From File',
    tagline: 'tag'
  });
});

test('themeName: file overrides SITE_THEME env', (t) => {
  const { root, env } = freshRoot(t);
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'site.json'), JSON.stringify({ theme: 'papermod' }));
  assert.equal(themeName({ ...env, SITE_THEME: 'default' }), 'papermod');
});

test('listAvailableThemes: default first, others sorted', () => {
  const themes = listAvailableThemes();
  assert.equal(themes[0], 'default');
  assert.ok(themes.includes('papermod'), 'papermod should be available');
  // The rest are sorted alphabetically.
  const rest = themes.slice(1);
  const sorted = [...rest].sort();
  assert.deepEqual(rest, sorted);
});

test('postTeaser round-trips true/false; siteConfig surfaces only when true', (t) => {
  const { env } = freshRoot(t);
  writePersistedSiteConfig({ postTeaser: true }, env);
  assert.equal(readPersistedSiteConfig(env).postTeaser, true);
  assert.equal(siteConfig(env).postTeaser, true);
  // Explicit false persists (it is a boolean, so it is not dropped) and
  // siteConfig leaves postTeaser unset rather than surfacing `false`.
  writePersistedSiteConfig({ postTeaser: false }, env);
  assert.equal(readPersistedSiteConfig(env).postTeaser, false);
  assert.equal(siteConfig(env).postTeaser, undefined);
});
