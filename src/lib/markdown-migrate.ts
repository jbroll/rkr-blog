// One-way migration: markdown post (frontmatter + mdast body) to a JSON
// block tree. Frontmatter becomes page fields; the body sequence becomes
// one `flow` node with mixed text/figure/video leaves in page order.
// justify=inline figures map to centered figures (inline is dropped).

import type { Definition, Root, RootContent } from 'mdast';
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
    subtitle?: string;
    [key: string]: unknown;
  };
}

const KNOWN_FIELDS = new Set(['title', 'slug', 'date', 'status', 'tags']);
const TEXT_FIELDS = new Set(['subtitle', 'excerpt']);

// The editor's serializer writes `-` bullets; matching it keeps migrated
// lists editable in place (the round-trip check in unified-shell.ts).
function stringifyOne(node: RootContent): string {
  const root: Root = { type: 'root', children: [node] };
  return String(
    remark()
      .use(remarkFrontmatter, ['yaml'])
      .use(remarkDirective)
      .data('settings', { bullet: '-' })
      .stringify(root)
  ).trim();
}

type MdNode = { type: string; children?: MdNode[] } & Record<string, unknown>;

/** Rewrite reference links and images to inline ones and drop the
 * definitions, so splitting the body into text blocks cannot separate a
 * reference from its definition. Unresolved references stay as written. */
function inlineReferences(ast: Root): void {
  const defs = new Map<string, Definition>();
  const collect = (node: MdNode): void => {
    if (node.type === 'definition') {
      const def = node as unknown as Definition;
      if (!defs.has(def.identifier)) defs.set(def.identifier, def);
    }
    for (const kid of node.children ?? []) collect(kid);
  };
  collect(ast as unknown as MdNode);
  if (defs.size === 0) return;
  const rewrite = (node: MdNode): MdNode | null => {
    if (node.type === 'definition') return null;
    const def =
      node.type === 'linkReference' || node.type === 'imageReference'
        ? defs.get(node.identifier as string)
        : undefined;
    if (def && node.type === 'linkReference') {
      return { type: 'link', url: def.url, title: def.title ?? null, children: node.children };
    }
    if (def && node.type === 'imageReference') {
      return { type: 'image', url: def.url, title: def.title ?? null, alt: node.alt };
    }
    if (node.children) {
      node.children = node.children.map(rewrite).filter((n): n is MdNode => n !== null);
    }
    return node;
  };
  rewrite(ast as unknown as MdNode);
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
 * the frontmatter itself is missing or unparseable. Frontmatter keys the
 * page fields don't name (subtitle, importer provenance) pass through. */
export function migratePostToTree(raw: string): MigratedTree {
  const { frontmatter, ast } = parsePost(raw);
  inlineReferences(ast);
  const blocks = ast.children.flatMap(convertNode);
  const extra = Object.fromEntries(
    Object.entries(frontmatter)
      .filter(([k, v]) => !KNOWN_FIELDS.has(k) && v !== undefined)
      // The save route accepts only string text fields.
      .map(([k, v]) => [k, TEXT_FIELDS.has(k) && typeof v !== 'string' ? String(v) : v])
  );
  return {
    version: 1,
    body: [{ type: 'flow', blocks }],
    fields: {
      ...extra,
      title: frontmatter.title,
      slug: frontmatter.slug,
      ...(typeof frontmatter.date === 'string' ? { date: frontmatter.date } : {}),
      ...(typeof frontmatter.status === 'string' ? { status: frontmatter.status } : {}),
      ...(Array.isArray(frontmatter.tags) ? { tags: frontmatter.tags.map(String) } : {})
    }
  };
}
