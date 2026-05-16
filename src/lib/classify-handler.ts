// The `classify` job handler. Glue between comments.ts (DB) and
// spam-classifier.ts (HTTP). Fail-safe: any classifier error resolves
// the comment to 'queued' (human review) and the job completes
// normally — an unscored comment must never auto-publish, and a
// thrown job would just sit 'failed' with no retry (jobs.ts has no
// auto-retry; the classifier already retried internally).

import { applyClassification, getCommentById } from './comments.ts';
import type { Db } from './db.ts';
import { type ClassifyConfig, classifyComment, type SpamVerdict } from './spam-classifier.ts';

export interface ClassifyPayload {
  commentId: number;
}

export type Classifier = (input: {
  authorName: string;
  authorEmail: string;
  authorUrl: string | null;
  body: string;
}) => Promise<SpamVerdict>;

/** Build the env-backed production classifier. Reads config lazily so
 * importing this module has no side effects and tests can bypass it. */
export function envClassifier(): Classifier {
  const cfg: Omit<ClassifyConfig, 'fetcher'> = {
    baseUrl: process.env.OLLAMA_BASE_URL ?? '',
    token: process.env.OLLAMA_TOKEN ?? '',
    model: process.env.SPAM_MODEL ?? 'llama3.2:3b',
    timeoutMs: Number(process.env.SPAM_TIMEOUT_MS ?? 8000),
    maxAttempts: Number(process.env.SPAM_MAX_ATTEMPTS ?? 3)
  };
  return (input) => classifyComment(input, cfg);
}

/** Create a classify handler around a Classifier. The handler reads
 * `ctx.db` (server.ts + cli/render.ts both put the Db in ctx). */
export function makeClassifyHandler(
  classifier: Classifier
): (payload: ClassifyPayload, ctx: { siteRoot: string; [k: string]: unknown }) => Promise<void> {
  return async (payload, ctx) => {
    const db = ctx.db as Db | undefined;
    if (!db) throw new Error('classify handler requires ctx.db');
    const comment = getCommentById(db, payload.commentId);
    if (!comment || comment.status !== 'pending') return;
    try {
      const v = await classifier({
        authorName: comment.author_name,
        authorEmail: comment.author_email,
        authorUrl: comment.author_url,
        body: comment.body
      });
      applyClassification(db, payload.commentId, {
        status: v.verdict === 'ham' ? 'published' : 'queued',
        score: v.score,
        reason: v.reason
      });
    } catch (err) {
      applyClassification(db, payload.commentId, {
        status: 'queued',
        score: null,
        reason: `classify failed: ${(err as Error).message}`.slice(0, 280)
      });
    }
  };
}
