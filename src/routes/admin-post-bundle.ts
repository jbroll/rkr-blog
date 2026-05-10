// GET /admin/post-bundle/:slug?manifest=1 (spec-offline §6) —
// manifest the offline-pin flow uses to populate OPFS. Originals
// fetch separately via /admin/original/:id so a flaky connection
// can resume one image at a time.

import fs from 'node:fs';
import path from 'node:path';

import type { FastifyInstance, RouteShorthandOptions } from 'fastify';

import { parsePost } from '../lib/content.ts';
import { FORMAT_TO_EXT } from '../lib/image-constants.ts';
import { originalPath } from '../lib/originals.ts';
import { listSidecarIds, scanPostForImageIds } from '../lib/posts.ts';
import { read as sidecarRead } from '../lib/sidecar.ts';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;
const MAX_SLUG_LENGTH = 100;

export interface PostBundleRouteOpts {
  siteRoot: string;
  guard: RouteShorthandOptions;
}

export function registerPostBundleRoutes(
  fastify: FastifyInstance,
  opts: PostBundleRouteOpts
): void {
  const { siteRoot, guard } = opts;
  fastify.get<{ Params: { slug: string }; Querystring: { manifest?: string } }>(
    '/admin/post-bundle/:slug',
    { ...guard },
    async (request, reply) => {
      const slug = request.params.slug;
      if (!SLUG_RE.test(slug) || slug.length > MAX_SLUG_LENGTH) {
        return reply.code(400).send({ error: 'invalid slug' });
      }
      // Reject anything other than ?manifest=1 so a typo doesn't
      // silently return partial data.
      if (request.query.manifest !== '1') {
        return reply.code(400).send({ error: 'only ?manifest=1 is supported' });
      }
      const filePath = path.join(siteRoot, 'content', 'posts', `${slug}.md`);
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reply.code(404).send({ error: 'post not found' });
        }
        /* v8 ignore next 2 -- non-ENOENT stat failure */
        throw err;
      }
      const raw = await fs.promises.readFile(filePath, 'utf8');
      const parsed = parsePost(raw);
      const fm = parsed.frontmatter;
      const markdown = stripFrontmatter(raw);

      const knownIds = new Set(listSidecarIds(siteRoot));
      const refIds = scanPostForImageIds(markdown, knownIds);

      const originals: { id: string; ext: string; bytes: number }[] = [];
      const sidecars: { id: string; json: unknown }[] = [];
      for (const id of [...refIds].sort()) {
        const sc = await sidecarRead(siteRoot, id);
        if (!sc) continue;
        sidecars.push({ id, json: sc });
        // Path-traversal safety hinges on the FORMAT_TO_EXT
        // allowlist: a malformed format falls through to undefined
        // and we skip the original.
        const fmt = sc.metadata.format;
        const ext = fmt ? FORMAT_TO_EXT[fmt] : undefined;
        if (!fmt || !ext) continue;
        try {
          const ostat = await fs.promises.stat(originalPath(siteRoot, id, ext));
          originals.push({ id, ext, bytes: ostat.size });
        } catch {
          /* sidecar without original; client treats as ops-only */
        }
      }

      return {
        slug,
        title: fm.title,
        status: fm.status,
        date: fm.date,
        lastModified: new Date(stat.mtimeMs).toISOString(),
        markdown,
        originals,
        sidecars
      };
    }
  );
}

const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n([\s\S]*)$/;
function stripFrontmatter(raw: string): string {
  const m = FRONTMATTER_RE.exec(raw);
  return m ? (m[1] as string) : raw;
}
