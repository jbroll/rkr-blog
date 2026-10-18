import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  fetchOneDriveFile,
  getOneDriveThumbnail,
  listOneDriveFolder
} from '../../src/lib/microsoft-graph.ts';

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

// ---- listOneDriveFolder --------------------------------------------------

test('listOneDriveFolder happy path', async () => {
  const fetcher = fixedFetcher(
    () =>
      new Response(
        JSON.stringify({
          value: [
            { id: 'f1', name: 'Photos', folder: {} },
            { id: 'img1', name: 'cat.jpg', file: { mimeType: 'image/jpeg' } },
            { id: 'doc1', name: 'notes.txt', file: { mimeType: 'text/plain' } }
          ],
          '@odata.nextLink': 'https://example.com/next'
        }),
        { headers: { 'content-type': 'application/json' } }
      )
  );
  const page = await listOneDriveFolder('tok', 'root', { fetcher });
  // text/plain should be filtered out; folder + jpeg remain
  assert.equal(page.items.length, 2);
  // folder sorts first
  const first = page.items[0];
  assert.ok(first);
  assert.equal(first.type, 'folder');
  assert.ok(page.nextLink !== null);
});

test('listOneDriveFolder uses subfolder URL', async () => {
  let capturedUrl = '';
  const fetcher = (async (url: string | URL) => {
    capturedUrl = typeof url === 'string' ? url : url.toString();
    return new Response(JSON.stringify({ value: [] }), {
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
  await listOneDriveFolder('tok', 'abc-folder', { fetcher });
  assert.match(capturedUrl, /\/items\/abc-folder\/children/);
});

test('listOneDriveFolder uses a graph.microsoft.com nextLink directly when provided', async () => {
  let capturedUrl = '';
  const fetcher = (async (url: string | URL) => {
    capturedUrl = typeof url === 'string' ? url : url.toString();
    return new Response(JSON.stringify({ value: [] }), {
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
  const nextLink = 'https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=abc';
  await listOneDriveFolder('tok', 'root', { fetcher, nextLink });
  assert.equal(capturedUrl, nextLink);
});

test('listOneDriveFolder rejects an unparseable nextLink', async () => {
  await assert.rejects(
    () =>
      listOneDriveFolder('tok', 'root', {
        nextLink: 'not a url',
        fetcher: async () => new Response('{}')
      }),
    /invalid.*nextLink/i
  );
});

test('listOneDriveFolder rejects a nextLink not on graph.microsoft.com', async () => {
  await assert.rejects(
    () =>
      listOneDriveFolder('tok', 'root', {
        nextLink: 'http://169.254.169.254/latest/meta-data/',
        fetcher: async () => new Response('{}')
      }),
    /unsafe|invalid.*nextLink|graph\.microsoft\.com/i
  );
});

test('listOneDriveFolder rejects a non-graph https host', async () => {
  await assert.rejects(
    () =>
      listOneDriveFolder('tok', 'root', {
        nextLink: 'https://evil.example.com/x',
        fetcher: async () => new Response('{}')
      }),
    /unsafe|invalid.*nextLink|graph\.microsoft\.com/i
  );
});

test('listOneDriveFolder accepts a real graph.microsoft.com nextLink', async () => {
  const r = await listOneDriveFolder('tok', 'root', {
    nextLink: 'https://graph.microsoft.com/v1.0/me/drive/items/x/children?$skiptoken=abc',
    fetcher: async () => new Response(JSON.stringify({ value: [] }))
  });
  assert.ok(r);
});

test('listOneDriveFolder throws on HTTP error', async () => {
  const fetcher = fixedFetcher(() => new Response('bad request', { status: 400 }));
  await assert.rejects(listOneDriveFolder('tok', 'root', { fetcher }), /Graph 400/);
});

const GRAPH_NEXT = 'https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=next';

test('listOneDriveFolder pages past an all-non-video first page in video mode', async () => {
  // Sparse-folder regression: a page of 50 images (or docs) filters down to
  // nothing in video mode. Without following the nextLink the picker shows
  // "No videos or folders here." while more videos exist.
  const urls: string[] = [];
  const fetcher = (async (url: string | URL) => {
    const u = url.toString();
    urls.push(u);
    if (u.includes('$skiptoken=')) {
      return new Response(
        JSON.stringify({
          value: [
            { id: 'fold1', name: 'Clips', folder: {} },
            { id: 'vid1', name: 'clip.mp4', file: { mimeType: 'video/mp4' } }
          ]
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({
        value: [
          { id: 'img1', name: 'photo.png', file: { mimeType: 'image/png' } },
          { id: 'doc1', name: 'notes.txt', file: { mimeType: 'text/plain' } }
        ],
        '@odata.nextLink': GRAPH_NEXT
      }),
      { headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch;

  const page = await listOneDriveFolder('tok', 'root', { fetcher, kind: 'video' });
  assert.deepEqual(
    page.items.map((i) => i.id),
    ['fold1', 'vid1']
  );
  assert.equal(page.nextLink, null);
  assert.equal(urls.length, 2);
});

test('listOneDriveFolder stops following empty pages after a bounded number of fetches', async () => {
  // Bound the eager paging: a folder with no matching media must not walk
  // the whole drive. The returned nextLink still lets the client page on.
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return new Response(
      JSON.stringify({
        value: [{ id: 'img1', name: 'photo.png', file: { mimeType: 'image/png' } }],
        '@odata.nextLink': `${GRAPH_NEXT}${calls}`
      }),
      { headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch;

  const page = await listOneDriveFolder('tok', 'root', { fetcher, kind: 'video' });
  assert.equal(page.items.length, 0);
  // nextLink of the last page fetched — page 6 for the client to continue.
  assert.equal(page.nextLink, `${GRAPH_NEXT}5`);
  assert.equal(calls, 5);
});

test('listOneDriveFolder does not follow nextLink when the page has matching items', async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return new Response(
      JSON.stringify({
        value: [{ id: 'img1', name: 'photo.png', file: { mimeType: 'image/png' } }],
        '@odata.nextLink': GRAPH_NEXT
      }),
      { headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch;

  const page = await listOneDriveFolder('tok', 'root', { fetcher });
  assert.equal(calls, 1);
  assert.equal(page.items.length, 1);
  assert.equal(page.nextLink, GRAPH_NEXT);
});

// ---- getOneDriveThumbnail ------------------------------------------------

test('getOneDriveThumbnail returns large URL', async () => {
  const fetcher = fixedFetcher(
    () =>
      new Response(
        JSON.stringify({
          large: { url: 'https://t.example.com/large' },
          medium: { url: 'https://t.example.com/medium' }
        }),
        { headers: { 'content-type': 'application/json' } }
      )
  );
  const url = await getOneDriveThumbnail('tok', 'item1', { fetcher });
  assert.equal(url, 'https://t.example.com/large');
});

test('getOneDriveThumbnail falls back to medium when large absent', async () => {
  const fetcher = fixedFetcher(
    () =>
      new Response(JSON.stringify({ medium: { url: 'https://t.example.com/medium' } }), {
        headers: { 'content-type': 'application/json' }
      })
  );
  const url = await getOneDriveThumbnail('tok', 'item1', { fetcher });
  assert.equal(url, 'https://t.example.com/medium');
});

test('getOneDriveThumbnail returns null on non-ok response', async () => {
  const fetcher = fixedFetcher(() => new Response('not found', { status: 404 }));
  const url = await getOneDriveThumbnail('tok', 'item1', { fetcher });
  assert.equal(url, null);
});
