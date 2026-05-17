import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { _resetGitHashCache } from '../../src/lib/build-info.ts';
import { _resetThemeNameCache } from '../../src/lib/config.ts';
import {
  bundleVersion,
  indexAdminFabs,
  postAdminFab,
  siteFoot,
  siteHead,
  stylesheetLinks
} from '../../src/templates/layout.ts';

// resolveGitHash() + themeName() are process-cached; reset between
// tests that probe env-driven branches.
afterEach(() => {
  _resetGitHashCache();
  _resetThemeNameCache();
});

test('bundleVersion: ?v=<12-char short hash> when GIT_HASH is set', () => {
  const prev = process.env.GIT_HASH;
  process.env.GIT_HASH = 'abcdef0123456789abcdef0123456789abcdef01';
  try {
    assert.equal(bundleVersion(), '?v=abcdef012345');
  } finally {
    if (prev === undefined) delete process.env.GIT_HASH;
    else process.env.GIT_HASH = prev;
  }
});

test('bundleVersion: produces a stable ?v= suffix per process', () => {
  // Whatever the resolver returns (real hash from .git or 'unknown'),
  // two calls in the same process return the same string. That's the
  // SW-caching contract: one deploy = one cache key.
  assert.equal(bundleVersion(), bundleVersion());
});

test('siteHead: anonymous visitor sees Login link in the header', () => {
  const html = siteHead({ title: 'My site', tagline: 'wat' });
  assert.match(html, /My site/);
  assert.match(html, /wat/);
  assert.match(html, /href="\/login"/);
  assert.match(html, />Login</);
  assert.ok(!html.includes('Logout'), 'no Logout for anonymous visitors');
  assert.ok(!html.includes('rkr-admin-strip'), 'admin strip must be absent');
  assert.ok(!html.includes('New post'), 'New post moved to a FAB');
});

test('siteHead: authed visitor sees a POST-form Logout button in the header', () => {
  const html = siteHead({ title: 'My site', tagline: 'wat' }, { isAdmin: true });
  assert.match(html, /My site/);
  assert.match(html, /<form [^>]*method="post" [^>]*action="\/admin\/logout"/);
  assert.match(html, /<button[^>]*>Logout</);
  assert.ok(!html.includes('href="/login"'), 'no Login link when authed');
  assert.ok(!html.includes('rkr-admin-strip'), 'admin strip must be absent');
});

test('siteFoot: renders copyright line without auth links', () => {
  const anon = siteFoot({ title: 'My site' });
  const auth = siteFoot({ title: 'My site' }, { isAdmin: true });
  for (const html of [anon, auth]) {
    assert.match(html, /My site/);
    assert.ok(!html.includes('Login'), 'Login is in the header now');
    assert.ok(!html.includes('Logout'), 'Logout is in the header now');
  }
});

test('indexAdminFabs: renders New post, Settings and Comments-moderation anchors', () => {
  const html = indexAdminFabs();
  assert.match(
    html,
    /class="rkr-fab[^"]*"[^>]*href="\/admin\/editor\?new=1"[^>]*aria-label="New post"/
  );
  assert.match(html, /class="rkr-fab[^"]*"[^>]*href="\/admin\/settings"[^>]*aria-label="Settings"/);
  assert.match(
    html,
    /class="rkr-fab[^"]*"[^>]*href="\/admin\/comments"[^>]*aria-label="Moderate comments"/
  );
});

test('postAdminFab: pencil FAB carries the URL-encoded slug', () => {
  const html = postAdminFab('hello world');
  assert.match(html, /aria-label="Edit this post"/);
  assert.match(html, /href="\/admin\/editor\?slug=hello%20world"/);
});

test('stylesheetLinks: default theme loads base + default only, prefixed by color-scheme meta', () => {
  const prev = process.env.SITE_THEME;
  delete process.env.SITE_THEME;
  try {
    const html = stylesheetLinks();
    assert.match(html, /\/static\/base\.css/);
    assert.match(html, /\/static\/themes\/default\.css/);
    // Default theme is already in the default.css path; no extra layer.
    assert.equal(html.match(/\/static\/themes\//g)?.length, 1);
    // color-scheme meta sits ahead of the link tags so dark-mode
    // visitors don't see a white canvas during the brief window
    // before the external stylesheets parse — see stylesheetLinks's
    // doc comment for the SW-bypass story this defends against.
    assert.match(html, /<meta name="color-scheme" content="light dark"[^>]*>[\s\S]*<link/);
  } finally {
    if (prev !== undefined) process.env.SITE_THEME = prev;
  }
});

test('stylesheetLinks: alternate theme layers on top of default', () => {
  const prev = process.env.SITE_THEME;
  process.env.SITE_THEME = 'papermod';
  try {
    const html = stylesheetLinks();
    assert.match(html, /\/static\/base\.css/);
    assert.match(html, /\/static\/themes\/default\.css/);
    assert.match(html, /\/static\/themes\/papermod\.css/);
    // Cascade order: default first, theme last.
    const defaultIdx = html.indexOf('/static/themes/default.css');
    const themeIdx = html.indexOf('/static/themes/papermod.css');
    assert.ok(defaultIdx < themeIdx, 'default must come before the active theme');
  } finally {
    if (prev !== undefined) process.env.SITE_THEME = prev;
    else delete process.env.SITE_THEME;
  }
});

test('siteHead: emits Home + About nav and the correct auth control', () => {
  const anon = siteHead({ title: 'S' });
  assert.match(anon, /<nav class="rkr-site-head-nav"[^>]*>/);
  assert.match(anon, /href="\/"[^>]*>Home</);
  assert.match(anon, /href="\/about"[^>]*>About</);
  assert.match(anon, /href="\/login"/);
  assert.doesNotMatch(anon, /\/admin\/logout/);

  const admin = siteHead({ title: 'S' }, { isAdmin: true });
  assert.match(admin, /href="\/about"[^>]*>About</);
  assert.match(admin, /action="\/admin\/logout"/);
});
