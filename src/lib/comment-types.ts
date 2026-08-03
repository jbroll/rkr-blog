// Comment shapes the templates render. Separate from lib/comments.ts
// so a browser-side renderer doesn't pull db.ts into its type program.

export interface ThreadComment {
  id: number;
  author_name: string;
  body: string;
  created_at: string;
  replies: ThreadComment[];
}

/** Total comments in a published thread (top-level + their one-level
 * replies). Replies never nest deeper (one-level threading invariant),
 * so a single pass suffices. */
export function countThread(thread: ThreadComment[]): number {
  return thread.reduce((n, c) => n + 1 + c.replies.length, 0);
}
