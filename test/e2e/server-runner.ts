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

import type { FastifyReply, FastifyRequest } from 'fastify';

import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { ensureSecretKey } from '../../src/lib/secrets.ts';
import { buildApp } from '../../src/server.ts';

const root = process.env.SITE_ROOT;
if (!root) throw new Error('SITE_ROOT required');
for (const sub of ['sidecars', 'originals', 'cache/img', 'data', 'content/posts']) {
  fs.mkdirSync(path.join(root, sub), { recursive: true });
}
ensureSecretKey(root);

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
// E2E-only test hook: bump a post's mtime forward by a given offset
// to simulate a competing-device write. Drives the savePost-conflict
// e2e (phase 1l). Lives in server-runner.ts so it never reaches
// production buildApp; defense in depth — slug regex matches the
// /admin/posts handler so the param can't escape the posts dir.
const E2E_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;
app.post<{ Params: { slug: string }; Body: { offsetMs?: number } }>(
  '/admin/test/bump-mtime/:slug',
  async (
    request: FastifyRequest<{ Params: { slug: string }; Body: { offsetMs?: number } }>,
    reply: FastifyReply
  ) => {
    const slug = request.params.slug;
    if (!E2E_SLUG_RE.test(slug) || slug.length > 100) {
      return reply.code(400).send({ error: 'invalid slug' });
    }
    const offsetMs = typeof request.body?.offsetMs === 'number' ? request.body.offsetMs : 5_000;
    const filePath = path.join(root, 'content', 'posts', `${slug}.md`);
    if (!fs.existsSync(filePath)) {
      return reply.code(404).send({ error: 'not found' });
    }
    const future = new Date(Date.now() + offsetMs);
    fs.utimesSync(filePath, future, future);
    return { mtime: future.toISOString() };
  }
);

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
