// Admin routes (gated by social login + sessions; see auth-middleware.ts).
// Routes:
//   GET  /admin/editor       → SPA shell (loads /static/admin/main.js)
//   GET  /static/*           → public + admin static assets (CSS, admin bundle)
//   GET  /admin/preview/:id  → 302 to a derivative URL the editor can <img src>
//   GET  /admin/original/:id → streams the original (master) bytes for client-side ops
//   POST /admin/sidecar/:id/bake → upload the client-baked post-ops WebP
//   POST /admin/posts        → save editor JSON as a markdown post + reindex
//   POST /admin/upload       → multipart image ingest (routed to ingestStream)
//   POST /admin/import/url   → server-side fetch + ingest from a URL

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { runReindex } from '../cli/reindex.ts';
import { requireUser } from '../lib/auth-middleware.ts';
import { paths, siteConfig } from '../lib/config.ts';
import { parsePost } from '../lib/content.ts';
import type { Db } from '../lib/db.ts';
import { ingestStream } from '../lib/originals.ts';
import { slugify } from '../lib/slugify.ts';
import { safeFetch } from '../lib/url-safety.ts';
import { renderAdminPage } from '../templates/admin.ts';
import {
  looksLikeFrontmatterDelimiter,
  resolveSavedStatus,
  yamlScalar
} from './admin-frontmatter.ts';
import { registerImageLookupRoutes } from './admin-image-lookup.ts';
import { registerUrlImportRoute, type UrlFetcher } from './admin-import-url.ts';
import { registerPostBundleRoutes } from './admin-post-bundle.ts';
import { isValidSlug } from './admin-post-consts.ts';
import { registerAdminPostsRoutes } from './admin-posts.ts';
import { prewarmVariants } from './admin-prewarm.ts';
import { registerAdminSettingsRoutes } from './admin-settings.ts';
import { registerSidecarEditRoutes } from './admin-sidecar-edit.ts';

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
  /** Jobs DB. When provided, /admin/posts pre-warms variant renders
   * by enqueueing render jobs for every image referenced by the new
   * post — first public reader gets cache hits. */
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
  const urlFetcher: UrlFetcher = opts.urlFetcher ?? safeFetch;

  // One static handler at /static/. Public CSS lives at /static/site.css;
  // the admin bundle at /static/admin/main.js. Apache vhost (implementation.md §7)
  // already serves /static/* directly with cache headers in production.
  if (fs.existsSync(staticDir)) {
    await fastify.register(fastifyStatic, {
      root: staticDir,
      prefix: '/static/',
      decorateReply: false,
      // Service-Worker-Allowed lets the SW at /static/site/sw.js claim
      // scope `/` rather than only `/static/site/`. Without this the
      // browser rejects the registration the public templates issue.
      // No effect on any other static asset.
      setHeaders: (res, filepath) => {
        if (filepath.endsWith(`${path.sep}site${path.sep}sw.js`)) {
          res.setHeader('Service-Worker-Allowed', '/');
        }
      }
    });
  }

  fastify.get('/admin/editor', { ...guard }, async (_req, reply) => {
    return reply
      .type('text/html; charset=utf-8')
      .header('Content-Security-Policy', ADMIN_EDITOR_CSP)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'strict-origin-when-cross-origin')
      .send(renderAdminPage({ site: siteConfig(), bundleUrl: '/static/admin/main.js' }));
  });

  // /admin/posts (now 301 → /) + per-row status / delete endpoints.
  // The handlers touch the filesystem + runReindex (which opens its
  // own DB), so they no longer need opts.db to be present.
  registerAdminPostsRoutes(fastify, { siteRoot, guard });

  // Site settings (title / tagline / theme) — surfaces the persisted
  // config that lib/config.ts already reads on every request.
  registerAdminSettingsRoutes(fastify, { guard });

  const { invalidate: invalidateSidecarListCache } = registerImageLookupRoutes(fastify, {
    siteRoot,
    guard
  });

  registerSidecarEditRoutes(fastify, { siteRoot, guard });
  registerPostBundleRoutes(fastify, { siteRoot, guard });

  fastify.post<{
    Body: {
      slug?: unknown;
      title?: unknown;
      subtitle?: unknown;
      status?: unknown;
      date?: unknown;
      markdown?: unknown;
      /** Sidecar ID of the post's banner/featured image. */
      banner?: unknown;
    };
  }>('/admin/posts', { ...guard }, async (request, reply) => {
    const { slug: slugRaw, title, subtitle, status, date, markdown, banner } = request.body ?? {};

    if (typeof title !== 'string' || !title.trim()) {
      return reply.code(400).send({ error: 'title is required' });
    }
    if (typeof markdown !== 'string') {
      return reply.code(400).send({ error: 'markdown must be a string' });
    }
    // Empty slug → derive from the title. Existing posts carry the
    // loaded slug verbatim (editor stamps it back into the hidden
    // input after each save). Non-empty values still must pass the
    // kebab-case regex + length cap.
    const slugProvided = typeof slugRaw === 'string' && slugRaw.length > 0;
    if (slugProvided && !isValidSlug(slugRaw)) {
      return reply.code(400).send({ error: 'slug must be a kebab-case identifier (max 100)' });
    }
    const slug = slugProvided ? slugRaw : slugify(title);
    const subtitleStr = typeof subtitle === 'string' ? subtitle.trim() : '';
    // YAML-smuggling guard: reject a body that opens with a YAML
    // frontmatter delimiter. Without this, a forged request could prepend
    // its own ---\nslug: ...\n--- block and parsePost would pick up the
    // *first* yaml node it sees, ignoring the one we're about to write.
    // proseToMarkdown emits horizontal rules as `* * *` (not `---`) so
    // the editor never produces this prefix; we still validate at the
    // boundary because the endpoint is also driven by the WP importer
    // and any future scripted client.
    if (looksLikeFrontmatterDelimiter(markdown)) {
      return reply.code(400).send({ error: 'markdown body must not start with --- frontmatter' });
    }
    const finalStatus = resolveSavedStatus(
      status,
      path.join(siteRoot, 'content', 'posts', `${slug}.md`)
    );
    const dateStr = typeof date === 'string' && date.trim() ? date : new Date().toISOString();

    const bannerStr =
      typeof banner === 'string' && /^[0-9a-f]{64}$/.test(banner.trim()) ? banner.trim() : '';
    const fmLines = ['---', `title: ${yamlScalar(title)}`];
    if (subtitleStr) fmLines.push(`subtitle: ${yamlScalar(subtitleStr)}`);
    if (bannerStr) fmLines.push(`banner: ${bannerStr}`);
    fmLines.push(
      `slug: ${yamlScalar(slug)}`,
      `date: ${yamlScalar(dateStr)}`,
      `status: ${finalStatus}`,
      '---',
      ''
    );
    const fm = fmLines.join('\n');
    const trimmedMd = markdown.startsWith('\n') ? markdown.slice(1) : markdown;
    const file = `${fm}\n${trimmedMd}`;

    // parsePost only verifies our assembled YAML frontmatter is a mapping
    // with title/slug strings — it doesn't reject body content (most
    // markdown is permissive). It catches the case where one of our own
    // yamlScalar() calls produced something unparseable.
    try {
      parsePost(file);
    } catch (err) {
      return reply.code(400).send({ error: `markdown failed to parse: ${(err as Error).message}` });
    }

    const postsDir = path.join(siteRoot, 'content', 'posts');
    await fs.promises.mkdir(postsDir, { recursive: true });
    const filename = `${slug}.md`;
    const finalPath = path.join(postsDir, filename);
    const inserted = !fs.existsSync(finalPath);

    // Optimistic-concurrency guard (spec-offline §6). When the
    // client supplies X-Rkr-Last-Synced-At — the server's
    // updated_at the client believed at the time the offline edits
    // BEGAN — refuse the write if the server's actual updated_at
    // has advanced since. The header is optional: a fresh post that
    // was never synced just omits it and we accept unconditionally.
    //
    // Compare numerically (Date.parse → ms-since-epoch) so the
    // string-vs-string lex compare doesn't wave through:
    //   • a malformed header like "banana" (NaN > number is false →
    //     would silently accept), or
    //   • a future-dated header like "9999-12-31T..." (lexicographic
    //     compare would defeat the guard outright).
    // Clamp the client's claim to "now" — clock skew or a
    // malicious client can't bypass the check by claiming the
    // future.
    const lastSyncedAtRaw = request.headers['x-rkr-last-synced-at'];
    if (typeof lastSyncedAtRaw === 'string' && !inserted) {
      const lastSyncedMs = Date.parse(lastSyncedAtRaw);
      if (Number.isNaN(lastSyncedMs)) {
        return reply
          .code(400)
          .send({ error: 'X-Rkr-Last-Synced-At must be an ISO-8601 timestamp' });
      }
      const clampedLastSyncedMs = Math.min(lastSyncedMs, Date.now());
      // fs.statSync().mtimeMs is a float with sub-millisecond
      // precision on some filesystems; the header's ISO timestamp
      // round-trips through ms. Compare at ms granularity so a file
      // whose mtime matches the header (modulo nanosecond noise)
      // doesn't 409 against itself.
      const serverMtimeMs = Math.floor(fs.statSync(finalPath).mtimeMs);
      if (serverMtimeMs > clampedLastSyncedMs) {
        return reply.code(409).send({
          error: 'post-superseded',
          slug,
          serverUpdatedAt: new Date(serverMtimeMs).toISOString(),
          clientLastSyncedAt: lastSyncedAtRaw
        });
      }
    }

    await fs.promises.writeFile(finalPath, file, 'utf8');

    runReindex(siteRoot);

    // Pre-warm: enqueue render jobs for every (variant × output)
    // combo each image in the post body declares. The job-queue
    // dedups by cache_key so re-saves don't pile up. With worker
    // concurrency = 1 the renders trickle through in the
    // background without saturating CPU.
    if (opts.db) {
      void prewarmVariants(opts.db, siteRoot, markdown).catch((err: unknown) => {
        request.log.warn({ err, slug }, 'pre-warm enqueue failed');
      });
    }

    // Echo the server's updated_at (the file mtime) so the client
    // can stamp meta.lastSyncedAt for the next save's conflict
    // check (spec-offline §6 — clients must know what the server
    // saw to detect concurrent writes).
    const updatedAt = new Date(fs.statSync(finalPath).mtimeMs).toISOString();
    return { slug, inserted, updatedAt };
  });

  fastify.post('/admin/upload', { ...guard }, async (request, reply) => {
    const part = await request.file();
    if (!part) return reply.code(400).send({ error: 'no file part' });

    try {
      const result = await ingestStream({
        stream: part.file,
        siteRoot,
        source: { kind: 'upload', originalName: part.filename ?? null }
      });

      // @fastify/multipart sets file.truncated when the size limit was
      // hit. ingestStream already wrote the partial bytes + a sidecar
      // for them; unlink both before returning 413 so storage doesn't
      // accumulate truncated-image garbage that the user can't reach
      // (the partial bytes have a different sha256 than any future
      // full upload, so they're orphaned by id alone).
      if (part.file.truncated) {
        await fs.promises.unlink(result.path).catch(() => {});
        const sidecarFile = path.join(siteRoot, 'sidecars', `${result.id}.json`);
        await fs.promises.unlink(sidecarFile).catch(() => {});
        return reply.code(413).send({ error: 'file too large' });
      }

      // Fresh id: drop the sidecar-listing cache so the next
      // /admin/preview/<short-prefix> finds it without waiting out
      // the TTL.
      invalidateSidecarListCache();

      return {
        id: result.id,
        bytes: result.bytes,
        deduplicated: result.deduplicated,
        ext: result.ext
      };
    } catch (err) {
      // ingestStream throws Error("ingestStream: <reason>") for both
      // user-input failures (unrecognized format, oversize source,
      // unsupported encoding) and server-side sharp glitches (resize
      // crash, orientation normalize failure). The first set
      // surfaces as 400 so the editor's status line says "bad file";
      // anything else falls through to 500 so operator logs flag it
      // as a real issue instead of looking like another bad upload.
      const msg = (err as Error).message;
      const isInput =
        msg.startsWith('ingestStream: not a recognized image') ||
        msg.startsWith('ingestStream: image too large') ||
        msg.startsWith('ingestStream: unsupported image format');
      request.log.error({ err }, 'upload failed');
      return reply.code(isInput ? 400 : 500).send({ error: msg });
    }
  });

  registerUrlImportRoute(fastify, {
    siteRoot,
    guard,
    urlFetcher,
    invalidateSidecarListCache
  });

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
  fastify.post('/admin/reset', { ...guard }, async (request, reply) => {
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

/**
 * Recursively walk a directory: unlink every regular file, then rmdir
 * every now-empty INNER subdirectory (leaves up to root). The top-level
 * `dir` itself is preserved so a Fly volume mount point — which can't
 * be unlinked — stays in place. Returns the count of files removed.
 *
 * Two passes by design:
 *   1. forward (stack) walk to unlink files and enumerate subdirs
 *   2. reverse walk to rmdir each inner subdir (leaves first), best-
 *      effort — a non-empty dir or transient EBUSY is silently skipped
 *
 * Without the rmdir pass the originals/sidecars/cache trees accumulate
 * empty shard subdirs (originals/aa/bb/) after every reset; cosmetic
 * but they leak directory entries indefinitely on a long-lived demo.
 */
async function wipeDirectoryContents(dir: string): Promise<number> {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  const visitedDirs: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        visitedDirs.push(full);
      } else {
        try {
          await fs.promises.unlink(full);
          count++;
        } catch {
          /* c8 ignore next -- best-effort: a transient EBUSY etc. shouldn't abort the wipe */
        }
      }
    }
  }
  // Reverse-order rmdir so leaf subdirs go first; the top-level `dir`
  // is excluded from visitedDirs so it's never touched.
  for (const sub of visitedDirs.reverse()) {
    try {
      await fs.promises.rmdir(sub);
    } catch {
      /* c8 ignore next -- non-empty (concurrent write) or EBUSY: harmless to skip */
    }
  }
  return count;
}

