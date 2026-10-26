// Admin routes (gated by social login + sessions; see auth-middleware.ts).
// Routes:
//   GET  /static/*           → public + admin static assets (CSS, admin bundle)
//   GET  /admin/preview/:id  → 302 to a derivative URL the editor can <img src>
//   GET  /admin/original/:id → streams the original (master) bytes for client-side ops
//   POST /admin/sidecar/:id/commit → ops + the client-baked post-ops WebP, in one atomic request
//   POST /admin/upload       → multipart image ingest (routed to ingestStream)
//   POST /admin/import/url   → server-side fetch + ingest from a URL
//
// All blog editing now goes through the JSON blocks editor
// (/admin/blocks*). The markdown write paths (POST /admin/posts and
// friends) were retired in the JSON cutover; markdown is read-only
// until Task 4 archives the sources.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyStatic, { type SetHeadersResponse } from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { requireOwner, requireUser } from '../lib/auth-middleware.ts';
import { paths } from '../lib/config.ts';
import type { Db } from '../lib/db.ts';
import { safeFetch } from '../lib/url-safety.ts';
import { registerArchiveRoutes } from './admin-archive.ts';
import { registerAdminCommentsRoutes } from './admin-comments.ts';
import { registerImageLookupRoutes } from './admin-image-lookup.ts';
import { registerUrlImportRoute, type UrlFetcher } from './admin-import-url.ts';
import { registerAdminPostsRoutes } from './admin-posts.ts';
import { wipeRuntimeData } from './admin-reset-helpers.ts';
import { registerAdminSettingsRoutes } from './admin-settings.ts';
import { registerShellRoutes } from './admin-shell.ts';
import { registerSidecarEditRoutes } from './admin-sidecar-edit.ts';
import { registerAdminTagsRoute } from './admin-tags.ts';
import { registerAdminUploadRoute } from './admin-upload.ts';
import { registerAdminVideoRoutes } from './admin-video.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Repo layout: src/routes/admin.ts → ../../static
const REPO_STATIC_DIR = path.resolve(__dirname, '..', '..', 'static');

export interface AdminRoutesOpts {
  siteRoot?: string;
  /**
   * Where the public/admin static assets live on disk. Defaults to
   * <repo>/static, which contains both:
   *   - admin/main.js (compiled by build:admin)
   *   - site.css (committed source)
   * Served at /static/* by Apache (production) or fastify-static (dev).
   */
  staticDir?: string;
  /** Legacy: the admin bundle directory; kept for tests that override it. */
  adminBundleDir?: string;
  /** When true, every /admin route gets the requireUser preHandler. */
  requireAuth?: boolean;
  /** Override the URL-import fetcher (default: SSRF-safe via lib/url-safety). */
  urlFetcher?: UrlFetcher;
  /** Jobs DB used by the settings, comments, tags and sidecar routes. */
  db?: Db;
}

