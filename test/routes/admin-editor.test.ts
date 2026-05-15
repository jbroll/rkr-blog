import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';

import { ingestStream } from '../../src/lib/originals.ts';
import type { SidecarOp } from '../../src/lib/sidecar-types.ts';
import { buildApp } from '../../src/server.ts';
import { buildMultipartParts } from '../helpers/multipart.ts';

/** Build + POST a /admin/sidecar/:id/commit request. Mirrors the
 * editor client's `postCommit` (image-edit.ts): one `ops` JSON field
 * + optional `bake` WebP file. Most validation-failure tests don't
 * need a bake (server returns 400 before reaching the bake check);
 * success tests with non-empty ops do. */
async function commit(
  app: FastifyInstance,
  id: string,
  body: { ops: unknown; redoStack?: unknown },
  opts?: { bake?: Buffer }
): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> {
  const parts: Parameters<typeof buildMultipartParts>[0][number][] = [
    { kind: 'field', fieldName: 'ops', value: JSON.stringify(body) }
  ];
  if (opts?.bake) {
    parts.push({
      kind: 'file',
      fieldName: 'bake',
      filename: `${id}.webp`,
      contentType: 'image/webp',
      bytes: opts.bake
    });
  }
  const mp = buildMultipartParts(parts);
  return app.inject({
    method: 'POST',
    url: `/admin/sidecar/${id}/commit`,
    headers: mp.headers,
    payload: mp.payload
  });
}

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-editor-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeBundle(t: TestContext): string {
  // Returns a directory laid out like the repo's static/: contains an
  // admin/main.js subpath that maps to /static/admin/main.js.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-editor-bundle-'));
  fs.mkdirSync(path.join(dir, 'admin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'admin', 'main.js'), 'console.log("test bundle");');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'admin');
}

test('GET /admin/editor returns the SPA shell HTML pointing at /static/admin/main.js', async (t) => {
  const root = freshSiteRoot(t);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/admin/editor' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /text\/html/);
  assert.match(res.body, /<div id="rkroll-admin-root">/);
  assert.match(res.body, /<article id="rkroll-admin-article"><\/article>/);
  assert.match(res.body, /<script type="module" src="\/static\/admin\/main\.js[^"]*"><\/script>/);

  // Public theme stylesheets (base + the active theme) are loaded so
  // the editor preview matches the rendered post.
  assert.match(res.body, /<link rel="stylesheet" href="\/static\/base\.css(\?v=[^"]+)?"\/>/);
  assert.match(
    res.body,
    /<link rel="stylesheet" href="\/static\/themes\/[a-z][a-z0-9-]*\.css(\?v=[^"]+)?"\/>/
  );

  // Security headers: TipTap is bundled into the admin entry, so
  // script-src does NOT include esm.sh or any 'unsafe-inline'. The
  // single third-party allowance is apis.google.com, the Drive
  // picker SDK loaded dynamically by the gdrive integration — same
  // trust we already extend to Google for OAuth.
  const csp = res.headers['content-security-policy'] as string;
  assert.equal(csp.includes('esm.sh'), false);
  assert.equal(csp.includes("script-src 'self' 'unsafe-inline'"), false);
  assert.match(csp, /script-src 'self' https:\/\/apis\.google\.com/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');

  // No inline import map — TipTap is bundled.
  assert.equal(res.body.includes('importmap'), false);
  assert.equal(res.body.includes('esm.sh'), false);
});

test('GET /static/admin/main.js serves the compiled bundle when present', async (t) => {
  const root = freshSiteRoot(t);
  const bundleDir = writeBundle(t);
  const app = await buildApp({ siteRoot: root, adminBundleDir: bundleDir });
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/static/admin/main.js' });
  assert.equal(res.statusCode, 200);
  assert.match(
    res.headers['content-type'] as string,
    /(application|text)\/javascript|application\/octet-stream/
  );
  assert.match(res.body, /test bundle/);
});

test('GET /static/admin/main.js 404s when the bundle directory does not exist', async (t) => {
  const root = freshSiteRoot(t);
  const missing = path.join(root, 'no-such-bundle-dir');
  const app = await buildApp({ siteRoot: root, adminBundleDir: missing });
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/static/admin/main.js' });
  assert.equal(res.statusCode, 404);
});

// ---- /admin/preview/:id -------------------------------------------------
// The editor's image node uses /admin/preview/<id> as its <img src>; the
// server redirects to the actual cached derivative URL. This avoids
// having the browser-side editor reproduce the cache-key calculation.

