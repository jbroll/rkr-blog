// Palette insert for the unified editor: click-to-append and
// drag-and-drop onto live nodes.
//
// Extracted from unified-shell.ts to keep that file under the 500-line
// size cap. The shell owns the tree and saving; this module owns
// placement: click appends at the end of the selected container (or
// the page body), drags resolve to before/after/inside drop positions,
// and containers that would nest deeper than the macro depth rule are
// refused with the save-inner-part nudge.
//
// Browser-safe: no node:* imports.

import type { BlockNode, BlockTree } from '../lib/blocks.ts';
import {
  depthLabel,
  MAX_MACRO_DEPTH,
  mountBlocksPalette,
  type PaletteMacro,
  primitiveNode
} from './blocks-editor.ts';
import {
  type DropPosition,
  getAtPath,
  insertAtPath,
  type Path,
  resolveDrop
} from './blocks-page-editor.ts';

/** Reload so the DOM stays the server render: structural inserts have
 * no live markup until the save round-trips. Text blurs skip this. */
export const reloadPage = (): void => {
  try {
    sessionStorage.setItem('rkr-edit-mode', '1');
  } catch {
    // sessionStorage may be unavailable (private mode); ignore.
  }
  const loc = (globalThis as { location?: { reload(): void } }).location;
  loc?.reload();
};

const PAGE_CONTAINERS: ReadonlySet<string> = new Set(['section', 'row', 'col', 'flow']);

function dropKind(name: string): string {
  return name.startsWith('primitive:') ? name.slice('primitive:'.length) : name;
}

function dropRefused(name: string, depth: number): boolean {
  return PAGE_CONTAINERS.has(dropKind(name)) && depth >= MAX_MACRO_DEPTH;
}

/** Thirds of the hovered card: top → before, bottom → after,
 * middle → inside (containers only; resolveDrop decides). */
function dropPosition(clientY: number, rect: { top: number; height: number }): DropPosition {
  if (clientY < rect.top + rect.height / 3) return 'before';
  if (clientY > rect.top + (rect.height * 2) / 3) return 'after';
  return 'inside';
}

export interface InsertEnv {
  dock: Element;
  body: Element;
  macros: PaletteMacro[];
  getTree(): BlockTree;
  getSelected(): Path | null;
  /** Shell applies the tree, marks editing, and saves (with reload). */
  commitInsert(next: BlockTree): void;
  /** Surface a refusal (depth nudge) without changing state. */
  showNudge(text: string): void;
}

function isContainerPath(tree: BlockTree, path: Path): boolean {
  const node = getAtPath(tree, path);
  if (!node || node.type === 'macro') return false;
  const kids =
    (node as { children?: BlockNode[]; blocks?: BlockNode[] }).children ??
    (node as { children?: BlockNode[]; blocks?: BlockNode[] }).blocks;
  return Array.isArray(kids);
}

/** Mount palette click + drag-drop insertion over the live page. */
export function mountPaletteInsert(env: InsertEnv): void {
  const { dock, body, macros } = env;

  const insertTarget = (): Path => {
    const selected = env.getSelected();
    if (selected) {
      if (isContainerPath(env.getTree(), selected)) return selected;
      const parent = selected.slice(0, -1);
      if (parent.length > 0 && isContainerPath(env.getTree(), parent)) return parent;
    }
    return [];
  };

  const nudge = (kind: string): void => {
    env.showNudge(
      `Containers stop at ${depthLabel(MAX_MACRO_DEPTH)} — save inner part as its own macro (${kind})`
    );
  };

  const insertNode = (name: string, at: Path, index: number): void => {
    if (dropRefused(name, at.length)) {
      nudge(dropKind(name));
      return;
    }
    const node: BlockNode = name.startsWith('primitive:')
      ? primitiveNode(name)
      : { type: 'macro', macro: name };
    env.commitInsert(insertAtPath(env.getTree(), at, index, node));
  };

  mountBlocksPalette(dock, macros, (name) => {
    const at = insertTarget();
    const list =
      at.length === 0
        ? env.getTree().body
        : (getAtPath(env.getTree(), at) as { children?: BlockNode[]; blocks?: BlockNode[] });
    const kids = Array.isArray(list) ? list : (list.children ?? list.blocks ?? []);
    insertNode(name, at, kids.length);
  });

  let dragName: string | null = null;
  const clearDropMarks = (): void => {
    for (const marked of body.querySelectorAll('[data-drop]')) marked.removeAttribute('data-drop');
  };

  for (const btn of dock.querySelectorAll('.rkr-blocks-palette-item') as unknown as HTMLElement[]) {
    btn.draggable = true;
    btn.addEventListener('dragstart', (ev) => {
      dragName = (btn as HTMLElement).dataset.macro ?? null;
      const dt = (ev as unknown as { dataTransfer?: { setData(t: string, v: string): void } })
        .dataTransfer;
      try {
        dt?.setData('text/plain', dragName ?? '');
      } catch {
        // Test fakes and locked-down browsers may throw; the dragName
        // closure carries the payload instead.
      }
    });
  }

  const dropCard = (ev: Event): Element | null => {
    const target = (ev as unknown as { target: Element | null }).target;
    return target?.closest?.('[data-rkr-path]') ?? null;
  };

  const dropName = (ev: Event): string | null => {
    if (dragName) return dragName;
    const dt = (ev as unknown as { dataTransfer?: { getData(t: string): string } }).dataTransfer;
    try {
      const name = dt?.getData('text/plain');
      return name ? name : null;
    } catch {
      return null;
    }
  };

  const dropPath = (card: Element): Path =>
    String(card.getAttribute('data-rkr-path'))
      .split(',')
      .filter((s) => s !== '')
      .map(Number);

  body.addEventListener('dragover', (ev: Event) => {
    ev.preventDefault();
    if (!dragName && !dropName(ev)) return;
    const card = dropCard(ev);
    if (!card) {
      clearDropMarks();
      body.setAttribute('data-drop', 'inside');
      return;
    }
    body.removeAttribute('data-drop');
    const rect = card.getBoundingClientRect();
    const pos = dropPosition((ev as unknown as { clientY?: number }).clientY ?? 0, rect);
    if (!resolveDrop(env.getTree(), dropPath(card), pos)) {
      clearDropMarks();
      return;
    }
    // Only re-mark when the target/position changes to avoid flicker.
    if (card.getAttribute('data-drop') !== pos) {
      clearDropMarks();
      card.setAttribute('data-drop', pos);
    }
  });

  body.addEventListener('dragleave', (ev: Event) => {
    const related = (ev as unknown as { relatedTarget: Node | null }).relatedTarget;
    if (!related || !body.contains(related)) clearDropMarks();
    body.removeAttribute('data-drop');
  });

  body.addEventListener('drop', (ev: Event) => {
    ev.preventDefault();
    const name = dropName(ev);
    const card = dropCard(ev);
    clearDropMarks();
    body.removeAttribute('data-drop');
    dragName = null;
    if (!name) return;
    let resolved: { parentPath: Path; index: number } | null = null;
    if (card) {
      const rect = card.getBoundingClientRect();
      const pos = dropPosition((ev as unknown as { clientY?: number }).clientY ?? 0, rect);
      resolved = resolveDrop(env.getTree(), dropPath(card), pos);
    } else {
      resolved = { parentPath: [], index: env.getTree().body.length };
    }
    if (!resolved) return;
    insertNode(name, resolved.parentPath, resolved.index);
  });
}