export default async function adminRoutes(
  fastify: FastifyInstance,
  opts: AdminRoutesOpts = {}
): Promise<void> {
  const siteRoot = opts.siteRoot ?? paths().root;
  // Tests can still override just the admin bundle by passing
  // adminBundleDir; in that case we point /static at its parent so
  // /static/admin/main.js resolves correctly.
  const staticDir =
    opts.staticDir ?? (opts.adminBundleDir ? path.dirname(opts.adminBundleDir) : REPO_STATIC_DIR);
  const guard = opts.requireAuth ? { preHandler: requireUser } : {};
  const ownerGuard = opts.requireAuth ? { preHandler: requireOwner } : {};
  const urlFetcher: UrlFetcher = opts.urlFetcher ?? safeFetch;

  // One static handler at /static/. Public CSS lives at /static/site.css;
  // the admin bundle at /static/admin/main.js. Apache vhost (implementation.md §7)
  // already serves /static/* directly with cache headers in production.
  // Service-Worker-Allowed lets sw-admin.js claim scope `/admin/`
  // rather than only the directory it is served from.
  const setHeaders = (res: SetHeadersResponse, filepath: string): void => {
    if (filepath.endsWith(`${path.sep}site${path.sep}sw-admin.js`)) {
      res.setHeader('Service-Worker-Allowed', '/admin/');
    }
  };

  if (fs.existsSync(staticDir)) {
    await fastify.register(fastifyStatic, {
      root: staticDir,
      prefix: '/static/',
      decorateReply: false,
      setHeaders
    });
    // Same bytes, second mount: a service worker scoped to /admin/
    // never sees a fetch for /static/*, so the shell's assets have to
    // be reachable inside the scope.
    await fastify.register(fastifyStatic, {
      root: staticDir,
      prefix: '/admin/static/',
      decorateReply: false,
      setHeaders
    });
  }

  // /admin/view/:slug (preview shell; see admin-shell.ts). The legacy
  // /admin/editor entry point is retired and answers 404 with a pointer
  // to the blocks editor.
  registerShellRoutes(fastify, { guard });

  // /admin/posts is a 301 → / for old bookmarks. Every markdown write
  // endpoint that used to live beside it has been retired.
  registerAdminPostsRoutes(fastify, { guard });

  fastify.get('/admin', { ...guard }, async (_req, reply) => reply.redirect('/admin/blocks', 302));

  // Site settings (title / tagline / theme) — surfaces the persisted
  // config that lib/config.ts already reads on every request.
  registerAdminSettingsRoutes(fastify, { guard, ownerGuard, db: opts.db, siteRoot });

  const { invalidate: invalidateSidecarListCache } = registerImageLookupRoutes(fastify, {
    siteRoot,
    guard
  });

  registerSidecarEditRoutes(fastify, { siteRoot, guard, ...(opts.db ? { db: opts.db } : {}) });
  registerAdminTagsRoute(fastify, { siteRoot, guard, db: opts.db });
  registerAdminCommentsRoutes(fastify, { siteRoot, guard, db: opts.db });
  registerArchiveRoutes(fastify, { siteRoot, ownerGuard });

  registerAdminUploadRoute(fastify, { siteRoot, guard, invalidateSidecarListCache });

  registerUrlImportRoute(fastify, {
    siteRoot,
    guard,
    urlFetcher,
    invalidateSidecarListCache
  });

  // Video ingest + trim live in their own module (admin.ts is at its
  // size cap); same guard/auth wiring as the image routes above.
  registerAdminVideoRoutes(fastify, { siteRoot, guard });

  // POST /admin/reset — bearer-only nuclear reset for the demo.
  //
  // Wipes all post + image runtime data (content/posts/, originals/,
  // sidecars/, cache/img/) and truncates the SQLite tables that index
  // them (posts + render-job tables; users/sessions are kept). Re-runs
  // migrations after the truncate so the schema stays consistent.
  //
  // Bearer-only: cookie-authed authors can write posts, but full reset
  // is a destructive operator action — we keep the cookie path locked
  // out by checking the synthetic id=0 user that auth-middleware
  // attaches when ADMIN_TOKEN matches. Defense in depth against an
  // accidental click-through from the editor.
  fastify.post('/admin/reset', { ...ownerGuard }, async (request, reply) => {
    if (!request.user || request.user.id !== 0) {
      return reply
        .code(403)
        .send({ error: 'reset is bearer-only; cookie auth not accepted for this endpoint' });
    }
    try {
      const counts = await wipeRuntimeData(siteRoot);
      // The database schema is unchanged, but truncating posts means
      // /:slug routes return 404 until a re-import. The render-job
      // queue is also drained.
      request.log.warn({ counts }, 'admin reset complete');
      return { ok: true, ...counts };
    } catch (err) {
      request.log.error({ err }, 'admin reset failed');
      return reply.code(500).send({ error: (err as Error).message });
    }
  });
}
