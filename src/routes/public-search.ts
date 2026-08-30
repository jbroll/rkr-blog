// GET /search — full-text search over posts_fts (migration 006).
// Split out of public.ts so that file stays under the 500-line cap.

import type { FastifyInstance } from 'fastify';

import type { SiteConfig } from '../lib/config.ts';
import { escapeText } from '../lib/content.ts';
import type { Db } from '../lib/db.ts';
import { buildFtsMatch } from '../lib/search-query.ts';
import { setPublicSecurityHeaders } from '../lib/security-headers.ts';
import { serverAssets } from '../lib/site-assets.ts';
import { renderSearchPage, type SearchHit } from '../templates/search.ts';

// snippet() wraps matches in sentinel chars (from the SQL char(1) /
// char(2) args = U+0001 / U+0002). Escape the whole string FIRST,
// THEN swap the (escaping-untouched) sentinels for <mark> — a literal
// "<mark>" in body text cannot be injected.
const SNIP_OPEN = String.fromCharCode(1);
const SNIP_CLOSE = String.fromCharCode(2);
function highlightSnippet(snip: string): string {
  return escapeText(snip).split(SNIP_OPEN).join('<mark>').split(SNIP_CLOSE).join('</mark>');
}

export interface PublicSearchRouteOpts {
  db: Db;
  getSite: () => SiteConfig;
}

export function registerPublicSearchRoute(
  fastify: FastifyInstance,
  opts: PublicSearchRouteOpts
): void {
  const { db, getSite } = opts;

  // Probe once at registration time: is the FTS table present?
  // If migration 006 has not run, posts_fts doesn't exist and the probe
  // throws — we set ftsAvailable=false and skip the query entirely (graceful
  // empty results, no error). If the table exists but a later query fails
  // (corrupt index, etc.) that error propagates to the global error handler.
  //
  // Self-healing: when cached false, re-probe inside the request handler so a
  // runtime runReindex (admin reindex) that creates posts_fts on the same db
  // is picked up without a process restart. Once true, never probe again.
  let ftsAvailable = false;
  try {
    db.prepare('SELECT 1 FROM posts_fts LIMIT 0').all();
    ftsAvailable = true;
  } catch {
    // posts_fts not yet migrated — degrade to no-results silently.
  }

  fastify.get<{ Querystring: { q?: string } }>('/search', async (req, reply) => {
    const site = getSite();
    const isAdmin = !!req.user;
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const match = buildFtsMatch(q);

    // Lazy re-probe: if cached false, check once per request whether FTS has
    // since been created (e.g. by a runtime runReindex). On success flip the
    // cache to true so subsequent requests skip the probe entirely.
    if (!ftsAvailable) {
      try {
        db.prepare('SELECT 1 FROM posts_fts LIMIT 0').all();
        ftsAvailable = true;
      } catch {
        // Still not migrated — stay false and return graceful empty below.
      }
    }

    let results: SearchHit[] = [];
    if (ftsAvailable && match) {
      const rows = db
        .prepare<{
          slug: string;
          title: string;
          published_at: string | null;
          snip: string;
        }>(
          `SELECT p.slug AS slug, p.title AS title, p.published_at AS published_at,
                    snippet(posts_fts, 3, char(1), char(2), '…', 12) AS snip
               FROM posts_fts
               JOIN posts p ON p.slug = posts_fts.slug
              WHERE posts_fts MATCH ?
                AND (p.status = 'published' OR ? = 1)
              ORDER BY bm25(posts_fts, 0.0, 10.0, 5.0, 1.0)
              LIMIT 50`
        )
        .all(match, isAdmin ? 1 : 0);
      results = rows.map((r) => ({
        slug: r.slug,
        title: r.title,
        ...(r.published_at ? { date: r.published_at.slice(0, 10) } : {}),
        snippetHtml: highlightSnippet(r.snip)
      }));
    }

    setPublicSecurityHeaders(reply);
    if (isAdmin) reply.header('Cache-Control', 'private, no-store');
    return reply
      .type('text/html; charset=utf-8')
      .send(renderSearchPage({ site, assets: serverAssets(), q, results, isAdmin }));
  });
}
