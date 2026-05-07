// Admin routes. Authentication added in Step 7b (social login + sessions).
//
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

import { runReindex } from '../cli/reindex.ts';
import { requireUser } from '../lib/auth-middleware.ts';
import { paths } from '../lib/config.ts';
import { cacheKey } from '../lib/hash.ts';
import { bakePath, FORMAT_TO_EXT, ingestStream, originalPath } from '../lib/originals.ts';
import { listSidecarIds } from '../lib/posts.ts';
import { type ProseDoc, proseToMarkdown } from '../lib/prose-markdown.ts';
import type { OutputFormat } from '../lib/render.ts';
import { read as sidecarRead, write as sidecarWrite } from '../lib/sidecar.ts';
import { type SafeFetchOptions, safeFetch, UnsafeUrlError } from '../lib/url-safety.ts';
import { renderAdminPage } from '../templates/admin.ts';
// Import the fallback as a named, non-optional export so the runtime
// guard (and its c8 ignore) goes away. Widget.fallback is `?:` on the
// interface to allow future widgets that don't render images; for the
// only image-fallback consumer we know about today, we can pin the
// type to FallbackSpec directly.
import { fallback as imageFallback } from '../widgets/image.ts';

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
  // the admin bundle at /static/admin/main.js. Apache vhost (spec §14)
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
  //
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
      body?: unknown;
    };
  }>('/admin/posts', { ...guard }, async (request, reply) => {
    const { slug, title, status, date, body } = request.body ?? {};

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
    const finalStatus: 'draft' | 'published' = status === 'published' ? 'published' : 'draft';
    const dateStr = typeof date === 'string' && date.trim() ? date : new Date().toISOString();
    if (!body || typeof body !== 'object' || (body as ProseDoc).type !== 'doc') {
      return reply.code(400).send({ error: 'body must be a ProseMirror doc' });
    }

    const md = proseToMarkdown(body as ProseDoc);
    const fm = [
      '---',
      `title: ${yamlScalar(title)}`,
      `slug: ${yamlScalar(slug)}`,
      `date: ${yamlScalar(dateStr)}`,
      `status: ${finalStatus}`,
      '---',
      ''
    ].join('\n');
    const file = `${fm}\n${md}`;

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

      // @fastify/multipart sets file.truncated when the size limit was hit.
      if (part.file.truncated) {
        return reply.code(413).send({ error: 'file too large' });
      }

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
          return reply.code(400).send({ error: `unsafe url: ${err.message}` });
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
}

const URL_FETCH_TIMEOUT_MS = 30_000;
const URL_FETCH_MAX_BYTES = 50 * 1024 * 1024; // 50 MiB per spec §13

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
 * the original file. Limited to formats the ingest accepts. */
function formatContentType(fmt: string): string {
  switch (fmt) {
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
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
  }
}

/** Maximum ops in a sidecar. Caps the chain depth a single editor save
 * can install — defends against a malicious / runaway client building
 * a million-step pipeline that the renderer would have to execute. */
const MAX_OPS = 8;

/** Cap on a resample target dimension. Above this we'd be asking sharp
 * to bake a derivative larger than any realistic display, and approach
 * the SHARP_PIXEL_LIMIT from the original axis. */
const MAX_RESAMPLE_PX = 8000;

/** Cap on any single perspective corner coord. Practical pipeline
 * canvases top out around 50 Mpx (the SHARP_PIXEL_LIMIT) so a coord
 * 100k pixels on a side is well past anything legitimate; this exists
 * to refuse runaway values from a buggy or malicious client up front. */
const MAX_PERSPECTIVE_COORD = 100_000;

const VALID_FITS = new Set(['inside', 'outside', 'cover', 'contain', 'fill']);

type SidecarOp = { type: string; [k: string]: unknown };

interface ValidatedOps {
  ok: true;
  ops: SidecarOp[];
}
type OpsValidation = ValidatedOps | { ok: false; error: string };

/**
 * Validate the body's `ops` array and clamp it against the source's
 * actual pixel bounds. Supports the four edit ops the renderer knows
 * about: crop, rotate, flip, resample.
 */
function validateOps(raw: unknown, metadata: { width?: number; height?: number }): OpsValidation {
  if (!Array.isArray(raw)) return { ok: false, error: 'ops must be an array' };
  if (raw.length > MAX_OPS) return { ok: false, error: `at most ${MAX_OPS} ops` };

  const W = metadata.width ?? 0;
  const H = metadata.height ?? 0;
  // Without source dimensions we can't sanity-check crop bounds.
  // Silently accepting would let an authored op produce an
  // unrenderable sidecar (sharp.extract throws) — every /img request
  // that hits this id then 500s. Refuse non-empty op lists in that
  // case; an empty array (clear all ops) is still allowed.
  if (raw.length > 0 && (W <= 0 || H <= 0)) {
    return { ok: false, error: 'source has no recorded dimensions; cannot validate ops' };
  }

  const out: { type: string; [k: string]: unknown }[] = [];
  for (const [i, opRaw] of raw.entries()) {
    if (!opRaw || typeof opRaw !== 'object') {
      return { ok: false, error: `ops[${i}] must be an object` };
    }
    const op = opRaw as Record<string, unknown>;
    const type = op.type;
    if (type === 'crop') {
      const x = Number(op.x);
      const y = Number(op.y);
      const w = Number(op.w);
      const h = Number(op.h);
      if (![x, y, w, h].every(Number.isFinite)) {
        return { ok: false, error: `ops[${i}] crop must have numeric x/y/w/h` };
      }
      if (x < 0 || y < 0 || w <= 0 || h <= 0) {
        return { ok: false, error: `ops[${i}] crop must have x/y >= 0 and w/h > 0` };
      }
      if (W > 0 && H > 0 && (x + w > W || y + h > H)) {
        return {
          ok: false,
          error: `ops[${i}] crop ${x},${y} ${w}x${h} exceeds source ${W}x${H}`
        };
      }
      out.push({
        type: 'crop',
        x: Math.floor(x),
        y: Math.floor(y),
        w: Math.floor(w),
        h: Math.floor(h)
      });
    } else if (type === 'rotate') {
      const degrees = Number(op.degrees ?? 0);
      // Only orthogonal rotations make sense in our flow (the editor
      // emits ±90 multiples). Sharp accepts arbitrary angles, which
      // would force libvips to fill the corners — reject as
      // probably-wrong rather than render unexpectedly.
      if (!Number.isFinite(degrees) || degrees % 90 !== 0) {
        return { ok: false, error: `ops[${i}] rotate degrees must be a multiple of 90` };
      }
      const norm = ((degrees % 360) + 360) % 360;
      if (norm === 0) continue; // no-op rotation; drop silently
      out.push({ type: 'rotate', degrees: norm });
    } else if (type === 'flip') {
      const axis = op.axis;
      if (axis !== 'horizontal' && axis !== 'vertical') {
        return { ok: false, error: `ops[${i}] flip axis must be 'horizontal' or 'vertical'` };
      }
      out.push({ type: 'flip', axis });
    } else if (type === 'resample') {
      const w = op.w !== undefined ? Number(op.w) : undefined;
      const h = op.h !== undefined ? Number(op.h) : undefined;
      if (w === undefined && h === undefined) {
        return { ok: false, error: `ops[${i}] resample needs at least w or h` };
      }
      for (const [name, v] of [
        ['w', w],
        ['h', h]
      ] as const) {
        if (v === undefined) continue;
        if (!Number.isFinite(v) || v <= 0) {
          return { ok: false, error: `ops[${i}] resample ${name} must be > 0` };
        }
        if (v > MAX_RESAMPLE_PX) {
          return {
            ok: false,
            error: `ops[${i}] resample ${name} must be <= ${MAX_RESAMPLE_PX}`
          };
        }
      }
      const fitRaw = op.fit;
      const fit =
        typeof fitRaw === 'string' && VALID_FITS.has(fitRaw) ? (fitRaw as string) : 'inside';
      const norm: { type: 'resample'; w?: number; h?: number; fit: string } = {
        type: 'resample',
        fit
      };
      if (w !== undefined) norm.w = Math.floor(w);
      if (h !== undefined) norm.h = Math.floor(h);
      out.push(norm);
    } else if (type === 'perspective') {
      // Perspective rectify is a client-only execution path: the
      // canvas pipeline produces the rectified result and uploads it
      // as the bake. Sharp doesn't apply perspective ops; if a render
      // request hits a sidecar with perspective in ops AND the bake is
      // missing, renderDerivative will error out. Validate shape only.
      const corners = op.corners;
      if (!Array.isArray(corners) || corners.length !== 4) {
        return { ok: false, error: `ops[${i}] perspective corners must be an array of 4 points` };
      }
      const normCorners: [number, number][] = [];
      for (let k = 0; k < 4; k++) {
        const c = corners[k];
        if (!Array.isArray(c) || c.length !== 2) {
          return {
            ok: false,
            error: `ops[${i}] perspective corners[${k}] must be a [x, y] pair`
          };
        }
        const x = Number(c[0]);
        const y = Number(c[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          return {
            ok: false,
            error: `ops[${i}] perspective corners[${k}] must be finite numbers`
          };
        }
        if (x < 0 || y < 0) {
          return {
            ok: false,
            error: `ops[${i}] perspective corners[${k}] must be non-negative`
          };
        }
        if (x > MAX_PERSPECTIVE_COORD || y > MAX_PERSPECTIVE_COORD) {
          return {
            ok: false,
            error: `ops[${i}] perspective corners[${k}] must be <= ${MAX_PERSPECTIVE_COORD}`
          };
        }
        normCorners.push([Math.round(x), Math.round(y)]);
      }
      out.push({ type: 'perspective', corners: normCorners });
    } else {
      return {
        ok: false,
        error: `ops[${i}].type must be 'crop' | 'rotate' | 'flip' | 'resample' | 'perspective' (got ${String(type)})`
      };
    }
  }
  return { ok: true, ops: out };
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
    /* ignore — fall through */
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
