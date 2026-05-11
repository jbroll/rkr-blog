import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { _resetGitHashCache } from '../../src/lib/build-info.ts';
import { bundleVersion, siteFoot, siteHead } from '../../src/templates/layout.ts';

// resolveGitHash() is process-cached, so each test that depends on a
// specific GIT_HASH env value must clear the cache afterwards or
// subsequent tests pick up the previous value.
afterEach(() => {
  _resetGitHashCache();
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

test('siteFoot: discreet admin link to /admin/login', () => {
  const html = siteFoot({ title: 'My site' });
  assert.match(html, /href="\/admin\/login"/);
  assert.match(html, /My site/);
});