interface ResetCounts {
  posts: number;
  originals: number;
  sidecars: number;
  cacheFiles: number;
  postsTableRows: number;
}

async function wipeRuntimeData(siteRoot: string): Promise<ResetCounts> {
  const postsDir = path.join(siteRoot, 'content', 'posts');
  const originalsDir = path.join(siteRoot, 'originals');
  const sidecarsDir = path.join(siteRoot, 'sidecars');
  const cacheImgDir = path.join(siteRoot, 'cache', 'img');

  const posts = await wipeDirectoryContents(postsDir);
  const originals = await wipeDirectoryContents(originalsDir);
  const sidecars = await wipeDirectoryContents(sidecarsDir);
  const cacheFiles = await wipeDirectoryContents(cacheImgDir);

  // Truncate the posts + render-job tables. Users and sessions are
  // intentionally untouched — the operator stays signed in. The DB
  // file itself stays so the migrations don't need to re-run.
  const dbPath = path.join(siteRoot, 'data', 'site.db');
  let postsTableRows = 0;
  if (fs.existsSync(dbPath)) {
    const db = (await import('../lib/db.ts')).open(dbPath);
    try {
      const before = db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM posts').get();
      postsTableRows = before?.n ?? 0;
      db.exec('DELETE FROM posts');
      // The render queue (jobs table) may carry references to images
      // we just deleted; clear it so background workers don't churn
      // on missing files.
      db.exec('DELETE FROM jobs');
    } finally {
      db.close();
    }
  }
  return { posts, originals, sidecars, cacheFiles, postsTableRows };
}

/**
 * CSP for /admin/editor. TipTap is bundled by esbuild so the editor
 * itself has no third-party script dependency at runtime. The Google
 * Drive picker integration is an exception: it dynamically injects
 * https://apis.google.com/js/api.js (the Picker SDK), loads its UI
 * inside an iframe served from https://docs.google.com, and pulls
 * thumbnails from https://*.googleusercontent.com. Each Google host is
 * narrowly listed below — same trust we already extend to Google for
 * OAuth (verifying ID tokens via JWKS, exchanging codes).
 *
 * Inline styles still need `'unsafe-inline'` for the template's <style>
 * block (move to a nonce when we drop template-literal HTML).
 */
const ADMIN_EDITOR_CSP = [
  "default-src 'self'",
  "script-src 'self' https://apis.google.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.googleusercontent.com",
  "connect-src 'self' https://apis.google.com https://*.googleapis.com https://accounts.google.com",
  'frame-src https://docs.google.com https://accounts.google.com',
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ');