async function makeJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 100, height: 75, channels: 3, background: { r: 30, g: 60, b: 120 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

test('GET /admin/preview/:id 302s to the image-widget fallback URL', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpeg()]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: `/admin/preview/${ingest.id}` });
  assert.equal(res.statusCode, 302);
  const location = res.headers.location as string;
  // /img/<id>.<ophash>.jpeg — same scheme the public renderer uses, so a
  // single redirect lands on a URL Apache can serve directly when cached.
  assert.match(location, new RegExp(`^/img/${ingest.id}\\.[0-9a-f]{12}\\.jpeg$`));
});

test('GET /admin/preview/:id resolves a unique short-id prefix', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpeg()]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const prefix = ingest.id.slice(0, 12);
  const res = await app.inject({ method: 'GET', url: `/admin/preview/${prefix}` });
  assert.equal(res.statusCode, 302);
  const location = res.headers.location as string;
  // Redirect target uses the FULL id even when the request used a prefix.
  assert.match(location, new RegExp(`^/img/${ingest.id}\\.`));
});

test('GET /admin/preview/:id 400s on a malformed id', async (t) => {
  const root = freshSiteRoot(t);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/admin/preview/not-hex!' });
  assert.equal(res.statusCode, 400);
});

test('GET /admin/preview/:id 404s on an unknown but well-formed id', async (t) => {
  const root = freshSiteRoot(t);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const fakeId = 'd'.repeat(64);
  const res = await app.inject({ method: 'GET', url: `/admin/preview/${fakeId}` });
  assert.equal(res.statusCode, 404);
});

test('GET /admin/preview/:id 404s on an ambiguous short prefix', async (t) => {
  // Two ingests with hand-crafted sidecar files sharing a prefix; bypass
  // ingestStream so we can guarantee the prefix collision.
  const root = freshSiteRoot(t);
  const idA = `aaaaaa${'1'.repeat(58)}`;
  const idB = `aaaaaa${'2'.repeat(58)}`;
  for (const id of [idA, idB]) {
    fs.writeFileSync(
      path.join(root, 'sidecars', `${id}.json`),
      JSON.stringify({
        version: 1,
        original: id,
        source: { kind: 'upload', fetched: '2030-01-01T00:00:00Z' },
        metadata: { width: 100, height: 75, format: 'jpeg' },
        ops: [],
        outputs: [{ format: 'jpeg', quality: 85 }],
        variants: [{ w: 1200 }]
      })
    );
  }
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/admin/preview/aaaaaa' });
  assert.equal(res.statusCode, 404);
  assert.match(res.json<{ error: string }>().error, /ambiguous/);
});

// ---- /admin/original/:id -----------------------------------------------
// Streams the master original. Powers the editor's client-side canvas
// pipeline — preview-after-edit no longer needs a server round-trip
// (the client downloads this once, decodes, applies ops in-browser).

test('GET /admin/original/:id streams the original bytes with the right Content-Type', async (t) => {
  const root = freshSiteRoot(t);
  const bytes = await sharp({
    create: { width: 200, height: 150, channels: 3, background: { r: 80, g: 120, b: 200 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  const ingest = await ingestStream({
    stream: Readable.from([bytes]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: `/admin/original/${ingest.id}` });
  assert.equal(res.statusCode, 200);
  // Ingest re-encodes raster masters to WebP, so the on-disk master is
  // WebP regardless of the upload format (see ingest-resize.ts).
  assert.equal(res.headers['content-type'], 'image/webp');
  // Content-addressable bytes; immutable so the browser can keep the
  // decoded buffer alive across the editing session without
  // revalidating.
  assert.match(res.headers['cache-control'] as string, /immutable/);
  // Body is the post-resize WebP (different bytes from the upload, but
  // present and non-empty).
  assert.ok(res.rawPayload.length > 0);
});

test('GET /admin/original/:id 400s on malformed id and 404s on unknown id', async (t) => {
  const root = freshSiteRoot(t);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const bad = await app.inject({ method: 'GET', url: '/admin/original/short' });
  assert.equal(bad.statusCode, 400);

  const missing = await app.inject({
    method: 'GET',
    url: `/admin/original/${'a'.repeat(64)}`
  });
  assert.equal(missing.statusCode, 404);
});

test('GET /admin/original/:id 404s when sidecar exists but original file is missing', async (t) => {
  const root = freshSiteRoot(t);
  const id = 'e'.repeat(64);
  // Plant a sidecar with no matching file on disk.
  fs.writeFileSync(
    path.join(root, 'sidecars', `${id}.json`),
    JSON.stringify({
      version: 1,
      original: id,
      source: { kind: 'upload', fetched: '2030-01-01T00:00:00Z' },
      metadata: { width: 100, height: 75, format: 'jpeg' },
      ops: [],
      outputs: [{ format: 'jpeg', quality: 85 }],
      variants: [{ w: 1200 }]
    })
  );
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: `/admin/original/${id}` });
  assert.equal(res.statusCode, 404);
  assert.match(res.json<{ error: string }>().error, /missing/);
});

// ---- /admin/sidecar/:id/commit -----------------------------------------
// Atomic image-edit save: one multipart payload carries new ops + the
// client-baked WebP. Server validates both, writes the bake + sidecar
// back-to-back, drops stale per-id derivatives. Replaces the prior
// split /ops + /bake endpoints which exposed an inconsistent
// intermediate state and required an X-Rkr-Bake-Ops-Hash guard.

import { bakePath } from '../../src/lib/originals.ts';

async function makeJpegSized(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 50, g: 100, b: 200 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

async function makeWebp(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 60, g: 100, b: 180 } }
  })
    .webp({ quality: 90 })
    .toBuffer();
}

