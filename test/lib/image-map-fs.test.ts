import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { parsePost } from '../../src/lib/content.ts';
import { buildImageMap } from '../../src/lib/image-map-fs.ts';
import { bakePath, ingestStream } from '../../src/lib/originals.ts';
import { read as sidecarRead, write as sidecarWrite } from '../../src/lib/sidecar.ts';

function body(markdown: string) {
  return parsePost(`---\ntitle: t\nslug: s\n---\n\n${markdown}`).ast;
}

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-imap-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'bakes', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function seed(root: string, w = 800, h = 600): Promise<string> {
  const bytes = await sharp({
    create: { width: w, height: h, channels: 3, background: { r: 10, g: 20, b: 30 } }
  })
    .jpeg()
    .toBuffer();
  const r = await ingestStream({
    stream: Readable.from([bytes]),
    siteRoot: root,
    source: { kind: 'upload' }
  });
  return r.id;
}

test('buildImageMap: full id resolves, dimensions come from disk', async (t) => {
  const root = freshSiteRoot(t);
  const id = await seed(root);
  const map = await buildImageMap(root, body(`::figure{ids="${id}"}\n`));
  const src = map.get(id);
  assert.ok(src);
  assert.equal(src.width, 800);
  assert.equal(src.height, 600);
  assert.equal(src.sidecar.original, id);
});

test('buildImageMap: a prefix reference is keyed by the prefix as written', async (t) => {
  const root = freshSiteRoot(t);
  const id = await seed(root);
  const short = id.slice(0, 8);
  const map = await buildImageMap(root, body(`::figure{ids="${short}"}\n`));
  assert.ok(map.get(short), 'prefix key present');
  assert.equal(map.get(short)?.sidecar.original, id);
});

test('buildImageMap: urlFor produces the /img/<id>.<oph>.<fmt> URL', async (t) => {
  const root = freshSiteRoot(t);
  const id = await seed(root);
  const map = await buildImageMap(root, body(`::figure{ids="${id}"}\n`));
  const url = map.get(id)?.urlFor(640, 'webp', 85) ?? '';
  assert.match(url, new RegExp(`^/img/${id}\\.[0-9a-f]{12}\\.webp$`));
});

test('buildImageMap: a hex token in prose or code is not an image reference', async (t) => {
  const root = freshSiteRoot(t);
  const id = await seed(root);
  const token = id.slice(0, 8);
  const map = await buildImageMap(
    root,
    body(`The commit ${token} shipped it.\n\n\`\`\`css\ncolor: #${token};\n\`\`\`\n`)
  );
  assert.equal(map.size, 0);
});

test('buildImageMap: unknown and ambiguous ids are absent from the map', async (t) => {
  const root = freshSiteRoot(t);
  await seed(root);
  const map = await buildImageMap(root, body('::figure{ids="deadbeef"}\n'));
  assert.equal(map.get('deadbeef'), undefined);
});

test('buildImageMap: a recreated bake is reported to the passed logger', async (t) => {
  const root = freshSiteRoot(t);
  const id = await seed(root);
  const sidecar = await sidecarRead(root, id);
  assert.ok(sidecar);
  await sidecarWrite(root, id, {
    ...sidecar,
    ops: [{ type: 'crop', x: 0, y: 0, w: 400, h: 300 }]
  });
  assert.equal(fs.existsSync(bakePath(root, id)), false, 'no bake yet');

  const warns: Array<[Record<string, unknown>, string]> = [];
  const map = await buildImageMap(root, body(`::figure{ids="${id}"}\n`), {
    log: { warn: (obj, msg) => warns.push([obj, msg]) }
  });

  assert.deepEqual(warns, [[{ imageId: id }, 'recreated missing bake']]);
  assert.ok(fs.existsSync(bakePath(root, id)), 'bake self-healed');
  assert.equal(map.get(id)?.width, 400);
});
