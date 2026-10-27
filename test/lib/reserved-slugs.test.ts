import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { events } from '../../src/lib/jobs.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { PAGE_ROUTE_SLUGS, RESERVED_SLUGS } from '../../src/lib/reserved-slugs.ts';
import { buildApp } from '../../src/server.ts';

/** Full paths from fastify's route tree printout (commonPrefix: false). */
function routePaths(tree: string): string[] {
  const stack: string[] = [];
  const out: string[] = [];
  for (const line of tree.split('\n')) {
    const at = line.indexOf('── ');
    if (at < 0) continue;
    const depth = (at + 3) / 4 - 1;
    const name = line.slice(at + 3).replace(/ \(.*\)$/, '');
    const parent = depth === 0 ? '' : (stack[depth - 1] ?? '');
    const full = parent === '/' ? `/${name}` : `${parent}${name}`;
    stack[depth] = full;
    out.push(full);
  }
  return out;
}

test('RESERVED_SLUGS and PAGE_ROUTE_SLUGS match the fixed routes that shadow a page URL', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-reserved-'));
  fs.mkdirSync(path.join(root, 'data'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());
  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    auth: {
      exchange: {
        authorizationUrl: () => new URL('https://example.com/'),
        exchange: async () => {
          throw new Error('not used');
        }
      },
      secureCookies: false
    }
  });
  t.after(async () => {
    await app.close();
    events.removeAllListeners('enqueued');
  });
  await app.ready();

  const shadowing = new Set<string>();
  for (const route of routePaths(app.printRoutes({ commonPrefix: false }))) {
    const slug = (/^\/([a-z0-9-]+)$/.exec(route) ??
      /^\/admin\/blocks\/([a-z0-9-]+)$/.exec(route))?.[1];
    if (slug) shadowing.add(slug);
  }
  assert.deepEqual([...shadowing].sort(), [...RESERVED_SLUGS, ...PAGE_ROUTE_SLUGS].sort());
});
