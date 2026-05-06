import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { runRender } from '../../src/cli/render.ts';
import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { ingestStream } from '../../src/lib/originals.ts';
import {
  type DerivativeArgs,
  derivativeFilename,
  derivativePath,
  type Op
} from '../../src/lib/render.ts';

interface ImagedSidecar {
  id: string;
  ops: Op[];
  variants: { w?: number; h?: number; fit?: string }[];
  outputs: { format: string; quality?: number }[];
}

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-cli-render-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'content/posts', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  // Initialise the DB so runRender's migration step has somewhere to write.
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  db.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function makeJpeg(seed: number) {
  return sharp({
    create: {
      width: 80 + seed,
      height: 60 + seed,
      channels: 3,
      background: { r: (seed * 13) & 0xff, g: (seed * 29) & 0xff, b: (seed * 47) & 0xff }
    }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

async function ingestThree(root: string): Promise<ImagedSidecar[]> {
  const out: ImagedSidecar[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await ingestStream({
      stream: Readable.from([await makeJpeg(i)]),
      siteRoot: root,
      source: { kind: 'upload', originalName: `pic-${i}.jpg` }
    });
    out.push({
      id: r.id,
      ops: r.sidecar.ops as Op[],
      variants: r.sidecar.variants,
      outputs: r.sidecar.outputs
    });
  }
  return out;
}

function variantOutputCount(s: ImagedSidecar): number {
  return s.variants.length * s.outputs.length;
}

test('runRender renders all variants × outputs for every sidecar (3-post fixture)', async (t) => {
  const root = freshSiteRoot(t);
  const sidecars = await ingestThree(root);

  const r = await runRender(root, { concurrency: 2 });
  const expectedTotal = sidecars.reduce((n, s) => n + variantOutputCount(s), 0);

  assert.equal(r.errors, 0);
  assert.equal(r.rendered + r.cached, expectedTotal);
  assert.equal(r.rendered, expectedTotal, 'first run renders everything fresh');

  // Verify every expected derivative file exists.
  for (const s of sidecars) {
    for (const v of s.variants) {
      for (const o of s.outputs) {
        const args: DerivativeArgs = {
          originalId: s.id,
          ops: s.ops,
          variant: v as DerivativeArgs['variant'],
          output: o as DerivativeArgs['output']
        };
        assert.ok(fs.existsSync(derivativePath(root, args)), `missing ${derivativeFilename(args)}`);
      }
    }
  }
});

test('runRender with no --force skips already-cached derivatives', async (t) => {
  const root = freshSiteRoot(t);
  await ingestThree(root);

  const first = await runRender(root, { concurrency: 2 });
  const second = await runRender(root, { concurrency: 2 });

  assert.equal(second.errors, 0);
  assert.equal(second.rendered, 0, 'second run renders nothing fresh');
  assert.equal(second.cached, first.rendered, 'every derivative is now cached');
});

test('runRender with --force re-renders existing derivatives', async (t) => {
  const root = freshSiteRoot(t);
  const sidecars = await ingestThree(root);

  await runRender(root, { concurrency: 2 });

  // Snapshot mtimes.
  const before = new Map<string, number>();
  for (const s of sidecars) {
    for (const v of s.variants) {
      for (const o of s.outputs) {
        const p = derivativePath(root, {
          originalId: s.id,
          ops: s.ops,
          variant: v as DerivativeArgs['variant'],
          output: o as DerivativeArgs['output']
        });
        const fixedTime = new Date('2020-01-01T00:00:00Z');
        fs.utimesSync(p, fixedTime, fixedTime);
        before.set(p, fs.statSync(p).mtimeMs);
      }
    }
  }

  const result = await runRender(root, { concurrency: 2, force: true });
  assert.equal(result.errors, 0);
  assert.equal(result.cached, 0, '--force bypasses cache-hit fast path');

  for (const [p, ts] of before) {
    assert.notEqual(fs.statSync(p).mtimeMs, ts, `expected mtime change on ${path.basename(p)}`);
  }
});

test('runRender --post <slug> renders only images referenced by that post', async (t) => {
  const root = freshSiteRoot(t);
  const sidecars = await ingestThree(root);

  // Reference only the first two images in a single post.
  const a = sidecars[0]!.id;
  const b = sidecars[1]!.id;
  const c = sidecars[2]!.id;

  fs.writeFileSync(
    path.join(root, 'content', 'posts', '2026-05-06-only-ab.md'),
    `---\nslug: only-ab\ntitle: Only A and B\n---\n\n` +
      `Some text.\n\n::image{id=${a} alt="A"}\n\n` +
      `More.\n\n::gallery{ids=[${b}] layout=masonry}\n\nDone.\n`
  );

  const result = await runRender(root, { post: 'only-ab', concurrency: 2 });
  assert.equal(result.errors, 0);
  assert.equal(
    result.rendered,
    variantOutputCount(sidecars[0]!) + variantOutputCount(sidecars[1]!)
  );

  // c's variants must not be on disk.
  const cArgs: DerivativeArgs = {
    originalId: c,
    ops: sidecars[2]!.ops,
    variant: sidecars[2]!.variants[0] as DerivativeArgs['variant'],
    output: sidecars[2]!.outputs[0] as DerivativeArgs['output']
  };
  assert.equal(
    fs.existsSync(derivativePath(root, cArgs)),
    false,
    'c was not referenced by the post; nothing rendered for it'
  );
});

test('runRender --post <unknown> throws', async (t) => {
  const root = freshSiteRoot(t);
  await ingestThree(root);
  await assert.rejects(runRender(root, { post: 'no-such-post' }), /no post with slug/);
});

test('runRender --since filters by sidecar source.fetched', async (t) => {
  const root = freshSiteRoot(t);
  const sidecars = await ingestThree(root);

  // Backdate the first sidecar so it sits before the cutoff.
  const sidecarPath = path.join(root, 'sidecars', `${sidecars[0]!.id}.json`);
  const data = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  data.source.fetched = '2020-01-01T00:00:00Z';
  fs.writeFileSync(sidecarPath, JSON.stringify(data));

  const result = await runRender(root, {
    since: '2025-01-01T00:00:00Z',
    concurrency: 2
  });

  // Two sidecars qualify; one was excluded.
  assert.equal(
    result.rendered,
    variantOutputCount(sidecars[1]!) + variantOutputCount(sidecars[2]!)
  );
});
