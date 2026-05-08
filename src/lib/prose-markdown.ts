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
    // Editor's legacy node types are kept as a UI abstraction (richer
    // toolbar / cropper / attribute panels per shape) but the wire
    // format is uniformly `::figure` per spec.md §9. Each legacy case
    // maps to figure-shaped attrs and goes through the same emitter so
    // the constants-alignment / validation guards stay in one place.
    case 'image':
      return emitFigure(legacyImageToFigureAttrs(node.attrs ?? {}));
    case 'gallery':
    case 'carousel':
    case 'diptych':
    case 'triptych':
      return emitFigure(legacyMultiImageToFigureAttrs(node.type, node.attrs ?? {}));
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

/** Carousel autoplay cap; the figure widget caps timer at 60s (any
 * larger reads as "the author meant ms or made a typo"). The editor's
 * legacy CarouselNode allows free-typed autoplay; cap on emit so
 * markdown round-trip stays stable. */
const CAROUSEL_AUTOPLAY_CAP = 60;

/**
 * Map legacy ImageNode attrs `{id, alt, caption, position}` to the
 * unified figure attribute shape. The legacy single-image position
 * names are a subset of the figure's `justify` values:
 *   default → omit (figure default)   full / left / right / inline → same
 */
function legacyImageToFigureAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
  const id = String(attrs.id ?? '').trim();
  if (!id || !/^[0-9a-f]{6,64}$/.test(id)) return { ids: '' };
  const out: Record<string, unknown> = { ids: id };
  const alt = attrs.alt;
  if (typeof alt === 'string' && alt.length > 0) out.alts = alt;
  const caption = attrs.caption;
  if (typeof caption === 'string' && caption.length > 0) out.caption = caption;
  const position = attrs.position;
  if (
    typeof position === 'string' &&
    position !== 'default' &&
    (position === 'full' || position === 'left' || position === 'right' || position === 'inline')
  ) {
    out.justify = position;
  }
  return out;
}

/**
 * Map legacy multi-image node attrs (gallery / carousel / diptych /
 * triptych) to the unified figure shape. The kind selects a default
 * `matrix` value:
 *   gallery  → `matrix=<layout>` (justified | masonry | matrix-omitted)
 *   carousel → `matrix=1x1` + `timer=<autoplay>` (legacy carousel was 1-at-a-time)
 *   diptych  → `matrix=1x2`
 *   triptych → `matrix=1x3`
 */
function legacyMultiImageToFigureAttrs(
  kind: string,
  attrs: Record<string, unknown>
): Record<string, unknown> {
  const idsRaw = attrs.ids;
  const ids =
    typeof idsRaw === 'string'
      ? idsRaw
      : Array.isArray(idsRaw)
        ? idsRaw.filter((s): s is string => typeof s === 'string').join(',')
        : '';
  if (!ids.trim()) return { ids: '' };

  const out: Record<string, unknown> = { ids };

  // Alts (parallel array, comma-separated).
  const altsRaw = attrs.alts;
  const altsList: string[] =
    typeof altsRaw === 'string'
      ? altsRaw.split(',').map((s) => s.trim())
      : Array.isArray(altsRaw)
        ? altsRaw.map((s) => (typeof s === 'string' ? s.trim() : ''))
        : [];
  if (altsList.some((a) => a.length > 0)) out.alts = altsList.join(',');

  const caption = attrs.caption;
  if (typeof caption === 'string' && caption.length > 0) out.caption = caption;

  if (kind === 'gallery') {
    const layout = attrs.layout;
    if (typeof layout === 'string' && layout.length > 0 && layout !== 'matrix') {
      out.matrix = layout; // 'justified' | 'masonry'
    }
    // layout=matrix had no shape under the legacy widget; drop on emit.
  } else if (kind === 'carousel') {
    out.matrix = '1x1';
    const autoplay = Number(attrs.autoplay ?? 0);
    if (Number.isFinite(autoplay) && autoplay > 0) {
      out.timer = Math.min(CAROUSEL_AUTOPLAY_CAP, Math.floor(autoplay));
    }
  } else if (kind === 'diptych') {
    out.matrix = '1x2';
  } else if (kind === 'triptych') {
    out.matrix = '1x3';
  }

  return out;
}

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
 * Parse a `::figure{...}` directive's attributes and pick the best
 * matching editor node type. The editor keeps the legacy 5 node types
 * as a UI abstraction (each has its own toolbar / cropper / panel
 * affordances); we map figure attribute shapes back to those:
 *
 *   matrix=1x2                         → diptych
 *   matrix=1x3                         → triptych
 *   matrix=justified | masonry         → gallery
 *   matrix=1x1 with timer              → carousel
 *   single id, no matrix               → image
 *   anything else (NxM grid, custom    → figure (generic UI; new in
 *   width/aspect/fit, etc.)              Phase 5, used as a catch-all)
 *
 * The mapping is asymmetric on purpose: we prefer the legacy node
 * type when it exists because its editor UI is richer. For figures
 * with attrs that don't fit (`width=`, `aspect=`, `fit=`, multi-row
 * matrices), we use the generic figure node.
 */
function parseFigureToEditorNode(attrs: Record<string, string | null | undefined>): ProseNode {
  const ids = attrs.ids ?? '';
  const idList = ids
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const matrix = (attrs.matrix ?? '').toLowerCase();
  const hasCustomLayout =
    (attrs.width && attrs.width.length > 0) ||
    (attrs.aspect && attrs.aspect.length > 0) ||
    (attrs.fit && attrs.fit.length > 0);

  // Figures with custom layout attrs → generic figure node (the
  // legacy nodes don't carry these fields).
  if (hasCustomLayout) {
    return buildGenericFigureNode(attrs);
  }

  // matrix=1x2 with 2 ids → DiptychNode (legacy editor UI for 2-up).
  if (matrix === '1x2' && idList.length === 2) {
    return {
      type: 'diptych',
      attrs: { ids, alts: attrs.alts ?? '', caption: attrs.caption ?? '' }
    };
  }
  if (matrix === '1x3' && idList.length === 3) {
    return {
      type: 'triptych',
      attrs: { ids, alts: attrs.alts ?? '', caption: attrs.caption ?? '' }
    };
  }
  if (matrix === 'justified' || matrix === 'masonry') {
    return {
      type: 'gallery',
      attrs: {
        ids,
        alts: attrs.alts ?? '',
        caption: attrs.caption ?? '',
        layout: matrix
      }
    };
  }
  if (matrix === '1x1' && idList.length > 1) {
    // Multi-id with 1×1 visible cell → carousel (legacy 1-at-a-time).
    return {
      type: 'carousel',
      attrs: {
        ids,
        alts: attrs.alts ?? '',
        caption: attrs.caption ?? '',
        autoplay: Number(attrs.timer ?? 0) || 0
      }
    };
  }
  if (idList.length === 1 && (matrix === '' || matrix === '1x1')) {
    // Single id, default-shaped figure → ImageNode (legacy single-image
    // UI: cropper, ops editor, alt/caption/position attribute panel).
    return {
      type: 'image',
      attrs: {
        id: idList[0] ?? '',
        alt: attrs.alts ?? '',
        caption: attrs.caption ?? '',
        position:
          attrs.justify && /^(default|full|left|right|inline)$/.test(attrs.justify)
            ? attrs.justify
            : 'default'
      }
    };
  }
  // Anything else (NxM grid, atypical id count) → generic figure node.
  return buildGenericFigureNode(attrs);
}

function buildGenericFigureNode(attrs: Record<string, string | null | undefined>): ProseNode {
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
