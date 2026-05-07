// Post markdown read/parse/serialize + HTML rendering.
// See spec.md §8 (content model) and implementation.md §13 (sample fixtures).
//
// Round-trip notes (implementation.md §11 Step 5):
//   - Frontmatter content survives parse → stringify exactly.
//   - Directive attribute syntax is normalized by remark-directive:
//       `id=abcd1234` → `#abcd1234`     (id shorthand)
//       `layout=masonry` → `layout="masonry"` (always quoted)
//     Both forms parse to the same attributes; we treat this as the
//     "differs only in whitespace/syntax normalization" case the spec
//     allows. Tests assert *attribute* round-trip, not byte-identical.

import type {
  Heading,
  InlineCode,
  Link,
  List,
  ListItem,
  Image as MdImage,
  Paragraph,
  Parent,
  PhrasingContent,
  Root,
  RootContent,
  Text,
  Yaml
} from 'mdast';
import { remark } from 'remark';
import remarkDirective from 'remark-directive';
import remarkFrontmatter from 'remark-frontmatter';
import { parse as yamlParse } from 'yaml';

import { safeLinkUrl } from './safe-url.ts';
import type { WidgetRegistry } from './widgets.ts';

export { safeLinkUrl };

export interface PostFrontmatter {
  title: string;
  slug: string;
  date?: string;
  status?: 'draft' | 'published';
  tags?: string[];
  [k: string]: unknown;
}

export interface ParsedPost {
  frontmatter: PostFrontmatter;
  ast: Root;
}

export interface RenderCtx {
  siteRoot: string;
  widgets: WidgetRegistry;
}

interface DirectiveNode extends Parent {
  type: 'leafDirective' | 'textDirective' | 'containerDirective';
  name: string;
  attributes?: Record<string, string | null | undefined>;
  children: PhrasingContent[];
}

const DIRECTIVE_TYPES: ReadonlySet<string> = new Set([
  'leafDirective',
  'textDirective',
  'containerDirective'
]);

function makeProcessor() {
  return remark().use(remarkFrontmatter, ['yaml']).use(remarkDirective);
}

/** Parse a raw markdown string into frontmatter + mdast. */
export function parsePost(raw: string): ParsedPost {
  const ast = makeProcessor().parse(raw) as Root;

  let frontmatter: PostFrontmatter | undefined;
  for (const node of ast.children) {
    if (node.type === 'yaml') {
      const parsed = yamlParse((node as Yaml).value) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('parsePost: frontmatter is not a YAML mapping');
      }
      frontmatter = parsed as PostFrontmatter;
      break;
    }
  }
  if (!frontmatter) {
    throw new Error('parsePost: missing YAML frontmatter');
  }
  if (typeof frontmatter.title !== 'string' || typeof frontmatter.slug !== 'string') {
    throw new Error('parsePost: frontmatter must declare title and slug as strings');
  }

  return { frontmatter, ast };
}

/** Serialize a parsed post back to markdown. See round-trip notes above. */
export function serializePost(parsed: ParsedPost): string {
  return String(makeProcessor().stringify(parsed.ast));
}

/** Render the post body (everything after frontmatter) to HTML. */
export async function renderPostHtml(ast: Root, ctx: RenderCtx): Promise<string> {
  let out = '';
  for (const node of ast.children) {
    if (node.type === 'yaml') continue;
    out += await renderBlock(node, ctx);
  }
  return out;
}

async function renderBlock(node: RootContent, ctx: RenderCtx): Promise<string> {
  if (DIRECTIVE_TYPES.has(node.type)) {
    return ctx.widgets.dispatch((node as DirectiveNode).name, node as DirectiveNode, ctx);
  }
  switch (node.type) {
    case 'paragraph':
      return `<p>${await renderInline((node as Paragraph).children, ctx)}</p>\n`;
    case 'heading': {
      const h = node as Heading;
      return `<h${h.depth}>${await renderInline(h.children, ctx)}</h${h.depth}>\n`;
    }
    case 'list': {
      const list = node as List;
      const tag = list.ordered ? 'ol' : 'ul';
      let inner = '';
      for (const item of list.children) {
        inner += await renderListItem(item, ctx);
      }
      return `<${tag}>\n${inner}</${tag}>\n`;
    }
    case 'blockquote': {
      const q = node as Parent;
      let inner = '';
      for (const child of q.children) inner += await renderBlock(child as RootContent, ctx);
      return `<blockquote>\n${inner}</blockquote>\n`;
    }
    case 'code': {
      const c = node as { type: 'code'; lang?: string | null; value: string };
      const langAttr = c.lang ? ` class="language-${escapeAttr(c.lang)}"` : '';
      return `<pre><code${langAttr}>${escapeText(c.value)}</code></pre>\n`;
    }
    case 'thematicBreak':
      return '<hr/>\n';
    case 'html':
      // Trust authored HTML in posts (single-author site).
      return `${(node as { value: string }).value}\n`;
    default:
      return '';
  }
}

async function renderListItem(item: ListItem, ctx: RenderCtx): Promise<string> {
  let inner = '';
  for (const child of item.children) {
    inner += await renderBlock(child as RootContent, ctx);
  }
  // Strip a wrapping <p>...</p> when the list item has a single paragraph child.
  const stripped = inner.replace(/^<p>([\s\S]*?)<\/p>\n$/, '$1');
  return `<li>${stripped}</li>\n`;
}

async function renderInline(nodes: PhrasingContent[], ctx: RenderCtx): Promise<string> {
  let out = '';
  for (const n of nodes) out += await renderInlineOne(n, ctx);
  return out;
}

async function renderInlineOne(node: PhrasingContent, ctx: RenderCtx): Promise<string> {
  if (DIRECTIVE_TYPES.has(node.type)) {
    return ctx.widgets.dispatch((node as DirectiveNode).name, node as DirectiveNode, ctx);
  }
  switch (node.type) {
    case 'text':
      return escapeText((node as Text).value);
    case 'strong':
      return `<strong>${await renderInline((node as Parent).children as PhrasingContent[], ctx)}</strong>`;
    case 'emphasis':
      return `<em>${await renderInline((node as Parent).children as PhrasingContent[], ctx)}</em>`;
    case 'link': {
      const l = node as Link;
      return `<a href="${escapeAttr(safeLinkUrl(l.url))}">${await renderInline(l.children, ctx)}</a>`;
    }
    case 'inlineCode':
      return `<code>${escapeText((node as InlineCode).value)}</code>`;
    case 'image': {
      const i = node as MdImage;
      const alt = escapeAttr(i.alt ?? '');
      return `<img src="${escapeAttr(safeLinkUrl(i.url))}" alt="${alt}"/>`;
    }
    case 'break':
      return '<br/>';
    default:
      return '';
  }
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

export function escapeText(s: string): string {
  return s.replace(/[&<>]/g, (c) => HTML_ESCAPES[c] ?? c);
}

export function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}
