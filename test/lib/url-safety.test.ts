import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertSafeFetchUrl, safeFetch, UnsafeUrlError } from '../../src/lib/url-safety.ts';

// ---- assertSafeFetchUrl: scheme + port + IP-range checks ---------------
//
// IP literals skip DNS lookup, so these tests are hermetic.

test('rejects non-http(s) schemes', async () => {
  await assert.rejects(() => assertSafeFetchUrl('file:///etc/passwd'), UnsafeUrlError);
  await assert.rejects(() => assertSafeFetchUrl('gopher://example.com/'), UnsafeUrlError);
  await assert.rejects(() => assertSafeFetchUrl('ftp://example.com/'), UnsafeUrlError);
});

test('rejects malformed URLs', async () => {
  await assert.rejects(() => assertSafeFetchUrl('not a url'), UnsafeUrlError);
});

test('rejects non-default ports', async () => {
  await assert.rejects(() => assertSafeFetchUrl('http://1.1.1.1:8080/'), /non-default port/);
  await assert.rejects(() => assertSafeFetchUrl('https://1.1.1.1:8443/'), /non-default port/);
});

test('rejects loopback IPv4 (127.0.0.1, AWS metadata, link-local)', async () => {
  await assert.rejects(() => assertSafeFetchUrl('http://127.0.0.1/'), /restricted range/);
  await assert.rejects(() => assertSafeFetchUrl('http://169.254.169.254/'), /restricted range/);
  await assert.rejects(() => assertSafeFetchUrl('http://10.0.0.1/'), /restricted range/);
  await assert.rejects(() => assertSafeFetchUrl('http://192.168.1.1/'), /restricted range/);
  await assert.rejects(() => assertSafeFetchUrl('http://172.16.5.5/'), /restricted range/);
});

test('rejects loopback / unique-local / link-local IPv6', async () => {
  await assert.rejects(() => assertSafeFetchUrl('http://[::1]/'), /restricted range/);
  await assert.rejects(() => assertSafeFetchUrl('http://[fe80::1]/'), /restricted range/);
  await assert.rejects(() => assertSafeFetchUrl('http://[fc00::1]/'), /restricted range/);
});

test('rejects IPv4-mapped IPv6 pointing at loopback', async () => {
  // ::ffff:127.0.0.1 — would pass an IPv6-only check but is really 127.0.0.1
  await assert.rejects(() => assertSafeFetchUrl('http://[::ffff:7f00:1]/'), /restricted range/);
});

test('rejects multicast and reserved ranges', async () => {
  await assert.rejects(() => assertSafeFetchUrl('http://224.0.0.1/'), /restricted range/);
  await assert.rejects(() => assertSafeFetchUrl('http://0.0.0.0/'), /restricted range/);
});

test('accepts a public IPv4 literal on default port', async () => {
  // 1.1.1.1 (Cloudflare DNS) is public-routable. We don't hit it; we
  // just validate the URL through the safety check.
  const url = await assertSafeFetchUrl('http://1.1.1.1/');
  assert.equal(url.hostname, '1.1.1.1');
});

test('accepts a public IPv6 literal on default port', async () => {
  const url = await assertSafeFetchUrl('https://[2606:4700:4700::1111]/');
  assert.equal(url.hostname, '[2606:4700:4700::1111]');
});

// ---- safeFetch: redirect handling --------------------------------------

test('safeFetch follows valid redirects across hops', async () => {
  let hop = 0;
  const fetcher: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    hop++;
    if (hop === 1) {
      assert.match(url, /^http:\/\/1\.1\.1\.1\//);
      return new Response(null, { status: 302, headers: { location: 'http://8.8.8.8/' } });
    }
    if (hop === 2) {
      assert.match(url, /^http:\/\/8\.8\.8\.8\//);
      return new Response('ok', { status: 200 });
    }
    throw new Error(`unexpected hop ${hop}`);
  };
  const res = await safeFetch('http://1.1.1.1/', { fetcher });
  assert.equal(res.status, 200);
  assert.equal(hop, 2);
});

test('safeFetch rejects a redirect to a private IP', async () => {
  const fetcher: typeof fetch = async () =>
    new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
  await assert.rejects(() => safeFetch('http://1.1.1.1/', { fetcher }), /restricted range/);
});

test('safeFetch caps at maxRedirects', async () => {
  const fetcher: typeof fetch = async () =>
    new Response(null, { status: 302, headers: { location: 'http://1.1.1.1/' } });
  await assert.rejects(
    () => safeFetch('http://1.1.1.1/', { fetcher, maxRedirects: 2 }),
    /too many redirects/
  );
});

test('safeFetch rejects a redirect with no Location header', async () => {
  const fetcher: typeof fetch = async () => new Response(null, { status: 302 });
  await assert.rejects(() => safeFetch('http://1.1.1.1/', { fetcher }), /without Location/);
});
