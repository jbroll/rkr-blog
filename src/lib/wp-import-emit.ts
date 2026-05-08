// HTML (hast) → markdown emission for the WP importer. Walks a
// rehype-parse tree and emits a small markdown vocabulary: headings,
// paragraphs, blockquotes, lists, fenced code, inline emphasis /
// strong / code / links / br. Generic block wrappers (div / section /
// article / main) recurse; unknown blocks fall through to inline so
// their text content survives.
//
// figure blocks reaching the emitter are leftovers from
// collectFigures + replaceWithRawMarkdown — those should already have
// been replaced with directive markers by the importer's first pass.
// A figure that survives gets a comment placeholder.
//
// Pre-substituted directive markers (text nodes carrying raw
// markdown — the ::figure{...} directive lines) pass through verbatim.

import type { HastNode } from './wp-import-types.ts';

export function emitMarkdown(root: HastNode): string {
  return emitBlocks(root.children ?? []);
}

function emitBlocks(nodes: HastNode[]): string {
  const parts: string[] = [];
  for (const n of nodes) {
    const block = renderBlock(n);
    if (block) parts.push(block);
  }
  return parts.join('\n\n');
}

function renderBlock(node: HastNode): string {
  if (node.type === 'text') {
    // Top-level text — usually whitespace between blocks. Treat any
    // non-whitespace content as a paragraph.
    const v = (node.value ?? '').trim();
    return v;
  }
  if (node.type !== 'element') return '';
  const tag = node.tagName ?? '';
  const kids = node.children ?? [];
  switch (tag) {
    case 'p':
      return renderInline(kids).trim();
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const level = Number(tag.slice(1));
      return `${'#'.repeat(level)} ${renderInline(kids).trim()}`;
    }
    case 'hr':
      return '---';
    case 'br':
      return '';
    case 'blockquote':
      return emitBlocks(kids)
        .split('\n')
        .map((l) => (l.length > 0 ? `> ${l}` : '>'))
        .join('\n');
    case 'ul':
      return renderList(kids, /* ordered */ false);
    case 'ol':
      return renderList(kids, /* ordered */ true);
    case 'pre': {
      // <pre><code>...</code></pre> → fenced code block.
      const code = findFirst(node, (n) => n.tagName === 'code');
      const text = code ? collectText(code) : collectText(node);
      return `\`\`\`\n${text.replace(/\n+$/, '')}\n\`\`\``;
    }
    case 'figure':
      // Should already have been replaced with a directive marker by
      // collectFigures + replaceWithRawMarkdown. If a stray figure
      // survives (non-WP-block class), drop it with a comment.
      return '<!-- import: dropped non-WP figure -->';
    case 'div':
    case 'section':
    case 'article':
    case 'main':
      // Generic wrappers — recurse.
      return emitBlocks(kids);
    default:
      // Unknown block: try as inline; if there's nothing inside, drop.
      return renderInline(kids).trim();
  }
}

function renderList(items: HastNode[], ordered: boolean): string {
  const lines: string[] = [];
  let i = 1;
  for (const item of items) {
    if (item.type !== 'element' || item.tagName !== 'li') continue;
    const marker = ordered ? `${i}.` : '-';
    const inner = emitBlocks(item.children ?? []) || renderInline(item.children ?? []).trim();
    const indented = inner
      .split('\n')
      .map((l, idx) => (idx === 0 ? `${marker} ${l}` : `   ${l}`))
      .join('\n');
    lines.push(indented);
    i++;
  }
  return lines.join('\n');
}

function renderInline(nodes: HastNode[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') {
      out += n.value ?? '';
      continue;
    }
    if (n.type !== 'element') continue;
    const tag = n.tagName ?? '';
    const kids = n.children ?? [];
    switch (tag) {
      case 'strong':
      case 'b':
        out += `**${renderInline(kids)}**`;
        break;
      case 'em':
      case 'i':
        out += `*${renderInline(kids)}*`;
        break;
      case 'code':
        out += `\`${collectText(n)}\``;
        break;
      case 'br':
        out += '  \n';
        break;
      case 'a': {
        const href = String(n.properties?.href ?? '');
        const text = renderInline(kids);
        out += href ? `[${text}](${href})` : text;
        break;
      }
      case 'span':
      case 'small':
      case 'big':
        out += renderInline(kids);
        break;
      default:
        // Drop unknown inline tags but keep their text content.
        out += renderInline(kids);
    }
  }
  return out;
}

/** Walk a hast tree and return the first descendant the predicate
 * matches. Used to find a `<code>` inside a `<pre>` for fenced-code
 * emission, and (from the importer) to locate `<img>` / `<figcaption>`
 * inside a figure block. */
export function findFirst(node: HastNode, pred: (n: HastNode) => boolean): HastNode | null {
  if (pred(node)) return node;
  for (const c of node.children ?? []) {
    const hit = findFirst(c, pred);
    if (hit) return hit;
  }
  return null;
}

/** Concatenate all text-node values under a hast subtree. Used by both
 * the emitter (code-block content) and the importer (figcaption text). */
export function collectText(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  let out = '';
  for (const c of node.children ?? []) out += collectText(c);
  return out;
}
