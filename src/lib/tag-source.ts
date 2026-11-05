// Structural types, not imports from blocks.ts: blocks.ts imports this file.
type Slots = Record<string, unknown>;
interface NodeLike {
  type: string;
  slots?: Slots;
  children?: NodeLike[];
}
interface TreeLike {
  body: NodeLike[];
}

export interface TagSource {
  tag: string;
  sort?: 'order' | 'date';
  limit?: number;
}

export type TagLookup = (src: TagSource, selfSlug: string | undefined) => Slots[];

export function isTagSource(v: unknown): v is TagSource {
  return (
    !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as TagSource).tag === 'string'
  );
}

const TAG_SOURCE_KEYS = new Set(['tag', 'sort', 'limit']);

export function tagSourceProblem(label: string, v: unknown): string | null {
  const src = v as Record<string, unknown>;
  if (typeof src.tag !== 'string' || src.tag.trim() === '') {
    return `${label}: tag must be a non-empty string.`;
  }
  if (src.sort !== undefined && src.sort !== 'order' && src.sort !== 'date') {
    return `${label}: sort must be order or date.`;
  }
  if (src.limit !== undefined && !(Number.isInteger(src.limit) && (src.limit as number) > 0)) {
    return `${label}: limit must be a positive whole number.`;
  }
  const unknown = Object.keys(src).find((k) => !TAG_SOURCE_KEYS.has(k));
  return unknown ? `${label}: unknown key ${unknown}.` : null;
}

/** Fill page-level macro slots written as tag sources with the lookup's rows.
 * A source that fails validation becomes an empty list. */
export function resolveTagSources<T extends TreeLike>(
  tree: T,
  lookup: TagLookup,
  selfSlug?: string
): T {
  const walk = (node: NodeLike): NodeLike => {
    if (node.type === 'grid') return { ...node, children: (node.children ?? []).map(walk) };
    if (node.type !== 'macro' || !node.slots) return node;
    const slots = Object.fromEntries(
      Object.entries(node.slots).map(([k, v]) => [
        k,
        isTagSource(v) ? (tagSourceProblem(k, v) ? [] : lookup(v, selfSlug)) : v
      ])
    );
    return { ...node, slots };
  };
  return { ...tree, body: tree.body.map(walk) };
}

function firstIn(nodes: NodeLike[]): string | null {
  for (const node of nodes) {
    if (node.type === 'figure') {
      const ids = node.slots?.ids;
      const id = typeof ids === 'string' ? ids.split(/\s+/).find(Boolean) : undefined;
      if (id) return id;
    } else if (node.type === 'grid') {
      const id = firstIn(node.children ?? []);
      if (id) return id;
    }
  }
  return null;
}

/** First image id of the first figure in reading order, through grids and
 * not into macro instances. */
export function firstFigureId(tree: TreeLike): string | null {
  return firstIn(tree.body);
}
