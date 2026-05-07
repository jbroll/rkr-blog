import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchOneDriveFile } from '../../src/lib/microsoft-graph.ts';

function fixedFetcher(handler: (url: string) => Response): typeof fetch {
  return (async (url: string | URL) =>
    handler(typeof url === 'string' ? url : url.toString())) as typeof fetch;
}

test('fetchOneDriveFile happy path returns metadata + body', async () => {
  const body = Buffer.from('jpegbytes');
  const fetcher = fixedFetcher((url) => {
    if (url.endsWith('/content')) {
      return new Response(body, {
        headers: { 'content-type': 'image/jpeg', 'content-length': String(body.length) }
      });
    }
    return new Response(
      JSON.stringify({
        id: 'ms-id',
        name: 'cat.jpg',
        size: body.length,
        file: { mimeType: 'image/jpeg' }
      }),
      { headers: { 'content-type': 'application/json' } }
    );
  });
  const r = await fetchOneDriveFile('tok', 'ms-id', { fetcher });
  assert.equal(r.file.name, 'cat.jpg');
  assert.equal(r.file.mimeType, 'image/jpeg');
  assert.equal(r.contentType, 'image/jpeg');
  assert.equal(r.contentLength, body.length);
});

test('fetchOneDriveFile throws on metadata HTTP error', async () => {
  const fetcher = fixedFetcher(() => new Response('boom', { status: 500 }));
  await assert.rejects(fetchOneDriveFile('tok', 'ms-id', { fetcher }), /metadata: HTTP 500/);
});

test('fetchOneDriveFile throws when metadata is missing required fields', async () => {
  const fetcher = fixedFetcher(
    () =>
      new Response(JSON.stringify({ id: 'ms-id' /* no name */ }), {
        headers: { 'content-type': 'application/json' }
      })
  );
  await assert.rejects(fetchOneDriveFile('tok', 'ms-id', { fetcher }), /missing id or name/);
});

test('fetchOneDriveFile throws on /content HTTP error', async () => {
  const fetcher = fixedFetcher((url) => {
    if (url.endsWith('/content')) return new Response('forbidden', { status: 403 });
    return new Response(
      JSON.stringify({ id: 'ms-id', name: 'x', file: { mimeType: 'image/jpeg' } }),
      { headers: { 'content-type': 'application/json' } }
    );
  });
  await assert.rejects(fetchOneDriveFile('tok', 'ms-id', { fetcher }), /media: HTTP 403/);
});

test('fetchOneDriveFile throws when /content has no body', async () => {
  const fetcher = fixedFetcher((url) => {
    if (url.endsWith('/content')) return new Response(null, { status: 204 });
    return new Response(
      JSON.stringify({ id: 'ms-id', name: 'x', file: { mimeType: 'image/jpeg' } }),
      { headers: { 'content-type': 'application/json' } }
    );
  });
  await assert.rejects(fetchOneDriveFile('tok', 'ms-id', { fetcher }), /empty body/);
});

test('fetchOneDriveFile falls back to file.mimeType when /content omits content-type', async () => {
  const body = Buffer.from('x');
  const fetcher = fixedFetcher((url) => {
    if (url.endsWith('/content')) return new Response(body);
    return new Response(
      JSON.stringify({ id: 'ms-id', name: 'x', file: { mimeType: 'image/png' } }),
      { headers: { 'content-type': 'application/json' } }
    );
  });
  const r = await fetchOneDriveFile('tok', 'ms-id', { fetcher });
  assert.equal(r.contentType, 'image/png');
});

test('fetchOneDriveFile defaults mimeType to octet-stream when metadata lacks a file block', async () => {
  // Some OneDrive items (folders, shortcuts) don't have a `file` block.
  // The wrapper still returns a sensible default so the caller's
  // content-type allowlist does the gatekeeping.
  const body = Buffer.from('x');
  const fetcher = fixedFetcher((url) => {
    if (url.endsWith('/content')) return new Response(body);
    return new Response(JSON.stringify({ id: 'ms-id', name: 'x' }), {
      headers: { 'content-type': 'application/json' }
    });
  });
  const r = await fetchOneDriveFile('tok', 'ms-id', { fetcher });
  assert.equal(r.file.mimeType, 'application/octet-stream');
});
