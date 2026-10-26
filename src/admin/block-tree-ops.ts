// Pure, immutable edits on a JSON block tree, addressed by index path
// from the page body. The unified editor computes the next tree with
// these, re-renders, then saves the whole tree. Moves live in
// block-move.ts. Browser-safe: no node:* imports, no DOM.

import type { BlockNode, BlockTree, Slots } from '../lib/blocks.ts';

export type Path = number[];

/** A grid's children; leaves and macro instances have none. */
export function childrenOf(node: BlockNode): BlockNode[] {
  return node.type === 'grid' ? node.children : [];
}

/** Node at `path` (indices from the page body). Null when missing. */
export function getAtPath(tree: BlockTree, path: Path): BlockNode | null {
  let level: BlockNode[] = tree.body;
  let node: BlockNode | null = null;
  for (const i of path) {
    node = level[i] ?? null;
    if (!node) return null;
    level = childrenOf(node);
  }
  return node;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function updateList(
  tree: BlockTree,
  parentPath: Path,
  fn: (list: BlockNode[]) => BlockNode[]
): BlockTree {
  const next = clone(tree);
  if (parentPath.length === 0) {
    next.body = fn(next.body);
    return next;
  }
  const parent = getAtPath(next, parentPath);
  if (parent?.type !== 'grid') throw new Error('blocks editor: bad parent');
  parent.children = fn([...parent.children]);
  return next;
}

/** Copy of the tree with one slot set on the node at `path`. */
export function setSlotAtPath(tree: BlockTree, path: Path, key: string, value: string): BlockTree {
  const node = getAtPath(tree, path);
  if (!node || node.type === 'macro') throw new Error('blocks editor: path not found');
  return updateList(tree, path.slice(0, -1), (list) =>
    list.map((n, i) => {
      if (i !== (path[path.length - 1] as number)) return n;
      if (key === 'markdown') return { ...n, markdown: value };
      return { ...n, slots: { ...((n as { slots?: Slots }).slots ?? {}), [key]: value } };
    })
  );
}

/** Copy of the tree with `update` applied to the slots at `path`.
 * Unlike setSlotAtPath (single key, always present), the updater owns
 * the whole slots object: it may merge, and it may delete keys to
 * un-set an override so the macro default flows through again. */
export function updateSlotsAtPath(
  tree: BlockTree,
  path: Path,
  update: (slots: Slots) => Slots
): BlockTree {
  const node = getAtPath(tree, path);
  if (!node) {
    throw new Error('blocks editor: path not found');
  }
  return updateList(tree, path.slice(0, -1), (list) =>
    list.map((n, i) => {
      if (i !== (path[path.length - 1] as number)) return n;
      return { ...n, slots: update({ ...((n as { slots?: Slots }).slots ?? {}) }) };
    })
  );
}

/** Copy of the tree with `node` inserted into the parent at `index`. */
export function insertAtPath(
  tree: BlockTree,
  parentPath: Path,
  index: number,
  node: BlockNode
): BlockTree {
  return updateList(tree, parentPath, (list) => {
    const at = Math.max(0, Math.min(index, list.length));
    return [...list.slice(0, at), clone(node), ...list.slice(at)];
  });
}

/** Copy of the tree without the node at `path`. */
export function removeAtPath(tree: BlockTree, path: Path): BlockTree {
  if (path.length === 0) throw new Error('blocks editor: cannot remove root');
  const idx = path[path.length - 1] as number;
  return updateList(tree, path.slice(0, -1), (list) => list.filter((_, i) => i !== idx));
}

/** Copy of the tree with the node at `path` replaced by a grid of `cols`
 * columns that holds it. */
export function wrapAtPath(tree: BlockTree, path: Path, cols: 1 | 2): BlockTree {
  const node = getAtPath(tree, path);
  if (!node) throw new Error('blocks editor: path not found');
  const idx = path[path.length - 1] as number;
  return updateList(tree, path.slice(0, -1), (list) =>
    list.map((n, i) => (i === idx ? { type: 'grid', slots: { cols }, children: [n] } : n))
  );
}

/** Copy of the tree with the grid at `path` replaced by its children. */
export function unwrapAtPath(tree: BlockTree, path: Path): BlockTree {
  const node = getAtPath(tree, path);
  if (node?.type !== 'grid') throw new Error('blocks editor: not a grid');
  const idx = path[path.length - 1] as number;
  return updateList(tree, path.slice(0, -1), (list) => [
    ...list.slice(0, idx),
    ...clone(node.children),
    ...list.slice(idx + 1)
  ]);
}

export type DropPosition = 'before' | 'after' | 'inside';

/** Resolve a drop onto the card at `targetPath` to an insertion point.
 * before/after land in the target's parent; inside lands at the end of
 * the target, and only grids accept it — leaves and macro
 * instances (whose internals are not editable here) return null. */
export function resolveDrop(
  tree: BlockTree,
  targetPath: Path,
  position: DropPosition
): { parentPath: Path; index: number } | null {
  const target = getAtPath(tree, targetPath);
  if (!target) return null;
  if (position === 'inside') {
    if (target.type !== 'grid') return null;
    return { parentPath: targetPath, index: target.children.length };
  }
  const parentPath = targetPath.slice(0, -1);
  const idx = targetPath[targetPath.length - 1] as number;
  return { parentPath, index: position === 'after' ? idx + 1 : idx };
}
