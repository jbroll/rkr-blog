import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { canonicalJson } from '../../src/lib/canonical-json.ts';
import { ingestStream } from '../../src/lib/originals.ts';
import type { SidecarOp } from '../../src/lib/sidecar-types.ts';
import { buildApp } from '../../src/server.ts';

/** sha256 hex of canonicalJson(ops) — the value the server expects in
 * X-Rkr-Bake-Ops-Hash. Mirrors what the client computes; if this
 * function changes, src/admin/canvas-loaders.ts:uploadBake needs the
 * same change. */
function bakeOpsHash(ops: readonly SidecarOp[]): string {
  return crypto.createHash('sha256').update(canonicalJson(ops), 'utf8').digest('hex');
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
  assert.match(res.body, /<script type="module" src="\/static\/admin\/main\.js"><\/script>/);

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

// ---- /admin/sidecar/:id/bake -------------------------------------------
// The editor uploads its client-baked post-ops WebP here. The server
// stores it at bakes/<id[0:2]>/<id[2:4]>/<id>.webp and the render
// pipeline prefers it over the original (skipping applyOp in sharp).

import { bakePath } from '../../src/lib/originals.ts';

async function makeWebp(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 60, g: 100, b: 180 } }
  })
    .webp({ quality: 90 })
    .toBuffer();
}

test('POST /admin/sidecar/:id/bake stores the WebP at bakes/<id>.webp', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpegSized(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const webp = await makeWebp(800, 600);
  const res = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/bake`,
    headers: { 'content-type': 'image/webp', 'x-rkr-bake-ops-hash': bakeOpsHash([]) },
    payload: webp
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json<{ bytes: number }>().bytes, webp.length);

  // File on disk matches what we uploaded.
  const onDisk = await fs.promises.readFile(bakePath(root, ingest.id));
  assert.equal(Buffer.compare(onDisk, webp), 0);
});

test('POST /admin/sidecar/:id/bake rejects non-WebP content types and bad bodies', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpegSized(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  // Wrong content-type → 415.
  const wrongCt = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/bake`,
    headers: { 'content-type': 'image/png' },
    payload: Buffer.from([0x89, 0x50, 0x4e, 0x47])
  });
  assert.equal(wrongCt.statusCode, 415);

  // Right content-type but the body isn't a valid WebP → 400.
  const garbage = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/bake`,
    headers: { 'content-type': 'image/webp', 'x-rkr-bake-ops-hash': bakeOpsHash([]) },
    payload: Buffer.from('not a webp file at all just text bytes here')
  });
  assert.equal(garbage.statusCode, 400);
  assert.match(garbage.json<{ error: string }>().error, /not a WebP/);

  // Magic-byte spoof: starts with "RIFF????WEBP" but the rest is junk.
  // The pre-sharp magic-byte check passes, then sharp.metadata() fails
  // and we reject with the decode error rather than landing the bytes
  // on disk.
  const spoof = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x10, 0x00, 0x00, 0x00]), // size = 16
    Buffer.from('WEBP', 'ascii'),
    Buffer.from('garbage_!@#$', 'ascii')
  ]);
  const spoofRes = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/bake`,
    headers: { 'content-type': 'image/webp', 'x-rkr-bake-ops-hash': bakeOpsHash([]) },
    payload: spoof
  });
  assert.equal(spoofRes.statusCode, 400);
  assert.match(spoofRes.json<{ error: string }>().error, /not a decodable WebP/);
});

