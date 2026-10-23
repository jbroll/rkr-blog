import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import blocksMigrateCmd, {
  runBlocksMigrate,
  runBlocksMigrateAll
} from '../../src/cli/blocks-migrate.ts';

function withSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-blocks-migrate-'));
  fs.mkdirSync(path.join(root, 'content', 'posts'), { recursive: true });
  const prev = process.env.SITE_ROOT;
  process.env.SITE_ROOT = root;
  t.after(() => {
    if (prev === undefined) delete process.env.SITE_ROOT;
    else process.env.SITE_ROOT = prev;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function writePost(root: string, filename: string, body: string): void {
  fs.writeFileSync(path.join(root, 'content', 'posts', filename), body);
}

const POST = `---
title: T
slug: t
status: published
date: 2026-01-15T12:00:00Z
---

Hello world.

::figure{ids="ab12cd"}
`;

describe('blocks-migrate', () => {
  it('converts a markdown post to a JSON tree', (t: TestContext) => {
    const root = withSiteRoot(t);
    writePost(root, 't.md', POST);
    const tree = runBlocksMigrate(root, 't');
    assert.equal(tree.fields.slug, 't');
    assert.equal(tree.body[0]?.type, 'flow');
  });

  it('throws for a missing post', (t: TestContext) => {
    const root = withSiteRoot(t);
    assert.throws(() => runBlocksMigrate(root, 'nope'), /no post with slug/);
  });

  it('default export writes pretty JSON to a file', async (t: TestContext) => {
    const root = withSiteRoot(t);
    writePost(root, 't.md', POST);
    const out = path.join(root, 't.json');
    await blocksMigrateCmd(['--post', 't', '--out', out]);
    const parsed = JSON.parse(fs.readFileSync(out, 'utf8')) as { version: number };
    assert.equal(parsed.version, 1);
  });

  it('converts every post with --all, mirroring markdown basenames', (t: TestContext) => {
    const root = withSiteRoot(t);
    writePost(root, '2026-01-15-t.md', POST);
    writePost(root, 'u.md', POST.replace('slug: t', 'slug: u').replace('title: T', 'title: U'));
    const written = runBlocksMigrateAll(root);
    assert.equal(written.length, 2);
    assert.ok(fs.existsSync(path.join(root, 'content', 'blocks', '2026-01-15-t.json')));
    assert.ok(fs.existsSync(path.join(root, 'content', 'blocks', 'u.json')));
  });
});
