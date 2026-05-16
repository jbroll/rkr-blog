// POST /:slug/comments — anonymous reader comment submission.
//
// Flow: validate → cheap anti-abuse (honeypot / min-fill-time / length)
// → insert pending row → enqueue a classify job → 303 back to the post.
// The LLM verdict (Task 3) flips pending → published | queued
// asynchronously so the reader never waits on the GPU.

import type { FastifyInstance } from 'fastify';

import { getPostIdBySlug, insertWebComment, setCommentStatus } from '../lib/comments.ts';
import type { Db } from '../lib/db.ts';
import { enqueue } from '../lib/jobs.ts';

export interface PublicCommentRoutesOpts {
  db: Db;
}

// Submissions completed faster than this after the form rendered are
// almost certainly bots. Not a hard reject (a fast human on a cached
// form is possible) — route them to moderation instead.
const MIN_FILL_MS = 3000;
const MAX = { name: 80, email: 200, body: 5000 };

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function registerPublicCommentRoutes(
  fastify: FastifyInstance,
  opts: PublicCommentRoutesOpts
): void {
  const { db } = opts;

  fastify.post<{
    Params: { slug: string };
    Body: Record<string, unknown>;
  }>(
    '/:slug/comments',
    { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const { slug } = req.params;
      const body = req.body ?? {};

      // Honeypot: a populated `website` field means a bot. Silent
      // success (303) so the bot can't tell it was filtered.
      if (str(body.website) !== '') {
        return reply.code(303).header('location', `/${slug}?submitted=1#respond`).send();
      }

      const postId = getPostIdBySlug(db, slug);
      if (postId === null) {
        return reply.code(404).send({ error: 'post not found' });
      }

      const name = str(body.name);
      const email = str(body.email);
      const text = str(body.body);

      if (!name || !email || !text) {
        return reply.code(400).send({ error: 'name, email and body are required' });
      }
      if (name.length > MAX.name || email.length > MAX.email || text.length > MAX.body) {
        return reply.code(400).send({ error: 'a field exceeds its maximum length' });
      }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return reply.code(400).send({ error: 'invalid email' });
      }

      // Optional reply target. Must parse to a positive int; the
      // top-level-parent rule is enforced in insertWebComment.
      let parentId: number | null = null;
      const rawParent = str(body.parent_id);
      if (rawParent !== '') {
        const n = Number.parseInt(rawParent, 10);
        if (!Number.isInteger(n) || n <= 0) {
          return reply.code(400).send({ error: 'invalid parent_id' });
        }
        parentId = n;
      }

      let id: number;
      try {
        id = insertWebComment(db, {
          postId,
          parentId,
          authorName: name,
          authorEmail: email,
          body: text,
          ip: req.ip ?? null
        });
      } catch (err) {
        // Bad parent (not found / not top-level) — treat as client error.
        return reply.code(400).send({ error: (err as Error).message });
      }

      // Too-fast fill → straight to moderation, skip the classify job
      // (we already distrust it; don't spend GPU on it).
      const tRaw = Number.parseInt(str(body.t), 10);
      const tooFast = Number.isFinite(tRaw) && tRaw > 0 && Date.now() - tRaw < MIN_FILL_MS;
      if (tooFast) {
        setCommentStatus(db, id, 'queued');
      } else {
        enqueue(db, { kind: 'classify', payload: { commentId: id } });
      }

      return reply.code(303).header('location', `/${slug}?submitted=1#respond`).send();
    }
  );
}