test('POST /admin/sidecar/:id/bake 400s on malformed id and 404s on unknown', async (t) => {
  const root = freshSiteRoot(t);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const bad = await app.inject({
    method: 'POST',
    url: '/admin/sidecar/not-a-real-id/bake',
    headers: { 'content-type': 'image/webp', 'x-rkr-bake-ops-hash': bakeOpsHash([]) },
    payload: await makeWebp(10, 10)
  });
  assert.equal(bad.statusCode, 400);

  const missing = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${'a'.repeat(64)}/bake`,
    headers: { 'content-type': 'image/webp', 'x-rkr-bake-ops-hash': bakeOpsHash([]) },
    payload: await makeWebp(10, 10)
  });
  assert.equal(missing.statusCode, 404);
});

test('POST /admin/sidecar/:id/ops unlinks the bake (so render falls back to original until next bake upload)', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpegSized(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  // Plant a bake.
  const webp = await makeWebp(800, 600);
  const planted = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/bake`,
    headers: { 'content-type': 'image/webp', 'x-rkr-bake-ops-hash': bakeOpsHash([]) },
    payload: webp
  });
  assert.equal(planted.statusCode, 200);
  assert.equal(fs.existsSync(bakePath(root, ingest.id)), true);

  // Mutate ops; bake must be gone afterwards.
  const opsRes = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: { ops: [{ type: 'rotate', degrees: 90 }] }
  });
  assert.equal(opsRes.statusCode, 200);
  assert.equal(fs.existsSync(bakePath(root, ingest.id)), false);
});

test('POST /admin/sidecar/:id/bake also drops stale derivatives so cached results match the new bake', async (t) => {
  // Re-bake at higher quality (or a redo of identical ops) → ops
  // didn't change but the rendered output should. Stale per-id
  // cache files would otherwise serve a render derived from the
  // previous bake.
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpegSized(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const cacheImg = path.join(root, 'cache', 'img');
  fs.mkdirSync(cacheImg, { recursive: true });
  const stale = path.join(cacheImg, `${ingest.id}.aaaaaaaaaaaa.webp`);
  fs.writeFileSync(stale, 'old-bytes');

  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/bake`,
    headers: { 'content-type': 'image/webp', 'x-rkr-bake-ops-hash': bakeOpsHash([]) },
    payload: await makeWebp(800, 600)
  });

  assert.equal(fs.existsSync(stale), false);
});

test('POST /admin/sidecar/:id/bake 400s when X-Rkr-Bake-Ops-Hash header is missing', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpegSized(400, 300)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/bake`,
    headers: { 'content-type': 'image/webp' },
    payload: await makeWebp(400, 300)
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<{ error: string }>().error, /header required/);
});

test('POST /admin/sidecar/:id/bake 409s when X-Rkr-Bake-Ops-Hash does not match current ops', async (t) => {
  // Two-tab race: tab A applies a rotate (sidecar.ops = [rotate]), then
  // tab B — which still has stale local state — POSTs a bake whose
  // ops-hash matches the empty pre-rotate ops. Server must reject; tab B
  // can re-bake against current ops and retry.
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpegSized(400, 300)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  // Tab A applies a rotate.
  const opsRes = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: { ops: [{ type: 'rotate', degrees: 90 }] }
  });
  assert.equal(opsRes.statusCode, 200);

  // Tab B POSTs a bake with the empty-ops hash (its stale view).
  const stale = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/bake`,
    headers: { 'content-type': 'image/webp', 'x-rkr-bake-ops-hash': bakeOpsHash([]) },
    payload: await makeWebp(400, 300)
  });
  assert.equal(stale.statusCode, 409);
  const body = stale.json<{ error: string; expectedHash: string }>();
  assert.equal(body.error, 'bake-ops-mismatch');
  // Server returns the actual current-ops hash so the client knows what
  // to re-bake against.
  assert.equal(body.expectedHash, bakeOpsHash([{ type: 'rotate', degrees: 90 }]));

  // The bake file was NOT written.
  assert.equal(fs.existsSync(bakePath(root, ingest.id)), false);

  // Re-POST with the correct hash succeeds.
  const fresh = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/bake`,
    headers: {
      'content-type': 'image/webp',
      'x-rkr-bake-ops-hash': bakeOpsHash([{ type: 'rotate', degrees: 90 }])
    },
    payload: await makeWebp(400, 300)
  });
  assert.equal(fresh.statusCode, 200);
  assert.equal(fs.existsSync(bakePath(root, ingest.id)), true);
});

