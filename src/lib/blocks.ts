// JSON block trees for reusable page macros.
// A page is a macro tree, not a markdown file. Markdown survives only as
// the value language inside `text` widgets (`text.markdown`).

import { expandShorthand, gridSlotProblem } from './grid.ts';

export type Slots = Record<string, unknown>;

export type ContainerKind = 'grid';

export interface ContainerNode {
  type: 'grid';
  slots?: Slots;
  children: BlockNode[];
}

export interface LeafNode {
  type:
    | 'text'
    | 'figure'
    | 'video'
    | 'button'
    | 'list'
    | 'marquee'
    | 'accordion'
    | 'progress'
    | 'embed';
  slots?: Slots;
  markdown?: string;
}

export interface MacroInstanceNode {
  type: 'macro';
  macro: string;
  slots?: Slots;
}

export type BlockNode = ContainerNode | LeafNode | MacroInstanceNode;

export interface BlockTree {
  version: 1;
  body: BlockNode[];
  /** Page settings (title, status, date, tags). Present on trees the editor holds. */
  fields?: Record<string, unknown>;
}

export interface MacroDef {
  defaults: Slots;
}

const LEAVES: ReadonlySet<string> = new Set([
  'text',
  'figure',
  'video',
  'button',
  'list',
  'marquee',
  'accordion',
  'progress',
  'embed'
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Merge overrides over macro defaults. Absent (undefined) follows the
 * default; every present value — including empty string — stays local. */
export function resolveSlots(
  macroDef: Pick<MacroDef, 'defaults'>,
  overrides: Slots
): { slots: Slots } {
  const out: Slots = { ...macroDef.defaults };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return { slots: out };
}

/** Follow macro references transitively. Returns the cycle path when
 * `name` reaches itself, otherwise null. */
export function detectCycle(lib: Record<string, string[]>, name: string): string[] | null {
  const path: string[] = [name];
  const seen = new Set<string>([name]);
  const stack: string[] = [...(lib[name] ?? [])];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    if (seen.has(next)) return [...path, next];
    seen.add(next);
    path.push(next);
    for (const ref of lib[next] ?? []) stack.push(ref);
  }
  return null;
}

/** Count grid levels in one macro definition. Each grid counts 1; leaves
 * and macro instances count 0. */
export function containerDepth(node: BlockNode): number {
  if (node.type === 'macro') return 0;
  if (LEAVES.has(node.type)) return 0;
  const kids = (node as ContainerNode).children ?? [];
  if (kids.length === 0) return 1;
  return 1 + Math.max(...kids.map(containerDepth));
}

function parseNode(raw: unknown): BlockNode {
  if (!isRecord(raw) || typeof raw.type !== 'string') {
    throw new Error('parseBlockTree: every node needs a string type');
  }
  const node = expandShorthand(raw) as Record<string, unknown> & { type: string };
  if (node.type === 'macro') {
    if (typeof node.macro !== 'string' || node.macro.length === 0) {
      throw new Error('parseBlockTree: macro instance needs a macro name');
    }
    if (node.slots !== undefined && !isRecord(node.slots)) {
      throw new Error('parseBlockTree: macro slots must be an object');
    }
    return { type: 'macro', macro: node.macro, slots: node.slots as Slots | undefined };
  }
  if (LEAVES.has(node.type)) {
    if (node.type === 'text' && node.markdown !== undefined && typeof node.markdown !== 'string') {
      throw new Error('parseBlockTree: text.markdown must be a string');
    }
    return {
      type: node.type as LeafNode['type'],
      slots: isRecord(node.slots) ? (node.slots as Slots) : undefined,
      markdown: typeof node.markdown === 'string' ? node.markdown : undefined
    };
  }
  if (node.type === 'grid') {
    if (node.slots !== undefined && !isRecord(node.slots)) {
      throw new Error('parseBlockTree: grid slots must be an object');
    }
    const kids = Array.isArray(node.children) ? node.children : [];
    return {
      type: 'grid',
      slots: node.slots as Slots | undefined,
      children: kids.map(parseNode)
    };
  }
  throw new Error(`parseBlockTree: unknown block type ${(node as { type: unknown }).type}`);
}

/** Validate unknown JSON into a BlockTree. Throws with a message naming
 * the problem; never returns a partial tree. */
export function parseBlockTree(json: unknown): BlockTree {
  if (!isRecord(json) || !Array.isArray(json.body)) {
    throw new Error('parseBlockTree: tree needs a body array');
  }
  return { version: 1, body: json.body.map(parseNode) };
}

const MAX_GRID_LEVELS = 3;

function hasIds(slots: Slots | undefined): boolean {
  const ids = slots?.ids;
  const list = Array.isArray(ids) ? ids : typeof ids === 'string' ? ids.split(',') : [];
  return list.some((id) => typeof id === 'string' && id.trim() !== '');
}

/** Hard rules 2-6 for a tree about to be saved (rule 1 is `parseBlockTree`).
 * Returns the first problem in document order, or null. */
export function validateForSave(
  tree: BlockTree,
  macroNames: ReadonlySet<string>
): { path: number[]; message: string } | null {
  const own = (node: BlockNode, level: number): string | null => {
    switch (node.type) {
      case 'macro':
        return macroNames.has(node.macro)
          ? null
          : `This block can't be saved: the macro ${node.macro} no longer exists. Delete it to save.`;
      case 'figure':
        return hasIds(node.slots) ? null : 'An image block has no images.';
      case 'video':
        return hasIds(node.slots) ? null : 'A video block has no video.';
      case 'grid':
        return level > MAX_GRID_LEVELS
          ? 'Grids nest at most 3 levels.'
          : gridSlotProblem(node.slots);
      default:
        return null;
    }
  };
  const visit = (
    node: BlockNode,
    path: number[],
    level: number
  ): { path: number[]; message: string } | null => {
    const message = own(node, level);
    if (message) return { path, message };
    if (node.type !== 'grid') return null;
    for (const [i, kid] of node.children.entries()) {
      const found = visit(kid, [...path, i], level + 1);
      if (found) return found;
    }
    return null;
  };
  for (const [i, node] of tree.body.entries()) {
    const found = visit(node, [i], 1);
    if (found) return found;
  }
  return null;
}
