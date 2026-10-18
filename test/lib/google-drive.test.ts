import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchDriveFile, listDriveFolder } from '../../src/lib/google-drive.ts';

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

const FOLDER_MIME = 'application/vnd.google-apps.folder';

function listFixture() {
  return {
    files: [
      { id: 'img-1', name: 'photo.jpg', mimeType: 'image/jpeg', thumbnailLink: 'https://th/photo' },
      { id: 'vid-1', name: 'clip.mp4', mimeType: 'video/mp4' },
      { id: 'fld-1', name: 'Photos', mimeType: FOLDER_MIME }
    ]
  };
}

test('listDriveFolder image mode keeps image files + folders, drops videos', async () => {
  const fetcher = fixedFetcher(
    () =>
      new Response(JSON.stringify(listFixture()), {
        headers: { 'content-type': 'application/json' }
      })
  );
  const page = await listDriveFolder('tok', 'root', { fetcher });
  assert.deepEqual(
    page.items.map((i) => i.id),
    ['fld-1', 'img-1']
  );
  assert.equal(page.items.find((i) => i.id === 'fld-1')?.type, 'folder');
  assert.equal(page.nextPageToken, null);
});

test('listDriveFolder video mode keeps video files + folders, drops images', async () => {
  const fetcher = fixedFetcher(
    () =>
      new Response(JSON.stringify(listFixture()), {
        headers: { 'content-type': 'application/json' }
      })
  );
  const page = await listDriveFolder('tok', 'root', { fetcher, kind: 'video' });
  assert.deepEqual(
    page.items.map((i) => i.id),
    ['fld-1', 'vid-1']
  );
});

test('listDriveFolder queries the given folder and excludes trashed', async () => {
  const seen: string[] = [];
  const fetcher = fixedFetcher((url) => {
    seen.push(url);
    return new Response(JSON.stringify({ files: [] }), {
      headers: { 'content-type': 'application/json' }
    });
  });
  await listDriveFolder('tok', 'folder-9', { fetcher });
  const q = new URL(seen[0] ?? '').searchParams.get('q') ?? '';
  assert.match(q, /'folder-9' in parents/);
  assert.match(q, /trashed = false/);
  await listDriveFolder('tok', 'root', { fetcher });
  assert.match(new URL(seen[1] ?? '').searchParams.get('q') ?? '', /'root' in parents/);
});

test('listDriveFolder passes pageToken and surfaces nextPageToken', async () => {
  const seen: string[] = [];
  const fetcher = fixedFetcher((url) => {
    seen.push(url);
    return new Response(JSON.stringify({ files: [], nextPageToken: 'tok2' }), {
      headers: { 'content-type': 'application/json' }
    });
  });
  const page = await listDriveFolder('tok', 'root', { fetcher, pageToken: 'p2' });
  assert.match(seen[0] ?? '', /pageToken=p2/);
  assert.equal(page.nextPageToken, 'tok2');
});

test('listDriveFolder surfaces thumbnailLink as thumbnailUrl', async () => {
  const fetcher = fixedFetcher(
    () =>
      new Response(JSON.stringify(listFixture()), {
        headers: { 'content-type': 'application/json' }
      })
  );
  const page = await listDriveFolder('tok', 'root', { fetcher });
  assert.equal(page.items.find((i) => i.id === 'img-1')?.thumbnailUrl, 'https://th/photo');
});

test('listDriveFolder throws on HTTP error', async () => {
  const fetcher = fixedFetcher(() => new Response('boom', { status: 500 }));
  await assert.rejects(listDriveFolder('tok', 'root', { fetcher }), /drive list: HTTP 500/);
});
