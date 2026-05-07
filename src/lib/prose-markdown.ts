// Bidirectional ProseMirror JSON ↔ markdown converter for the admin editor.
// Scope: only the node + mark types our TipTap editor declares (paragraph,
// heading, hard_break, text, bold, italic, link, code, our custom `image`,
// blockquote, code block, lists, thematic break). Unknown nodes/marks fall
// through silently (the editor schema prevents them from being authored).

import type {
  Blockquote,
  Code,
  Emphasis,
  Heading,
  InlineCode,
  Link,
  List,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Strong,
  Text
} from 'mdast';
import { remark } from 'remark';
import remarkDirective from 'remark-directive';
import remarkFrontmatter from 'remark-frontmatter';

// ---- ProseMirror JSON shape (subset) ----------------------------------

export interface ProseMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface ProseNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: ProseNode[];
  text?: string;
  marks?: ProseMark[];
}

export interface ProseDoc extends ProseNode {
  type: 'doc';
  content: ProseNode[];
}

// ---- ProseMirror JSON → markdown --------------------------------------

export function proseToMarkdown(doc: ProseDoc): string {
  const blocks = doc.content.map(emitBlock).filter((s) => s.length > 0);
  return `${blocks.join('\n\n')}\n`;
}

function emitBlock(node: ProseNode): string {
  switch (node.type) {
    case 'paragraph':
      return emitInline(node.content ?? []);
    case 'heading': {
      const level = clampHeadingLevel(node.attrs?.level);
      return `${'#'.repeat(level)} ${emitInline(node.content ?? [])}`;
    }
    case 'horizontalRule':
    case 'horizontal_rule':
      return '---';
    case 'codeBlock':
    case 'code_block': {
      const lang = typeof node.attrs?.language === 'string' ? node.attrs.language : '';
      const text = (node.content ?? []).map((c) => c.text ?? '').join('');
      return `\`\`\`${lang}\n${text}\n\`\`\``;
    }
    case 'blockquote': {
      const inner = (node.content ?? []).map(emitBlock).join('\n\n');
      return inner
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n');
    }
    case 'bulletList':
    case 'bullet_list':
      return emitList(node, '-');
    case 'orderedList':
    case 'ordered_list':
      return emitList(node, '1.');
    case 'image': {
      const id = String(node.attrs?.id ?? '').trim();
      if (!id) return '';
      const parts: string[] = [];
      const alt = node.attrs?.alt;
      if (typeof alt === 'string' && alt.length > 0) parts.push(`alt=${quote(alt)}`);
      const caption = node.attrs?.caption;
      if (typeof caption === 'string' && caption.length > 0) {
        parts.push(`caption=${quote(caption)}`);
      }
      // Position values are constrained to the same set the public renderer
      // recognises. 'default' is the implicit default; only emit when set.
      const position = node.attrs?.position;
      if (typeof position === 'string' && position !== 'default' && position.length > 0) {
        parts.push(`position=${position}`);
      }
      const attrPart = parts.length > 0 ? ` ${parts.join(' ')}` : '';
      return `::image{#${id}${attrPart}}`;
    }
    /* c8 ignore next 2 -- defensive: editor schema prevents unknown block node types */
    default:
      return '';
  }
}

function emitList(node: ProseNode, marker: string): string {
  const items = (node.content ?? []).map((item) => {
    const inner = (item.content ?? []).map(emitBlock).join('\n\n');
    const indented = inner
      .split('\n')
      .map((line, i) => (i === 0 ? line : `  ${line}`))
      .join('\n');
    return `${marker} ${indented}`;
  });
  return items.join('\n');
}

function emitInline(content: ProseNode[]): string {
  return content.map(emitInlineOne).join('');
}

function emitInlineOne(node: ProseNode): string {
  if (node.type === 'hardBreak' || node.type === 'hard_break') return '  \n';
  /* c8 ignore next -- defensive: editor schema only emits text + hardBreak inline */
  if (node.type !== 'text') return '';
  const text = node.text ?? '';
  const marks = node.marks ?? [];
  // Code spans are literal: skip markdown escaping when wrapped in `code`.
  const hasCode = marks.some((m) => m.type === 'code');
  let out = hasCode ? text : escapeMarkdown(text);
  for (const mark of marks) {
    out = applyMark(mark, out);
  }
  return out;
}