test('round-trip: float-coord crop normalized by server matches client hash without 409', async (t) => {
  // Regression: validateOps Math.floors crop x/y/w/h, but the client
  // used to compute X-Rkr-Bake-Ops-Hash against its un-normalized
  // in-memory ops. A canvas crop with subpixel coords would then
  // 409 deterministically — single-tab, single-flow. Fix: POST /ops
  // returns the normalized ops in its body, and the client adopts
  // them as authoritative before hashing + uploading the bake.
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpegSized(400, 300)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  // Client posts a crop with float coords (typical canvas drag output).
  const floatCrop = { type: 'crop', x: 10.7, y: 20.3, w: 200.9, h: 150.4 };
  const opsRes = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: { ops: [floatCrop] }
  });
  assert.equal(opsRes.statusCode, 200);
  const normalized = opsRes.json<{ ops: SidecarOp[] }>();
  // Server floored the coords.
  assert.deepEqual(normalized.ops, [{ type: 'crop', x: 10, y: 20, w: 200, h: 150 }]);

  // Client hashes the NORMALIZED ops (post-fix behavior) and uploads.
  const bake = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/bake`,
    headers: {
      'content-type': 'image/webp',
      'x-rkr-bake-ops-hash': bakeOpsHash(normalized.ops)
    },
    payload: await makeWebp(200, 150)
  });
  assert.equal(bake.statusCode, 200, `bake should succeed; got body: ${bake.body}`);

  // The pre-fix behavior — hashing un-normalized client ops — would 409.
  // Verify the same hash mismatch story still applies, so the fix is
  // about the *client* adopting normalized ops, not the server relaxing
  // the guard.
  const stale = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/bake`,
    headers: {
      'content-type': 'image/webp',
      'x-rkr-bake-ops-hash': bakeOpsHash([floatCrop as unknown as SidecarOp])
    },
    payload: await makeWebp(200, 150)
  });
  assert.equal(stale.statusCode, 409);
});

// ---- /admin/sidecar/:id/meta + /admin/sidecar/:id/ops -----------------
// Backing endpoints for the crop UI: meta supplies original-pixel
// dimensions so the cropper can scale display coords; ops replaces the
// sidecar's ops array with a validated crop (or future resample/rotate).

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

async function makeJpegSized(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 50, g: 100, b: 200 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

test('GET /admin/sidecar/:id/meta returns original dimensions + ops', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpegSized(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
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
  // Fresh sidecar has no redo history. Empty array (not absent) so the
  // client doesn't have to defend against undefined.
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

test('POST /admin/sidecar/:id/ops persists a crop op', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpegSized(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: { ops: [{ type: 'crop', x: 100, y: 50, w: 400, h: 300 }] }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<OpsResponse>();
  assert.deepEqual(body.ops, [{ type: 'crop', x: 100, y: 50, w: 400, h: 300 }]);

  // Confirm the sidecar on disk reflects the new ops.
  const meta = await app.inject({ method: 'GET', url: `/admin/sidecar/${ingest.id}/meta` });
  assert.deepEqual(meta.json<MetaResponse>().ops, [
    { type: 'crop', x: 100, y: 50, w: 400, h: 300 }
  ]);
});

test('POST /admin/sidecar/:id/ops rejects out-of-bounds crops', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpegSized(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  // Crop extends past the right edge.
  const overflow = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: { ops: [{ type: 'crop', x: 500, y: 0, w: 400, h: 100 }] }
  });
  assert.equal(overflow.statusCode, 400);
  assert.match(overflow.json<{ error: string }>().error, /exceeds source/);

  // Negative coordinate.
  const neg = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: { ops: [{ type: 'crop', x: -1, y: 0, w: 100, h: 100 }] }
  });
  assert.equal(neg.statusCode, 400);

  // Zero width.
  const zero = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: { ops: [{ type: 'crop', x: 0, y: 0, w: 0, h: 100 }] }
  });
  assert.equal(zero.statusCode, 400);
});

test('POST /admin/sidecar/:id/ops rejects unknown op types', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpegSized(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: { ops: [{ type: 'invert' }] }
  });
  assert.equal(res.statusCode, 400);
  assert.match(
    res.json<{ error: string }>().error,
    /must be 'crop' \| 'rotate' \| 'flip' \| 'resample'/
  );
});

