import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchDriveFile } from '../../src/lib/google-drive.ts';

function fixedFetcher(handler: (url: string) => Response): typeof fetch {
  return (async (url: string | URL) =>
    handler(typeof url === 'string' ? url : url.toString())) as typeof fetch;
}

test('fetchDriveFile happy path returns metadata + body', async () => {
  const body = Buffer.from('jpegbytes');
  const fetcher = fixedFetcher((url) => {
    if (url.includes('?fields=')) {
      return new Response(
        JSON.stringify({ id: 'fid', name: 'cat.jpg', mimeType: 'image/jpeg', size: body.length }),
        { headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(body, {
      headers: { 'content-type': 'image/jpeg', 'content-length': String(body.length) }
    });
  });
  const r = await fetchDriveFile('tok', 'fid', { fetcher });
  assert.equal(r.file.name, 'cat.jpg');
  assert.equal(r.contentType, 'image/jpeg');
  assert.equal(r.contentLength, body.length);
});

test('fetchDriveFile throws on metadata HTTP error', async () => {
  const fetcher = fixedFetcher(() => new Response('boom', { status: 500 }));
  await assert.rejects(fetchDriveFile('tok', 'fid', { fetcher }), /metadata: HTTP 500/);
});

test('fetchDriveFile throws on media HTTP error', async () => {
  const fetcher = fixedFetcher((url) => {
    if (url.includes('?fields=')) {
      return new Response(JSON.stringify({ id: 'fid', name: 'x', mimeType: 'image/jpeg' }), {
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response('forbidden', { status: 403 });
  });
  await assert.rejects(fetchDriveFile('tok', 'fid', { fetcher }), /media: HTTP 403/);
});

test('fetchDriveFile throws when media response has no body', async () => {
  // Construct a Response with null body — happens for HEAD-style or 204.
  const fetcher = fixedFetcher((url) => {
    if (url.includes('?fields=')) {
      return new Response(JSON.stringify({ id: 'fid', name: 'x', mimeType: 'image/jpeg' }), {
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(null, { status: 204 });
  });
  await assert.rejects(fetchDriveFile('tok', 'fid', { fetcher }), /empty body/);
});

test('fetchDriveFile falls back to file.mimeType when response lacks content-type', async () => {
  const body = Buffer.from('x');
  const fetcher = fixedFetcher((url) => {
    if (url.includes('?fields=')) {
      return new Response(JSON.stringify({ id: 'fid', name: 'x', mimeType: 'image/png' }), {
        headers: { 'content-type': 'application/json' }
      });
    }
    // No content-type header on the media response.
    return new Response(body);
  });
  const r = await fetchDriveFile('tok', 'fid', { fetcher });
  assert.equal(r.contentType, 'image/png');
});
