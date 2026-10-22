// One-way migration: markdown post (frontmatter + mdast body) to a JSON
// block tree. Frontmatter becomes page fields; the body sequence becomes
// one `flow` node with mixed text/figure/video leaves in page order.
// justify=inline figures map to centered figures (inline is dropped).

import type { Root, RootContent } from 'mdast';
import { remark } from 'remark';
import remarkDirective from 'remark-directive';
import remarkFrontmatter from 'remark-frontmatter';
import type { BlockNode, BlockTree } from './blocks.ts';
import { parsePost } from './content.ts';
import type { DirectiveNode } from './widgets.ts';

export interface MigratedTree extends BlockTree {
  fields: {
    title: string;
    slug: string;
    date?: string;
    status?: string;
    tags?: string[];
  };
}

function stringifyOne(node: RootContent): string {
  const root: Root = { type: 'root', children: [node] };
  return String(
    remark().use(remarkFrontmatter, ['yaml']).use(remarkDirective).stringify(root)
  ).trim();
}

function directiveSlots(node: DirectiveNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(node.attributes ?? {})) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function convertDirective(node: DirectiveNode): BlockNode {
  const slots = directiveSlots(node);
  if (node.name === 'figure') {
    if (slots.justify === 'inline') slots.justify = 'center';
    return { type: 'figure', slots };
  }
  if (node.name === 'video') return { type: 'video', slots };
  // Unknown directives survive as visible text; the renderer never throws.
  return { type: 'text', markdown: stringifyOne(node as unknown as RootContent) };
}

function convertNode(node: RootContent): BlockNode[] {
  if (node.type === 'yaml') return [];
  if (node.type === 'leafDirective' || node.type === 'textDirective') {
    return [convertDirective(node as unknown as DirectiveNode)];
  }
  if (node.type === 'containerDirective') {
    const inner = (node as unknown as { children: RootContent[] }).children ?? [];
    // Old markdown has no sections; nest converted content directly.
    return [{ type: 'section', children: inner.flatMap(convertNode) }];
  }
  if (node.type === 'html') return [{ type: 'text', markdown: (node as { value: string }).value }];
  const md = stringifyOne(node);
  if (!md) return [];
  return [{ type: 'text', markdown: md }];
}

/** Migrate one raw markdown post to a JSON block tree. Throws only when
 * the frontmatter itself is missing or unparseable. */
export function migratePostToTree(raw: string): MigratedTree {
  const { frontmatter, ast } = parsePost(raw);
  const blocks = ast.children.flatMap(convertNode);
  return {
    version: 1,
    body: [{ type: 'flow', blocks }],
    fields: {
      title: frontmatter.title,
      slug: frontmatter.slug,
      ...(typeof frontmatter.date === 'string' ? { date: frontmatter.date } : {}),
      ...(typeof frontmatter.status === 'string' ? { status: frontmatter.status } : {}),
      ...(Array.isArray(frontmatter.tags) ? { tags: frontmatter.tags as string[] } : {})
    }
  };
}
