import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { evaluateSidecarBase, sidecarUpdatedAt } from '../../src/routes/sidecar-base.ts';

const ID = 'abc123def4567890';

function siteRootWithSidecar(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-sidecar-base-'));
  fs.mkdirSync(path.join(root, 'sidecars'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sidecars', `${ID}.json`), '{"ops":[]}');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function setMtime(root: string, when: number): void {
  fs.utimesSync(path.join(root, 'sidecars', `${ID}.json`), new Date(when), new Date(when));
}

test('evaluateSidecarBase: the echoed updatedAt is accepted as the baseline', async (t) => {
  const root = siteRootWithSidecar(t);
  const base = sidecarUpdatedAt(root, ID);
  assert.ok(base);
  assert.deepEqual(evaluateSidecarBase(base, root, ID), { verdict: 'ok' });
});

test('evaluateSidecarBase: a future-dated mtime is recoverable by echoing serverUpdatedAt', async (t) => {
  const root = siteRootWithSidecar(t);
  setMtime(root, Date.now() + 60_000);

  const stale = evaluateSidecarBase(new Date(Date.now() - 1000).toISOString(), root, ID);
  assert.equal(stale.verdict, 'superseded');
  assert.ok('serverUpdatedAt' in stale);

  assert.deepEqual(evaluateSidecarBase(stale.serverUpdatedAt, root, ID), { verdict: 'ok' });
});

test('evaluateSidecarBase: a baseline newer than mtime is superseded, not a pass', async (t) => {
  const root = siteRootWithSidecar(t);
  const mtime = Math.floor(fs.statSync(path.join(root, 'sidecars', `${ID}.json`)).mtimeMs);
  const ahead = evaluateSidecarBase(new Date(mtime + 5000).toISOString(), root, ID);
  assert.equal(ahead.verdict, 'superseded');
});

test('evaluateSidecarBase: absent header and malformed header', async (t) => {
  const root = siteRootWithSidecar(t);
  assert.deepEqual(evaluateSidecarBase(undefined, root, ID), { verdict: 'no-baseline' });
  assert.deepEqual(evaluateSidecarBase('banana', root, ID), { verdict: 'invalid' });
});
