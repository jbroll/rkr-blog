// Search results page. Reuses the .post-list chrome; adds a snippet
// line per hit. Header shows the search form only (no sort toggle —
// results are relevance-ranked, not date-ordered).

import { escapeAttr, escapeText } from '../lib/content.ts';
import {
  bundleVersion,
  renderSearchForm,
  type SiteChrome,
  siteFoot,
  siteHead,
  stylesheetLinks
} from './layout.ts';

export interface SearchHit {
  slug: string;
  title: string;
  date?: string;
  /** Trusted, pre-sanitized HTML: escaped snippet text with <mark> spans. */
  snippetHtml: string;
}

export interface SearchPageData extends SiteChrome {
  q: string;
  results: SearchHit[];
  isAdmin?: boolean;
}

export function renderSearchPage(data: SearchPageData): string {
  const v = bundleVersion();
  const head = siteHead(data.site, { isAdmin: data.isAdmin });
  const trimmed = data.q.trim();

  let bodyHtml: string;
  if (trimmed === '') {
    bodyHtml = `<p class="rkr-search-empty">Type a query to search posts.</p>`;
  } else if (data.results.length === 0) {
    bodyHtml = `<p class="rkr-search-empty">No results for “${escapeText(data.q)}”.</p>`;
  } else {
    const items = data.results
      .map((r) => {
        const dateBlock = r.date
          ? `<time datetime="${escapeAttr(r.date)}">${escapeText(r.date)}</time>`
          : '';
        return `  <li><a href="/${escapeAttr(r.slug)}">${escapeText(r.title)}</a>${dateBlock}<p class="rkr-search-snippet">${r.snippetHtml}</p></li>`;
      })
      .join('\n');
    bodyHtml = `<ul class="post-list rkr-search-results">\n${items}\n</ul>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Search — ${escapeText(data.site.title)}</title>
${stylesheetLinks()}
<meta name="theme-color" content="#1a4f7f"/>
<script type="module" src="/static/site/sw-unregister.js${v}" defer></script>
</head>
<body>
${head}<main id="main" tabindex="-1">
<div class="rkr-index-layout rkr-index-layout--has-rail">
<div class="rkr-index-posts">
<h1 class="rkr-index-heading">Search</h1>
${bodyHtml}
</div>
<aside class="rkr-tag-rail">
<div class="rkr-rail-controls">${renderSearchForm(data.q)}</div>
</aside>
</div>
</main>
${siteFoot(data.site, { isAdmin: data.isAdmin })}
</body>
</html>
`;
}
