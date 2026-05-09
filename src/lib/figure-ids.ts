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

/** Count the comma-separated ids in a figure-attrs `ids` string.
 * Whitespace-tolerant; empty / undefined input → 0. */
export function idCount(ids: string | undefined): number {
  return (ids ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean).length;
}

/** Extract the single id from a figure that has exactly one. Returns
 * the first id (trimmed) regardless of how many ids the string has —
 * callers should gate on `idCount(ids) === 1` first. */
export function singleId(ids: string | undefined): string {
  return (ids ?? '').split(',')[0]?.trim() ?? '';
}