test('POST /admin/sidecar/:id/ops rejects too-many ops', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpegSized(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const ops = Array.from({ length: 20 }, () => ({ type: 'crop', x: 0, y: 0, w: 100, h: 100 }));
  const res = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: { ops }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<{ error: string }>().error, /at most/);
});

test('POST /admin/sidecar/:id/ops with empty ops clears the array', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpegSized(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  // Install a crop, then clear it.
  await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: { ops: [{ type: 'crop', x: 0, y: 0, w: 100, h: 100 }] }
  });
  const cleared = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: { ops: [] }
  });
  assert.equal(cleared.statusCode, 200);
  assert.deepEqual(cleared.json<OpsResponse>().ops, []);
});

test('POST /admin/sidecar/:id/ops 400s when body.ops is missing', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpegSized(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: {}
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<{ error: string }>().error, /must be an array/);
});

test('POST /admin/sidecar/:id/ops unlinks stale derivatives so previously-shared URLs stop serving', async (t) => {
  // If the owner crops to redact, anyone who saw a previously-shared
  // /img/<id>.<oldHash>.<fmt> URL must not still get the unredacted
  // image. Re-audit LOW finding: invalidate the cache on ops change.
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpegSized(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  // Plant some stale derivative files keyed by id.
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

  const res = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: { ops: [{ type: 'crop', x: 0, y: 0, w: 100, h: 100 }] }
  });
  assert.equal(res.statusCode, 200);

  // Stale derivatives for THIS id are gone…
  assert.equal(fs.existsSync(stale1), false);
  assert.equal(fs.existsSync(stale2), false);
  // …but a derivative for a DIFFERENT id is untouched.
  assert.equal(fs.existsSync(path.join(cacheImg, otherId)), true);
});

test('POST /admin/sidecar/:id/ops accepts rotate / flip / resample shapes', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpegSized(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: {
      ops: [
        { type: 'crop', x: 0, y: 0, w: 400, h: 400 },
        { type: 'rotate', degrees: 90 },
        { type: 'flip', axis: 'horizontal' },
        { type: 'resample', w: 200, fit: 'inside' }
      ]
    }
  });
  assert.equal(res.statusCode, 200);
  const ops = res.json<OpsResponse>().ops;
  assert.equal(ops.length, 4);
  assert.equal(ops[1]?.type, 'rotate');
  assert.equal(ops[2]?.type, 'flip');
  assert.equal(ops[3]?.type, 'resample');
});

test('POST /admin/sidecar/:id/ops normalizes rotate degrees mod 360 and drops zero-angle', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpegSized(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  // 450° → 90° after mod 360. -90 → 270.
  const big = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: { ops: [{ type: 'rotate', degrees: 450 }] }
  });
  assert.equal(big.json<OpsResponse>().ops[0]?.degrees, 90);

  const neg = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: { ops: [{ type: 'rotate', degrees: -90 }] }
  });
  assert.equal(neg.json<OpsResponse>().ops[0]?.degrees, 270);

  // 360° normalizes to 0 → silently dropped.
  const zero = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: { ops: [{ type: 'rotate', degrees: 360 }] }
  });
  assert.deepEqual(zero.json<OpsResponse>().ops, []);
});

test('POST /admin/sidecar/:id/ops rejects rotate degrees that are not multiples of 90', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpegSized(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: { ops: [{ type: 'rotate', degrees: 45 }] }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<{ error: string }>().error, /multiple of 90/);
});

test('POST /admin/sidecar/:id/ops rejects flip with bad axis', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpegSized(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: { ops: [{ type: 'flip', axis: 'diagonal' }] }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<{ error: string }>().error, /horizontal.*vertical/);
});

test('POST /admin/sidecar/:id/ops rejects resample with no dimension or out-of-range dimension', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpegSized(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const empty = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: { ops: [{ type: 'resample' }] }
  });
  assert.equal(empty.statusCode, 400);
  assert.match(empty.json<{ error: string }>().error, /needs at least w or h/);

  const huge = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: { ops: [{ type: 'resample', w: 99999 }] }
  });
  assert.equal(huge.statusCode, 400);
  assert.match(huge.json<{ error: string }>().error, /<= 8000/);
});

