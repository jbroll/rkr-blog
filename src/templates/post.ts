// Post page template. Plain template-literal HTML per spec §12.

import { escapeAttr, escapeText } from '../lib/content.ts';

export interface PostPageData {
  title: string;
  slug: string;
  date?: string;
  bodyHtml: string;
}

export function renderPostPage(post: PostPageData): string {
  const dateBlock = post.date
    ? `<time datetime="${escapeAttr(post.date)}">${escapeText(post.date)}</time>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeText(post.title)}</title>
</head>
<body>
<main>
<article>
<header>
<h1>${escapeText(post.title)}</h1>
${dateBlock}
</header>
${post.bodyHtml}
</article>
</main>
</body>
</html>
`;
}