async function ingestSized(root: string, w: number, h: number): Promise<{ id: string }> {
  return ingestStream({
    stream: Readable.from([await makeJpegSized(w, h)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
}

interface MetaResponse {
  width: number | null;
  height: number | null;
  format: string | null;
  ops: Array<Record<string, unknown>>;
  redoStack: Array<Record<string, unknown>>;
}

interface OpsResponse {
  ops: Array<Record<string, unknown>>;
  redoStack: Array<Record<string, unknown>>;
}

test('POST /commit writes the bake and updates ops atomically', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestSized(root, 800, 600);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const webp = await makeWebp(400, 300);
  const res = await commit(
    app,
    ingest.id,
    { ops: [{ type: 'crop', x: 0, y: 0, w: 400, h: 300 }], redoStack: [] },
    { bake: webp }
  );
  assert.equal(res.statusCode, 200, `body: ${res.body}`);
  const body = res.json<{ ops: SidecarOp[]; redoStack: SidecarOp[] }>();
  assert.deepEqual(body.ops, [{ type: 'crop', x: 0, y: 0, w: 400, h: 300 }]);
  assert.deepEqual(body.redoStack, []);

  // Bake landed byte-identical on disk.
  const onDisk = await fs.promises.readFile(bakePath(root, ingest.id));
  assert.equal(Buffer.compare(onDisk, webp), 0);
});

test('POST /commit with empty ops + no bake clears any prior bake', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestSized(root, 800, 600);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  await commit(
    app,
    ingest.id,
    { ops: [{ type: 'crop', x: 0, y: 0, w: 400, h: 300 }], redoStack: [] },
    { bake: await makeWebp(400, 300) }
  );
  assert.equal(fs.existsSync(bakePath(root, ingest.id)), true);

  const cleared = await commit(app, ingest.id, { ops: [], redoStack: [] });
  assert.equal(cleared.statusCode, 200);
  assert.equal(fs.existsSync(bakePath(root, ingest.id)), false);
});

test('POST /commit rejects non-empty ops without a bake', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestSized(root, 800, 600);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await commit(app, ingest.id, {
    ops: [{ type: 'rotate', degrees: 90 }],
    redoStack: []
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<{ error: string }>().error, /bake required/);
});

test('POST /commit rejects empty ops with a bake', async (t) => {
  // No bake belongs on a clear-edits save; the server unlinks any
  // existing bake. Accepting a bake here would store pixels for ops
  // that aren't there.
  const root = freshSiteRoot(t);
  const ingest = await ingestSized(root, 800, 600);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await commit(
    app,
    ingest.id,
    { ops: [], redoStack: [] },
    { bake: await makeWebp(10, 10) }
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.json<{ error: string }>().error, /bake forbidden/);
});

test('POST /commit rejects malformed bake bytes', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestSized(root, 800, 600);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  // Not a WebP at all (no RIFF/WEBP magic).
  const garbage = await commit(
    app,
    ingest.id,
    { ops: [{ type: 'crop', x: 0, y: 0, w: 100, h: 100 }], redoStack: [] },
    { bake: Buffer.from('not a webp file at all') }
  );
  assert.equal(garbage.statusCode, 400);
  assert.match(garbage.json<{ error: string }>().error, /not a WebP/);

  // Magic-byte spoof: RIFF/WEBP header but the rest decodes nothing.
  const spoof = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x10, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'ascii'),
    Buffer.from('garbage_!@#$', 'ascii')
  ]);
  const spoofRes = await commit(
    app,
    ingest.id,
    { ops: [{ type: 'crop', x: 0, y: 0, w: 100, h: 100 }], redoStack: [] },
    { bake: spoof }
  );
  assert.equal(spoofRes.statusCode, 400);
  assert.match(spoofRes.json<{ error: string }>().error, /not a decodable WebP/);
});

