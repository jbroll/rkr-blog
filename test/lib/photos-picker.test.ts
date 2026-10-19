import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createPickingSession,
  deletePickingSession,
  getPickingSession,
  listSessionMediaItems,
  PHOTOS_PICKER_SCOPE
} from '../../src/lib/photos-picker.ts';

function fixedFetcher(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) =>
    handler(typeof url === 'string' ? url : url.toString(), init)) as typeof fetch;
}

test('PHOTOS_PICKER_SCOPE is the picker readonly scope', () => {
  assert.equal(
    PHOTOS_PICKER_SCOPE,
    'https://www.googleapis.com/auth/photospicker.mediaitems.readonly'
  );
});

test('createPickingSession maps id/pickerUri/pollingConfig', async () => {
  const seen: string[] = [];
  const fetcher = fixedFetcher((url) => {
    seen.push(url);
    return new Response(
      JSON.stringify({
        id: 'sess-1',
        pickerUri: 'https://photos.google.com/picker/abc',
        pollingConfig: { pollInterval: '5s', timeoutIn: '600s' }
      }),
      { headers: { 'content-type': 'application/json' } }
    );
  });
  const s = await createPickingSession('tok', { fetcher });
  assert.match(seen[0] ?? '', /photospicker\.googleapis\.com\/v1\/sessions$/);
  assert.equal(s.sessionId, 'sess-1');
  assert.equal(s.pickerUri, 'https://photos.google.com/picker/abc');
  assert.equal(s.pollIntervalMs, 5000);
  assert.equal(s.timeoutMs, 600000);
});

test('createPickingSession falls back on missing or malformed pollingConfig', async () => {
  const forConfig = (pollingConfig: unknown) =>
    fixedFetcher(
      () =>
        new Response(JSON.stringify({ id: 's', pickerUri: 'https://p', pollingConfig }), {
          headers: { 'content-type': 'application/json' }
        })
    );
  const missing = await createPickingSession('tok', { fetcher: forConfig(undefined) });
  assert.equal(missing.pollIntervalMs, 5000);
  assert.equal(missing.timeoutMs, 600000);
  const garbage = await createPickingSession('tok', {
    fetcher: forConfig({ pollInterval: 'soon', timeoutIn: '' })
  });
  assert.equal(garbage.pollIntervalMs, 5000);
  assert.equal(garbage.timeoutMs, 600000);
});

test('getPickingSession reports done only when mediaItemsSet is true', async () => {
  const forDone = (done: boolean) =>
    fixedFetcher(
      () =>
        new Response(JSON.stringify({ id: 'sess-1', mediaItemsSet: done }), {
          headers: { 'content-type': 'application/json' }
        })
    );
  assert.equal((await getPickingSession('tok', 'sess-1', { fetcher: forDone(true) })).done, true);
  assert.equal((await getPickingSession('tok', 'sess-1', { fetcher: forDone(false) })).done, false);
});

function mediaItemsFixture() {
  return {
    mediaItems: [
      {
        id: 'mi-1',
        mediaFile: {
          baseUrl: 'https://lh3.googleusercontent.com/base1',
          filename: 'beach.jpg',
          mimeType: 'image/jpeg',
          mediaFileMetadata: { width: '4000', height: '3000' }
        }
      },
      {
        id: 'mi-2',
        mediaFile: {
          baseUrl: 'https://lh3.googleusercontent.com/base2',
          filename: 'clip.mp4',
          mimeType: 'video/mp4',
          mediaFileMetadata: { width: '1920', height: '1080', video: {} }
        }
      }
    ],
    nextPageToken: 'np2'
  };
}

test('listSessionMediaItems maps photo + video items with thumb/download URLs', async () => {
  const fetcher = fixedFetcher(
    () =>
      new Response(JSON.stringify(mediaItemsFixture()), {
        headers: { 'content-type': 'application/json' }
      })
  );
  const page = await listSessionMediaItems('tok', 'sess-1', { fetcher });
  assert.equal(page.items.length, 2);
  const photo = page.items.find((i) => i.id === 'mi-1');
  assert.equal(photo?.name, 'beach.jpg');
  assert.equal(photo?.mimeType, 'image/jpeg');
  assert.equal(photo?.kind, 'image');
  assert.equal(photo?.thumbnailUrl, 'https://lh3.googleusercontent.com/base1=w256-h256');
  assert.equal(photo?.downloadUrl, 'https://lh3.googleusercontent.com/base1=d');
  assert.equal(page.items.find((i) => i.id === 'mi-2')?.kind, 'video');
  assert.equal(page.nextPageToken, 'np2');
});

test('listSessionMediaItems forwards pageToken', async () => {
  const seen: string[] = [];
  const fetcher = fixedFetcher((url) => {
    seen.push(url);
    return new Response(JSON.stringify({ mediaItems: [] }), {
      headers: { 'content-type': 'application/json' }
    });
  });
  await listSessionMediaItems('tok', 'sess-1', { fetcher, pageToken: 'pt9' });
  assert.match(seen[0] ?? '', /\/v1\/mediaItems\?/);
  assert.match(seen[0] ?? '', /sessionId=sess-1/);
  assert.match(seen[0] ?? '', /pageToken=pt9/);
});

for (const [op, fn] of [
  ['create', () => createPickingSession('tok', { fetcher: failingFetcher(500) })],
  ['poll', () => getPickingSession('tok', 'sess-1', { fetcher: failingFetcher(500) })],
  ['list', () => listSessionMediaItems('tok', 'sess-1', { fetcher: failingFetcher(500) })],
  ['delete', () => deletePickingSession('tok', 'sess-1', { fetcher: failingFetcher(500) })]
] as const) {
  test(`photos ${op} throws on HTTP error`, async () => {
    await assert.rejects(fn(), new RegExp(`photos ${op}: HTTP 500`));
  });
}

function failingFetcher(status: number): typeof fetch {
  return fixedFetcher(() => new Response('boom', { status }));
}

test('listSessionMediaItems drops malformed and non-media rows', async () => {
  const fetcher = fixedFetcher(
    () =>
      new Response(
        JSON.stringify({
          mediaItems: [
            {
              id: 'good',
              mediaFile: { baseUrl: 'https://x/b', filename: 'a.jpg', mimeType: 'image/jpeg' }
            },
            { mediaFile: { baseUrl: 'https://x/b', filename: 'noid.jpg', mimeType: 'image/jpeg' } },
            { id: 'nobase', mediaFile: { filename: 'x.jpg', mimeType: 'image/jpeg' } },
            {
              id: 'doc',
              mediaFile: { baseUrl: 'https://x/b', filename: 'd.pdf', mimeType: 'application/pdf' }
            }
          ]
        }),
        { headers: { 'content-type': 'application/json' } }
      )
  );
  const page = await listSessionMediaItems('tok', 'sess-1', { fetcher });
  assert.deepEqual(
    page.items.map((i) => i.id),
    ['good']
  );
});

test('createPickingSession throws on missing id', async () => {
  const fetcher = fixedFetcher(
    () =>
      new Response(JSON.stringify({ pickerUri: 'https://p' }), {
        headers: { 'content-type': 'application/json' }
      })
  );
  await assert.rejects(createPickingSession('tok', { fetcher }), /missing id or pickerUri/);
});

test('deletePickingSession resolves on success', async () => {
  const fetcher = fixedFetcher(() => new Response('{}'));
  await deletePickingSession('tok', 'sess-1', { fetcher });
});

test('deletePickingSession tolerates 404', async () => {
  const fetcher = failingFetcher(404);
  await deletePickingSession('tok', 'sess-1', { fetcher });
});
