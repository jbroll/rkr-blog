import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { _resetGitHashCache } from '../../src/lib/build-info.ts';
import { _resetThemeNameCache } from '../../src/lib/config.ts';
import { bundleVersion, siteFoot, siteHead, stylesheetLinks } from '../../src/templates/layout.ts';

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

test('siteHead: anonymous visitor — no admin strip', () => {
  const html = siteHead({ title: 'My site', tagline: 'wat' });
  assert.match(html, /My site/);
  assert.match(html, /wat/);
  assert.ok(!html.includes('rkr-admin-strip'), 'admin strip must be absent');
});

test('siteHead: isAdmin on index — New post + Posts + Logout, no Edit', () => {
  const html = siteHead({ title: 'My site' }, { isAdmin: true });
  assert.match(html, /rkr-admin-strip/);
  assert.match(html, />New post</);
  assert.match(html, />Posts</);
  assert.match(html, /<button[^>]*>Logout</);
  assert.ok(!html.includes('Edit this post'), 'no edit link without currentSlug');
});

test('siteHead: isAdmin on a post — adds Edit this post with URL-encoded slug', () => {
  const html = siteHead({ title: 's' }, { isAdmin: true, currentSlug: 'hello world' });
  assert.match(html, />Edit this post</);
  assert.match(html, /href="\/admin\/editor\?slug=hello%20world"/);
});

test('siteFoot: anonymous visitor sees the discreet admin link', () => {
  const html = siteFoot({ title: 'My site' });
  assert.match(html, /href="\/admin\/login"/);
  assert.match(html, /My site/);
});

test('siteFoot: authed visitor does not see the admin link', () => {
  // The header already carries the admin strip (New post / Posts /
  // Logout); a second "Admin" link in the footer pointing at
  // /admin/login is noise + confusing (it suggests they're somehow
  // not logged in). The separator pipe disappears with the link so
  // the footer reads as a single line, not "© rkroll ·".
  const html = siteFoot({ title: 'My site' }, { isAdmin: true });
  assert.doesNotMatch(html, /\/admin\/login/);
  assert.doesNotMatch(html, /rkr-site-foot-admin/);
  assert.doesNotMatch(html, /rkr-site-foot-sep/);
});

test('stylesheetLinks: default theme loads base + default only', () => {
  const prev = process.env.SITE_THEME;
  delete process.env.SITE_THEME;
  try {
    const html = stylesheetLinks();
    assert.match(html, /\/static\/base\.css/);
    assert.match(html, /\/static\/themes\/default\.css/);
    // Default theme is already in the default.css path; no extra layer.
    assert.equal(html.match(/\/static\/themes\//g)?.length, 1);
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