test('POST /commit 400s on malformed id, 404s on unknown', async (t) => {
  const root = freshSiteRoot(t);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const bad = await commit(app, 'not-a-real-id', { ops: [], redoStack: [] });
  assert.equal(bad.statusCode, 400);

  const missing = await commit(app, 'a'.repeat(64), { ops: [], redoStack: [] });
  assert.equal(missing.statusCode, 404);
});

test('POST /commit drops stale derivatives so previously-shared URLs stop serving', async (t) => {
  // If the owner crops to redact, anyone who saw a previously-shared
  // /img/<id>.<oldHash>.<fmt> must not still get the unredacted image.
  const root = freshSiteRoot(t);
  const ingest = await ingestSized(root, 800, 600);
  const cacheImg = path.join(root, 'cache', 'img');
  fs.mkdirSync(cacheImg, { recursive: true });
  const stale1 = path.join(cacheImg, `${ingest.id}.aaaaaaaaaaaa.jpeg`);
  const stale2 = path.join(cacheImg, `${ingest.id}.bbbbbbbbbbbb.webp`);
  const otherId = `${'c'.repeat(64)}.aaaaaaaaaaaa.jpeg`;
  fs.writeFileSync(stale1, 'old-jpeg');
  fs.writeFileSync(stale2, 'old-webp');
  fs.writeFileSync(path.join(cacheImg, otherId), 'unrelated');

  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  await commit(
    app,
    ingest.id,
    { ops: [{ type: 'crop', x: 0, y: 0, w: 100, h: 100 }], redoStack: [] },
    { bake: await makeWebp(100, 100) }
  );

  assert.equal(fs.existsSync(stale1), false);
  assert.equal(fs.existsSync(stale2), false);
  assert.equal(fs.existsSync(path.join(cacheImg, otherId)), true);
});

test('POST /commit normalizes float-coord crops (formerly produced bake-ops-mismatch 409)', async (t) => {
  // Regression of the bake-ops-mismatch class. validateOps Math.floors
  // crop x/y/w/h; with the prior split /ops + /bake design the client
  // would hash un-normalized coords and the server would hash floored
  // coords → 409 + halted drain. Atomic commit eliminates the hash
  // entirely; the server returns normalized ops, the client adopts.
  const root = freshSiteRoot(t);
  const ingest = await ingestSized(root, 400, 300);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await commit(
    app,
    ingest.id,
    {
      ops: [{ type: 'crop', x: 10.7, y: 20.3, w: 200.9, h: 150.4 }],
      redoStack: []
    },
    { bake: await makeWebp(200, 150) }
  );
  assert.equal(res.statusCode, 200, `body: ${res.body}`);
  assert.deepEqual(res.json<{ ops: SidecarOp[] }>().ops, [
    { type: 'crop', x: 10, y: 20, w: 200, h: 150 }
  ]);
});

// ---- /admin/sidecar/:id/meta + /commit ops validation -------------------
// These exercise validateOps via /commit. The validator is shared
// with the client editor (src/lib/ops-validation.ts).

test('GET /admin/sidecar/:id/meta returns original dimensions + ops', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestSized(root, 800, 600);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: `/admin/sidecar/${ingest.id}/meta` });
  assert.equal(res.statusCode, 200);
  const body = res.json<MetaResponse>();
  assert.equal(body.width, 800);
  assert.equal(body.height, 600);
  // metadata.format reflects bytes on disk, which are post-resize WebP.
  assert.equal(body.format, 'webp');
  assert.deepEqual(body.ops, []);
  assert.deepEqual(body.redoStack, []);
});

