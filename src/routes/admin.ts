// Admin routes. Authentication added in Step 7b (social login + sessions).
//
// Routes:
//   GET  /admin/editor       → SPA shell (loads /static/admin/main.js)
//   GET  /static/*           → public + admin static assets (CSS, admin bundle)
//   GET  /admin/preview/:id  → 302 to a derivative URL the editor can <img src>
//   POST /admin/posts        → save editor JSON as a markdown post + reindex
//   POST /admin/upload       → multipart image ingest (routed to ingestStream)
//   POST /admin/import/url   → server-side fetch + ingest from a URL

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
import { ingestStream } from '../lib/originals.ts';
import { listSidecarIds } from '../lib/posts.ts';
import { type ProseDoc, proseToMarkdown } from '../lib/prose-markdown.ts';
import type { OutputFormat } from '../lib/render.ts';
import { read as sidecarRead, write as sidecarWrite } from '../lib/sidecar.ts';
import { type SafeFetchOptions, safeFetch, UnsafeUrlError } from '../lib/url-safety.ts';
import { renderAdminPage } from '../templates/admin.ts';
import imageWidget from '../widgets/image.ts';

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

      const fb = imageWidget.fallback;
      /* c8 ignore next 3 -- imageWidget always declares a fallback */
      if (!fb) return reply.code(500).send({ error: 'no fallback configured' });

      const ophash = cacheKey({
        originalId: fullId,
        ops: sidecar.ops as Parameters<typeof cacheKey>[0]['ops'],
        variant: { w: fb.w },
        output: { format: fb.format as OutputFormat, quality: fb.quality }
      });
      return reply.redirect(`/img/${fullId}.${ophash}.${fb.format}`, 302);
    }
  );

  // Sidecar inspection: returns just the metadata + ops the editor needs
  // for the crop UI. Original-pixel width/height let the cropper scale
  // display coords (from the smaller preview img) back to original coords.
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
        ops: sidecar.ops
      };
    }
  );

  // Replace a sidecar's ops array. Used by the crop UI; future image-
  // edit ops (resample, rotate) extend the same endpoint.
  // Crops live on the SIDECAR, not per-instance: changing a sidecar's
  // ops affects every post that references this image. That's the
  // existing render-pipeline design (sidecar.ops is the source of truth).
  fastify.post<{ Params: { id: string }; Body: { ops?: unknown } }>(
    '/admin/sidecar/:id/ops',
    { ...guard },
    async (req, reply) => {
      const { id } = req.params;
      if (!/^[0-9a-f]{64}$/.test(id)) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      const sidecar = await sidecarRead(siteRoot, id);
      if (!sidecar) return reply.code(404).send({ error: 'no sidecar' });

      const validation = validateOps(req.body?.ops, sidecar.metadata);
      if (!validation.ok) return reply.code(400).send({ error: validation.error });

      sidecar.ops = validation.ops;
      try {
        await sidecarWrite(siteRoot, id, sidecar);
      } catch (err) {
        req.log.error({ err, id }, 'sidecar write failed');
        return reply.code(500).send({ error: 'sidecar write failed' });
      }
      return { ops: sidecar.ops };
    }
  );

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

/** Maximum ops in a sidecar. Caps the chain depth a single editor save
 * can install — defends against a malicious / runaway client building
 * a million-step pipeline that the renderer would have to execute. */
const MAX_OPS = 8;

interface ValidatedOps {
  ok: true;
  ops: { type: string; [k: string]: unknown }[];
}
type OpsValidation = ValidatedOps | { ok: false; error: string };

/**
 * Validate the body's `ops` array and clamp it against the source's
 * actual pixel bounds. Currently supports only the `crop` op shape
 * (the only op the editor's crop UI emits today); resample/rotate land
 * here when their UIs ship.
 */
function validateOps(raw: unknown, metadata: { width?: number; height?: number }): OpsValidation {
  if (!Array.isArray(raw)) return { ok: false, error: 'ops must be an array' };
  if (raw.length > MAX_OPS) return { ok: false, error: `at most ${MAX_OPS} ops` };

  const W = metadata.width ?? 0;
  const H = metadata.height ?? 0;

  const out: { type: string; [k: string]: unknown }[] = [];
  for (const [i, opRaw] of raw.entries()) {
    if (!opRaw || typeof opRaw !== 'object') {
      return { ok: false, error: `ops[${i}] must be an object` };
    }
    const op = opRaw as Record<string, unknown>;
    if (op.type !== 'crop') {
      return { ok: false, error: `ops[${i}].type must be 'crop' (got ${String(op.type)})` };
    }
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
  }
  return { ok: true, ops: out };
}

/**
 * CSP for /admin/editor. TipTap is now bundled into the admin entry by
 * esbuild (no esm.sh / CDN at runtime), so script-src can be 'self' only
 * with no third-party allowance and no `'unsafe-inline'`. Inline styles
 * still need `'unsafe-inline'` for the template's <style> block (move
 * to a nonce when we drop template-literal HTML).
 */
const ADMIN_EDITOR_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
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
