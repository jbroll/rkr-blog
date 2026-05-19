// The `classify` job handler. Glue between comments.ts (DB) and
// spam-classifier.ts (HTTP). Fail-safe: any classifier error resolves
// the comment to 'queued' (human review) and the job completes
// normally — an unscored comment must never auto-publish, and a
// thrown job would just sit 'failed' with no retry (jobs.ts has no
// auto-retry; the classifier already retried internally).

import { applyClassification, getCommentById } from './comments.ts';
import { siteConfig } from './config.ts';
import type { Db } from './db.ts';
import { type ClassifyConfig, classifyComment, type SpamVerdict } from './spam-classifier.ts';

// Injected rather than imported from jobs.ts: jobs.ts imports this
// module for makeClassifyHandler, so importing `enqueue` back would
// create a jobs↔classify-handler cycle (the circular gate fails).
// jobs.ts passes its own `enqueue` when wiring DEFAULT_HANDLERS;
// `enqueue` is structurally assignable to this narrow type.
type NotifyEnqueue = (db: Db, job: { kind: 'notify'; payload: { commentId: number } }) => unknown;

/** Enqueue a notify job iff the operator's commentNotify level
 * (default 'ham') covers this resolved status. Gating at enqueue
 * keeps dead jobs out of the queue. */
function maybeNotify(
  enqueueJob: NotifyEnqueue,
  db: Db,
  commentId: number,
  status: 'published' | 'queued'
): void {
  const lvl = siteConfig().commentNotify ?? 'ham';
  const want =
    (status === 'published' && (lvl === 'ham' || lvl === 'all')) ||
    (status === 'queued' && (lvl === 'queued' || lvl === 'all'));
  if (want) enqueueJob(db, { kind: 'notify', payload: { commentId } });
}

export interface ClassifyPayload {
  commentId: number;
}

export type Classifier = (input: {
  authorName: string;
  authorEmail: string;
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
 * `ctx.db`, which `server.ts`'s worker populates. */
export function makeClassifyHandler(
  classifier: Classifier,
  enqueueJob: NotifyEnqueue
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
        body: comment.body
      });
      const status = v.verdict === 'ham' ? 'published' : 'queued';
      const applied = applyClassification(db, payload.commentId, {
        status,
        score: v.score,
        reason: v.reason
      });
      if (applied) maybeNotify(enqueueJob, db, payload.commentId, status);
    } catch (err) {
      const applied = applyClassification(db, payload.commentId, {
        status: 'queued',
        score: null,
        // cap the stored reason at a tweet-ish length (audit only)
        reason: `classify failed: ${(err as Error).message}`.slice(0, 280)
      });
      if (applied) maybeNotify(enqueueJob, db, payload.commentId, 'queued');
    }
  };
}
