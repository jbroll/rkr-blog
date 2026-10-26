// Blocks palette + inline-field helpers for the JSON-pages editor.
// Browser-safe: no node:* imports (bundled into the admin bundle).
// Depth guidance lives here, not in the build: a macro definition holds
// at most 3 container levels, and the palette refuses a 4th level with
// a "save inner part as its own macro" nudge.

import { type BlockNode, containerDepth, type Slots } from '../lib/blocks.ts';
import { groupPalette, paletteIcon } from './palette-groups.ts';

const CONTAINER_KINDS: ReadonlySet<string> = new Set(['grid', 'section', 'row', 'col']);

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

/** Dialog-facing view of a macro's `fieldSchema` entry (the server
 * type lives in a node-only module the browser bundle can't import). */
export interface PaletteFieldSpec {
  label: string;
  type: string;
  options?: string[];
}

export interface PaletteMacro {
  name: string;
  label: string;
  /** Dock group; site macros omit it and land under Sections. */
  group?: string;
  /** One line shown under the label. */
  description?: string;
  /** Macro defaults for field editors; absent when the library entry
   * carries none (primitives) or the list predates them. */
  defaults?: Slots;
  /** Labels and input types for the macro dialog, keyed by slot name. */
  fieldSchema?: Record<string, PaletteFieldSpec>;
}

/** Built-in primitives, always present even with an empty macro
 * library. Names are `primitive:<kind>` so the page editor can build
 * the node directly instead of expanding a macro. */
export const PALETTE_PRIMITIVES: PaletteMacro[] = [
  {
    name: 'primitive:text',
    label: 'Text',
    group: 'Basics',
    description: 'Paragraphs and headings'
  },
  {
    name: 'primitive:button',
    label: 'Button',
    group: 'Basics',
    description: 'A link styled as a button'
  },
  { name: 'primitive:figure', label: 'Image', group: 'Media', description: 'Photos with captions' },
  {
    name: 'primitive:video',
    label: 'Video',
    group: 'Media',
    description: 'A video with a caption'
  },
  {
    name: 'primitive:section',
    label: 'Section',
    group: 'Layout',
    description: 'A full-width band with its own background'
  },
  { name: 'primitive:row', label: 'Row', group: 'Layout', description: 'Blocks side by side' },
  { name: 'primitive:col', label: 'Column', group: 'Layout', description: 'A stack inside a row' }
];

/** Node template for a primitive palette name. Throws on unknown names. */
export function primitiveNode(name: string): BlockNode {
  switch (name) {
    case 'primitive:text':
      return { type: 'text', markdown: '' };
    case 'primitive:figure':
      return { type: 'figure', slots: { ids: '' } };
    case 'primitive:video':
      return { type: 'video', slots: { ids: '' } };
    case 'primitive:button':
      return { type: 'button', slots: { label: 'Button', href: '/', variant: 'primary' } };
    case 'primitive:row':
      return { type: 'grid', slots: { cols: 2 }, children: [] };
    case 'primitive:col':
      return { type: 'grid', slots: { cols: 1 }, children: [] };
    case 'primitive:section':
      return { type: 'grid', slots: { cols: 1, band: true }, children: [] };
    default:
      throw new Error(`blocks editor: unknown primitive ${name}`);
  }
}

/** Mount the palette into `root`: a heading, then one titled group per
 * kind, each item a full-width row. Click inserts; Enter and Space on a
 * focused item arrive as clicks, so placement never requires a drag. */
export function mountBlocksPalette(
  root: Element,
  macros: PaletteMacro[],
  onInsert: (name: string) => void
): void {
  const doc = root.ownerDocument;
  const palette = doc.createElement('div');
  palette.className = 'rkr-blocks-palette';
  const heading = doc.createElement('h2');
  heading.className = 'rkr-palette-title';
  heading.textContent = 'Add block';
  palette.append(heading);

  for (const { group, items } of groupPalette([...PALETTE_PRIMITIVES, ...macros])) {
    const section = doc.createElement('div');
    section.className = 'rkr-palette-group';
    section.setAttribute('role', 'group');
    section.setAttribute('aria-label', group);
    const title = doc.createElement('h3');
    title.className = 'rkr-palette-group-title';
    title.textContent = group;
    section.append(title);
    for (const m of items) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'rkr-blocks-palette-item';
      btn.dataset.macro = m.name;
      const icon = doc.createElement('span');
      icon.className = 'rkr-palette-icon';
      icon.innerHTML = paletteIcon(m.name);
      const text = doc.createElement('span');
      text.className = 'rkr-palette-text';
      const label = doc.createElement('span');
      label.className = 'rkr-palette-label';
      label.textContent = m.label;
      text.append(label);
      if (m.description) {
        const desc = doc.createElement('span');
        desc.className = 'rkr-palette-desc';
        desc.textContent = m.description;
        text.append(desc);
      }
      btn.append(icon, text);
      btn.addEventListener('click', () => onInsert(m.name));
      section.append(btn);
    }
    palette.append(section);
  }
  root.prepend(palette);
}
