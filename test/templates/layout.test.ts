import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderBlocksPage } from '../../src/templates/blocks.ts';
import { renderIndexPage } from '../../src/templates/index.ts';
import {
  bundleVersion,
  indexAdminFabs,
  postAdminFab,
  renderSearchForm,
  siteFoot,
  siteHead,
  stylesheetLinks
} from '../../src/templates/layout.ts';
import { renderNotFoundPage } from '../../src/templates/not-found.ts';
import { renderPostPage } from '../../src/templates/post.ts';
import { renderSearchPage } from '../../src/templates/search.ts';

const assets = { theme: 'default', hash: 'abcdef012345', base: '/static' };

test('renderSearchForm is a no-JS GET form with escaped, prefilled q', () => {
  const html = renderSearchForm('a "b" <x>');
  assert.match(html, /<form[^>]*action="\/search"/);
  assert.match(html, /method="get"/);
  assert.match(html, /name="q"/);
  assert.match(html, /value="a &quot;b&quot; &lt;x&gt;"/);
});

test('renderSearchForm value is empty when no query given', () => {
  assert.match(renderSearchForm(), /value=""/);
});

test('bundleVersion: ?v=<hash> from the given AssetCtx', () => {
  assert.equal(bundleVersion(assets), '?v=abcdef012345');
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

test('siteFoot: copyright line plus an admin link that points by sign-in state', () => {
  const anon = siteFoot({ title: 'My site' });
  const auth = siteFoot({ title: 'My site' }, { isAdmin: true });
  for (const html of [anon, auth]) {
    assert.match(html, /My site/);
    assert.ok(!html.includes('Logout'), 'Logout is in the header');
  }
  assert.match(anon, /<a class="rkr-site-foot-admin" href="\/login">Admin<\/a>/);
  assert.match(auth, /<a class="rkr-site-foot-admin" href="\/admin\/blocks">Admin<\/a>/);
});

test('siteFoot: footerHtml replaces the copyright line and keeps the admin link', () => {
  const html = siteFoot({ title: 'My site' }, { footerHtml: '<p>Join us</p>' });
  assert.match(
    html,
    /^<footer class="rkr-site-foot"><p>Join us<\/p><a class="rkr-site-foot-admin"/
  );
  assert.ok(!html.includes('&copy;'));
});

test('indexAdminFabs: renders New page, Settings and Comments-moderation anchors', () => {
  const html = indexAdminFabs();
  assert.match(
    html,
    /class="rkr-fab[^"]*"[^>]*href="\/admin\/blocks\/new"[^>]*aria-label="New page"/
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
  assert.match(html, /href="\/admin\/blocks\/edit\/hello%20world"/);
});

test('stylesheetLinks: default theme loads base + default only, prefixed by color-scheme meta', () => {
  const html = stylesheetLinks(assets);
  assert.match(html, /\/static\/base\.css/);
  assert.match(html, /\/static\/themes\/default\.css/);
  // Default theme is already in the default.css path; no extra layer.
  assert.equal(html.match(/\/static\/themes\//g)?.length, 1);
  // color-scheme meta sits ahead of the link tags so dark-mode
  // visitors don't see a white canvas during the brief window
  // before the external stylesheets parse — see stylesheetLinks's
  // doc comment for the SW-bypass story this defends against.
  assert.match(html, /<meta name="color-scheme" content="light dark"[^>]*>[\s\S]*<link/);
});

test('stylesheetLinks: themeHref replaces the bundled theme path', () => {
  const html = stylesheetLinks({
    ...assets,
    theme: 'club',
    themeHref: '/site-theme/club.css'
  });
  assert.match(html, /href="\/site-theme\/club\.css\?v=abcdef012345"/);
  assert.doesNotMatch(html, /themes\/club\.css/);
});

test('stylesheetLinks: alternate theme layers on top of default', () => {
  const html = stylesheetLinks({ ...assets, theme: 'papermod' });
  assert.match(html, /\/static\/base\.css/);
  assert.match(html, /\/static\/themes\/default\.css/);
  assert.match(html, /\/static\/themes\/papermod\.css/);
  // Cascade order: default first, theme last.
  const defaultIdx = html.indexOf('/static/themes/default.css');
  const themeIdx = html.indexOf('/static/themes/papermod.css');
  assert.ok(defaultIdx < themeIdx, 'default must come before the active theme');
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

test('siteHead: hideHomeLink omits the Home link but keeps About', () => {
  const html = siteHead({ title: 'S' }, { hideHomeLink: true });
  assert.doesNotMatch(html, /href="\/"[^>]*>Home</);
  assert.match(html, /href="\/about"[^>]*>About</);
});

const MENU = [
  { label: 'About us', href: '/about-us' },
  { label: 'Evil', href: 'javascript:alert(1)' },
  { label: 'Shop & <b>', href: 'https://shop.example/' }
];

test('siteHead without menu is unchanged by the rest of the header settings', () => {
  const site = { title: 'S', tagline: 't' };
  const plain = siteHead(site, { buildHash: 'abc', assets });
  const chrome = {
    logoHtml: '<picture>logo</picture>',
    cta: { label: 'Join', href: '/join' },
    social: [{ platform: 'facebook' as const, url: 'https://facebook.com/x' }]
  };
  assert.equal(siteHead(site, { buildHash: 'abc', assets, chrome }), plain);
  assert.equal(siteHead(site, { buildHash: 'abc', assets, chrome: {} }), plain);
});

test('siteHead with menu: items in order, no Home/About/Login, unsafe href neutralized', () => {
  const html = siteHead({ title: 'S' }, { chrome: { menu: MENU } });
  assert.doesNotMatch(html, /href="\/login"/);
  assert.doesNotMatch(html, />Home</);
  assert.doesNotMatch(html, /href="\/about"/);
  assert.doesNotMatch(html, /javascript:/);
  const hrefs = [...html.matchAll(/class="rkr-site-menu-link" href="([^"]*)">([^<]*)</g)].map(
    (m) => [m[1], m[2]]
  );
  assert.deepEqual(hrefs, [
    ['/about-us', 'About us'],
    ['#', 'Evil'],
    ['https://shop.example/', 'Shop &amp; &lt;b&gt;']
  ]);
  assert.match(html, /<input [^>]*type="checkbox"[^>]*id="rkr-menu-toggle"/);
  assert.match(html, /<label [^>]*for="rkr-menu-toggle"/);
  assert.match(html, /<p class="rkr-site-title"><a href="\/">S<\/a><\/p>/);
});

test('siteHead with menu: signed-in admin still gets the Logout form', () => {
  const html = siteHead({ title: 'S' }, { isAdmin: true, assets, chrome: { menu: MENU } });
  assert.match(html, /<form [^>]*method="post" [^>]*action="\/admin\/logout"/);
  assert.match(html, /\/static\/site\/signout\.js/);
  assert.doesNotMatch(html, /href="\/login"/);
});

test('siteHead with menu: logo, CTA button and social icons with safe hrefs', () => {
  const html = siteHead(
    { title: 'Club <1>' },
    {
      chrome: {
        menu: MENU,
        logoHtml: '<picture><img src="/img/x" alt=""/></picture>',
        cta: { label: 'Donate', href: 'javascript:void(0)' },
        social: [
          { platform: 'instagram', url: 'https://instagram.com/x' },
          { platform: 'email', url: 'mailto:hi@example.org' }
        ]
      }
    }
  );
  assert.match(html, /<a href="\/" aria-label="Club &lt;1&gt;"><picture>/);
  assert.match(html, /<a class="rkr-btn rkr-site-head-cta" href="#">Donate<\/a>/);
  assert.match(html, /href="https:\/\/instagram\.com\/x" aria-label="Instagram"[^>]*><svg/);
  assert.match(html, /href="mailto:hi@example\.org" aria-label="Email"[^>]*><svg/);
});

test('announcement: off or empty renders nothing; on renders a bar above the header', () => {
  const plain = siteHead({ title: 'S' }, { assets });
  const off = siteHead(
    { title: 'S' },
    { assets, chrome: { announcement: { text: 'Hi', on: false } } }
  );
  assert.equal(off, plain);
  const on = siteHead(
    { title: 'S' },
    { assets, chrome: { announcement: { text: 'Big <news>', href: '/news', on: true } } }
  );
  assert.ok(on.indexOf('rkr-announce') < on.indexOf('<header'), 'bar sits above the header');
  assert.match(on, /<div class="rkr-announce" data-rkr-announce="[0-9a-f]{16}">/);
  assert.match(on, /<a href="\/news">Big &lt;news&gt;<\/a>/);
  assert.match(on, /<button type="button" class="rkr-announce-close"[^>]*hidden/);
  assert.match(on, /\/static\/site\/announcement\.js\?v=abcdef012345/);
  const other = siteHead(
    { title: 'S' },
    { assets, chrome: { announcement: { text: 'Other', on: true } } }
  );
  const key = (h: string) => h.match(/data-rkr-announce="([^"]*)"/)?.[1];
  assert.notEqual(key(on), key(other), 'a new text gets a new key');
  assert.match(other, /<p class="rkr-announce-text">Other<\/p>/);
});

test('every public template passes chrome through to the header', () => {
  const base = { site: { title: 'rkroll' }, assets, chrome: { menu: MENU } };
  const pages = [
    renderNotFoundPage(base),
    renderPostPage({ ...base, title: 'T', slug: 't', bodyHtml: '' }),
    renderIndexPage({ ...base, posts: [], page: 1, totalPages: 1 }),
    renderSearchPage({ ...base, q: '', results: [] }),
    renderBlocksPage({ ...base, title: 'T', bodyHtml: '' })
  ];
  for (const html of pages) assert.match(html, /rkr-site-menu-link/);
});

test('renderNotFoundPage: anonymous view uses sw-unregister.js, not sw-register.js', () => {
  const html = renderNotFoundPage({ site: { title: 'rkroll' }, assets });
  assert.match(html, /\/static\/site\/sw-unregister\.js/);
  assert.doesNotMatch(html, /\/static\/site\/sw-register\.js/);
});

test('renderNotFoundPage: admin view also uses sw-unregister.js', () => {
  const html = renderNotFoundPage({ site: { title: 'rkroll' }, isAdmin: true, assets });
  assert.match(html, /\/static\/site\/sw-unregister\.js/);
  assert.doesNotMatch(html, /\/static\/site\/sw-register\.js/);
});
