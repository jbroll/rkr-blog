// Hydrate the edit render's `<!--rkr:path=i,j-->` markers back to tree
// paths. Marker order is the server's render order (`renderBlockTree`
// with `mark`): containers are nodes themselves, a macro instance is a
// single unit, and blank text renders an edit placeholder, so every node
// has a marker. Paths never depend on the DOM shape.
//
// Browser-safe: no node:* imports (bundled into the admin entry).

import type { BlockNode, BlockTree } from '../lib/blocks.ts';
import { getAtPath, type Path } from './blocks-page-editor.ts';

export interface HydratedUnit {
  path: Path;
  node: BlockNode;
  /** Elements rendered by this node. A text leaf can render several
   * block elements (one per markdown block); containers render one. */
  elements: Element[];
}

const MARKER = /^rkr:path=([0-9,]+)$/;

function kidsOf(node: BlockNode): BlockNode[] {
  if (node.type === 'macro') return [];
  const n = node as { children?: BlockNode[]; blocks?: BlockNode[] };
  return n.children ?? n.blocks ?? [];
}

/** Tree nodes in the server's render order. */
function serverOrder(tree: BlockTree): { path: Path; node: BlockNode }[] {
  const out: { path: Path; node: BlockNode }[] = [];
  const walk = (nodes: BlockNode[], base: Path): void => {
    nodes.forEach((node, i) => {
      const path = [...base, i];
      out.push({ path, node });
      walk(kidsOf(node), path);
    });
  };
  walk(tree.body, []);
  return out;
}

function parseMarker(value: string | null): Path | null {
  const match = MARKER.exec((value ?? '').trim());
  if (!match) return null;
  const path = (match[1] as string).split(',').map(Number);
  return path.some((i) => !Number.isInteger(i)) ? null : path;
}

function samePath(a: Path, b: Path): boolean {
  return a.length === b.length && a.every((v, i) => b[i] === v);
}

/** Every path marker under `scope`, in document order. */
function collectMarkers(scope: Element): Node[] {
  const out: Node[] = [];
  const walk = (parent: Node): void => {
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 8 && parseMarker(child.nodeValue)) out.push(child);
      else if (child.nodeType === 1) walk(child);
    }
  };
  walk(scope);
  return out;
}

/** Sibling elements emitted by the node whose marker is `marker`.
 * Sibling markers delimit units, so a container reports only its own
 * element while a multi-paragraph text leaf reports every paragraph. */
function elementsAfter(marker: Node): Element[] {
  const out: Element[] = [];
  for (let next = marker.nextSibling; next; next = next.nextSibling) {
    if (next.nodeType === 8 && parseMarker(next.nodeValue)) break;
    if (next.nodeType === 1) out.push(next as Element);
  }
  return out;
}

/** Zip the markers under `body` to `tree`. Stamps `data-rkr-path` on
 * every unit element so drop targets and CSS can find them. */
export function hydrate(tree: BlockTree, body: Element): HydratedUnit[] {
  const ordered = serverOrder(tree);
  const units: HydratedUnit[] = [];
  collectMarkers(body).forEach((marker, i) => {
    const markerPath = parseMarker(marker.nodeValue);
    if (!markerPath) return;
    const zipped = ordered[i];
    const node =
      zipped && samePath(zipped.path, markerPath) ? zipped.node : getAtPath(tree, markerPath);
    if (!node) return;
    let elements = elementsAfter(marker);
    if (elements.length === 0) {
      // Nothing rendered (an unresolvable figure, an unknown macro):
      // plant a selectable stand-in so the node stays configurable.
      const holder = body.ownerDocument.createElement('div');
      holder.className = 'rkr-unified-empty';
      holder.textContent = `Empty ${node.type === 'macro' ? `macro ${node.macro}` : node.type} — configure to add content`;
      marker.parentNode?.insertBefore(holder, marker.nextSibling);
      elements = [holder];
    }
    for (const el of elements) el.setAttribute('data-rkr-path', markerPath.join(','));
    units.push({ path: markerPath, node, elements });
  });
  return units;
}
