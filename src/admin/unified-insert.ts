// Palette insert placement for the unified editor. The shell owns the tree
// and saving; this module only decides where a click or drop lands.
//
// Browser-safe: no node:* imports.

import { type BlockNode, type BlockTree, containerDepth } from '../lib/blocks.ts';
import { readGridSlots } from '../lib/grid.ts';
import { moveBlock, movedPath } from './block-move.ts';
import {
  childrenOf,
  type DropPosition,
  getAtPath,
  insertAtPath,
  type Path,
  resolveDrop
} from './block-tree-ops.ts';
import {
  depthLabel,
  isLayoutPreset,
  MAX_MACRO_DEPTH,
  mountBlocksPalette,
  PALETTE_PRIMITIVES,
  type PaletteMacro,
  primitiveNode
} from './blocks-editor.ts';

function dropKind(name: string): string {
  return name.startsWith('primitive:') ? name.slice('primitive:'.length) : name;
}

function dropRefused(name: string, depth: number): boolean {
  return isLayoutPreset(name) && depth >= MAX_MACRO_DEPTH;
}

/** Containers split the hovered card in thirds: top → before, bottom →
 * after, middle → inside. Leaves split at half (before/after) because
 * "inside" is refused for them and would leave tall cards half dead. */
export function dropPosition(
  clientY: number,
  rect: { top: number; height: number },
  container: boolean
): DropPosition {
  if (!container) return clientY < rect.top + rect.height / 2 ? 'before' : 'after';
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
  /** Commit the focused text leaf before an insert reads the tree. */
  flushText(): void;
  /** Shell re-renders `next` in place, selects `path`, and saves.
   * `inserted` is false for a move. */
  commitInsert(next: BlockTree, path: Path, inserted: boolean): void;
  /** Surface a refusal (depth nudge) without changing state. */
  showNudge(text: string): void;
}

