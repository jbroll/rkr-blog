import type { BlockNode, BlockTree } from './blocks.ts';

function firstIn(nodes: BlockNode[]): string | null {
  for (const node of nodes) {
    if (node.type === 'figure') {
      const ids = node.slots?.ids;
      const id = typeof ids === 'string' ? ids.split(/\s+/).find(Boolean) : undefined;
      if (id) return id;
    } else if (node.type === 'grid') {
      const id = firstIn(node.children);
      if (id) return id;
    }
  }
  return null;
}

/** First image id of the first figure in reading order, through grids and
 * not into macro instances. */
export function firstFigureId(tree: BlockTree): string | null {
  return firstIn(tree.body);
}
