// Palette insert placement for the unified editor. The shell owns the tree
// and saving; this module only decides where a click or drop lands.
//
// Browser-safe: no node:* imports.

import type { BlockNode, BlockTree } from '../lib/blocks.ts';
import { moveBlock, movedPath } from './block-move.ts';
import { childrenOf, getAtPath, insertAtPath, type Path } from './block-tree-ops.ts';
import {
  mountBlocksPalette,
  PALETTE_PRIMITIVES,
  type PaletteMacro,
  primitiveNode
} from './blocks-editor.ts';
import { type DropSlot, depthNudge, findDropSlot, fitsDepth } from './drop-slots.ts';

function nodeFor(name: string): BlockNode {
  return name.startsWith('primitive:') ? primitiveNode(name) : { type: 'macro', macro: name };
}

export interface InsertEnv {
  dock: Element;
  body: Element;
  macros: PaletteMacro[];
  getTree(): BlockTree;
  getSelected(): Path | null;
  /** Commit the focused text leaf before an insert reads the tree. */
  flushText(): void;
  /** Shell re-renders `next` in place, selects `path`, and saves.
   * `inserted` is false for a move. */
  commitInsert(next: BlockTree, path: Path, inserted: boolean): void;
  /** Surface a refusal (depth nudge) without changing state. */
  showNudge(text: string): void;
}

function isContainerPath(tree: BlockTree, path: Path): boolean {
  return getAtPath(tree, path)?.type === 'grid';
}

export interface PaletteInsert {
  /** An existing block is being dragged by its toolbar handle. */
  beginMove(path: Path): void;
  endMove(): void;
}

/** Mount palette click + drag-drop insertion over the live page. */
export function mountPaletteInsert(env: InsertEnv): PaletteInsert {
  const { dock, body, macros } = env;

  const childCount = (at: Path): number => {
    const tree = env.getTree();
    if (at.length === 0) return tree.body.length;
    const node = getAtPath(tree, at);
    return node ? childrenOf(node).length : 0;
  };

  /** Directly after the selected leaf; at the end of a selected container;
   * at the end of the page when nothing is selected. A Section only goes
   * in the page body, after the selected block's top-level ancestor. */
  const clickTarget = (name: string): { at: Path; index: number } => {
    const selected = env.getSelected();
    const live = selected && getAtPath(env.getTree(), selected) ? selected : null;
    if (name === 'primitive:section') {
      return { at: [], index: live ? (live[0] as number) + 1 : childCount([]) };
    }
    if (!live) return { at: [], index: childCount([]) };
    if (isContainerPath(env.getTree(), live)) return { at: live, index: childCount(live) };
    return { at: live.slice(0, -1), index: (live[live.length - 1] as number) + 1 };
  };

  const insertNode = (name: string, at: Path, index: number): void => {
    const node = nodeFor(name);
    if (node.type === 'grid' && !fitsDepth(at, node)) {
      env.showNudge(depthNudge(node));
      return;
    }
    const next = insertAtPath(env.getTree(), at, index, node);
    env.commitInsert(next, [...at, index], true);
  };

  mountBlocksPalette(dock, macros, (name) => {
    env.flushText();
    const { at, index } = clickTarget(name);
    insertNode(name, at, index);
  });

  let dragName: string | null = null;
  let moving: Path | null = null;
  let lastMarked: Element | null = null;

  const unmark = (el: Element): void => {
    el.removeAttribute('data-drop');
    el.removeAttribute('data-drop-axis');
  };

  const clearDropMarks = (): void => {
    for (const marked of body.querySelectorAll('[data-drop]')) unmark(marked);
    body.removeAttribute('data-drop');
    lastMarked = null;
  };

  for (const btn of dock.querySelectorAll('.rkr-blocks-palette-item') as unknown as HTMLElement[]) {
    btn.draggable = true;
    btn.addEventListener('dragstart', (ev) => {
      env.flushText();
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
    // A refused drop fires no `drop`, so a stale name would let a later
    // foreign drag insert this entry.
    btn.addEventListener('dragend', () => {
      dragName = null;
      clearDropMarks();
    });
  }

  // Drag text from elsewhere (an image URL, selected words) is not a
  // block name; only palette entries may insert.
  const paletteNames = new Set([...PALETTE_PRIMITIVES, ...macros].map((m) => m.name));

  const dropName = (ev: Event): string | null => {
    if (dragName) return dragName;
    const dt = (ev as unknown as { dataTransfer?: { getData(t: string): string } }).dataTransfer;
    try {
      const name = dt?.getData('text/plain');
      return name && paletteNames.has(name) ? name : null;
    } catch {
      return null;
    }
  };

  // The page's own images and links would otherwise start a native drag
  // that drops their URL; blocks move by the toolbar's Drag handle.
  body.addEventListener('dragstart', (ev: Event) => {
    const target = (ev as unknown as { target: Element | null }).target;
    if (['img', 'a', 'picture', 'video'].some((tag) => target?.closest?.(tag))) {
      ev.preventDefault();
    }
  });

  const slotFor = (ev: Event): DropSlot | null => {
    const tree = env.getTree();
    const name = moving ? null : dropName(ev);
    const dragged = moving ? getAtPath(tree, moving) : name ? nodeFor(name) : null;
    if (!dragged) return null;
    const {
      clientX = 0,
      clientY = 0,
      target = null
    } = ev as unknown as { clientX?: number; clientY?: number; target?: Element | null };
    return findDropSlot(body, tree, clientX, clientY, target, dragged, moving);
  };

  const mark = (slot: DropSlot | null): void => {
    const anchor = slot?.anchor ?? null;
    if (lastMarked && lastMarked !== anchor) unmark(lastMarked);
    lastMarked = anchor;
    if (slot && !anchor) body.setAttribute('data-drop', 'inside');
    else body.removeAttribute('data-drop');
    if (!slot || !anchor) return;
    if (anchor.getAttribute('data-drop') !== slot.side) anchor.setAttribute('data-drop', slot.side);
    if (anchor.getAttribute('data-drop-axis') !== slot.axis) {
      anchor.setAttribute('data-drop-axis', slot.axis);
    }
  };

  // No preventDefault without a legal slot: the browser then shows the
  // drop as refused.
  body.addEventListener('dragover', (ev: Event) => {
    const slot = slotFor(ev);
    mark(slot);
    if (slot) ev.preventDefault();
  });

  body.addEventListener('dragleave', (ev: Event) => {
    const related = (ev as unknown as { relatedTarget: Node | null }).relatedTarget;
    if (!related || !body.contains(related)) clearDropMarks();
    body.removeAttribute('data-drop');
  });

  body.addEventListener('drop', (ev: Event) => {
    ev.preventDefault();
    const name = dropName(ev);
    const slot = slotFor(ev);
    const from = moving;
    clearDropMarks();
    dragName = null;
    moving = null;
    if (!slot) return;
    if (from) {
      const next = moveBlock(env.getTree(), from, slot.parentPath, slot.index);
      env.commitInsert(next, movedPath(from, slot.parentPath, slot.index), false);
      return;
    }
    if (name) insertNode(name, slot.parentPath, slot.index);
  });

  return {
    beginMove: (path) => {
      moving = path;
    },
    endMove: () => {
      moving = null;
      clearDropMarks();
    }
  };
}
