// Where a dragged block may land: a gap of the innermost grid under the
// pointer (or of the page body), kept only when the hard and soft rules
// allow the dragged block there. Browser-safe: no node:* imports.

import { type BlockNode, type BlockTree, containerDepth } from '../lib/blocks.ts';
import { gridLabel, MAX_GRID_LEVELS, readGridSlots } from '../lib/grid.ts';
import { isInside } from './block-move.ts';
import { childrenOf, getAtPath, type Path } from './block-tree-ops.ts';

export interface DropSlot {
  parentPath: Path;
  index: number;
  anchor: Element | null;
  side: 'before' | 'after' | 'inside';
  axis: 'horizontal' | 'vertical';
}

type Axis = DropSlot['axis'];

interface Box {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

interface Item {
  index: number;
  box: Box;
  first: Element;
  last: Element;
}

interface Gap {
  index: number;
  anchor: Element;
  side: 'before' | 'after';
  axis: Axis;
  dist: number;
}

function boxOf(els: Element[]): Box {
  const boxes = els.map((el) => {
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
  return {
    top: Math.min(...boxes.map((b) => b.top)),
    left: Math.min(...boxes.map((b) => b.left)),
    bottom: Math.max(...boxes.map((b) => b.bottom)),
    right: Math.max(...boxes.map((b) => b.right))
  };
}

function pathOf(el: Element): Path | null {
  const raw = el.getAttribute?.('data-rkr-path');
  if (raw == null) return null;
  return raw
    .split(',')
    .filter((s) => s !== '')
    .map(Number);
}

/** The `.rkr-grid` element of the grid whose path element is `el`
 * (a wrap or band section holds it). */
function gridElementOf(el: Element): Element {
  return el.classList.contains('rkr-grid') ? el : (el.querySelector('.rkr-grid') ?? el);
}

function innermostGrid(
  body: Element,
  tree: BlockTree,
  hovered: Element | null
): { path: Path; el: Element } | null {
  for (let node: Node | null = hovered; node && node !== body; node = node.parentNode) {
    if (node.nodeType !== 1) continue;
    const path = pathOf(node as Element);
    if (path && getAtPath(tree, path)?.type === 'grid') return { path, el: node as Element };
  }
  return null;
}

/** Each child's cell, measured instead of the child so the gaps between
 * cells are the grid's own. */
function gridItems(gridEl: Element, gridPath: Path): Item[] {
  const items: Item[] = [];
  for (const cell of Array.from(gridEl.children)) {
    if (!cell.classList.contains('rkr-grid-cell')) continue;
    const child = cell.querySelector('[data-rkr-path]');
    const path = child ? pathOf(child) : null;
    if (path?.length !== gridPath.length + 1) continue;
    items.push({
      index: path[gridPath.length] as number,
      box: boxOf([cell]),
      first: cell,
      last: cell
    });
  }
  return items.sort((a, b) => a.index - b.index);
}

function bodyItems(body: Element): Item[] {
  const groups = new Map<number, Element[]>();
  for (const el of Array.from(body.querySelectorAll('[data-rkr-path]'))) {
    const path = pathOf(el);
    if (path?.length !== 1) continue;
    const index = path[0] as number;
    groups.set(index, [...(groups.get(index) ?? []), el]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, els]) => ({
      index,
      box: boxOf(els),
      first: els[0] as Element,
      last: els[els.length - 1] as Element
    }));
}

function sideBySide(a: Box, b: Box): boolean {
  return a.top < b.bottom && b.top < a.bottom;
}

function distance(x: number, y: number, seg: Box): number {
  return Math.hypot(
    Math.max(seg.left - x, 0, x - seg.right),
    Math.max(seg.top - y, 0, y - seg.bottom)
  );
}

function edge(box: Box, axis: Axis, end: 'start' | 'end'): Box {
  if (axis === 'vertical') {
    const x = end === 'start' ? box.left : box.right;
    return { top: box.top, bottom: box.bottom, left: x, right: x };
  }
  const y = end === 'start' ? box.top : box.bottom;
  return { top: y, bottom: y, left: box.left, right: box.right };
}

function endGap(item: Item, axes: Axis[], end: 'start' | 'end', x: number, y: number): Gap {
  const [axis, dist] = axes
    .map((a): [Axis, number] => [a, distance(x, y, edge(item.box, a, end))])
    .reduce((best, next) => (next[1] < best[1] ? next : best));
  return end === 'start'
    ? { index: item.index, anchor: item.first, side: 'before', axis, dist }
    : { index: item.index + 1, anchor: item.last, side: 'after', axis, dist };
}

/** Axes an end gap may take. A lone item has no neighbour to read the
 * axis from, and the last item of a wrapped row has free cells to its
 * right, so both offer the side edge as well. */
function endAxes(items: Item[], end: 'start' | 'end', rowRight: number): Axis[] {
  const item = (end === 'start' ? items[0] : items[items.length - 1]) as Item;
  const neighbour = end === 'start' ? items[1] : items[items.length - 2];
  if (!neighbour) return ['horizontal', 'vertical'];
  if (sideBySide(item.box, neighbour.box)) return ['vertical'];
  return end === 'end' && rowRight > item.box.right ? ['horizontal', 'vertical'] : ['horizontal'];
}

/** `rowRight` is the rightmost cell edge, which a padded grid box would
 * overstate; null for the page body, which always stacks. */
function nearestGap(items: Item[], x: number, y: number, rowRight: number | null): Gap {
  const stack = rowRight === null;
  const axesAt = (end: 'start' | 'end'): Axis[] =>
    rowRight === null ? ['horizontal'] : endAxes(items, end, rowRight);
  const gaps: Gap[] = [endGap(items[0] as Item, axesAt('start'), 'start', x, y)];
  for (let k = 1; k < items.length; k++) {
    const a = items[k - 1] as Item;
    const b = items[k] as Item;
    const vertical = !stack && sideBySide(a.box, b.box);
    // A row break's gap sits over the next row's first cell, not across
    // the whole grid, so the free cells beside the last row stay free.
    const span = {
      top: Math.min(a.box.top, b.box.top),
      bottom: Math.max(a.box.bottom, b.box.bottom),
      left: vertical ? Math.min(a.box.left, b.box.left) : b.box.left,
      right: vertical ? Math.max(a.box.right, b.box.right) : b.box.right
    };
    const [from, to] = vertical ? [a.box.right, b.box.left] : [a.box.bottom, b.box.top];
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const seg = vertical ? { ...span, left: lo, right: hi } : { ...span, top: lo, bottom: hi };
    gaps.push({
      index: a.index + 1,
      anchor: a.last,
      side: 'after',
      axis: vertical ? 'vertical' : 'horizontal',
      dist: distance(x, y, seg)
    });
  }
  gaps.push(endGap(items[items.length - 1] as Item, axesAt('end'), 'end', x, y));
  return gaps.reduce((best, next) => (next.dist < best.dist ? next : best));
}

/** Whether `node` placed in the list at `parentPath` stays within the grid depth limit. */
export function fitsDepth(parentPath: Path, node: BlockNode): boolean {
  return parentPath.length + containerDepth(node) <= MAX_GRID_LEVELS;
}

export function depthNudge(grid: Extract<BlockNode, { type: 'grid' }>): string {
  return `${gridLabel(grid.slots)} can't go here: grids nest at most ${MAX_GRID_LEVELS} levels. Save the inner part as its own macro.`;
}

function legal(tree: BlockTree, slot: DropSlot, dragged: BlockNode, from: Path | null): boolean {
  const { parentPath, index } = slot;
  if (from) {
    if (isInside(from, parentPath)) return false;
    const fromIdx = from[from.length - 1] as number;
    const sameParent = from.slice(0, -1).join(',') === parentPath.join(',');
    if (sameParent && (index === fromIdx || index === fromIdx + 1)) return false;
  }
  if (dragged.type === 'grid') {
    const own = readGridSlots(dragged.slots);
    if (own.band && parentPath.length > 0) return false;
    const parent = parentPath.length > 0 ? getAtPath(tree, parentPath) : null;
    if (own.cols === 1 && parent?.type === 'grid' && readGridSlots(parent.slots).cols === 1) {
      return false;
    }
  }
  return fitsDepth(parentPath, dragged);
}

/** The legal slot nearest (x, y) for `dragged`, or null when the nearest
 * slot breaks a rule. `from` is the dragged block's path for a move. */
export function findDropSlot(
  body: Element,
  tree: BlockTree,
  x: number,
  y: number,
  hovered: Element | null,
  dragged: BlockNode,
  from: Path | null
): DropSlot | null {
  const grid = innermostGrid(body, tree, hovered);
  const parentPath = grid?.path ?? [];
  const gridEl = grid ? gridElementOf(grid.el) : null;
  const items = gridEl ? gridItems(gridEl, parentPath) : bodyItems(body);
  let slot: DropSlot;
  if (items.length === 0) {
    const placeholder = gridEl
      ? (Array.from(gridEl.children).find((c) => c.hasAttribute('data-rkr-grid-empty')) ?? gridEl)
      : null;
    const parent = grid ? getAtPath(tree, parentPath) : null;
    slot = {
      parentPath,
      index: parent ? childrenOf(parent).length : tree.body.length,
      anchor: placeholder,
      side: 'inside',
      axis: 'horizontal'
    };
  } else {
    const rowRight = gridEl ? Math.max(...items.map((i) => i.box.right)) : null;
    const { dist: _dist, ...gap } = nearestGap(items, x, y, rowRight);
    slot = { parentPath, ...gap };
  }
  return legal(tree, slot, dragged, from) ? slot : null;
}
