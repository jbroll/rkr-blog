// DOM → text-DSL serializer for in-place editing.
//
// The server renders each text leaf to HTML; in edit mode the author
// edits that HTML directly (contenteditable). On blur this module maps
// the DOM back to the text widget's markdown DSL: paragraphs,
// bold/italic, links, lists, headings, inline and fenced code.
// Anything outside that subset is escaped as literal text — content is
// never dropped, only de-formatted.
//
// Browser-safe: no node:* imports. The `Element`/`Node` types are the
// DOM lib's; tests pass structurally compatible fakes via
// `as unknown as Element`.

import { safeLinkUrl } from '../lib/safe-url.ts';

/** Escape only what markdown would reinterpret inside a line: inline
 * markers, an intraword-safe underscore, and entity or tag openers.
 * Line-start syntax is handled by `escapeLineStarts`. */
function escapeText(value: string): string {
  return value
    .replace(/([\\`*[\]])/g, '\\$1')
    .replace(/(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/g, '\\_')
    .replace(/<(?=[A-Za-z/!?])/g, '\\<')
    .replace(/&(?=#?\w+;)/g, '\\&');
}

/** Escape block syntax (headings, bullets, quotes, ordered lists) that
 * plain text would trigger at the start of a line. */
function escapeLineStarts(value: string): string {
  return value
    .split('\n')
    .map((line) =>
      line
        .replace(/^(\s*)(?=-+\s*$|=+\s*$|~{3})/, '$1\\')
        .replace(
          /^(\s*)(?:([#+-])(?=\s|$)|(>)|(\d+)([.)])(?=\s|$))/,
          (_all, space: string, bullet?: string, quote?: string, num?: string, delim?: string) =>
            num ? `${space}${num}\\${delim}` : `${space}\\${bullet ?? quote}`
        )
    )
    .join('\n');
}

function inlineChildren(el: Element): string {
  let out = '';
  for (const child of [...(el.childNodes as unknown as ChildNode[])]) {
    out += inlineNode(child as unknown as Element & Text);
  }
  return out;
}

function inlineNode(node: Element & Text): string {
  if (node.nodeType === 3) return escapeText(node.nodeValue ?? '');
  if (node.nodeType !== 1) return '';
  const el = node as unknown as Element;
  const tag = el.tagName.toLowerCase();
  if (tag === 'strong' || tag === 'b') return `**${inlineChildren(el)}**`;
  if (tag === 'em' || tag === 'i') return `*${inlineChildren(el)}*`;
  if (tag === 'code') return `\`${(el.textContent ?? '').replace(/`/g, '\\`')}\``;
  if (tag === 'a') {
    const href = safeLinkUrl(el.getAttribute('href') ?? '');
    return `[${inlineChildren(el)}](${href})`;
  }
  if (tag === 'br') return '\n';
  // Foreign inline (spans, marks, pasted widgets): keep the words.
  if (el.childNodes.length > 0) return escapeText(el.textContent ?? '');
  return '';
}

function listItems(list: Element, indent: string): string[] {
  const out: string[] = [];
  const ordered = list.tagName.toLowerCase() === 'ol';
  let n = 0;
  for (const child of [...(list.childNodes as unknown as ChildNode[])]) {
    const li = child as unknown as Element;
    if (li.nodeType !== 1 || li.tagName.toLowerCase() !== 'li') continue;
    n += 1;
    const bullet = ordered ? `${n}. ` : '- ';
    const parts: string[] = [];
    let inline = '';
    for (const grand of [...(li.childNodes as unknown as ChildNode[])]) {
      const g = grand as unknown as Element;
      if (
        g.nodeType === 1 &&
        (g.tagName.toLowerCase() === 'ul' || g.tagName.toLowerCase() === 'ol')
      ) {
        if (inline.trim() !== '')
          parts.push(`${indent}${bullet}${escapeLineStarts(inline.trim())}`);
        inline = '';
        parts.push(...listItems(g, `${indent}  `));
      } else {
        inline += inlineNode(g as unknown as Element & Text);
      }
    }
    if (inline.trim() !== '' || parts.length === 0)
      parts.unshift(`${indent}${bullet}${escapeLineStarts(inline.trim())}`);
    out.push(...parts);
  }
  return out;
}

function blockToMarkdown(el: Element): string[] {
  const tag = el.tagName.toLowerCase();
  if (tag === 'p' || tag === 'div') return [escapeLineStarts(inlineChildren(el).trim())];
  if (/^h[1-6]$/.test(tag)) {
    return [`${'#'.repeat(Number(tag[1]))} ${inlineChildren(el).trim()}`];
  }
  if (tag === 'ul' || tag === 'ol') {
    const lines = listItems(el, '');
    return lines.length > 0 ? [lines.join('\n')] : [];
  }
  if (tag === 'li') return [`- ${inlineChildren(el).trim()}`];
  if (tag === 'pre') {
    const code = el.querySelector('code');
    const body = (code?.textContent ?? el.textContent ?? '').replace(/\n$/, '');
    return [`\`\`\`\n${body}\n\`\`\``];
  }
  if (tag === 'blockquote') return [escapeLineStarts(escapeText((el.textContent ?? '').trim()))];
  // Foreign block: keep the words as an escaped paragraph.
  return [escapeLineStarts(escapeText((el.textContent ?? '').trim()))];
}

/** Serialize rendered text-leaf elements back to the markdown DSL.
 * Empty results (whitespace-only edits) yield '' so clearing a leaf
 * empties the widget instead of saving blank markup. */
export function domToMarkdown(elements: readonly Element[]): string {
  const blocks: string[] = [];
  for (const el of elements) {
    if (el.nodeType === 3) {
      const text = escapeLineStarts(escapeText((el.nodeValue ?? '').trim()));
      if (text !== '') blocks.push(text);
      continue;
    }
    if (el.nodeType !== 1) continue;
    for (const block of blockToMarkdown(el)) {
      if (block.trim() !== '') blocks.push(block);
    }
  }
  return blocks.join('\n\n');
}
