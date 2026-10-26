// Palette insert for the unified editor: click-to-append and
// drag-and-drop onto live nodes.
//
// Extracted from unified-shell.ts to keep that file under the 500-line
// size cap. The shell owns the tree and saving; this module owns
// placement: click inserts after the selected block (or at the end of a
// selected container, or of the page body), drags resolve to before/after/inside drop positions,
// and containers that would nest deeper than the macro depth rule are
// refused with the save-inner-part nudge.
//
// Browser-safe: no node:* imports.

import { type BlockNode, type BlockTree, containerDepth } from '../lib/blocks.ts';
import { moveBlock, movedPath } from './block-move.ts';
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

const PAGE_CONTAINERS: ReadonlySet<string> = new Set(['section', 'row', 'col', 'flow']);

function dropKind(name: string): string {
  return name.startsWith('primitive:') ? name.slice('primitive:'.length) : name;
}

function dropRefused(name: string, depth: number): boolean {
  return PAGE_CONTAINERS.has(dropKind(name)) && depth >= MAX_MACRO_DEPTH;
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

function isContainerPath(tree: BlockTree, path: Path): boolean {
  const node = getAtPath(tree, path);
  if (!node || node.type === 'macro') return false;
  const kids =
    (node as { children?: BlockNode[]; blocks?: BlockNode[] }).children ??
    (node as { children?: BlockNode[]; blocks?: BlockNode[] }).blocks;
  return Array.isArray(kids);
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
    const list =
      at.length === 0
        ? env.getTree().body
        : (getAtPath(env.getTree(), at) as { children?: BlockNode[]; blocks?: BlockNode[] });
    const kids = Array.isArray(list) ? list : (list.children ?? list.blocks ?? []);
    return kids.length;
  };

  /** Directly after the selected leaf; at the end of a selected container;
   * at the end of the page when nothing is selected. */
  const clickTarget = (): { at: Path; index: number } => {
    const selected = env.getSelected();
    if (selected && getAtPath(env.getTree(), selected)) {
      if (isContainerPath(env.getTree(), selected)) {
        return { at: selected, index: childCount(selected) };
      }
      return { at: selected.slice(0, -1), index: (selected[selected.length - 1] as number) + 1 };
    }
    return { at: [], index: childCount([]) };
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
    const { at, index } = clickTarget();
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

  let moving: Path | null = null;
  let lastMarked: Element | null = null;

  const dropAt = (
    ev: Event,
    card: Element
  ): { pos: DropPosition; at: ReturnType<typeof resolveDrop> } => {
    const path = dropPath(card);
    const pos = dropPosition(
      (ev as unknown as { clientY?: number }).clientY ?? 0,
      card.getBoundingClientRect(),
      isContainerPath(env.getTree(), path)
    );
    return { pos, at: resolveDrop(env.getTree(), path, pos) };
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
    card: Element | null,
    from: Path | null
  ): { pos: DropPosition; at: { parentPath: Path; index: number } | null } => {
    if (!card) {
      const end = { parentPath: [], index: env.getTree().body.length };
      return { pos: 'inside', at: from ? moveTarget(from, end) : end };
    }
    const { pos, at } = dropAt(ev, card);
    return { pos, at: from ? moveTarget(from, at) : at };
  };

  body.addEventListener('dragover', (ev: Event) => {
    ev.preventDefault();
    if (!dragName && !moving && !dropName(ev)) return;
    const card = dropCard(ev);
    if (!card) {
      if (lastMarked) {
        lastMarked.removeAttribute('data-drop');
        lastMarked = null;
      }
      body.setAttribute('data-drop', 'inside');
      return;
    }
    body.removeAttribute('data-drop');
    const { pos, at } = resolveHover(ev, card, moving);
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
    const card = dropCard(ev);
    clearDropMarks();
    body.removeAttribute('data-drop');
    dragName = null;
    const from = moving;
    moving = null;
    if (!name && !from) return;
    const { at } = resolveHover(ev, card, from);
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
