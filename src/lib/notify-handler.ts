// notify job handler: load comment + post, send the owner a
// plain-text email. Mirrors classify-handler.ts's ctx.db shape +
// defensive-return discipline. Never throws on mail failure (jobs.ts
// has no auto-retry — a thrown handler would sit 'failed' forever).

import { getCommentById, getPostMetaById } from './comments.ts';
import type { Db } from './db.ts';
import type { Mailer } from './mailer.ts';

export interface NotifyPayload {
  commentId: number;
}

export function makeNotifyHandler(
  mailer: Mailer
): (p: NotifyPayload, ctx: { siteRoot: string; [k: string]: unknown }) => Promise<void> {
  return async (payload, ctx) => {
    const db = ctx.db as Db | undefined;
    if (!db) throw new Error('notify handler requires ctx.db');
    const c = getCommentById(db, payload.commentId);
    if (!c || (c.status !== 'published' && c.status !== 'queued')) return;
    const post = getPostMetaById(db, c.post_id);
    if (!post) return;
    const base = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
    const subject =
      c.status === 'queued'
        ? `[moderation] Held comment on "${post.title}" by ${c.author_name}`
        : `New comment on "${post.title}" by ${c.author_name}`;
    const text = [
      `${c.author_name} <${c.author_email}>`,
      `Post: ${post.title}`,
      '',
      c.body,
      '',
      `Comment: ${base}/${post.slug}#comment-${c.id}`,
      `Moderate: ${base}/admin/comments`
    ].join('\n');
    await mailer.sendMail({ to: '', subject, text });
  };
}
