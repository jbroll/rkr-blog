// Pure helpers for the comma-separated `ids` field on a figure node /
// directive. Lives in src/lib (rather than alongside FigureNode in
// src/admin/figure-node.ts) so c8 can measure it under the standard
// coverage gate — admin/figure-node.ts itself imports @tiptap/core and
// stays admin-side.
//
// The wire format is "id1,id2,id3" (whitespace tolerated). Both the
// editor (admin/main.ts: activeImageId, attribute panel population)
// and the renderer parse the same shape, so a parsing inconsistency
// between them is a real bug surface — hence the unit-test gate.

import { extractImageIdsAndAlts } from './widget-helpers.ts';

/** Split a figure-attrs `ids` string into its trimmed, non-empty
 * ids. The single canonical parse of the comma-separated wire shape —
 * callers (idCount, eviction live-refs) must not re-roll split/trim. */
export function splitIds(ids: string | undefined): string[] {
  return (ids ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Count the comma-separated ids in a figure-attrs `ids` string.
 * Whitespace-tolerant; empty / undefined input → 0. */
export function idCount(ids: string | undefined): number {
  return splitIds(ids).length;
}

/** Extract the single id from a figure that has exactly one. Returns
 * the first id (trimmed) regardless of how many ids the string has —
 * callers should gate on `idCount(ids) === 1` first. */
export function singleId(ids: string | undefined): string {
  return (ids ?? '').split(',')[0]?.trim() ?? '';
}

/** An mdast node as the figure walk reads it: directives carry `name`
 * and `attributes`, parents carry `children`. */
interface FigureIdNode {
  type: string;
  name?: string;
  attributes?: Record<string, string | null | undefined> | null | undefined;
  children?: readonly FigureIdNode[] | undefined;
}

export type FigureIdSource = FigureIdNode | readonly FigureIdNode[];

const DIRECTIVE_TYPES: ReadonlySet<string> = new Set([
  'leafDirective',
  'textDirective',
  'containerDirective'
]);

/** The image ids a subtree's ::figure directives reference, parsed by
 * the same `ids` reader the figure widget renders from, so a prepass
 * map and the renderer's lookups agree by construction. Ids appear as
 * written (lowercased, deduplicated) — resolution to full ids is the
 * caller's job. */
export function collectFigureIds(source: FigureIdSource): string[] {
  const stack: FigureIdNode[] = Array.isArray(source) ? [...source] : [source as FigureIdNode];
  const out = new Set<string>();
  while (stack.length > 0) {
    const node = stack.pop() as FigureIdNode;
    if (node.name === 'figure' && DIRECTIVE_TYPES.has(node.type)) {
      for (const { id } of extractImageIdsAndAlts(node.attributes?.ids, undefined)) out.add(id);
    }
    if (node.children) stack.push(...node.children);
  }
  return [...out];
}
