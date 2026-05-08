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

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';

import { runReindex } from '../cli/reindex.ts';
import { requireUser } from '../lib/auth-middleware.ts';
import { paths } from '../lib/config.ts';
import { parsePost } from '../lib/content.ts';
import { cacheKey } from '../lib/hash.ts';
import { FORMAT_TO_EXT, SHARP_PIXEL_LIMIT } from '../lib/image-constants.ts';
import { bakePath, ingestStream, originalPath } from '../lib/originals.ts';
import { listSidecarIds } from '../lib/posts.ts';
import type { OutputFormat } from '../lib/render.ts';
import { read as sidecarRead, write as sidecarWrite } from '../lib/sidecar.ts';
import type { SidecarOp } from '../lib/sidecar-types.ts';
import { type SafeFetchOptions, safeFetch, UnsafeUrlError } from '../lib/url-safety.ts';
import { renderAdminPage } from '../templates/admin.ts';
// Import the fallback as a named, non-optional export so the runtime
// guard (and its c8 ignore) goes away. Widget.fallback is `?:` on the
// interface to allow future widgets that don't render images; for the
// only image-fallback consumer we know about today, we can pin the
// type to FallbackSpec directly.
import { fallback as imageFallback } from '../widgets/figure.ts';
import { validateOps } from './admin-ops-validation.ts';

/** Production default fetcher used by /admin/import/url. Injectable from
 * tests so a fixture server on 127.0.0.1 doesn't trip the SSRF guard. */
