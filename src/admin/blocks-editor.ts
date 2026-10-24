// Blocks palette + inline-field helpers for the JSON-pages editor.
// Browser-safe: no node:* imports (bundled into the admin bundle).
// Depth guidance lives here, not in the build: a macro definition holds
// at most 3 container levels, and the palette refuses a 4th level with
// a "save inner part as its own macro" nudge.

import { type BlockNode, containerDepth, type Slots } from '../lib/blocks.ts';

const CONTAINER_KINDS: ReadonlySet<string> = new Set(['section', 'row', 'col', 'flow']);

export const MAX_MACRO_DEPTH = 3;

/** Whether `kind` may be inserted into `tree`. Containers are refused
 * at depth 3; leaves and macro instances are always allowed. */
export function insertAllowed(tree: BlockNode, kind: string): boolean {
  if (!CONTAINER_KINDS.has(kind)) return true;
  return containerDepth(tree) < MAX_MACRO_DEPTH;
}

/** Copy one macro instance's overrides for duplicate. Deep copy so the
 * duplicate never shares array/object identity with the source. */
export function duplicateOverrides(slots: Slots): Slots {
  return JSON.parse(JSON.stringify(slots)) as Slots;
}

/** Depth-meter copy, e.g. "Level 2 of 3". */
export function depthLabel(depth: number): string {
  return `Level ${depth} of ${MAX_MACRO_DEPTH}`;
}

/** Stored macro names are lowercase slugs: `hero`, `cards-3`. */
export function isValidMacroName(name: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(name);
}

export interface PaletteMacro {
  name: string;
  label: string;
  /** Macro defaults for field editors; absent when the library entry
   * carries none (primitives) or the list predates them. */
  defaults?: Slots;
}

/** Built-in primitives, always present even with an empty macro
 * library. Names are `primitive:<kind>` so the page editor can build
 * the node directly instead of expanding a macro. */
export const PRIMITIVE_MACROS: PaletteMacro[] = [
  { name: 'primitive:text', label: 'Text' },
  { name: 'primitive:figure', label: 'Image' },
  { name: 'primitive:button', label: 'Button' },
  { name: 'primitive:row', label: 'Row' },
  { name: 'primitive:col', label: 'Column' },
  { name: 'primitive:section', label: 'Section' }
];

/** Node template for a primitive palette name. Throws on unknown names. */
export function primitiveNode(name: string): BlockNode {
  switch (name) {
    case 'primitive:text':
      return { type: 'text', markdown: '' };
    case 'primitive:figure':
      return { type: 'figure', slots: { ids: '' } };
    case 'primitive:button':
      return { type: 'button', slots: { label: 'Button', href: '/', variant: 'primary' } };
    case 'primitive:row':
      return { type: 'row', children: [] };
    case 'primitive:col':
      return { type: 'col', children: [] };
    case 'primitive:section':
      return { type: 'section', slots: { theme: 'light', edge: 'straight' }, children: [] };
    default:
      throw new Error(`blocks editor: unknown primitive ${name}`);
  }
}

/** Mount the macro palette into `root`. Primitives come first, then
 * the site macros. Click, double-click, or Enter inserts; the latter
 * two exist so placement never requires a drag. */
export function mountBlocksPalette(
  root: Element,
  macros: PaletteMacro[],
  onInsert: (name: string) => void
): void {
  const aside = root.ownerDocument.createElement('aside');
  aside.className = 'rkr-blocks-palette';
  aside.setAttribute('aria-label', 'Reusable blocks');
  for (const m of [...PRIMITIVE_MACROS, ...macros]) {
    const btn = root.ownerDocument.createElement('button');
    btn.type = 'button';
    btn.className = 'rkr-blocks-palette-item';
    btn.textContent = m.label;
    btn.dataset.macro = m.name;
    btn.addEventListener('click', () => onInsert(m.name));
    btn.addEventListener('dblclick', () => onInsert(m.name));
    btn.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter') onInsert(m.name);
    });
    aside.append(btn);
  }
  root.prepend(aside);
}