test('GET /admin/sidecar/:id/meta 404s on unknown id and 400s on malformed', async (t) => {
  const root = freshSiteRoot(t);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const fake = await app.inject({
    method: 'GET',
    url: `/admin/sidecar/${'a'.repeat(64)}/meta`
  });
  assert.equal(fake.statusCode, 404);

  const bad = await app.inject({ method: 'GET', url: '/admin/sidecar/short/meta' });
  assert.equal(bad.statusCode, 400);
});

test('POST /commit persists a crop op (round-trips via GET /meta)', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestSized(root, 800, 600);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await commit(
    app,
    ingest.id,
    { ops: [{ type: 'crop', x: 100, y: 50, w: 400, h: 300 }], redoStack: [] },
    { bake: await makeWebp(400, 300) }
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json<OpsResponse>().ops, [{ type: 'crop', x: 100, y: 50, w: 400, h: 300 }]);

  const meta = await app.inject({ method: 'GET', url: `/admin/sidecar/${ingest.id}/meta` });
  assert.deepEqual(meta.json<MetaResponse>().ops, [
    { type: 'crop', x: 100, y: 50, w: 400, h: 300 }
  ]);
});

test('POST /commit rejects out-of-bounds crops', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestSized(root, 800, 600);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const overflow = await commit(app, ingest.id, {
    ops: [{ type: 'crop', x: 500, y: 0, w: 400, h: 100 }],
    redoStack: []
  });
  assert.equal(overflow.statusCode, 400);
  assert.match(overflow.json<{ error: string }>().error, /exceeds source/);

  const neg = await commit(app, ingest.id, {
    ops: [{ type: 'crop', x: -1, y: 0, w: 100, h: 100 }],
    redoStack: []
  });
  assert.equal(neg.statusCode, 400);

  const zero = await commit(app, ingest.id, {
    ops: [{ type: 'crop', x: 0, y: 0, w: 0, h: 100 }],
    redoStack: []
  });
  assert.equal(zero.statusCode, 400);
});

test('POST /commit rejects unknown op types', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestSized(root, 800, 600);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await commit(app, ingest.id, { ops: [{ type: 'invert' }], redoStack: [] });
  assert.equal(res.statusCode, 400);
  assert.match(
    res.json<{ error: string }>().error,
    /must be 'crop' \| 'rotate' \| 'flip' \| 'resample'/
  );
});

test('POST /commit rejects too-many ops', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestSized(root, 800, 600);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const ops = Array.from({ length: 20 }, () => ({ type: 'crop', x: 0, y: 0, w: 100, h: 100 }));
  const res = await commit(app, ingest.id, { ops, redoStack: [] });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<{ error: string }>().error, /at most/);
});

test('POST /commit accepts rotate / flip / resample shapes', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestSized(root, 800, 600);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await commit(
    app,
    ingest.id,
    {
      ops: [
        { type: 'crop', x: 0, y: 0, w: 400, h: 400 },
        { type: 'rotate', degrees: 90 },
        { type: 'flip', axis: 'horizontal' },
        { type: 'resample', w: 200, fit: 'inside' }
      ],
      redoStack: []
    },
    { bake: await makeWebp(200, 200) }
  );
  assert.equal(res.statusCode, 200);
  const ops = res.json<OpsResponse>().ops;
  assert.equal(ops.length, 4);
  assert.equal(ops[1]?.type, 'rotate');
  assert.equal(ops[2]?.type, 'flip');
  assert.equal(ops[3]?.type, 'resample');
});

test('POST /commit normalizes rotate degrees mod 360 and drops zero-angle', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestSized(root, 800, 600);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  // 450 → 90; -90 → 270; 360 → dropped (no-op rotation).
  const big = await commit(
    app,
    ingest.id,
    { ops: [{ type: 'rotate', degrees: 450 }], redoStack: [] },
    { bake: await makeWebp(600, 800) }
  );
  assert.equal(big.json<OpsResponse>().ops[0]?.degrees, 90);

  const neg = await commit(
    app,
    ingest.id,
    { ops: [{ type: 'rotate', degrees: -90 }], redoStack: [] },
    { bake: await makeWebp(600, 800) }
  );
  assert.equal(neg.json<OpsResponse>().ops[0]?.degrees, 270);

  // 360 mod 360 = 0 → dropped → empty ops → no bake needed.
  const zero = await commit(app, ingest.id, {
    ops: [{ type: 'rotate', degrees: 360 }],
    redoStack: []
  });
  assert.deepEqual(zero.json<OpsResponse>().ops, []);
});

