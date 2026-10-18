// Video-mode cloud picker logic: the server-side OneDrive listing filter
// is the pure, extractable part of the video picker. The Drive/OneDrive
// picker UIs are browser-only and covered end-to-end in Task 3; here we
// pin the kind:'video' vs default 'image' media filtering.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { listOneDriveFolder } from '../../src/lib/microsoft-graph.ts';

function fixedFetcher(handler: (url: string) => Response): typeof fetch {
  return (async (url: string | URL) =>
    handler(typeof url === 'string' ? url : url.toString())) as typeof fetch;
}

// Folder + image + video + non-media file, as Graph would return them.
function mixedFetcher(): typeof fetch {
  return fixedFetcher(
    () =>
      new Response(
        JSON.stringify({
          value: [
            { id: 'fold1', name: 'Clips', folder: {} },
            { id: 'img1', name: 'photo.png', file: { mimeType: 'image/png' } },
            { id: 'vid1', name: 'clip.mp4', file: { mimeType: 'video/mp4' } },
            { id: 'doc1', name: 'notes.txt', file: { mimeType: 'text/plain' } }
          ]
        }),
        { headers: { 'content-type': 'application/json' } }
      )
  );
}

test('listOneDriveFolder video mode keeps video/* + folders, drops images', async () => {
  const page = await listOneDriveFolder('tok', 'root', {
    fetcher: mixedFetcher(),
    kind: 'video'
  });
  const ids = page.items.map((i) => i.id).sort();
  assert.deepEqual(ids, ['fold1', 'vid1']);
});

test('listOneDriveFolder defaults to image mode when kind is omitted', async () => {
  const page = await listOneDriveFolder('tok', 'root', { fetcher: mixedFetcher() });
  const ids = page.items.map((i) => i.id).sort();
  assert.deepEqual(ids, ['fold1', 'img1']);
});

test("listOneDriveFolder kind 'image' matches the default behaviour", async () => {
  const page = await listOneDriveFolder('tok', 'root', {
    fetcher: mixedFetcher(),
    kind: 'image'
  });
  const ids = page.items.map((i) => i.id).sort();
  assert.deepEqual(ids, ['fold1', 'img1']);
});
