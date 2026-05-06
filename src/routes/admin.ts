// Admin routes. Authentication is added in Step 9 — for now these are open.
//
// Routes:
//   GET  /admin/editor      → SPA shell (loads /admin/static/main.js)
//   GET  /admin/static/*    → compiled admin bundle from static/admin/
//   POST /admin/upload      → multipart image ingest (routed to ingestStream)

import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

import { runReindex } from '../cli/reindex.ts';
import { paths } from '../lib/config.ts';
import { ingestStream } from '../lib/originals.ts';
import { type ProseDoc, proseToMarkdown } from '../lib/prose-markdown.ts';
import { renderAdminPage } from '../templates/admin.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Repo layout: src/routes/admin.ts → ../../static/admin
const REPO_ADMIN_BUNDLE_DIR = path.resolve(__dirname, '..', '..', 'static', 'admin');

export interface AdminRoutesOpts {
  siteRoot?: string;
  /**
   * Where the compiled admin bundle lives on disk. Defaults to
   * <repo>/static/admin (the build:admin tsc output).
   */
  adminBundleDir?: string;
}

export default async function adminRoutes(
  fastify: FastifyInstance,
  opts: AdminRoutesOpts = {}
): Promise<void> {
  const siteRoot = opts.siteRoot ?? paths().root;
  const bundleDir = opts.adminBundleDir ?? REPO_ADMIN_BUNDLE_DIR;

  // Static serving for the compiled admin bundle. Only registers if the
  // build directory exists — saves tests from needing to run build:admin.
  if (fs.existsSync(bundleDir)) {
    await fastify.register(fastifyStatic, {
      root: bundleDir,
      prefix: '/admin/static/',
      decorateReply: false
    });
  }

  fastify.get('/admin/editor', async (_req, reply) => {
    return reply
      .type('text/html; charset=utf-8')
      .send(renderAdminPage({ bundleUrl: '/admin/static/main.js' }));
  });

  fastify.post<{
    Body: {
      slug?: unknown;
      title?: unknown;
      status?: unknown;
      date?: unknown;
      body?: unknown;
    };
  }>('/admin/posts', async (request, reply) => {
    const { slug, title, status, date, body } = request.body ?? {};

    if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/i.test(slug)) {
      return reply.code(400).send({ error: 'slug must be a kebab-case identifier' });
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

  fastify.post('/admin/upload', async (request, reply) => {
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

  fastify.post<{ Body: { url?: unknown } }>('/admin/import/url', async (request, reply) => {
    const { url } = request.body ?? {};
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return reply.code(400).send({ error: 'url must be an http(s) URL' });
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), URL_FETCH_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    } catch (err) {
      clearTimeout(timer);
      const msg =
        (err as { name?: string; message?: string }).name === 'AbortError'
          ? 'fetch timed out'
          : `fetch failed: ${(err as Error).message}`;
      return reply.code(400).send({ error: msg });
    }

    if (!res.ok) {
      clearTimeout(timer);
      return reply.code(400).send({ error: `fetch returned ${res.status}` });
    }

    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!/^image\//.test(ct)) {
      clearTimeout(timer);
      return reply.code(415).send({ error: `content-type must be image/*; got ${ct || '(none)'}` });
    }

    const contentLength = Number(res.headers.get('content-length') ?? 0);
    if (contentLength && contentLength > URL_FETCH_MAX_BYTES) {
      clearTimeout(timer);
      return reply.code(413).send({ error: `content-length ${contentLength} exceeds limit` });
    }

    if (!res.body) {
      clearTimeout(timer);
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
    } finally {
      clearTimeout(timer);
    }
  });
}

const URL_FETCH_TIMEOUT_MS = 30_000;
const URL_FETCH_MAX_BYTES = 50 * 1024 * 1024; // 50 MiB per spec §13

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
