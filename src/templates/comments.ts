// Comment list + submission form. Template-literal HTML (spec.md §8).
// All user-controlled text goes through escapeText/escapeAttr. The
// form works without JS (native POST → 303 redirect); site JS may
// enhance it later but is not required.

import type { ThreadComment } from '../lib/comments.ts';
import { escapeAttr, escapeText } from '../lib/content.ts';

function authorHtml(name: string, url: string | null): string {
  const safeName = escapeText(name);
  if (!url) return safeName;
  // Only http/https author URLs become links; anything else renders as text.
  if (!/^https?:\/\//i.test(url)) return safeName;
  return `<a href="${escapeAttr(url)}" rel="nofollow ugc noopener" target="_blank">${safeName}</a>`;
}

function commentItem(c: ThreadComment, withReplies: boolean): string {
  const replies =
    withReplies && c.replies.length > 0
      ? `<ol class="rkr-comment-replies">${c.replies
          .map((r) => commentItem(r, false))
          .join('')}</ol>`
      : '';
  return `<li class="rkr-comment" id="comment-${c.id}">
<div class="rkr-comment-meta">${authorHtml(c.author_name, c.author_url)} · <time datetime="${escapeAttr(
    c.created_at
  )}">${escapeText(c.created_at.slice(0, 10))}</time></div>
<div class="rkr-comment-body">${escapeText(c.body)}</div>
${replies}</li>`;
}

export function renderCommentList(thread: ThreadComment[]): string {
  if (thread.length === 0) {
    return `<section class="rkr-comments" id="comments"><h2>Comments</h2><p class="rkr-comments-empty">No comments yet — be the first.</p></section>`;
  }
  const items = thread.map((c) => commentItem(c, true)).join('');
  return `<section class="rkr-comments" id="comments"><h2>Comments</h2><ol class="rkr-comment-list">${items}</ol></section>`;
}

export interface CommentFormOpts {
  /** Pre-fill parent_id for a reply. */
  replyTo?: number;
  /** Notice to show above the form (e.g. after a submit redirect). */
  notice?: string;
}

export function renderCommentForm(slug: string, opts: CommentFormOpts = {}): string {
  const notice = opts.notice
    ? `<p class="rkr-comment-notice" role="status">${escapeText(opts.notice)}</p>`
    : '';
  const parent =
    opts.replyTo !== undefined
      ? `<input type="hidden" name="parent_id" value="${escapeAttr(String(opts.replyTo))}"/>`
      : '';
  // Honeypot: real browsers leave `website` empty (hidden via CSS in the
  // theme; the field is also aria-hidden + autocomplete=off). `t` is the
  // render time in ms — submissions faster than the server threshold are
  // treated as bots. Both are defence-in-depth before the LLM check.
  return `<section class="rkr-comment-form-wrap" id="respond">
<h2>Leave a comment</h2>
${notice}
<form class="rkr-comment-form" method="POST" action="/${escapeAttr(slug)}/comments">
${parent}
<input type="hidden" name="t" value="${Date.now()}"/>
<div class="rkr-hp" aria-hidden="true">
  <label>Website<input type="text" name="website" tabindex="-1" autocomplete="off"/></label>
</div>
<label>Name<input type="text" name="name" required maxlength="80"/></label>
<label>Email (never shown)<input type="email" name="email" required maxlength="200"/></label>
<label>Website (optional)<input type="url" name="url" maxlength="200"/></label>
<label>Comment<textarea name="body" required rows="5" maxlength="5000"></textarea></label>
<button type="submit">Post comment</button>
</form>
</section>`;
}
