import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, type TestContext, test } from 'node:test';

import { writePersistedSiteConfig } from '../../src/lib/config.ts';
import {
  _resetThemeNameCache,
  activeSectionThemes,
  listAvailableThemes,
  sectionThemeNames,
  siteThemeFile,
  themeFile,
  themeName
} from '../../src/lib/themes.ts';

// themeName() memoises within the process so the warning fires once;
// reset between tests that probe the env-driven branches.
afterEach(() => {
  _resetThemeNameCache();
});

function freshRoot(t: TestContext): { root: string; env: NodeJS.ProcessEnv } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-themes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, env: { SITE_ROOT: root } };
}

function siteTheme(root: string, name: string, css = 'body{}'): void {
  fs.mkdirSync(path.join(root, 'themes'), { recursive: true });
  fs.writeFileSync(path.join(root, 'themes', `${name}.css`), css);
}

test('site themes: listed after default, merged with bundled, selectable', (t) => {
  const { root, env } = freshRoot(t);
  siteTheme(root, 'club');
  siteTheme(root, 'default');
  const list = listAvailableThemes(env);
  assert.equal(list[0], 'default');
  assert.ok(list.includes('club'));
  assert.equal(new Set(list).size, list.length);
  assert.equal(themeName({ ...env, SITE_THEME: 'club' }), 'club');
});

test('site themes: a site copy wins a name clash', (t) => {
  const { root, env } = freshRoot(t);
  siteTheme(root, 'default');
  assert.equal(themeFile('default', env), path.join(root, 'themes', 'default.css'));
  assert.notEqual(themeFile('default', {}), path.join(root, 'themes', 'default.css'));
});

test('site themes: activeSectionThemes reads the site copy', (t) => {
  const { root, env } = freshRoot(t);
  siteTheme(root, 'club', '/* rkr-section-themes: forest */');
  assert.deepEqual(activeSectionThemes({ ...env, SITE_THEME: 'club' }), [
    'light',
    'light-bold',
    'dark',
    'dark-bold',
    'forest'
  ]);
});

test('site themes: unsafe or missing names never resolve', (t) => {
  const { env } = freshRoot(t);
  assert.equal(siteThemeFile('../x', env), null);
  assert.equal(siteThemeFile('nope', env), null);
});

test('themeName: defaults to "default"', () => {
  assert.equal(themeName({}), 'default');
});

test('themeName: SITE_THEME=default resolves to default (round-trip)', () => {
  assert.equal(themeName({ SITE_THEME: 'default' }), 'default');
});

test('themeName: rejects unsafe names with a fallback to default', (t) => {
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

test('themeName: an unknown theme falls back to default with a warning', (t) => {
  const writes: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  assert.equal(themeName({ SITE_THEME: 'no-such-theme' }), 'default');
  assert.ok(writes.some((s) => s.includes('not found')));
});

test('themeName: memoises across calls in a process', () => {
  assert.equal(themeName({ SITE_THEME: 'default' }), 'default');
  assert.equal(themeName({ SITE_THEME: 'whatever-other' }), 'default');
});

test('themeName: file overrides SITE_THEME env', (t) => {
  const { root, env } = freshRoot(t);
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'site.json'), JSON.stringify({ theme: 'papermod' }));
  assert.equal(themeName({ ...env, SITE_THEME: 'default' }), 'papermod');
});

test('themeName: a settings write takes effect without a reset', (t) => {
  const { env } = freshRoot(t);
  assert.equal(themeName(env), 'default');
  writePersistedSiteConfig({ theme: 'papermod' }, env);
  assert.equal(themeName(env), 'papermod');
});

test('listAvailableThemes: default first, others sorted', () => {
  const themes = listAvailableThemes();
  assert.equal(themes[0], 'default');
  assert.ok(themes.includes('papermod'), 'papermod should be available');
  const rest = themes.slice(1);
  assert.deepEqual(rest, [...rest].sort());
});

test('themeFile: path for a bundled theme, null for unknown or unsafe names', () => {
  assert.match(themeFile('default') ?? '', /static\/themes\/default\.css$/);
  assert.equal(themeFile('no-such-theme'), null);
  assert.equal(themeFile('../config'), null);
});

test('sectionThemeNames reads the declaration comment; none → []', () => {
  assert.deepEqual(
    sectionThemeNames('a{}\n/* rkr-section-themes: forest, sky-blue ,Bad Name, sand */\nb{}'),
    ['forest', 'sky-blue', 'sand']
  );
  assert.deepEqual(sectionThemeNames(':root { --x: 1; }'), []);
  assert.deepEqual(sectionThemeNames('/* rkr-section-themes: */'), []);
});

test('activeSectionThemes lists light, light-bold, dark, dark-bold then theme extras', (t) => {
  const builtIns = ['light', 'light-bold', 'dark', 'dark-bold'];
  assert.deepEqual(activeSectionThemes({}), builtIns);

  const realRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', ((p: fs.PathOrFileDescriptor, ...rest: unknown[]) =>
    String(p).endsWith(`${path.sep}default.css`)
      ? '/* rkr-section-themes: forest, dark, sky */'
      : (realRead as (...a: unknown[]) => unknown)(p, ...rest)) as typeof fs.readFileSync);
  assert.deepEqual(activeSectionThemes({}), [...builtIns, 'forest', 'sky']);
});
