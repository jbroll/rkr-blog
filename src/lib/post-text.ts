// Plain-text extraction from a post's mdast tree, for the search
// index. Skips frontmatter, directive nodes (::figure family), and
// fenced code blocks; keeps prose, headings, and inline code. Pure —
// mirrors the walker style of teaser-truncate.ts.

import type { Nodes, Root } from 'mdast';

const SKIP_TYPES: ReadonlySet<string> = new Set([
  'yaml',
  'code',
  'leafDirective',
  'containerDirective',
  'textDirective'
]);

export function extractPlainText(ast: Root): string {
  const out: string[] = [];

  function walk(node: Nodes): void {
    if (SKIP_TYPES.has(node.type)) return;
    if (node.type === 'text' || node.type === 'inlineCode') {
      const v = (node as { value: string }).value.trim();
      if (v) out.push(v);
      return;
    }
    if ('children' in node && Array.isArray(node.children)) {
      for (const child of node.children as Nodes[]) walk(child);
    }
  }

  walk(ast);
  return out.join(' ');
}
