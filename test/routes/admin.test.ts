import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { read as sidecarRead } from '../../src/lib/sidecar.ts';
import { buildApp } from '../../src/server.ts';
import { buildMultipart } from '../helpers/multipart.ts';

interface UploadResponse {
  id: string;
  bytes: number;
  deduplicated: boolean;
  ext: string;
}

interface ErrorResponse {
  error: string;
}

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-route-'));
  fs.mkdirSync(path.join(root, 'sidecars'), { recursive: true });
  fs.mkdirSync(path.join(root, 'originals'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function makeJpeg() {
  return sharp({
    create: { width: 80, height: 60, channels: 3, background: { r: 100, g: 50, b: 25 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

test('POST /admin/upload writes original + sidecar', async (t) => {
  const root = freshSiteRoot(t);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const bytes = await makeJpeg();
  const expectedId = crypto.createHash('sha256').update(bytes).digest('hex');

  const { payload, headers } = buildMultipart({
    filename: 'photo.jpg',
    contentType: 'image/jpeg',
    bytes
  });

  const res = await app.inject({
    method: 'POST',
    url: '/admin/upload',
    payload,
    headers
  });

  assert.equal(res.statusCode, 200, res.body);
  const body = res.json<UploadResponse>();
  assert.equal(body.id, expectedId);
  assert.equal(body.bytes, bytes.length);
  assert.equal(body.deduplicated, false);
  assert.equal(body.ext, 'jpg');

  // Original on disk matches input bytes.
  const onDisk = fs.readFileSync(
    path.join(
      root,
      'originals',
      expectedId.slice(0, 2),
      expectedId.slice(2, 4),
      `${expectedId}.jpg`
    )
  );
  assert.deepEqual(onDisk, bytes);

  // Sidecar present with kind=upload.
  const sidecar = await sidecarRead(root, expectedId);
  assert.ok(sidecar);
  assert.equal(sidecar.source.kind, 'upload');
  assert.equal(sidecar.source.originalName, 'photo.jpg');
});

test('POST /admin/upload dedupes a byte-identical re-upload', async (t) => {
  const root = freshSiteRoot(t);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const bytes = await makeJpeg();

  for (let i = 0; i < 2; i++) {
    const { payload, headers } = buildMultipart({
      filename: `try-${i}.jpg`,
      contentType: 'image/jpeg',
      bytes
    });
    const res = await app.inject({ method: 'POST', url: '/admin/upload', payload, headers });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json<UploadResponse>();
    assert.equal(body.deduplicated, i === 1);
  }
});

test('POST /admin/upload rejects non-image payloads', async (t) => {
  const root = freshSiteRoot(t);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const { payload, headers } = buildMultipart({
    filename: 'hello.txt',
    contentType: 'text/plain',
    bytes: Buffer.from('not an image')
  });

  const res = await app.inject({ method: 'POST', url: '/admin/upload', payload, headers });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorResponse>().error, /not a recognized image/);
});

test('POST /admin/upload returns 400 when no file part is present', async (t) => {
  const root = freshSiteRoot(t);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  // Field-only multipart, no file.
  const boundary = '----rkrtest';
  const payload = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="x"\r\n\r\nhi\r\n--${boundary}--\r\n`
  );
  const res = await app.inject({
    method: 'POST',
    url: '/admin/upload',
    payload,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(payload.length)
    }
  });
  // @fastify/multipart treats this as no file; we return 400.
  assert.equal(res.statusCode, 400);
});
