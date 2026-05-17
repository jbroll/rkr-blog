// Word-truncate a teaser excerpt at the mdast layer (posts are stored
// as Markdown → parsed to mdast; the excerpt is the first paragraph
// node). Trimming the tree instead of the rendered HTML keeps inline
// markup — links, emphasis, strong — balanced for free when remark
// re-renders the subtree: no tag re-closing, no entity edge cases.

import type { Paragraph, PhrasingContent } from 'mdast';

const ELLIPSIS = '…';

function words(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

/** Truncate `para` to at most `maxWords` words across its text
 * descendants, preserving inline structure and appending an ellipsis
 * when content was dropped. Returns the input untouched when
 * `maxWords <= 0` or the paragraph is already within the limit. Pure:
 * never mutates the input (cut nodes are rebuilt, kept whole nodes are
 * shared by reference since callers never mutate the result). */
export function truncateParagraph(para: Paragraph, maxWords: number): Paragraph {
  if (maxWords <= 0) return para;

  let remaining = maxWords;
  let truncated = false;

  function take(node: PhrasingContent): PhrasingContent | null {
    if (remaining <= 0) {
      truncated = true;
      return null;
    }
    if (node.type === 'text' || node.type === 'inlineCode') {
      const ws = words(node.value);
      if (ws.length <= remaining) {
        remaining -= ws.length;
        return node;
      }
      truncated = true;
      const kept = ws.slice(0, remaining).join(' ');
      remaining = 0;
      // inlineCode can't carry a trailing ellipsis cleanly; emit the
      // partial slice as plain text so the ellipsis reads naturally.
      return { type: 'text', value: kept };
    }
    if ('children' in node && Array.isArray(node.children)) {
      const kept: PhrasingContent[] = [];
      for (const child of node.children as PhrasingContent[]) {
        const out = take(child);
        if (out) kept.push(out);
        if (remaining <= 0) break;
      }
      if (kept.length === 0) return null;
      return { ...node, children: kept } as PhrasingContent;
    }
    // Zero-word inline nodes (break, image, html, refs): keep while
    // there is still budget, drop once the limit is reached.
    return node;
  }

  const children: PhrasingContent[] = [];
  for (const child of para.children) {
    const out = take(child);
    if (out) children.push(out);
    if (remaining <= 0) break;
  }
  if (!truncated) return para;
  children.push({ type: 'text', value: ELLIPSIS });
  return { type: 'paragraph', children };
}