test('POST /commit rejects rotate degrees that are not multiples of 90', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestSized(root, 800, 600);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await commit(app, ingest.id, {
    ops: [{ type: 'rotate', degrees: 45 }],
    redoStack: []
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<{ error: string }>().error, /multiple of 90/);
});

test('POST /commit rejects flip with bad axis', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestSized(root, 800, 600);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await commit(app, ingest.id, {
    ops: [{ type: 'flip', axis: 'diagonal' }],
    redoStack: []
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<{ error: string }>().error, /horizontal.*vertical/);
});

test('POST /commit rejects resample with no dimension or out-of-range dimension', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestSized(root, 800, 600);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const empty = await commit(app, ingest.id, {
    ops: [{ type: 'resample' }],
    redoStack: []
  });
  assert.equal(empty.statusCode, 400);
  assert.match(empty.json<{ error: string }>().error, /needs at least w or h/);

  const huge = await commit(app, ingest.id, {
    ops: [{ type: 'resample', w: 99999 }],
    redoStack: []
  });
  assert.equal(huge.statusCode, 400);
  assert.match(huge.json<{ error: string }>().error, /<= 8000/);
});

test('POST /commit refuses non-empty ops when source has no recorded dimensions', async (t) => {
  // Hand-built sidecar without metadata.width/height — bounds-checking
  // crop ops is impossible. ops=[] (clear) still works.
  const root = freshSiteRoot(t);
  const id = 'd'.repeat(64);
  fs.writeFileSync(
    path.join(root, 'sidecars', `${id}.json`),
    JSON.stringify({
      version: 1,
      original: id,
      source: { kind: 'upload', fetched: '2030-01-01T00:00:00Z' },
      metadata: {},
      ops: [],
      outputs: [{ format: 'jpeg', quality: 85 }],
      variants: [{ w: 1200 }]
    })
  );
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await commit(app, id, {
    ops: [{ type: 'crop', x: 0, y: 0, w: 100, h: 100 }],
    redoStack: []
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<{ error: string }>().error, /no recorded dimensions/);

  const cleared = await commit(app, id, { ops: [], redoStack: [] });
  assert.equal(cleared.statusCode, 200);
});

test('POST /commit preserves click order (no canonicalization)', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestSized(root, 800, 600);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await commit(
    app,
    ingest.id,
    {
      ops: [
        { type: 'flip', axis: 'horizontal' },
        { type: 'rotate', degrees: 90 },
        { type: 'flip', axis: 'vertical' }
      ],
      redoStack: []
    },
    { bake: await makeWebp(600, 800) }
  );
  assert.equal(res.statusCode, 200);
  const ops = res.json<OpsResponse>().ops;
  assert.equal(ops[0]?.type, 'flip');
  assert.equal(ops[0]?.axis, 'horizontal');
  assert.equal(ops[1]?.type, 'rotate');
  assert.equal(ops[2]?.type, 'flip');
  assert.equal(ops[2]?.axis, 'vertical');
});

test('POST /commit persists and round-trips redoStack', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestSized(root, 800, 600);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const saved = await commit(
    app,
    ingest.id,
    {
      ops: [{ type: 'rotate', degrees: 90 }],
      redoStack: [{ type: 'flip', axis: 'horizontal' }]
    },
    { bake: await makeWebp(600, 800) }
  );
  assert.equal(saved.statusCode, 200);
  const body = saved.json<OpsResponse>();
  assert.deepEqual(body.ops, [{ type: 'rotate', degrees: 90 }]);
  assert.deepEqual(body.redoStack, [{ type: 'flip', axis: 'horizontal' }]);

  const meta = await app.inject({ method: 'GET', url: `/admin/sidecar/${ingest.id}/meta` });
  const m = meta.json<MetaResponse>();
  assert.deepEqual(m.ops, [{ type: 'rotate', degrees: 90 }]);
  assert.deepEqual(m.redoStack, [{ type: 'flip', axis: 'horizontal' }]);
});

