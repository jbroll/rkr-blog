// POST /admin/import/url — server-side fetch + ingest from a URL.
//
// Lives separately from src/routes/admin.ts to keep that file under
// the 500-line cap. Registered as a small plugin from the main admin
// routes; closure dependencies (siteRoot, guard, urlFetcher,
// invalidateSidecarListCache) are passed as opts.

import { Readable, Transform } from 'node:stream';

import type { FastifyInstance, RouteShorthandOptions } from 'fastify';

import { parseResizeOverrides } from '../lib/ingest-resize.ts';
import { ingestStream } from '../lib/originals.ts';
import { type SafeFetchOptions, UnsafeUrlError } from '../lib/url-safety.ts';

const URL_FETCH_TIMEOUT_MS = 30_000;
const URL_FETCH_MAX_BYTES = 50 * 1024 * 1024; // 50 MiB per spec.md §10 remote import

export type UrlFetcher = (url: string, opts: SafeFetchOptions) => Promise<Response>;

export interface UrlImportRouteOpts {
  siteRoot: string;
  /** Per-route options spread into the handler — typically a preHandler
   * gate. The parent passes `{ preHandler: requireUser } | {}`
   * depending on opts.requireAuth. */
  guard: RouteShorthandOptions;
  urlFetcher: UrlFetcher;
  /** Drop the parent's sidecar-list cache after a successful ingest. */
  invalidateSidecarListCache: () => void;
}

export function registerUrlImportRoute(fastify: FastifyInstance, opts: UrlImportRouteOpts): void {
  const { siteRoot, guard, urlFetcher, invalidateSidecarListCache } = opts;

  fastify.post<{ Body: { url?: unknown; resize?: unknown } }>(
    '/admin/import/url',
    { ...guard },
    async (request, reply) => {
      const { url, resize: resizeBody } = request.body ?? {};
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
        return reply.code(400).send({ error: 'url must be an http(s) URL' });
      }
      const resize = parseResizeOverrides(resizeBody);

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
        /* c8 ignore start -- timeout / generic-fetch error paths require
           injecting a fetcher that rejects; covered by integration once
           Playwright drives the import flow */
        const msg =
          (err as { name?: string; message?: string }).name === 'AbortError'
            ? 'fetch timed out'
            : `fetch failed: ${(err as Error).message}`;
        return reply.code(400).send({ error: msg });
        /* c8 ignore stop */
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

      /* c8 ignore next 3 -- defensive: fetch() always populates res.body
         on a successful response; covered by integration if a future
         non-standard server omits it */
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
          source: { kind: 'url', originalName: deriveName(url, ct) },
          ...(resize ? { resize } : {})
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
}

function deriveName(url: string, contentType: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').pop() ?? '';
    if (last && /\.[a-z0-9]+$/i.test(last)) return last;
    /* c8 ignore start -- defensive: callers pass URLs that already
       parsed through safeFetch; this catch only fires on a malformed URL
       that slipped past, which our test fixtures don't synthesize */
  } catch {
    // fall through to content-type-derived name
  }
  /* c8 ignore stop */
  const subtype = contentType.split('/')[1]?.split(';')[0]?.trim() ?? 'bin';
  return `import.${subtype}`;
}
