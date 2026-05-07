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
      // Validate hex shape on emit — the editor's upload flow only ever
      // produces 64-hex ids, but a forged ProseMirror JSON body submitted
      // via POST /admin/posts could otherwise inject directive syntax
      // through the id (e.g. `id="abc} ::shell{cmd=rm` would round-trip
      // verbatim into the markdown). The public-side widget rejects
      // bad ids defensively too, but blocking at emit is cheaper and
      // matches the validation already present for multi-image directives.
      if (!id || !/^[0-9a-f]{6,64}$/.test(id)) return '';
      const parts: string[] = [];
      const alt = node.attrs?.alt;
      if (typeof alt === 'string' && alt.length > 0) parts.push(`alt=${quote(alt)}`);
      const caption = node.attrs?.caption;
      if (typeof caption === 'string' && caption.length > 0) {
        parts.push(`caption=${quote(caption)}`);
      }
      // Position values are constrained to the same set the public renderer
      // recognises (src/widgets/image.ts extractPosition). Validate on emit
      // so a stale/forged prose doc can't round-trip an unknown value into
      // markdown — `position=foo` would be silently coerced to 'default'
      // by the widget anyway, breaking round-trip identity. Unquoted
      // because every valid position is slug-safe (no spaces/specials).
      const position = node.attrs?.position;
      if (
        typeof position === 'string' &&
        position !== 'default' &&
        VALID_IMAGE_POSITIONS.has(position)
      ) {
        parts.push(`position=${position}`);
      }
      const attrPart = parts.length > 0 ? ` ${parts.join(' ')}` : '';
      return `::image{#${id}${attrPart}}`;
    }
    case 'gallery':
    case 'carousel':
    case 'diptych':
    case 'triptych':
      return emitMultiImage(node.type, node.attrs ?? {});
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

/** Mirrors VALID_POSITIONS in src/widgets/image.ts. Kept locally rather
 * than importing to keep prose-markdown free of widget-side dependencies. */
const VALID_IMAGE_POSITIONS = new Set(['default', 'full', 'left', 'right', 'inline']);

/** Carousel autoplay cap; mirrors src/widgets/carousel.ts extractAutoplay.
 * Without this, the editor could store autoplay=999, emit it verbatim,
 * and the public renderer would silently cap to 60 — breaking round-trip
 * identity (markdown→prose→markdown wouldn't be stable). */
const CAROUSEL_AUTOPLAY_CAP = 60;

/**
 * Emit a multi-image directive (gallery / carousel / diptych / triptych).
 * `ids` may be either a comma-separated string or a string array; the
 * editor stores it as a string for round-trip simplicity. Empty/zero
 * extras are omitted so the round-trip stays minimal.
 */
function emitMultiImage(kind: string, attrs: Record<string, unknown>): string {
  const idsRaw = attrs.ids;
  const ids =
    typeof idsRaw === 'string'
      ? idsRaw
      : Array.isArray(idsRaw)
        ? idsRaw.filter((s): s is string => typeof s === 'string').join(',')
        : '';
  if (!ids.trim()) return '';

  const parts: string[] = [`ids=${quote(ids)}`];

  // Per-image alts (parallel array, comma-separated). Only emit when at
  // least one slot has non-empty alt text — bare `alts=",,,"` is noise.
  // Each alt's commas would break this format; the spec's
  // `:::gallery{...}` container directive form is the path for that
  // case (DEFERRED.md).
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

  if (kind === 'gallery') {
    const layout = attrs.layout;
    // Only emit when set to a non-default value; the public renderer's
    // default is 'justified'.
    if (typeof layout === 'string' && layout.length > 0 && layout !== 'justified') {
      parts.push(`layout=${layout}`);
    }
  }

  if (kind === 'carousel') {
    const autoplay = Number(attrs.autoplay ?? 0);
    if (Number.isFinite(autoplay) && autoplay > 0) {
      parts.push(`autoplay=${Math.min(CAROUSEL_AUTOPLAY_CAP, Math.floor(autoplay))}`);
    }
  }

  const caption = attrs.caption;
  if (typeof caption === 'string' && caption.length > 0) {
    parts.push(`caption=${quote(caption)}`);
  }

  return `::${kind}{${parts.join(' ')}}`;
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
    if (
      d.name === 'gallery' ||
      d.name === 'carousel' ||
      d.name === 'diptych' ||
      d.name === 'triptych'
    ) {
      const attrs = d.attributes ?? {};
      const node: ProseNode = {
        type: d.name,
        attrs: {
          ids: attrs.ids ?? '',
          // Parallel alt-text array, same comma-separated convention as
          // ids. Empty string means "no alts authored".
          alts: attrs.alts ?? '',
          caption: attrs.caption ?? ''
        }
      };
      if (d.name === 'gallery') {
        // Same default as the public renderer in src/widgets/gallery.ts.
        (node.attrs as Record<string, unknown>).layout = attrs.layout ?? 'justified';
      }
      if (d.name === 'carousel') {
        const ap = Number(attrs.autoplay ?? 0);
        (node.attrs as Record<string, unknown>).autoplay = Number.isFinite(ap) ? ap : 0;
      }
      return node;
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
