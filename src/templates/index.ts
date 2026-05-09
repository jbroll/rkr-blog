// Index page template. Plain template-literal HTML (spec.md §8 content model).

import { escapeAttr, escapeText } from '../lib/content.ts';
import { type SiteChrome, siteFoot, siteHead } from './layout.ts';

interface IndexEntry {
  slug: string;
  title: string;
  date?: string;
}

export interface IndexPageData extends SiteChrome {
  posts: IndexEntry[];
  page: number;
  totalPages: number;
}

export function renderIndexPage(data: IndexPageData): string {
  const items = data.posts
    .map((p) => {
      const dateBlock = p.date
        ? `<time datetime="${escapeAttr(p.date)}">${escapeText(p.date)}</time>`
        : /* c8 ignore next -- runReindex always supplies published_at on listed posts */ '';
      return `  <li>${dateBlock}<a href="/${escapeAttr(p.slug)}">${escapeText(p.title)}</a></li>`;
    })
    .join('\n');

  const pager =
    data.totalPages > 1
      ? `<nav aria-label="pagination">
  <span>page ${data.page} of ${data.totalPages}</span>
  ${data.page > 1 ? `<a rel="prev" href="/?page=${data.page - 1}">prev</a>` : ''}
  ${data.page < data.totalPages ? `<a rel="next" href="/?page=${data.page + 1}">next</a>` : ''}
</nav>`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeText(data.site.title)}</title>
<link rel="stylesheet" href="/static/site.css"/>
<link rel="manifest" href="/static/manifest.webmanifest"/>
<meta name="theme-color" content="#1a4f7f"/>
</head>
<body>
${siteHead(data.site)}
<main id="main" tabindex="-1">
<h1 class="rkr-index-heading">${escapeText(data.site.title)}</h1>
<ul class="post-list">
${items}
</ul>
${pager}
</main>
${siteFoot(data.site)}
</body>
</html>
`;
}
