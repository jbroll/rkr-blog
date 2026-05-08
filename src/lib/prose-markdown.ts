// Bidirectional ProseMirror JSON ↔ markdown converter for the admin editor.
// Lives under src/lib/ but is bundled into the admin browser bundle (via
// tsconfig.browser.json) — the editor calls `proseToMarkdown` locally on
// save and POSTs markdown to /admin/posts, so the server never loads this
// module at runtime. Imports must stay browser-safe (no node:* APIs).
//
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

import { safeLinkUrl } from './safe-url.ts';

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
      // `* * *` instead of `---` so a leading horizontal rule can't be
      // mistaken for a YAML frontmatter delimiter when the markdown is
      // pushed to /admin/posts. Both forms parse to thematicBreak.
      return '* * *';
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
    // The unified `figure` is the only image-bearing node type in the
    // editor (spec.md §9 — legacy ImageNode/GalleryNode/CarouselNode/
    // DiptychNode/TriptychNode were removed). The figure attribute set
    // covers every prior shape via matrix/justify/etc.
    case 'figure':
      return emitFigure(node.attrs ?? {});
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
      // Strip dangerous schemes (javascript:, data:, vbscript:) at
      // serialize time so a paste / typo can't ride through to the
      // public renderer. content.ts re-applies the same guard on
      // render — defense in depth.
      const href = safeLinkUrl(String(mark.attrs?.href ?? ''));
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

/** Carousel timer cap — anything larger reads as "the author meant ms
 * or made a typo." Mirrors the figure widget's TIMER_CAP_SECONDS. */
const CAROUSEL_AUTOPLAY_CAP = 60;

/**
 * Emit a `::figure{...}` directive for the unified widget. Mirrors
 * the spec.md §9 attribute table — only emit attributes whose values
 * differ from the widget's defaults so the round-trip stays minimal
 * and authored markdown reads cleanly.
 */
function emitFigure(attrs: Record<string, unknown>): string {
  const idsRaw = attrs.ids;
  const ids =
    typeof idsRaw === 'string'
      ? idsRaw
      : Array.isArray(idsRaw)
        ? idsRaw.filter((s): s is string => typeof s === 'string').join(',')
        : '';
  if (!ids.trim()) return '';

  const parts: string[] = [`ids=${quote(ids)}`];

  const matrix = attrs.matrix;
  if (typeof matrix === 'string' && matrix.length > 0) {
    parts.push(`matrix=${matrix}`);
  }

  const justify = attrs.justify;
  if (typeof justify === 'string' && justify.length > 0 && justify !== 'center') {
    parts.push(`justify=${justify}`);
  }

  const width = attrs.width;
  if (typeof width === 'string' && /^\d+(px|%)$/.test(width)) {
    parts.push(`width=${width}`);
  }

  const aspect = attrs.aspect;
  if (typeof aspect === 'string' && /^\d+\s*[:x]\s*\d+$/.test(aspect)) {
    parts.push(`aspect=${aspect}`);
  }

  const fit = attrs.fit;
  if ((fit === 'cover' || fit === 'contain') && fit !== 'cover') {
    parts.push(`fit=${fit}`);
  }

  // Per-image alts (parallel array, comma-separated).
  const altsRaw = attrs.alts;
  const altsList: string[] =
    typeof altsRaw === 'string'
      ? altsRaw.split(',').map((s) => s.trim())
      : Array.isArray(altsRaw)
        ? altsRaw.map((s) => (typeof s === 'string' ? s.trim() : ''))
        : [];
  if (altsList.some((a) => a.length > 0)) {
    parts.push(`alts=${quote(altsList.join(','))}`);
  }

  // Per-image captions (pipe-separated).
  const captionsRaw = attrs.captions;
  const captionsList: string[] =
    typeof captionsRaw === 'string'
      ? captionsRaw.split('|').map((s) => s.trim())
      : Array.isArray(captionsRaw)
        ? captionsRaw.map((s) => (typeof s === 'string' ? s.trim() : ''))
        : [];
  if (captionsList.some((c) => c.length > 0)) {
    parts.push(`captions=${quote(captionsList.join('|'))}`);
  }

  const caption = attrs.caption;
  if (typeof caption === 'string' && caption.length > 0) {
    parts.push(`caption=${quote(caption)}`);
  }

  const timer = Number(attrs.timer ?? 0);
  if (Number.isFinite(timer) && timer > 0) {
    parts.push(`timer=${Math.min(CAROUSEL_AUTOPLAY_CAP, Math.floor(timer))}`);
  }

  return `::figure{${parts.join(' ')}}`;
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
    if (d.name === 'figure') {
      return parseFigureToEditorNode(d.attributes ?? {});
    }
    return null; // unknown directive → drop silently
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

/**
 * Parse a `::figure{...}` directive's attributes into the unified
 * `figure` ProseMirror node. The editor's UI surface (toolbar buttons,
 * attribute panel) discriminates between image / gallery / carousel /
 * diptych / triptych modes by inspecting the figure's `matrix` + `ids`
 * count at the UI layer (see src/admin/main.ts figureKind helper) —
 * the prose document keeps a single node type so the wire format and
 * the editor model stay aligned.
 */
function parseFigureToEditorNode(attrs: Record<string, string | null | undefined>): ProseNode {
  return {
    type: 'figure',
    attrs: {
      ids: attrs.ids ?? '',
      alts: attrs.alts ?? '',
      captions: attrs.captions ?? '',
      caption: attrs.caption ?? '',
      matrix: attrs.matrix ?? '',
      justify: attrs.justify ?? 'center',
      width: attrs.width ?? '',
      aspect: attrs.aspect ?? '',
      fit: attrs.fit ?? 'cover',
      timer: Number(attrs.timer ?? 0)
    }
  };
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
