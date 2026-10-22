// JSON block trees for reusable page macros.
// A page is a macro tree, not a markdown file. Markdown survives only as
// the value language inside `text` widgets (`text.markdown`).

export type Slots = Record<string, unknown>;

export type ContainerKind = 'section' | 'row' | 'col' | 'flow';

export interface ContainerNode {
  type: ContainerKind;
  slots?: Slots;
  children?: BlockNode[];
  /** Flow containers hold leaves in page order under `blocks`. */
  blocks?: BlockNode[];
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
}

export interface MacroDef {
  defaults: Slots;
}

const CONTAINERS: ReadonlySet<string> = new Set(['section', 'row', 'col', 'flow']);
const LEAVES: ReadonlySet<string> = new Set([
  'text',
  'figure',
  'video',
  'button',
  'list',
  'marquee',
  'accordion',
  'progress',
  'embed',
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
export function detectCycle(
  lib: Record<string, string[]>,
  name: string
): string[] | null {
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

/** Count container levels in one macro definition. section/row/col/flow
 * each count 1; leaves and macro instances count 0. */
export function containerDepth(node: BlockNode): number {
  if (node.type === 'macro') return 0;
  if (LEAVES.has(node.type)) return 0;
  const kids: BlockNode[] =
    (node as ContainerNode).children ?? (node as ContainerNode).blocks ?? [];
  if (kids.length === 0) return 1;
  return 1 + Math.max(...kids.map(containerDepth));
}

function parseNode(node: unknown): BlockNode {
  if (!isRecord(node) || typeof node.type !== 'string') {
    throw new Error('parseBlockTree: every node needs a string type');
  }
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
      markdown: typeof node.markdown === 'string' ? node.markdown : undefined,
    };
  }
  if (CONTAINERS.has(node.type)) {
    const children = Array.isArray(node.children)
      ? node.children.map(parseNode)
      : undefined;
    const blocks = Array.isArray((node as Record<string, unknown>).blocks)
      ? ((node as Record<string, unknown>).blocks as unknown[]).map(parseNode)
      : undefined;
    return {
      type: node.type as ContainerKind,
      slots: isRecord(node.slots) ? (node.slots as Slots) : undefined,
      ...(children ? { children } : {}),
      ...(blocks ? { blocks } : {}),
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