function isRow(node: BlockNode | null): boolean {
  return node?.type === 'grid' && readGridSlots(node.slots).cols > 1;
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
    const next = insertAtPath(env.getTree(), at, index, node);
    env.commitInsert(next, [...at, index], true);
  };

  mountBlocksPalette(dock, macros, (name) => {
    env.flushText();
    const { at, index } = clickTarget(name);
    insertNode(name, at, index);
  });

  let dragName: string | null = null;
  const clearDropMarks = (): void => {
    for (const marked of body.querySelectorAll('[data-drop]')) marked.removeAttribute('data-drop');
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
  }

  const dropCard = (ev: Event): Element | null => {
    const target = (ev as unknown as { target: Element | null }).target;
    return target?.closest?.('[data-rkr-path]') ?? null;
  };

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

  const dropPath = (card: Element): Path =>
    String(card.getAttribute('data-rkr-path'))
      .split(',')
      .filter((s) => s !== '')
      .map(Number);

  let moving: Path | null = null;
  let lastMarked: Element | null = null;

  const cardsOf = (path: Path): Element[] => {
    const key = path.join(',');
    return [...body.querySelectorAll(`[data-rkr-path="${key}"]`)];
  };

  const childPaths = (parent: Path): Path[] => {
    const key = parent.join(',');
    const seen = new Map<string, Path>();
    for (const el of body.querySelectorAll('[data-rkr-path]')) {
      const p = dropPath(el);
      if (p.length === parent.length + 1 && p.slice(0, -1).join(',') === key) {
        seen.set(p.join(','), p);
      }
    }
    return [...seen.values()];
  };

  const unionRect = (els: Element[]) => {
    const rects = els.map((el) => {
      const r: Partial<DOMRect> = el.getBoundingClientRect?.() ?? {};
      const top = r.top ?? 0;
      const left = r.left ?? 0;
      return {
        top,
        left,
        bottom: r.bottom ?? top + (r.height ?? 0),
        right: r.right ?? left + (r.width ?? 0)
      };
    });
    const top = Math.min(...rects.map((r) => r.top));
    const left = Math.min(...rects.map((r) => r.left));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    const right = Math.max(...rects.map((r) => r.right));
    return { top, left, bottom, right, height: bottom - top };
  };

  /** The card and side a drag lands on. Over a gap (between a
   * container's children, or outside every block) it is the nearest
   * block, so the marker never jumps to a distant container edge; only
   * an empty container takes a drop inside. */
  const dropTarget = (ev: Event): { card: Element; path: Path; pos: DropPosition } | null => {
    const { clientX: x = 0, clientY: y = 0 } = ev as unknown as {
      clientX?: number;
      clientY?: number;
    };
    const tree = env.getTree();
    const hovered = dropCard(ev);
    let path: Path = hovered ? dropPath(hovered) : [];
    for (;;) {
      if (path.length > 0 && !isContainerPath(tree, path)) break;
      const kids = childPaths(path);
      if (kids.length === 0) break;
      let best: {
        path: Path;
        rect: ReturnType<typeof unionRect>;
        dx: number;
        dy: number;
        dist: number;
      } | null = null;
      for (const kid of kids) {
        const rect = unionRect(cardsOf(kid));
        const dx = Math.max(rect.left - x, 0, x - rect.right);
        const dy = Math.max(rect.top - y, 0, y - rect.bottom);
        const dist = Math.hypot(dx, dy);
        if (!best || dist < best.dist) best = { path: kid, rect, dx, dy, dist };
      }
      if (!best) break;
      const sideways = isRow(getAtPath(tree, path));
      // Level with a container (e.g. in the margin beside a page-wide
      // flow): look inside it rather than dropping at its far edge.
      const level = sideways ? best.dx === 0 : best.dy === 0;
      if (best.dist === 0 || (level && isContainerPath(tree, best.path))) {
        path = best.path;
        continue;
      }
      const before = sideways
        ? x < (best.rect.left + best.rect.right) / 2
        : y < best.rect.top + best.rect.height / 2;
      const els = cardsOf(best.path);
      const card = (before ? els[0] : els[els.length - 1]) as Element;
      return { card, path: best.path, pos: before ? 'before' : 'after' };
    }
    if (path.length === 0) return null;
    const els = cardsOf(path);
    const pos = dropPosition(y, unionRect(els), isContainerPath(tree, path));
    const card = (pos === 'after' ? els[els.length - 1] : els[0]) as Element;
    return { card, path, pos };
  };

  /** Where a dragged block may land, or null when the move is refused
   * (into itself, past the container depth limit) or changes nothing. */
  const moveTarget = (
    from: Path,
    at: { parentPath: Path; index: number } | null
  ): { parentPath: Path; index: number } | null => {
    const node = getAtPath(env.getTree(), from);
    if (!at || !node) return null;
    const landing = [...at.parentPath, at.index];
    if (from.length < landing.length && from.every((v, i) => landing[i] === v)) return null;
    if (containerDepth(node) > 0 && at.parentPath.length + containerDepth(node) > MAX_MACRO_DEPTH) {
      return null;
    }
    const target = movedPath(from, at.parentPath, at.index);
    return target.join(',') === from.join(',') ? null : at;
  };

  const resolveHover = (
    ev: Event,
    from: Path | null
  ): {
    card: Element | null;
    pos: DropPosition;
    at: { parentPath: Path; index: number } | null;
  } => {
    const hit = dropTarget(ev);
    if (!hit) {
      const end = { parentPath: [], index: env.getTree().body.length };
      return { card: null, pos: 'inside', at: from ? moveTarget(from, end) : end };
    }
    const at = resolveDrop(env.getTree(), hit.path, hit.pos);
    return { card: hit.card, pos: hit.pos, at: from ? moveTarget(from, at) : at };
  };

  body.addEventListener('dragover', (ev: Event) => {
    if (!dragName && !moving && !dropName(ev)) return;
    ev.preventDefault();
    const { card, pos, at } = resolveHover(ev, moving);
    if (!card) {
      if (lastMarked) {
        lastMarked.removeAttribute('data-drop');
        lastMarked = null;
      }
      body.setAttribute('data-drop', 'inside');
      return;
    }
    body.removeAttribute('data-drop');
    if (!at) {
      if (lastMarked) {
        lastMarked.removeAttribute('data-drop');
        lastMarked = null;
      }
      return;
    }
    if (lastMarked && lastMarked !== card) lastMarked.removeAttribute('data-drop');
    if (card.getAttribute('data-drop') !== pos) card.setAttribute('data-drop', pos);
    lastMarked = card;
  });

  body.addEventListener('dragleave', (ev: Event) => {
    const related = (ev as unknown as { relatedTarget: Node | null }).relatedTarget;
    if (!related || !body.contains(related)) clearDropMarks();
    body.removeAttribute('data-drop');
  });

  body.addEventListener('drop', (ev: Event) => {
    ev.preventDefault();
    const name = dropName(ev);
    clearDropMarks();
    body.removeAttribute('data-drop');
    dragName = null;
    const from = moving;
    moving = null;
    if (!name && !from) return;
    const { at } = resolveHover(ev, from);
    if (!at) return;
    if (from) {
      const next = moveBlock(env.getTree(), from, at.parentPath, at.index);
      env.commitInsert(next, movedPath(from, at.parentPath, at.index), false);
      return;
    }
    if (name) insertNode(name, at.parentPath, at.index);
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
