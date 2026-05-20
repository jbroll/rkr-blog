// POST /:slug/comments — anonymous reader comment submission.
//
// Flow: validate → cheap anti-abuse (honeypot / min-fill-time / length)
// → insert pending row → enqueue a classify job → 303 back to the post.
// The LLM verdict (Task 3) flips pending → published | queued
// asynchronously so the reader never waits on the GPU.

import type { FastifyInstance } from 'fastify';

import { getPostIdBySlug, insertWebComment, setCommentStatus } from '../lib/comments.ts';
import { siteConfig } from '../lib/config.ts';
import type { Db } from '../lib/db.ts';
import { enqueue } from '../lib/jobs.ts';
import { COMMENT_SUBMITTED_NOTICE } from '../templates/comments.ts';

// Both "accepted" outcomes (real success AND silent honeypot reject)
// must be byte-identical so a fetch()-driven bot can't tell it was
// filtered. The site script sets `x-rkr-ajax` to opt into the
// no-flicker JSON reply; everything else gets the no-JS PRG 303.
function accepted(reply: import('fastify').FastifyReply, slug: string, ajax: boolean) {
  return ajax
    ? reply.code(200).send({ ok: true, notice: COMMENT_SUBMITTED_NOTICE })
    : reply.code(303).header('location', `/${slug}?submitted=1#respond`).send();
}

export interface PublicCommentRoutesOpts {
  db: Db;
}

// Submissions completed faster than this after the form rendered are
// almost certainly bots. Not a hard reject (a fast human on a cached
// form is possible) — route them to moderation instead.
const MIN_FILL_MS = 3000;
const MAX = { name: 80, email: 200, body: 5000 };

// Returns true if s contains C0 control chars other than TAB/LF/CR.
// Uses charCodeAt comparisons rather than a regex literal so biome's
// noControlCharactersInRegex rule does not flag it.
function hasCtrlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 8 || c === 11 || c === 12 || (c >= 14 && c <= 31)) return true;
  }
  return false;
}

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
      const ajax = req.headers['x-rkr-ajax'] === '1';

      // Honeypot: a populated `website` field means a bot. Silent
      // success so the bot can't tell it was filtered.
      if (str(body.website) !== '') {
        return accepted(reply, slug, ajax);
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
      if (hasCtrlChars(name)) {
        return reply.code(400).send({ error: 'name contains invalid characters' });
      }
      if (text.includes('\x00')) {
        return reply.code(400).send({ error: 'body contains invalid characters' });
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
        req.log.warn({ err }, 'insertWebComment failed');
        return reply.code(400).send({ error: 'invalid parent_id' });
      }

      // Too-fast fill → straight to moderation, skip the classify job
      // (we already distrust it; don't spend GPU on it).
      const tRaw = Number.parseInt(str(body.t), 10);
      const tooFast = Number.isFinite(tRaw) && tRaw > 0 && Date.now() - tRaw < MIN_FILL_MS;
      if (tooFast) {
        setCommentStatus(db, id, 'queued');
        // Skips the classify job, so notify must be enqueued here for
        // the queued-covering levels (classify-handler handles the
        // non-too-fast path).
        const lvl = siteConfig().commentNotify ?? 'ham';
        if (lvl === 'queued' || lvl === 'all') {
          enqueue(db, { kind: 'notify', payload: { commentId: id } });
        }
      } else {
        enqueue(db, { kind: 'classify', payload: { commentId: id } });
      }

      return accepted(reply, slug, ajax);
    }
  );
}
