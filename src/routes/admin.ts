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
import { paths } from '../lib/config.ts';
import { parsePost } from '../lib/content.ts';
import { ingestStream } from '../lib/originals.ts';
import { safeFetch } from '../lib/url-safety.ts';
import { renderAdminPage } from '../templates/admin.ts';
import { registerImageLookupRoutes } from './admin-image-lookup.ts';
import { registerUrlImportRoute, type UrlFetcher } from './admin-import-url.ts';
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
      .send(renderAdminPage({ bundleUrl: '/static/admin/main.js' }));
  });

  const { invalidate: invalidateSidecarListCache } = registerImageLookupRoutes(fastify, {
    siteRoot,
    guard
  });

  registerSidecarEditRoutes(fastify, { siteRoot, guard });

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

/** Cap slug length so a 50KB attacker slug can't be written to disk and
 * indexed. The kebab-case regex permits a-z/0-9/-; this just bounds it. */
const MAX_SLUG_LENGTH = 100;

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