function applyMark(mark: ProseMark, text: string): string {
  switch (mark.type) {
    case 'bold':
    case 'strong':
      return `**${text}**`;
    case 'italic':
    case 'em':
      return `*${text}*`;
    case 'code':
      return `\`${text}\``;
    case 'link': {
      const href = String(mark.attrs?.href ?? '');
      return `[${text}](${href})`;
    }
    default:
      return text;
  }
}

function escapeMarkdown(s: string): string {
  // Conservative: only escape characters that would otherwise be parsed.
  return s.replace(/([\\`*_{}[\]()#+\-!])/g, '\\$1');
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function clampHeadingLevel(level: unknown): number {
  const n = Number(level);
  if (!Number.isFinite(n)) return 1;
  return Math.min(6, Math.max(1, Math.round(n)));
}

// ---- markdown → ProseMirror JSON --------------------------------------

const DIRECTIVE_TYPES = new Set(['leafDirective', 'textDirective', 'containerDirective']);

interface DirectiveLike {
  type: string;
  name?: string;
  attributes?: Record<string, string | null | undefined>;
}

export function markdownToProse(body: string): ProseDoc {
  const proc = remark().use(remarkFrontmatter, ['yaml']).use(remarkDirective);
  const tree = proc.parse(body) as Root;

  const content: ProseNode[] = [];
  for (const child of tree.children) {
    if (child.type === 'yaml') continue; // frontmatter is handled separately
    const block = mdBlockToProse(child);
    if (block) content.push(block);
  }
  return { type: 'doc', content };
}

function mdBlockToProse(node: RootContent): ProseNode | null {
  if (DIRECTIVE_TYPES.has(node.type)) {
    const d = node as unknown as DirectiveLike;
    if (d.name === 'image') {
      const attrs = d.attributes ?? {};
      return {
        type: 'image',
        attrs: {
          id: attrs.id ?? '',
          alt: attrs.alt ?? '',
          caption: attrs.caption ?? '',
          // Default to 'default' so the editor's position select always has
          // a non-empty value, matching the public renderer's fallback.
          position: attrs.position ?? 'default'
        }
      };
    }
    return null;
  }
  switch (node.type) {
    case 'paragraph':
      return { type: 'paragraph', content: inlinesToProse((node as Paragraph).children) };
    case 'heading': {
      const h = node as Heading;
      return { type: 'heading', attrs: { level: h.depth }, content: inlinesToProse(h.children) };
    }
    case 'thematicBreak':
      return { type: 'horizontalRule' };
    case 'code': {
      const c = node as Code;
      return {
        type: 'codeBlock',
        attrs: { language: c.lang ?? null },
        content: c.value ? [{ type: 'text', text: c.value }] : []
      };
    }
    case 'blockquote': {
      const bq = node as Blockquote;
      return {
        type: 'blockquote',
        content: bq.children
          .map((c) => mdBlockToProse(c as RootContent))
          .filter((n): n is ProseNode => n !== null)
      };
    }
    case 'list': {
      const list = node as List;
      return {
        type: list.ordered ? 'orderedList' : 'bulletList',
        content: list.children.map((item) => ({
          type: 'listItem',
          content: item.children
            .map((c) => mdBlockToProse(c as RootContent))
            .filter((n): n is ProseNode => n !== null)
        }))
      };
    }
    default:
      return null;
  }
}

function inlinesToProse(nodes: PhrasingContent[]): ProseNode[] {
  const out: ProseNode[] = [];
  for (const n of nodes) {
    out.push(...inlineToProse(n, []));
  }
  return out;
}

function inlineToProse(node: PhrasingContent, marks: ProseMark[]): ProseNode[] {
  switch (node.type) {
    case 'text':
      return [{ type: 'text', text: (node as Text).value, ...(marks.length ? { marks } : {}) }];
    case 'strong':
      return (node as Strong).children.flatMap((c) =>
        inlineToProse(c, [...marks, { type: 'bold' }])
      );
    case 'emphasis':
      return (node as Emphasis).children.flatMap((c) =>
        inlineToProse(c, [...marks, { type: 'italic' }])
      );
    case 'inlineCode':
      return [
        { type: 'text', text: (node as InlineCode).value, marks: [...marks, { type: 'code' }] }
      ];
    case 'link': {
      const link = node as Link;
      const linkMark: ProseMark = { type: 'link', attrs: { href: link.url } };
      return link.children.flatMap((c) => inlineToProse(c, [...marks, linkMark]));
    }
    case 'break':
      return [{ type: 'hardBreak' }];
    default:
      return [];
  }
}
