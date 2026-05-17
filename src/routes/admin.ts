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
import { lookupApplied, pruneApplied, recordApplied } from '../lib/applied-outbox.ts';
import { writeFileAtomic } from '../lib/atomic-write.ts';
import { requireUser } from '../lib/auth-middleware.ts';
import { resolveGitHash } from '../lib/build-info.ts';
import { paths, siteConfig } from '../lib/config.ts';
import { parsePost } from '../lib/content.ts';
import type { Db } from '../lib/db.ts';
import { ingestStream } from '../lib/originals.ts';
import { runReindex } from '../lib/post-index.ts';
import { slugify } from '../lib/slugify.ts';
import { safeFetch } from '../lib/url-safety.ts';
import { renderAdminPage } from '../templates/admin.ts';
import { registerAdminCommentsRoutes } from './admin-comments.ts';
import { buildAdminEditorCsp, makeCspNonce } from './admin-csp.ts';
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
import { registerSidecarEditRoutes } from './admin-sidecar-edit.ts';
import { registerAdminTagsRoute } from './admin-tags.ts';

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
    // Per-RESPONSE nonce: binds the template's inline <style> block so
    // the CSP can drop script-src 'unsafe-inline' (see admin-csp.ts).
    const nonce = makeCspNonce();
    return reply
      .type('text/html; charset=utf-8')
      .header('Content-Security-Policy', buildAdminEditorCsp(nonce))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'strict-origin-when-cross-origin')
      .send(
        renderAdminPage({
          site: siteConfig(),
          bundleUrl: `/static/admin/main.js?v=${resolveGitHash().slice(0, 12)}`,
          cspNonce: nonce
        })
      );
  });

  // /admin/posts (now 301 → /) + per-row status / delete endpoints.
  // The handlers touch the filesystem + runReindex (which opens its
  // own DB), so they no longer need opts.db to be present.
  registerAdminPostsRoutes(fastify, { siteRoot, guard });

  // Site settings (title / tagline / theme) — surfaces the persisted
  // config that lib/config.ts already reads on every request.
  registerAdminSettingsRoutes(fastify, { guard, db: opts.db, siteRoot });

  const { invalidate: invalidateSidecarListCache } = registerImageLookupRoutes(fastify, {
    siteRoot,
    guard
  });

  registerSidecarEditRoutes(fastify, { siteRoot, guard, ...(opts.db ? { db: opts.db } : {}) });
  registerPostBundleRoutes(fastify, { siteRoot, guard });
  registerAdminTagsRoute(fastify, { siteRoot, guard });
  registerAdminCommentsRoutes(fastify, { siteRoot, guard });

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
        const updatedAt = new Date(fs.statSync(finalPath).mtimeMs).toISOString();
        const body = { slug, inserted, updatedAt, date: dateStr };
        if (idem && opts.db) {
          recordApplied(opts.db, idem.deviceId, idem.seq, 200, JSON.stringify(body));
          pruneApplied(opts.db);
        }
        return body;
      }
    }

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
    const updatedAt = new Date(fs.statSync(finalPath).mtimeMs).toISOString();
    const body = { slug, inserted, updatedAt, date: dateStr };
    if (idem && opts.db) {
      recordApplied(opts.db, idem.deviceId, idem.seq, 200, JSON.stringify(body));
      pruneApplied(opts.db);
    }
    return body;
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