test('POST /commit with empty redoStack clears any prior redo history', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestSized(root, 800, 600);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  // Stash redo history first.
  await commit(app, ingest.id, {
    ops: [],
    redoStack: [{ type: 'rotate', degrees: 90 }]
  });

  // Push a new op with redoStack:[] — the standard linear-undo
  // invariant. The redoStack should be cleared on disk.
  const res = await commit(
    app,
    ingest.id,
    {
      ops: [{ type: 'flip', axis: 'horizontal' }],
      redoStack: []
    },
    { bake: await makeWebp(800, 600) }
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json<OpsResponse>().redoStack, []);

  const meta = await app.inject({ method: 'GET', url: `/admin/sidecar/${ingest.id}/meta` });
  assert.deepEqual(meta.json<MetaResponse>().redoStack, []);
});

test('POST /commit validates redoStack op shapes the same as ops', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestSized(root, 800, 600);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await commit(app, ingest.id, {
    ops: [],
    redoStack: [{ type: 'invert' }]
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<{ error: string }>().error, /redoStack:/);
});

// ---- perspective op validation ------------------------------------------

test('POST /commit accepts a valid perspective op', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestSized(root, 800, 600);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const op = {
    type: 'perspective',
    corners: [
      [10, 20],
      [700, 5],
      [780, 590],
      [50, 580]
    ]
  };
  const res = await commit(
    app,
    ingest.id,
    { ops: [op], redoStack: [] },
    { bake: await makeWebp(770, 570) }
  );
  assert.equal(res.statusCode, 200);
  const ops = res.json<OpsResponse>().ops;
  assert.equal(ops.length, 1);
  assert.equal(ops[0]?.type, 'perspective');
  assert.deepEqual(ops[0]?.corners, [
    [10, 20],
    [700, 5],
    [780, 590],
    [50, 580]
  ]);
});

test('POST /commit rejects perspective with wrong corner count', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestSized(root, 800, 600);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await commit(app, ingest.id, {
    ops: [
      {
        type: 'perspective',
        corners: [
          [0, 0],
          [100, 0],
          [100, 100]
        ]
      }
    ],
    redoStack: []
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<{ error: string }>().error, /4 points/);
});

test('POST /commit rejects perspective with non-numeric / out-of-range corners', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestSized(root, 800, 600);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const wrongPair = await commit(app, ingest.id, {
    ops: [{ type: 'perspective', corners: [[0, 0], [100, 0], [100, 100], 5] }],
    redoStack: []
  });
  assert.equal(wrongPair.statusCode, 400);
  assert.match(wrongPair.json<{ error: string }>().error, /\[x, y\] pair/);

  const nonNumeric = await commit(app, ingest.id, {
    ops: [
      {
        type: 'perspective',
        corners: [
          [0, 0],
          ['oops', 0],
          [100, 100],
          [0, 100]
        ]
      }
    ],
    redoStack: []
  });
  assert.equal(nonNumeric.statusCode, 400);
  assert.match(nonNumeric.json<{ error: string }>().error, /finite/);

  const neg = await commit(app, ingest.id, {
    ops: [
      {
        type: 'perspective',
        corners: [
          [-1, 0],
          [100, 0],
          [100, 100],
          [0, 100]
        ]
      }
    ],
    redoStack: []
  });
  assert.equal(neg.statusCode, 400);
  assert.match(neg.json<{ error: string }>().error, /non-negative/);

  const huge = await commit(app, ingest.id, {
    ops: [
      {
        type: 'perspective',
        corners: [
          [0, 0],
          [200_000, 0],
          [100, 100],
          [0, 100]
        ]
      }
    ],
    redoStack: []
  });
  assert.equal(huge.statusCode, 400);
  assert.match(huge.json<{ error: string }>().error, /<= 100000/);
});

test('POST /commit 400s when `ops` field is missing from the multipart', async (t) => {
  // Multipart with only a bake part — the route requires the `ops`
  // text field.
  const root = freshSiteRoot(t);
  const ingest = await ingestSized(root, 800, 600);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const mp = buildMultipartParts([
    {
      kind: 'file',
      fieldName: 'bake',
      filename: 'x.webp',
      contentType: 'image/webp',
      bytes: await makeWebp(10, 10)
    }
  ]);
  const res = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/commit`,
    headers: mp.headers,
    payload: mp.payload
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<{ error: string }>().error, /`ops` field required/);
});

test('POST /commit 400s on malformed JSON in the `ops` field', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestSized(root, 800, 600);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const mp = buildMultipartParts([{ kind: 'field', fieldName: 'ops', value: 'not-json' }]);
  const res = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/commit`,
    headers: mp.headers,
    payload: mp.payload
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<{ error: string }>().error, /valid JSON/);
});