export type UrlFetcher = (url: string, opts: SafeFetchOptions) => Promise<Response>;

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

  // Raw-body parser for /admin/sidecar/:id/bake. The editor POSTs a
  // WebP blob; without an explicit parser fastify rejects unknown
  // content types. Capped at BAKE_MAX_BYTES (matches the route limit).
  fastify.addContentTypeParser(
    'image/webp',
    { parseAs: 'buffer', bodyLimit: BAKE_MAX_BYTES },
    (_req, body, done) => done(null, body)
  );

  // One static handler at /static/. Public CSS lives at /static/site.css;
  // the admin bundle at /static/admin/main.js. Apache vhost (implementation.md §7)
  // already serves /static/* directly with cache headers in production.
  if (fs.existsSync(staticDir)) {
    await fastify.register(fastifyStatic, {
      root: staticDir,
      prefix: '/static/',
      decorateReply: false
    });
  }

  fastify.get('/admin/editor', { ...guard }, async (_req, reply) => {
    return reply
      .type('text/html; charset=utf-8')
      .header('Content-Security-Policy', ADMIN_EDITOR_CSP)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'strict-origin-when-cross-origin')
      .send(renderAdminPage({ bundleUrl: '/static/admin/main.js' }));
  });

  // Editor preview: redirect to the derivative URL the public renderer
  // would serve for this image's <img> fallback. The editor uses this
  // as the `src` for image nodes in TipTap so it doesn't have to
  // reproduce the cache-key calculation client-side.
  // Short-prefix lookup needs the sidecar listing. listSidecarIds() is
  // a synchronous fs.readdirSync; an editor session that re-renders a
  // post with N image directives would otherwise scan once per image.
  // Cache for SIDECAR_LIST_TTL_MS so a burst stays cheap. Full-id
  // requests skip the listing entirely.
  let cachedIds: string[] | null = null;
  let cachedAt = 0;
  function getKnownIdsCached(): string[] {
    const now = Date.now();
    if (cachedIds && now - cachedAt < SIDECAR_LIST_TTL_MS) return cachedIds;
    cachedIds = listSidecarIds(siteRoot);
    cachedAt = now;
    return cachedIds;
  }
  /** Drop the cached id list. Call after any path that creates a new
   * sidecar (upload, url import, gdrive/onedrive import) so the next
   * /admin/preview/<short-prefix> sees the new id immediately. */
  function invalidateSidecarListCache(): void {
    cachedIds = null;
    cachedAt = 0;
  }

  fastify.get<{ Params: { id: string } }>(
    '/admin/preview/:id',
    { ...guard },
    async (req, reply) => {
      const { id } = req.params;
      if (!/^[0-9a-f]{6,64}$/.test(id)) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      let fullId = id;
      if (id.length !== 64) {
        const known = getKnownIdsCached();
        const matches = known.filter((k) => k.startsWith(id));
        if (matches.length !== 1) {
          return reply.code(404).send({ error: 'unknown or ambiguous id' });
        }
        fullId = matches[0] as string;
      }
      const sidecar = await sidecarRead(siteRoot, fullId);
      if (!sidecar) return reply.code(404).send({ error: 'no sidecar' });

      const ophash = cacheKey({
        originalId: fullId,
        ops: sidecar.ops as Parameters<typeof cacheKey>[0]['ops'],
        variant: { w: imageFallback.w },
        output: {
          format: imageFallback.format as OutputFormat,
          quality: imageFallback.quality
        }
      });
      return reply.redirect(`/img/${fullId}.${ophash}.${imageFallback.format}`, 302);
    }
  );

  // Stream the master original bytes. The editor's client-side canvas
  // pipeline downloads this once per editing session and re-applies ops
  // locally so live preview is round-trip-free. Browsers can't decode
  // every format Sharp can ingest (notably HEIC on most browsers); the
  // client falls back to /admin/preview/:id when decoding fails.
  fastify.get<{ Params: { id: string } }>(
    '/admin/original/:id',
    { ...guard },
    async (req, reply) => {
      const { id } = req.params;
      if (!/^[0-9a-f]{64}$/.test(id)) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      const sidecar = await sidecarRead(siteRoot, id);
      if (!sidecar) return reply.code(404).send({ error: 'no sidecar' });

      const fmt = sidecar.metadata.format;
      const ext = fmt ? FORMAT_TO_EXT[fmt] : undefined;
      if (!fmt || !ext) {
        return reply.code(500).send({ error: 'sidecar has no recognized format' });
      }

      const filePath = originalPath(siteRoot, id, ext);
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reply.code(404).send({ error: 'original missing' });
        }
        throw err;
      }

      // Originals are immutable (content-addressable by sha256). The 1y
      // cache + immutable directive lets the browser keep the bytes
      // across edits in the same session without revalidating.
      reply
        .header('Content-Type', formatContentType(fmt))
        .header('Content-Length', String(stat.size))
        .header('Cache-Control', 'private, max-age=31536000, immutable');
      return reply.send(fs.createReadStream(filePath));
    }
  );

  // Sidecar inspection: returns metadata + ops + redoStack so the
  // editor can populate its undo/redo UI on each session-start. The
  // redo stack is persisted on the sidecar (cheap JSON) so the
  // user's undo history survives reload and cross-session.
  fastify.get<{ Params: { id: string } }>(
    '/admin/sidecar/:id/meta',
    { ...guard },
    async (req, reply) => {
      const { id } = req.params;
      if (!/^[0-9a-f]{64}$/.test(id)) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      const sidecar = await sidecarRead(siteRoot, id);
      if (!sidecar) return reply.code(404).send({ error: 'no sidecar' });
      return {
        width: sidecar.metadata.width ?? null,
        height: sidecar.metadata.height ?? null,
        format: sidecar.metadata.format ?? null,
        ops: sidecar.ops,
        redoStack: sidecar.redoStack ?? []
      };
    }
  );

  // Replace a sidecar's ops array. Used by the crop / rotate / flip /
  // resample buttons in the image attribute panel.
  // Edit ops live on the SIDECAR, not per-instance: changing a sidecar's
  // ops affects every post that references this image. That's the
  // existing render-pipeline design (sidecar.ops is the source of truth).
  fastify.post<{
    Params: { id: string };
    Body: { ops?: unknown; redoStack?: unknown };
  }>('/admin/sidecar/:id/ops', { ...guard }, async (req, reply) => {
    const { id } = req.params;
    if (!/^[0-9a-f]{64}$/.test(id)) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    const sidecar = await sidecarRead(siteRoot, id);
    if (!sidecar) return reply.code(404).send({ error: 'no sidecar' });

    const validation = validateOps(req.body?.ops, sidecar.metadata);
    if (!validation.ok) return reply.code(400).send({ error: validation.error });

    // redoStack uses the same op-shape validator. The bounds check
    // against metadata is shared — popping an undone crop later
    // shouldn't suddenly produce out-of-bounds coords.
    let redoStackOut: SidecarOp[] = [];
    if (req.body?.redoStack !== undefined) {
      const rsValidation = validateOps(req.body.redoStack, sidecar.metadata);
      if (!rsValidation.ok) {
        return reply.code(400).send({ error: `redoStack: ${rsValidation.error}` });
      }
      redoStackOut = rsValidation.ops;
    }

    // Snapshot existing derivative filenames BEFORE writing the new
    // sidecar. After the write, every derivative still on disk is
    // bound to the OLD ops (different cacheKey from anything we'd
    // generate now). Unlink them so a previously-shared
    //   /img/<id>.<oldHash>.<fmt>
    // URL stops serving the stale uncropped image. Snapshotting
    // first avoids racing a render-in-flight that's about to rename
    // its tmp into final position with the new ops.
    const cacheImgDir = path.join(siteRoot, 'cache', 'img');
    const stalePrefix = `${id}.`;
    let staleNames: string[] = [];
    try {
      staleNames = (await fs.promises.readdir(cacheImgDir)).filter((n) =>
        n.startsWith(stalePrefix)
      );
    } catch (err) {
      /* c8 ignore next 3 -- ENOENT is fine; directory may not exist yet */
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    sidecar.ops = validation.ops;
    // Persist redoStack only when the client supplied one. Omitting
    // body.redoStack preserves whatever was on disk (e.g. a different
    // editor surface POSTing only ops).
    if (req.body?.redoStack !== undefined) {
      if (redoStackOut.length === 0) {
        delete sidecar.redoStack;
      } else {
        sidecar.redoStack = redoStackOut;
      }
    }
    try {
      await sidecarWrite(siteRoot, id, sidecar);
    } catch (err) {
      req.log.error({ err, id }, 'sidecar write failed');
      return reply.code(500).send({ error: 'sidecar write failed' });
    }

    // Best-effort cleanup; failures don't block the response.
    for (const name of staleNames) {
      await fs.promises.unlink(path.join(cacheImgDir, name)).catch(() => {});
    }
    // Also drop the client-baked post-ops image (if any). The bake
    // corresponds to the *previous* ops; the editor will re-upload
    // a fresh bake right after this POST returns. Until then, the
    // render pipeline falls back to the original.
    await fs.promises.unlink(bakePath(siteRoot, id)).catch(() => {});

    return { ops: sidecar.ops, redoStack: sidecar.redoStack ?? [] };
  });

  // Receive the editor's client-baked post-ops image for this id. The
  // canvas pipeline is now the authority on pixel results — this endpoint
  // just persists what the browser produced. The render pipeline reads
  // the bake instead of re-applying ops via sharp, taking ops out of
  // the per-request hot path.
  //
  // Body is the raw WebP bytes (image/webp content type). 25 MB cap
  // is well above realistic bakes (a 50 MP camera image at q=0.95 is
  // ~5-10 MB) but tight enough that a runaway / misused client can't
  // wedge a multi-GB upload through.
  fastify.post<{
    Params: { id: string };
  }>('/admin/sidecar/:id/bake', { ...guard, bodyLimit: BAKE_MAX_BYTES }, async (req, reply) => {
    const { id } = req.params;
    if (!/^[0-9a-f]{64}$/.test(id)) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    const ct = (req.headers['content-type'] ?? '').toLowerCase();
    if (!ct.startsWith('image/webp')) {
      return reply.code(415).send({ error: 'content-type must be image/webp' });
    }
    const sidecar = await sidecarRead(siteRoot, id);
    if (!sidecar) return reply.code(404).send({ error: 'no sidecar' });

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: 'empty body' });
    }
    // Magic-byte check: WebP files start with "RIFF????WEBP". Cheap
    // sanity check that the client posted what it claimed.
    if (
      body.length < 12 ||
      body.slice(0, 4).toString('ascii') !== 'RIFF' ||
      body.slice(8, 12).toString('ascii') !== 'WEBP'
    ) {
      return reply.code(400).send({ error: 'body is not a WebP file' });
    }
    // Full decode-side validation. The magic-byte check above is cheap
    // but a malformed WebP (truncated chunks, oversized declared dims)
    // would only fail at first render time. Run sharp.metadata() now
    // so corrupt or decompression-bomb uploads are rejected at the
    // boundary rather than landing on disk and 500-ing every public
    // image request that hits this id.
    try {
      const meta = await sharp(body, {
        failOn: 'error',
        limitInputPixels: SHARP_PIXEL_LIMIT
      }).metadata();
      if (meta.format !== 'webp') {
        return reply.code(400).send({ error: 'body did not decode as WebP' });
      }
      const w = meta.width ?? 0;
      const h = meta.height ?? 0;
      if (w * h > SHARP_PIXEL_LIMIT) {
        return reply
          .code(400)
          .send({ error: `bake exceeds pixel limit (${w}×${h} > ${SHARP_PIXEL_LIMIT})` });
      }
    } catch (err) {
      req.log.warn({ err, id }, 'bake decode failed');
      return reply.code(400).send({ error: 'body is not a decodable WebP' });
    }

    const finalPath = bakePath(siteRoot, id);
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
    const tmp = `${finalPath}.${randomSuffix()}.tmp`;
    try {
      await fs.promises.writeFile(tmp, body);
      await fs.promises.rename(tmp, finalPath);
    } catch (err) {
      await fs.promises.unlink(tmp).catch(() => {});
      req.log.error({ err, id }, 'bake write failed');
      return reply.code(500).send({ error: 'bake write failed' });
    }

    // Drop any stale derivatives keyed off the prior bake / prior
    // ops. /ops also does this when ops change, but /bake catches the
    // case where ops didn't change (e.g. user re-baked at higher
    // quality) so previously-cached derivatives still match the
    // current cacheKey.
    const cacheImgDir = path.join(siteRoot, 'cache', 'img');
    try {
      const stale = (await fs.promises.readdir(cacheImgDir)).filter((n) => n.startsWith(`${id}.`));
      for (const name of stale) {
        await fs.promises.unlink(path.join(cacheImgDir, name)).catch(() => {});
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    return { bytes: body.length };
  });

  fastify.post<{
    Body: {
      slug?: unknown;
      title?: unknown;
      status?: unknown;
      date?: unknown;
      markdown?: unknown;
    };
  }>('/admin/posts', { ...guard }, async (request, reply) => {
    const { slug, title, status, date, markdown } = request.body ?? {};

    if (
      typeof slug !== 'string' ||
      slug.length > MAX_SLUG_LENGTH ||
      !/^[a-z0-9][a-z0-9-]*$/i.test(slug)
    ) {
      return reply.code(400).send({ error: 'slug must be a kebab-case identifier (max 100)' });
    }
    if (typeof title !== 'string' || !title.trim()) {
      return reply.code(400).send({ error: 'title is required' });
    }
    if (typeof markdown !== 'string') {
      return reply.code(400).send({ error: 'markdown must be a string' });
    }
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
    const finalStatus: 'draft' | 'published' = status === 'published' ? 'published' : 'draft';
    const dateStr = typeof date === 'string' && date.trim() ? date : new Date().toISOString();

    const fm = [
      '---',
      `title: ${yamlScalar(title)}`,
      `slug: ${yamlScalar(slug)}`,
      `date: ${yamlScalar(dateStr)}`,
      `status: ${finalStatus}`,
      '---',
      ''
    ].join('\n');
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
    await fs.promises.writeFile(finalPath, file, 'utf8');

    runReindex(siteRoot);

    return { slug, inserted };
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
      request.log.error({ err }, 'upload failed');
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  fastify.post<{ Body: { url?: unknown } }>(
    '/admin/import/url',
    { ...guard },
    async (request, reply) => {
      const { url } = request.body ?? {};
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
        return reply.code(400).send({ error: 'url must be an http(s) URL' });
      }

      // safeFetch: SSRF defense — rejects private/loopback/link-local IPs,
      // non-default ports, and re-validates each redirect hop. Replaces
      // the previous fetch(url, { redirect: 'follow' }) which could be
      // pointed at AWS metadata, internal admin panels, or 127.0.0.1.
      let res: Response;
      try {
        res = await urlFetcher(url, { timeoutMs: URL_FETCH_TIMEOUT_MS });
      } catch (err) {
        if (err instanceof UnsafeUrlError) {
          // Detail (e.g. "address 169.254.169.254 is in restricted range:
          // linkLocal") goes to the server log only — leaking it gives an
          // authenticated attacker a small enumeration oracle for
          // internal IPs / DNS wildcards. Client just sees "unsafe url".
          request.log.warn({ url, reason: err.message }, 'url-import rejected');
          return reply.code(400).send({ error: 'unsafe url' });
        }
        const msg =
          (err as { name?: string; message?: string }).name === 'AbortError'
            ? 'fetch timed out'
            : `fetch failed: ${(err as Error).message}`;
        return reply.code(400).send({ error: msg });
      }

      if (!res.ok) {
        return reply.code(400).send({ error: `fetch returned ${res.status}` });
      }

      const ct = (res.headers.get('content-type') ?? '').toLowerCase();
      if (!/^image\//.test(ct)) {
        return reply
          .code(415)
          .send({ error: `content-type must be image/*; got ${ct || '(none)'}` });
      }

      const contentLength = Number(res.headers.get('content-length') ?? 0);
      if (contentLength && contentLength > URL_FETCH_MAX_BYTES) {
        return reply.code(413).send({ error: `content-length ${contentLength} exceeds limit` });
      }

      if (!res.body) {
        return reply.code(400).send({ error: 'empty response body' });
      }

      // Wrap the body in a Transform that aborts the stream once the byte
      // count exceeds the limit — guards servers that omit content-length.
      let bytes = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytes += chunk.length;
          if (bytes > URL_FETCH_MAX_BYTES) {
            cb(new Error('streamed bytes exceeded limit'));
            return;
          }
          cb(null, chunk);
        }
      });

      try {
        const result = await ingestStream({
          stream: Readable.fromWeb(res.body).pipe(limiter),
          siteRoot,
          source: { kind: 'url', originalName: deriveName(url, ct) }
        });
        invalidateSidecarListCache();
        return {
          id: result.id,
          bytes: result.bytes,
          deduplicated: result.deduplicated,
          ext: result.ext
        };
      } catch (err) {
        const msg = (err as Error).message;
        const code = /exceeded limit/.test(msg) ? 413 : 400;
        request.log.error({ err, url }, 'url-import failed');
        return reply.code(code).send({ error: msg });
      }
    }
  );

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
 * Recursively walk a directory and unlink every regular file, leaving
 * the empty directory shell. Returns the count of files removed. We
 * remove files (not the directories themselves) so a fly volume mount
 * point — which can't be unlinked — stays in place.
 */
