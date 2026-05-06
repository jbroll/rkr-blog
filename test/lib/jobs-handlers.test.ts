// Cover renderHandler (the default 'render' handler) end-to-end + the
// no-handler-for-kind error path in workQueue.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { open } from '../../src/lib/db.ts';
import {
  enqueue,
  events,
  type JobHandler,
  type JobHandlerMap,
  renderHandler,
  workQueue
} from '../../src/lib/jobs.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { ingestStream } from '../../src/lib/originals.ts';
import type { DerivativeArgs } from '../../src/lib/render.ts';
import { derivativeFilename, derivativePath } from '../../src/lib/render.ts';

function setup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-jobs-handlers-'));
  for (const sub of ['sidecars', 'originals', 'cache/img']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  const db = open(':memory:');
  migrate(db);
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
    events.removeAllListeners('enqueued');
  });
  return { root, db };
}

async function makeJpeg() {
  return sharp({
    create: { width: 80, height: 60, channels: 3, background: { r: 30, g: 60, b: 120 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

test('renderHandler renders a derivative end-to-end through the workQueue', async (t) => {
  const { root, db } = setup(t);
  const r = await ingestStream({
    stream: Readable.from([await makeJpeg()]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'pic.jpg' }
  });

  const args: DerivativeArgs = {
    originalId: r.id,
    ops: r.sidecar.ops as DerivativeArgs['ops'],
    variant: r.sidecar.variants[0] as DerivativeArgs['variant'],
    output: r.sidecar.outputs[0] as DerivativeArgs['output']
  };

  const handlers: JobHandlerMap = { render: renderHandler as JobHandler<unknown> };
  enqueue(db, { kind: 'render', payload: args });

  const ctrl = workQueue({ db, ctx: { siteRoot: root }, handlers, drainAndExit: true });
  await ctrl.done;

  // The cache file must exist at the path renderDerivative would have written.
  const expected = derivativePath(root, args);
  assert.ok(fs.existsSync(expected), `expected ${derivativeFilename(args)}`);
  assert.equal(
    db.prepare<{ state: string }>('SELECT state FROM jobs LIMIT 1').get()?.state,
    'done'
  );
});

test('workQueue: missing handler for a kind → state=failed with a "no handler" error', async (t) => {
  const { db } = setup(t);

  // Insert a row with a handler-less kind. Bypass enqueue's typed wrapper.
  const handlers: JobHandlerMap = {}; // no 'render' handler
  enqueue(db, { kind: 'render', payload: { irrelevant: true } });

  const ctrl = workQueue({ db, ctx: { siteRoot: '/dev/null' }, handlers, drainAndExit: true });
  await ctrl.done;

  const row = db
    .prepare<{ state: string; error: string | null }>('SELECT state, error FROM jobs LIMIT 1')
    .get();
  assert.ok(row);
  assert.equal(row.state, 'failed');
  assert.match(row.error ?? '', /no handler for kind=render/);
});
