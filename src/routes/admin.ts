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

import fastifyStatic, { type SetHeadersResponse } from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { lookupApplied, pruneApplied, recordApplied } from '../lib/applied-outbox.ts';
import { writeFileAtomic } from '../lib/atomic-write.ts';
import { requireOwner, requireUser } from '../lib/auth-middleware.ts';
import { BUILD_HEADER, STALE_CLIENT_STATUS } from '../lib/build-contract.ts';
import { staleClientRejection } from '../lib/client-build.ts';
import { paths } from '../lib/config.ts';
import { parsePost } from '../lib/content.ts';
import type { Db } from '../lib/db.ts';
import { runReindex } from '../lib/post-index.ts';
import { slugify } from '../lib/slugify.ts';
import { safeFetch } from '../lib/url-safety.ts';
import { registerArchiveRoutes } from './admin-archive.ts';
import { registerAdminCommentsRoutes } from './admin-comments.ts';
import {
  looksLikeFrontmatterDelimiter,
  resolveSavedDate,
  resolveSavedStatus,
  yamlScalar
} from './admin-frontmatter.ts';
import { readIdempotencyKey } from './admin-idempotency.ts';
import { registerImageLookupRoutes } from './admin-image-lookup.ts';
import { registerUrlImportRoute, type UrlFetcher } from './admin-import-url.ts';
import { registerPostBundleRoutes } from './admin-post-bundle.ts';
import { isValidSlug } from './admin-post-consts.ts';
import { registerAdminPostsRoutes } from './admin-posts.ts';
import { prewarmVariants } from './admin-prewarm.ts';
import { wipeRuntimeData } from './admin-reset-helpers.ts';
import { registerAdminSettingsRoutes } from './admin-settings.ts';
import { registerShellRoutes } from './admin-shell.ts';
import { registerSidecarEditRoutes } from './admin-sidecar-edit.ts';
import { registerAdminTagsRoute } from './admin-tags.ts';
import { registerAdminUploadRoute } from './admin-upload.ts';
import { registerAdminVideoRoutes } from './admin-video.ts';
import { evaluatePostBase, postUpdatedAt } from './post-base.ts';

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

  // /admin/editor + /admin/view/:slug (same shell; see admin-shell.ts).
  registerShellRoutes(fastify, { guard });

  // /admin/posts (now 301 → /) + per-row status / delete endpoints.
  // The handlers touch the filesystem + runReindex (which opens its
  // own DB), so they no longer need opts.db to be present.
  registerAdminPostsRoutes(fastify, { siteRoot, guard });

  // Site settings (title / tagline / theme) — surfaces the persisted
  // config that lib/config.ts already reads on every request.
  registerAdminSettingsRoutes(fastify, { guard, ownerGuard, db: opts.db, siteRoot });

  const { invalidate: invalidateSidecarListCache } = registerImageLookupRoutes(fastify, {
    siteRoot,
    guard
  });

  registerSidecarEditRoutes(fastify, { siteRoot, guard, ...(opts.db ? { db: opts.db } : {}) });
  registerPostBundleRoutes(fastify, { siteRoot, guard });
  registerAdminTagsRoute(fastify, { siteRoot, guard, db: opts.db });
  registerAdminCommentsRoutes(fastify, { siteRoot, guard, db: opts.db });
  registerArchiveRoutes(fastify, { siteRoot, ownerGuard });

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
      /** Tag names to attach to the post. */
      tags?: unknown;
    };
  }>('/admin/posts', { ...guard }, async (request, reply) => {
    // Server-side outbox idempotency (Task 8). A drained entry carries
    // (x-rkr-device-id, x-rkr-outbox-seq); a lost-ACK replay short-
    // circuits to the stored 2xx instead of re-running the mtime guard
    // with a stale baked-in lastSyncedAt (phantom 409 → user discards
    // → newer coalesced edit lost). opts.db is absent in some test
    // harnesses; the byte-identical layer below still self-heals then.
    const idem = readIdempotencyKey(request.headers);
    if (idem && opts.db) {
      const prior = lookupApplied(opts.db, idem.deviceId, idem.seq);
      if (prior) {
        return reply.code(prior.status).type('application/json').send(prior.body);
      }
    }

    // After the replay short-circuit: a lost-ACK replay from a stale
    // bundle already landed, so returning its stored 2xx is right.
    const stale = staleClientRejection(request.headers[BUILD_HEADER]);
    if (stale) return reply.code(STALE_CLIENT_STATUS).send(stale);

    const {
      slug: slugRaw,
      title,
      subtitle,
      status,
      date,
      markdown,
      banner,
      tags: tagsRaw
    } = request.body ?? {};

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
    const postFilePath = path.join(siteRoot, 'content', 'posts', `${slug}.md`);
    const finalStatus = resolveSavedStatus(status, postFilePath);
    // Preserve the existing post's date when the body omits it — both
    // to avoid silently re-dating a re-saved post and so a queued-
    // entry replay produces byte-identical content (Task 8 self-heal).
    const dateStr = resolveSavedDate(date, postFilePath);

    const bannerStr =
      typeof banner === 'string' && /^[0-9a-f]{64}$/.test(banner.trim()) ? banner.trim() : '';
    // Validate + clean tags: array of trimmed strings ≤32 chars, deduped
    // (case-insensitive first-occurrence wins), max 20.
    const cleanTags = cleanTagList(tagsRaw);
    const fmLines = ['---', `title: ${yamlScalar(title)}`];
    if (subtitleStr) fmLines.push(`subtitle: ${yamlScalar(subtitleStr)}`);
    if (bannerStr) fmLines.push(`banner: ${bannerStr}`);
    if (cleanTags.length > 0) {
      fmLines.push('tags:');
      for (const tag of cleanTags) fmLines.push(`- ${yamlScalar(tag)}`);
    }
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

    // Cheap idempotency layer (Task 8). If the bytes we'd write are
    // identical to what's already on disk, the queued POST has already
    // been applied (a lost-ACK replay across a client restart, where
    // the applied_outbox row may not exist or opts.db is absent).
    // Treat it as a satisfied no-op and return the normal 2xx BEFORE
    // the mtime/X-Rkr-Last-Synced-At guard below — otherwise the
    // replay's stale baked-in lastSyncedAt produces a phantom 409 and
    // the user "discarding" it can drop a newer coalesced edit.
    // Genuine concurrent divergence (different content + stale
    // lastSyncedAt) still falls through to the 409 path unchanged.
    if (!inserted) {
      let onDisk: string | null = null;
      try {
        onDisk = await fs.promises.readFile(finalPath, 'utf8');
      } catch {
        // Unreadable/just-vanished file: fall through to the normal
        // path (write + guard) rather than guessing.
        onDisk = null;
      }
      if (onDisk === file) {
        const updatedAt = postUpdatedAt(fs.statSync(finalPath).mtimeMs);
        const body = { slug, inserted, updatedAt, date: dateStr };
        if (idem && opts.db) {
          recordApplied(opts.db, idem.deviceId, idem.seq, 200, JSON.stringify(body));
          pruneApplied(opts.db);
        }
        return body;
      }
    }

    // Optimistic-concurrency guard (spec-offline §6). The client
    // echoes the server's updated_at it believed when the offline
    // edits BEGAN; anything but an exact match means that baseline
    // no longer describes the file on disk. The header is optional:
    // a fresh post that was never synced just omits it.
    const lastSyncedAtRaw = request.headers['x-rkr-last-synced-at'];
    if (!inserted) {
      // The file can vanish between the existsSync above and here, the
      // same window the no-op layer's read already contemplates. There is
      // then no baseline to compare against, so write instead of 500ing.
      let mtimeMs: number | null = null;
      try {
        mtimeMs = fs.statSync(finalPath).mtimeMs;
      } catch {
        mtimeMs = null;
      }
      if (mtimeMs !== null) {
        const verdict = evaluatePostBase(
          typeof lastSyncedAtRaw === 'string' ? lastSyncedAtRaw : undefined,
          mtimeMs
        );
        if (verdict.kind === 'invalid') {
          return reply
            .code(400)
            .send({ error: 'X-Rkr-Last-Synced-At must be an ISO-8601 timestamp' });
        }
        if (verdict.kind === 'superseded') {
          return reply.code(409).send({
            error: 'post-superseded',
            slug,
            serverUpdatedAt: verdict.serverUpdatedAt,
            clientLastSyncedAt: lastSyncedAtRaw
          });
        }
      }
    }

    await writeFileAtomic(finalPath, file);

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
    // Also echo back the resolved date so new posts can populate
    // the date input without a full reload.
    const updatedAt = postUpdatedAt(fs.statSync(finalPath).mtimeMs);
    const body = { slug, inserted, updatedAt, date: dateStr };
    if (idem && opts.db) {
      recordApplied(opts.db, idem.deviceId, idem.seq, 200, JSON.stringify(body));
      pruneApplied(opts.db);
    }
    return body;
  });

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

const MAX_TAG_LENGTH = 32;
const MAX_TAGS = 20;

/** Validate and deduplicate an incoming tags value from the request body.
 * Accepts an array; non-string entries and blank/overlong strings are
 * dropped. Deduplication is case-insensitive (first occurrence wins).
 * Returns at most MAX_TAGS entries. */
function cleanTagList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > MAX_TAG_LENGTH) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}
