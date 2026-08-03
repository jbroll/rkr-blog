import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { parsePost } from '../../src/lib/content.ts';
import { installMockOpfs } from './opfs-mock.ts';

const { resetMockOpfs } = installMockOpfs();

function body(markdown: string) {
  return parsePost(`---\ntitle: t\nslug: s\n---\n\n${markdown}`).ast;
}

const ID = 'c'.repeat(64);
const SIDECAR = {
  version: 1,
  original: ID,
  source: { kind: 'upload', uploadWidth: 300, uploadHeight: 150 },
  ops: [],
  outputs: [],
  variants: []
};

beforeEach(() => resetMockOpfs());

async function seedSidecar(overrides: Record<string, unknown> = {}): Promise<void> {
  const { writeJson } = await import('../../src/admin/opfs.ts');
  await writeJson(`sidecars/${ID}.json`, { ...SIDECAR, ...overrides });
}

async function seedBlob(path: string): Promise<void> {
  const { writeBlob } = await import('../../src/admin/opfs.ts');
  await writeBlob(path, new Blob([new Uint8Array([1, 2, 3])]));
}

const opts = {
  decode: async () => ({ width: 640, height: 480 }),
  toUrl: () => 'blob:fake'
};

test('client prepass: pinned original yields a blob: URL', async () => {
  const { buildImageMapFromOpfs } = await import('../../src/admin/image-map-opfs.ts');
  await seedSidecar();
  await seedBlob(`originals/${ID}.jpg`);
  const map = await buildImageMapFromOpfs(body(`::figure{ids="${ID}"}`), opts);
  const src = map.get(ID);
  assert.ok(src);
  assert.equal(src.urlFor(640, 'webp', 85), 'blob:fake');
  assert.deepEqual({ w: src.width, h: src.height }, { w: 640, h: 480 });
});

test('client prepass: no OPFS bytes yields the placeholder URL', async () => {
  const { buildImageMapFromOpfs, MISSING_IMAGE_URL } = await import(
    '../../src/admin/image-map-opfs.ts'
  );
  await seedSidecar();
  const map = await buildImageMapFromOpfs(body(`::figure{ids="${ID}"}`), opts);
  assert.equal(map.get(ID)?.urlFor(640, 'webp', 85), MISSING_IMAGE_URL);
});

test('client prepass: ops present + bake missing falls back to sidecar metadata dims', async () => {
  const { buildImageMapFromOpfs } = await import('../../src/admin/image-map-opfs.ts');
  await seedSidecar({
    ops: [{ type: 'rotate', degrees: 90 }],
    metadata: { width: 111, height: 222 }
  });
  await seedBlob(`originals/${ID}.jpg`);
  const map = await buildImageMapFromOpfs(body(`::figure{ids="${ID}"}`), opts);
  assert.deepEqual({ w: map.get(ID)?.width, h: map.get(ID)?.height }, { w: 111, h: 222 });
});

test('client prepass: a hex token in prose is not an image reference', async () => {
  const { buildImageMapFromOpfs } = await import('../../src/admin/image-map-opfs.ts');
  await seedSidecar();
  await seedBlob(`originals/${ID}.jpg`);
  const map = await buildImageMapFromOpfs(body('The commit cccccccc shipped it.'), opts);
  assert.equal(map.size, 0);
});

test('client prepass: a prefix reference is keyed by the prefix', async () => {
  const { buildImageMapFromOpfs } = await import('../../src/admin/image-map-opfs.ts');
  await seedSidecar();
  await seedBlob(`originals/${ID}.jpg`);
  const map = await buildImageMapFromOpfs(body('::figure{ids="cccccccc"}'), opts);
  assert.ok(map.get('cccccccc'));
});
