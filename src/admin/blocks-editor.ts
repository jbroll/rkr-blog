// Blocks palette + inline-field helpers for the JSON-pages editor.
// Browser-safe: no node:* imports (bundled into the admin bundle).

import type { BlockNode, Slots } from '../lib/blocks.ts';
import { MAX_GRID_LEVELS } from '../lib/grid.ts';
import { groupPalette, paletteIcon } from './palette-groups.ts';

/** Copy one macro instance's overrides for duplicate. Deep copy so the
 * duplicate never shares array/object identity with the source. */
export function duplicateOverrides(slots: Slots): Slots {
  return JSON.parse(JSON.stringify(slots)) as Slots;
}

/** Depth-meter copy, e.g. "Level 2 of 3". */
export function depthLabel(depth: number): string {
  return `Level ${depth} of ${MAX_GRID_LEVELS}`;
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
  options?: Array<string | { value: string; label: string }>;
  /** Field specs of one `list` item. */
  item?: Record<string, PaletteFieldSpec>;
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
  {
    name: 'primitive:marquee',
    label: 'Marquee',
    group: 'Basics',
    description: 'A line of scrolling text'
  },
  {
    name: 'primitive:accordion',
    label: 'Accordion',
    group: 'Basics',
    description: 'Titles that open to show text'
  },
  {
    name: 'primitive:progress',
    label: 'Progress',
    group: 'Basics',
    description: 'A bar toward a fundraising goal'
  },
  { name: 'primitive:figure', label: 'Image', group: 'Media', description: 'Photos with captions' },
  {
    name: 'primitive:video',
    label: 'Video',
    group: 'Media',
    description: 'A video with a caption'
  },
  {
    name: 'primitive:embed',
    label: 'Embed',
    group: 'Media',
    description: 'A Google form, map or document, or a YouTube or Vimeo video'
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
    case 'primitive:marquee':
      return { type: 'marquee', slots: { text: '' } };
    case 'primitive:accordion':
      return { type: 'accordion', slots: { items: [] } };
    case 'primitive:progress':
      return { type: 'progress', slots: { source: 'site' } };
    case 'primitive:embed':
      return { type: 'embed', slots: { url: '' } };
    case 'primitive:row':
      return { type: 'grid', slots: { cols: 2 }, children: [] };
    case 'primitive:col':
      return { type: 'grid', slots: { cols: 1 }, children: [] };
    case 'primitive:section':
      return {
        type: 'grid',
        slots: { cols: 1, band: true, theme: 'light', edge: 'straight' },
        children: []
      };
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
