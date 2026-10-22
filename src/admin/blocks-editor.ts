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
}

/** Mount the macro palette into `root`. Each macro becomes one insert
 * button; clicks call `onInsert` with the macro name. Safe to call when
 * the experimental blocks UI is disabled: renders nothing without macros. */
export function mountBlocksPalette(
  root: Element,
  macros: PaletteMacro[],
  onInsert: (name: string) => void
): void {
  if (macros.length === 0) return;
  const aside = root.ownerDocument.createElement('aside');
  aside.className = 'rkr-blocks-palette';
  aside.setAttribute('aria-label', 'Reusable blocks');
  for (const m of macros) {
    const btn = root.ownerDocument.createElement('button');
    btn.type = 'button';
    btn.className = 'rkr-blocks-palette-item';
    btn.textContent = m.label;
    btn.dataset.macro = m.name;
    btn.addEventListener('click', () => onInsert(m.name));
    aside.append(btn);
  }
  root.prepend(aside);
}