test('POST /admin/sidecar/:id/ops refuses non-empty ops when source has no recorded dimensions', async (t) => {
  // Direct-write a sidecar without metadata.width/height — simulating
  // an unusual format or future version where dims aren't known. Any
  // crop op would produce an unrenderable sidecar.
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

  const res = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${id}/ops`,
    payload: { ops: [{ type: 'crop', x: 0, y: 0, w: 100, h: 100 }] }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<{ error: string }>().error, /no recorded dimensions/);

  // But clearing ops with [] still works (no bounds to check against).
  const cleared = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${id}/ops`,
    payload: { ops: [] }
  });
  assert.equal(cleared.statusCode, 200);
});

// ---- Click-order + redoStack -----------------------------------------
// The pipeline preserves the user's click order — no canonicalization.
// `redoStack` is persisted alongside ops so undo/redo survives reload.
// Adding a new op invalidates redoStack (standard linear-undo invariant);
// the *client* enforces that by sending [] for redoStack on every
// op-mutating action. The server passes redoStack through verbatim.

test('POST /admin/sidecar/:id/ops preserves click order (no canonicalization)', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpegSized(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  // A flip BEFORE rotate should stay before rotate. An older
  // canonicalizer enforced a fixed order (crop → rotate → flip →
  // resample); we removed it so authors can chain ops in whatever
  // order they actually want.
  const res = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: {
      ops: [
        { type: 'flip', axis: 'horizontal' },
        { type: 'rotate', degrees: 90 },
        { type: 'flip', axis: 'vertical' }
      ]
    }
  });
  assert.equal(res.statusCode, 200);
  const ops = res.json<OpsResponse>().ops;
  assert.equal(ops[0]?.type, 'flip');
  assert.equal(ops[0]?.axis, 'horizontal');
  assert.equal(ops[1]?.type, 'rotate');
  assert.equal(ops[2]?.type, 'flip');
  assert.equal(ops[2]?.axis, 'vertical');
});

test('POST /admin/sidecar/:id/ops persists and round-trips redoStack', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpegSized(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  // Simulate a client undo: ops shrinks by one, redoStack grows by one.
  const saved = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: {
      ops: [{ type: 'rotate', degrees: 90 }],
      redoStack: [{ type: 'flip', axis: 'horizontal' }]
    }
  });
  assert.equal(saved.statusCode, 200);
  const body = saved.json<OpsResponse>();
  assert.deepEqual(body.ops, [{ type: 'rotate', degrees: 90 }]);
  assert.deepEqual(body.redoStack, [{ type: 'flip', axis: 'horizontal' }]);

  // Reload via GET /meta and confirm both arrays survive.
  const meta = await app.inject({ method: 'GET', url: `/admin/sidecar/${ingest.id}/meta` });
  const m = meta.json<MetaResponse>();
  assert.deepEqual(m.ops, [{ type: 'rotate', degrees: 90 }]);
  assert.deepEqual(m.redoStack, [{ type: 'flip', axis: 'horizontal' }]);
});

test('POST /admin/sidecar/:id/ops with empty redoStack clears any prior redo history', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpegSized(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  // Stash some redo history first.
  await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: {
      ops: [],
      redoStack: [{ type: 'rotate', degrees: 90 }]
    }
  });

  // Then push a new op with redoStack:[] — the standard linear-undo
  // invariant. The redoStack should be cleared on disk.
  const res = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: {
      ops: [{ type: 'flip', axis: 'horizontal' }],
      redoStack: []
    }
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json<OpsResponse>().redoStack, []);

  const meta = await app.inject({ method: 'GET', url: `/admin/sidecar/${ingest.id}/meta` });
  assert.deepEqual(meta.json<MetaResponse>().redoStack, []);
});

