// Post page template. Plain template-literal HTML (spec.md §8 content model).

import { countThread, type ThreadComment } from '../lib/comments.ts';
import { escapeAttr, escapeText } from '../lib/content.ts';
import { renderCommentForm, renderCommentList } from './comments.ts';
import { icon } from './icons.ts';
import {
  bundleVersion,
  postAdminFab,
  type SiteChrome,
  siteFoot,
  siteHead,
  stylesheetLinks
} from './layout.ts';

export interface PostPageData extends SiteChrome {
  title: string;
  /** Optional secondary heading rendered under <h1>. */
  subtitle?: string;
  slug: string;
  date?: string;
  bodyHtml: string;
  /** Full-bleed banner rendered between the site header and <main>.
   * Populated when the post's first element is a ::figure directive. */
  bannerHtml?: string;
  /** Logged-in admin → render admin strip with an "Edit this post"
   * link in siteHead. */
  isAdmin?: boolean;
  /** Published comment thread for this post. */
  comments?: ThreadComment[];
  /** Notice shown above the comment form (e.g. after a no-JS submit redirect). */
  commentNotice?: string;
  /** When false, render the page with no comment bubble, list, or
   * form (used by the static /about page). Default true. */
  showComments?: boolean;
}

export function renderPostPage(post: PostPageData): string {
  const dateBlock = post.date
    ? `<time datetime="${escapeAttr(post.date)}">${escapeText(post.date)}</time>`
    : /* c8 ignore next -- runReindex always supplies published_at */ '';
  const subtitleBlock = post.subtitle
    ? `<p class="rkr-post-subtitle">${escapeText(post.subtitle)}</p>`
    : '';

  const commentCount = countThread(post.comments ?? []);
  const bubbleLabel =
    commentCount === 0
      ? 'Leave a comment — jump to comment form'
      : `${commentCount} comment${commentCount === 1 ? '' : 's'} — jump to comment form`;
  const commentBubble = `<a class="rkr-comment-bubble" href="#respond" aria-label="${escapeAttr(
    bubbleLabel
  )}">${icon('comment', 36)}<span class="rkr-comment-bubble-count">${
    commentCount > 0 ? commentCount : ''
  }</span></a>`;

  const commentsBlock = `${renderCommentList(post.comments ?? [])}\n${renderCommentForm(post.slug, post.commentNotice ? { notice: post.commentNotice } : {})}`;
  const showComments = post.showComments !== false;
  const v = bundleVersion();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeText(post.title)} — ${escapeText(post.site.title)}</title>
${stylesheetLinks()}
<link rel="stylesheet" href="/static/site/lightbox.css${v}"/>
<link rel="manifest" href="/static/manifest.webmanifest"/>
<meta name="theme-color" content="#1a4f7f"/>
<script type="module" src="/static/site/sw-register.js${v}" defer></script>
<script type="module" src="/static/site/img-retry.js${v}" defer></script>
<script type="module" src="/static/site/lightbox.js${v}" defer></script>
<script type="module" src="/static/site/carousel.js${v}" defer></script>
<script type="module" src="/static/site/copy-link.js${v}" defer></script>
<script type="module" src="/static/site/comment-form.js${v}" defer></script>
</head>
<body>
${siteHead(post.site, { isAdmin: post.isAdmin })}
${post.bannerHtml ?? ''}<main id="main" tabindex="-1">
<article>
<header>
<h1>${escapeText(post.title)}<button type="button" class="rkr-post-copylink" title="Copy link" aria-label="Copy link">${icon('copy', 16)}</button></h1>
${subtitleBlock}
${dateBlock}
${showComments ? commentBubble : ''}
</header>
${post.bodyHtml}
</article>
${showComments ? commentsBlock : ''}
</main>
${siteFoot(post.site, { isAdmin: post.isAdmin })}
${post.isAdmin ? postAdminFab(post.slug) : ''}
</body>
</html>
`;
}
