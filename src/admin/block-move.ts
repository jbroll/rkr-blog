// Tree move that stays correct across nesting levels. `moveNode` in
// blocks-page-editor.ts only adjusts the target index for same-list
// moves; moving a block into a later sibling's container leaves the
// parent path pointing at the wrong node once the source is removed.
//
// Browser-safe: no node:* imports.

import type { BlockTree } from '../lib/blocks.ts';
import { getAtPath, insertAtPath, type Path, removeAtPath } from './blocks-page-editor.ts';

/** Where a node lands after moving `from` into `toParent` at `index`
 * (both expressed against the tree before the move). */
export function movedPath(from: Path, toParent: Path, index: number): Path {
  const fromParent = from.slice(0, -1);
  const fromIdx = from[from.length - 1] as number;
  const depth = fromParent.length;
  const underSameParent = toParent.length >= depth && fromParent.every((v, i) => toParent[i] === v);
  if (underSameParent && toParent.length === depth && fromIdx < index) {
    return [...toParent, index - 1];
  }
  if (underSameParent && toParent.length > depth && (toParent[depth] as number) > fromIdx) {
    const shifted = [...toParent];
    shifted[depth] = (shifted[depth] as number) - 1;
    return [...shifted, index];
  }
  return [...toParent, index];
}

/** True when `target` is `from` itself or inside it. */
export function isInside(from: Path, target: Path): boolean {
  return from.length <= target.length && from.every((v, i) => target[i] === v);
}

/** Move the node at `from` into `toParent` at `index`. Throws when the
 * target is inside the moved node or the source is missing. */
export function moveBlock(tree: BlockTree, from: Path, toParent: Path, index: number): BlockTree {
  if (isInside(from, toParent)) {
    throw new Error('blocks editor: cannot move into its own descendant');
  }
  const node = getAtPath(tree, from);
  if (!node) throw new Error('blocks editor: path not found');
  const landing = movedPath(from, toParent, index);
  return insertAtPath(
    removeAtPath(tree, from),
    landing.slice(0, -1),
    landing[landing.length - 1] as number,
    node
  );
}
