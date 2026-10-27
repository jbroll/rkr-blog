// JSON block trees for reusable page macros.
// A page is a macro tree, not a markdown file. Markdown survives only as
// the value language inside `text` widgets (`text.markdown`).

import { expandShorthand, gridSlotProblem, MAX_GRID_LEVELS } from './grid.ts';

export type Slots = Record<string, unknown>;

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

/** One entry of a macro's `fieldSchema`. */
export interface FieldSpec {
  label: string;
  type: 'text' | 'markdown' | 'image' | 'link' | 'select' | 'list';
  default?: unknown;
  /** Plain values, or `{ value, label }` when the dialog should show different text. */
  options?: Array<string | { value: string; label: string }>;
  /** Field specs of one item of a `list` field; never themselves `list`. */
  item?: Record<string, FieldSpec>;
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

const CONTAINER_TYPES = new Set(['grid', 'section', 'row', 'col', 'flow']);

/** Hard rules 1 and 4 on the raw request body, with the block's path:
 * `parseBlockTree` names no path, drops children from leaves and macros,
 * and empties a non-array container. Paths are raw paths. */
export function rawTreeProblem(body: unknown): { path: number[]; message: string } | null {
  const visit = (raw: unknown, path: number[]): { path: number[]; message: string } | null => {
    if (!isRecord(raw) || typeof raw.type !== 'string') {
      return { path, message: 'Every block needs a type.' };
    }
    if (!CONTAINER_TYPES.has(raw.type) && !LEAVES.has(raw.type) && raw.type !== 'macro') {
      return { path, message: `Unknown block type ${raw.type}.` };
    }
    if (!CONTAINER_TYPES.has(raw.type)) {
      return 'children' in raw
        ? { path, message: `A ${raw.type} block can't hold other blocks.` }
        : null;
    }
    const kids = 'children' in raw ? raw.children : raw.blocks;
    if (kids === undefined) return null;
    if (!Array.isArray(kids)) return { path, message: 'A grid needs a list of blocks.' };
    for (const [i, kid] of kids.entries()) {
      const found = visit(kid, [...path, i]);
      if (found) return found;
    }
    return null;
  };
  if (!Array.isArray(body)) return null;
  for (const [i, node] of body.entries()) {
    const found = visit(node, [i]);
    if (found) return found;
  }
  return null;
}

function hasIds(slots: Slots | undefined): boolean {
  const ids = slots?.ids;
  const list = Array.isArray(ids) ? ids : typeof ids === 'string' ? ids.split(',') : [];
  return list.some((id) => typeof id === 'string' && id.trim() !== '');
}

/** First list-slot problem in a macro instance's slots, or null. */
function listSlotProblem(
  slots: Slots | undefined,
  schema: Record<string, FieldSpec>
): string | null {
  for (const [key, spec] of Object.entries(schema)) {
    const value = slots?.[key];
    if (spec.type !== 'list' || value === undefined) continue;
    if (!Array.isArray(value) || !value.every(isRecord)) {
      return `${spec.label} must be a list of items.`;
    }
    for (const [i, item] of value.entries()) {
      const unknown = Object.keys(item).find((k) => !spec.item || !Object.hasOwn(spec.item, k));
      if (unknown) return `${spec.label}, item ${i + 1}: unknown field ${unknown}.`;
    }
  }
  return null;
}

/** Hard rules 2-7 for a tree about to be saved (rule 1 is `parseBlockTree`).
 * `schemaOf` supplies macro field schemas so list slots can be checked.
 * Returns the first problem in document order, or null. */
export function validateForSave(
  tree: BlockTree,
  macroNames: ReadonlySet<string>,
  schemaOf?: (macro: string) => Record<string, FieldSpec> | undefined
): { path: number[]; message: string } | null {
  const own = (node: BlockNode, level: number): string | null => {
    switch (node.type) {
      case 'macro': {
        if (!macroNames.has(node.macro)) {
          return `This block can't be saved: the macro ${node.macro} no longer exists. Delete it to save.`;
        }
        const schema = schemaOf?.(node.macro);
        return schema ? listSlotProblem(node.slots, schema) : null;
      }
      case 'figure':
        return hasIds(node.slots) ? null : 'An image block has no images.';
      case 'video':
        return hasIds(node.slots) ? null : 'A video block has no video.';
      case 'grid':
        return level > MAX_GRID_LEVELS
          ? `Grids nest at most ${MAX_GRID_LEVELS} levels.`
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
