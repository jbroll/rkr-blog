// Boots the rkr-blog Fastify app for Playwright e2e tests. Fresh tmp
// site root, migrations applied, secureCookies disabled (HTTP), worker
// disabled, dummy OAuth env so the Google route registers without
// hitting Google. The actual e2e tests exercise token-login, not OAuth.
//
// Driven by env vars set in playwright.config.ts:
//   SITE_ROOT      — tmp site dir (created if missing)
//   PORT           — listen port
//   HOST           — listen host (default 127.0.0.1)
//   ADMIN_TOKEN    — required, the password the e2e suite submits

import fs from 'node:fs';
import path from 'node:path';

import fastifyStatic from '@fastify/static';

import { open } from '../../src/lib/db.ts';
import { seedSiteMacros } from '../../src/lib/macro-library.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { ensureSecretKey } from '../../src/lib/secrets.ts';
import { buildApp } from '../../src/server.ts';

const root = process.env.SITE_ROOT;
if (!root) throw new Error('SITE_ROOT required');
for (const sub of ['sidecars', 'originals', 'cache/img', 'data', 'content/posts']) {
  fs.mkdirSync(path.join(root, sub), { recursive: true });
}
ensureSecretKey(root);
seedSiteMacros(root);
fs.writeFileSync(
  path.join(root, 'macros', 'e2e-team.json'),
  JSON.stringify({
    description: 'E2E fixture with a list field',
    defaults: { people: [] },
    fieldSchema: {
      people: { label: 'People', type: 'list', item: { name: { label: 'Name', type: 'text' } } }
    },
    tree: {
      type: 'grid',
      slots: { cols: 2, each: 'people' },
      children: [{ type: 'text', markdown: 'Member {{name}}' }]
    }
  })
);

// Dummy OAuth wiring so makeGoogleExchange() doesn't throw at route
// registration. The e2e suite hits /admin/auth/token-login, not the
// Google flow; if a test ever needed OAuth it would inject stubs the
// way the Node test suite does.
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? 'e2e-dummy';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? 'e2e-dummy';
const port = Number(process.env.PORT || 3789);
const host = process.env.HOST || '127.0.0.1';
process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? `http://${host}:${port}`;

const db = open(path.join(root, 'data', 'site.db'));
migrate(db);

const app = await buildApp({
  siteRoot: root,
  db,
  startWorker: false,
  // Loosened token-login rate cap: the e2e suite logs in once per
  // spec and currently runs 4+ specs per run, brushing the production
  // 5-per-5-minutes cap. Bumping it here keeps the gate in place (so
  // a test with bad logic can't spam infinitely) without flaking.
  auth: { secureCookies: false, tokenLoginRateMax: 100 }
});

// Static mount for the standalone image PWA, gated like production's
// ENABLE_TEST_ROUTES routes (src/server.ts) even though this runner
// never reaches production buildApp. index.html's asset paths are
// relative to its own directory, not dist/, so dist/, icons/ and
// manifest.webmanifest each get their own mount — sw.js is a sibling
// left out on purpose (see brief: wrong scope, not needed here).
if (process.env.ENABLE_TEST_ROUTES) {
  const pwaRoot = path.resolve(import.meta.dirname, '../../apps/image-pwa');
  // @fastify/static doesn't fail on a missing root, so without this the
  // spec dies on an opaque 30s selector timeout instead.
  if (!fs.existsSync(path.join(pwaRoot, 'dist'))) {
    // buildApp is called above with no logger, so app.log is Fastify's
    // no-op stub; console.warn is the only way this actually prints.
    console.warn('apps/image-pwa/dist is missing — run npm run build:pwa');
  }
  await app.register(fastifyStatic, {
    root: path.join(pwaRoot, 'dist'),
    prefix: '/pwa/dist/',
    decorateReply: false
  });
  await app.register(fastifyStatic, {
    root: path.join(pwaRoot, 'icons'),
    prefix: '/pwa/icons/',
    decorateReply: false
  });
  app.get('/pwa/', async (_req, reply) => {
    return reply.type('text/html').send(fs.readFileSync(path.join(pwaRoot, 'index.html'), 'utf8'));
  });
  app.get('/pwa/manifest.webmanifest', async (_req, reply) => {
    return reply
      .type('application/manifest+json')
      .send(fs.readFileSync(path.join(pwaRoot, 'manifest.webmanifest'), 'utf8'));
  });
}

app.addHook('onClose', async () => {
  db.close();
});

await app.listen({ port, host });
console.log(`e2e server listening on http://${host}:${port}`);

const shutdown = async (): Promise<void> => {
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