test('POST /admin/sidecar/:id/ops omitting body.redoStack preserves on-disk redoStack', async (t) => {
  // Backward compat: clients that don't know about redoStack (or simple
  // tools posting just an ops array) shouldn't accidentally wipe redo
  // history. Only an explicit body.redoStack mutates it.
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpegSized(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  // Stash a redo entry.
  await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: {
      ops: [{ type: 'rotate', degrees: 90 }],
      redoStack: [{ type: 'flip', axis: 'vertical' }]
    }
  });

  // Now POST with ops only (no redoStack key). Should preserve the
  // existing redoStack entry.
  const res = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: { ops: [{ type: 'rotate', degrees: 180 }] }
  });
  assert.equal(res.statusCode, 200);

  const meta = await app.inject({ method: 'GET', url: `/admin/sidecar/${ingest.id}/meta` });
  assert.deepEqual(meta.json<MetaResponse>().ops, [{ type: 'rotate', degrees: 180 }]);
  assert.deepEqual(meta.json<MetaResponse>().redoStack, [{ type: 'flip', axis: 'vertical' }]);
});

test('POST /admin/sidecar/:id/ops validates redoStack op shapes the same as ops', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpegSized(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: {
      ops: [],
      redoStack: [{ type: 'invert' }]
    }
  });
  assert.equal(res.statusCode, 400);
  // Error is prefixed with `redoStack:` so the caller can locate which
  // array was at fault.
  assert.match(res.json<{ error: string }>().error, /redoStack:/);
});

// ---- perspective op validation ----------------------------------------
// Perspective is the only op that doesn't run server-side: sharp can't
// apply a homography, so the client bakes the result and uploads it.
// The server validates op shape so a sidecar that round-trips through
// /sidecar/:id/ops carries an authentic perspective op the client
// (and any future server-side fallback) can execute.

test('POST /admin/sidecar/:id/ops accepts a valid perspective op', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpegSized(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
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
  const res = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: { ops: [op] }
  });
  assert.equal(res.statusCode, 200);
  const ops = res.json<OpsResponse>().ops;
  assert.equal(ops.length, 1);
  assert.equal(ops[0]?.type, 'perspective');
  // Coords are rounded to integers on store.
  assert.deepEqual(ops[0]?.corners, [
    [10, 20],
    [700, 5],
    [780, 590],
    [50, 580]
  ]);
});

test('POST /admin/sidecar/:id/ops rejects perspective with wrong corner count', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpegSized(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: {
      ops: [
        {
          type: 'perspective',
          corners: [
            [0, 0],
            [100, 0],
            [100, 100]
          ]
        }
      ]
    }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<{ error: string }>().error, /4 points/);
});

test('POST /admin/sidecar/:id/ops rejects perspective with non-numeric / malformed corners', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpegSized(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  // Wrong inner shape (single number not a pair).
  const wrongPair = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: {
      ops: [{ type: 'perspective', corners: [[0, 0], [100, 0], [100, 100], 5] }]
    }
  });
  assert.equal(wrongPair.statusCode, 400);
  assert.match(wrongPair.json<{ error: string }>().error, /\[x, y\] pair/);

  // Non-numeric coord (a string that can't be coerced).
  const nonNumeric = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: {
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
      ]
    }
  });
  assert.equal(nonNumeric.statusCode, 400);
  assert.match(nonNumeric.json<{ error: string }>().error, /finite/);

  // Negative coord.
  const neg = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: {
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
      ]
    }
  });
  assert.equal(neg.statusCode, 400);
  assert.match(neg.json<{ error: string }>().error, /non-negative/);

  // Way-too-large coord: refuse runaway values up front instead of
  // letting them flow into the sidecar and downstream renderer.
  const huge = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: {
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
      ]
    }
  });
  assert.equal(huge.statusCode, 400);
  assert.match(huge.json<{ error: string }>().error, /<= 100000/);
});

test('POST /admin/sidecar/:id/ops 400s when body.redoStack is not an array', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpegSized(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/ops`,
    payload: { ops: [], redoStack: 'not-an-array' }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<{ error: string }>().error, /redoStack/);
});