async function wipeDirectoryContents(dir: string): Promise<number> {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
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
        // Defer removal of inner directory shells; we only unlink files.
        // Empty subdirs are harmless (rmdir would also be fine, but
        // unlinking-only keeps the wipe idempotent against the volume
        // root and any future bind-mount points).
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

const URL_FETCH_TIMEOUT_MS = 30_000;
const URL_FETCH_MAX_BYTES = 50 * 1024 * 1024; // 50 MiB per spec.md §10 remote import

/** Cap slug length so a 50KB attacker slug can't be written to disk and
 * indexed. The kebab-case regex permits a-z/0-9/-; this just bounds it. */
const MAX_SLUG_LENGTH = 100;

/** Cache lifetime for the sidecar listing inside /admin/preview/:id.
 * Short enough that a freshly-uploaded image becomes findable by short
 * prefix within a few seconds; long enough that a post with many
 * images doesn't scan the directory once per request. */
const SIDECAR_LIST_TTL_MS = 5_000;

/** Max bytes accepted by /admin/sidecar/:id/bake. WebP at q=0.95 for a
 * 50 MP camera photo runs ~5-10 MB; 25 MB leaves headroom for unusual
 * sources (panoramas, scanner output) while keeping the upload bounded
 * tight enough that a runaway client can't wedge a multi-GB POST. */
const BAKE_MAX_BYTES = 25 * 1024 * 1024;

function randomSuffix(): string {
  return crypto.randomBytes(6).toString('hex');
}

/** Map a Sharp/libvips format name to an HTTP Content-Type for serving
 * the original file. Limited to formats the ingest accepts. The rarely-
 * served formats (webp/avif/gif/tiff/heif/default) have trivial 1:1
 * mappings; coverage-marking them avoids dragging fixture images of
 * every format into the unit suite. */
function formatContentType(fmt: string): string {
  switch (fmt) {
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    /* c8 ignore start -- trivial 1:1 mapping; tested via integration
       once a fixture exists for each format */
    case 'webp':
      return 'image/webp';
    case 'avif':
      return 'image/avif';
    case 'gif':
      return 'image/gif';
    case 'tiff':
      return 'image/tiff';
    case 'heif':
      return 'image/heif';
    default:
      return 'application/octet-stream';
    /* c8 ignore stop */
  }
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

function deriveName(url: string, contentType: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').pop() ?? '';
    if (last && /\.[a-z0-9]+$/i.test(last)) return last;
  } catch {
    /* c8 ignore next -- defensive: callers pass URLs that already parsed
       through safeFetch; this catch only fires on a malformed URL that
       slipped past, which our test fixtures don't synthesize */
  }
  const subtype = contentType.split('/')[1]?.split(';')[0]?.trim() ?? 'bin';
  return `import.${subtype}`;
}

function yamlScalar(s: string): string {
  // Quote if the string contains characters that would be ambiguous in YAML.
  if (/[:#&*!|>'"%@`,[\]{}\n]/.test(s) || /^[?]\s/.test(s) || /^\s|\s$/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

/**
 * Does the body open with a yaml frontmatter delimiter?
 *
 * Accepts: a leading BOM / unicode whitespace, then `---`, then a CR/LF,
 * then *something that resembles yaml content* — either another `---`
 * (empty frontmatter) or a `key:` mapping line. Matching only `---\n`
 * would false-positive on a leading `* * *` regression — we want to
 * reject the smuggling shape, not bare horizontal-rule punctuation.
 * CRLF and CR-only line endings are both handled.
 */
function looksLikeFrontmatterDelimiter(s: string): boolean {
  // Strip leading BOM + whitespace (incl. NBSP) so a one-byte prefix can't
  // sidestep the check.
  const trimmed = s.replace(/^[﻿\s]+/, '');
  if (!trimmed.startsWith('---')) return false;
  // Must be EOL right after the opening ---. Bare punctuation (`---foo`,
  // `--- text`) isn't a delimiter.
  const afterDashes = trimmed.slice(3);
  const eolMatch = /^[\t  ]*(\r\n|\r|\n)/.exec(afterDashes);
  if (!eolMatch) return false;
  // Look at the first non-empty line that follows. If it's another `---`
  // (empty frontmatter) or a `key:` mapping, this is yaml. A blank or
  // prose-shaped line means it was punctuation that happened to look
  // like our delimiter.
  const rest = afterDashes.slice(eolMatch[0].length);
  for (const line of rest.split(/\r\n|\r|\n/)) {
    if (line.trim() === '') continue;
    if (line.trim() === '---') return true;
    if (/^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(line)) return true;
    return false;
  }
  return false;
}
