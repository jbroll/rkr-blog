// Post page template. Plain template-literal HTML (spec.md §8 content model).

import { escapeAttr, escapeText } from '../lib/content.ts';
import { type SiteChrome, siteFoot, siteHead } from './layout.ts';

export interface PostPageData extends SiteChrome {
  title: string;
  slug: string;
  date?: string;
  bodyHtml: string;
}

export function renderPostPage(post: PostPageData): string {
  const dateBlock = post.date
    ? `<time datetime="${escapeAttr(post.date)}">${escapeText(post.date)}</time>`
    : /* c8 ignore next -- runReindex always supplies published_at */ '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeText(post.title)} — ${escapeText(post.site.title)}</title>
<link rel="stylesheet" href="/static/site.css"/>
<script type="module" src="/static/site/img-retry.js" defer></script>
<script type="module" src="/static/site/lightbox.js" defer></script>
<script type="module" src="/static/site/carousel.js" defer></script>
</head>
<body>
${siteHead(post.site)}
<main id="main" tabindex="-1">
<article>
<header>
<h1>${escapeText(post.title)}</h1>
${dateBlock}
</header>
${post.bodyHtml}
</article>
</main>
${siteFoot(post.site)}
</body>
</html>
`;
}
