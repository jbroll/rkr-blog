// Figure image reorder: pure permute/hit-test helpers + delegated
// pointer/keyboard wiring. Spec:
// docs/superpowers/specs/2026-05-16-figure-reorder-design.md
// Reorder is one permutation applied in lockstep to the figure's
// three parallel arrays (ids ',', alts ',', captions '|').

/** Move arr[from] to index `to`. Returns a new array on a real move;
 *  returns the input array unchanged when from===to or either index is
 *  out of [0, len) (same no-op identity contract as reorderFigureCells,
 *  so callers can skip work on reference equality). Never mutates. */
export function moveItem<T>(arr: T[], from: number, to: number): T[] {
  const n = arr.length;
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return arr;
  const copy = arr.slice();
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item as T);
  return copy;
}

export interface FigureCellArrays {
  ids: string;
  alts: string;
  captions: string;
}

/** Split the three parallel arrays, move cell from→to in lockstep,
 *  re-pad alts/captions to ids length, rejoin. Returns the original
 *  object when the move is a no-op (so callers can skip the commit). */
export function reorderFigureCells(
  attrs: FigureCellArrays,
  from: number,
  to: number
): FigureCellArrays {
  const ids = attrs.ids.split(',').map((s) => s.trim());
  const n = ids.length;
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return attrs;
  const alts = attrs.alts.split(',').map((s) => s.trim());
  const captions = attrs.captions.split('|');
  while (alts.length < n) alts.push('');
  while (captions.length < n) captions.push('');
  alts.length = n;
  captions.length = n;
  return {
    ids: moveItem(ids, from, to).join(','),
    alts: moveItem(alts, from, to).join(','),
    captions: moveItem(captions, from, to).join('|')
  };
}

/** Insertion index for a pointer at coordinate `pos` (px along the
 *  drag axis) given cell midpoints in DOM order. Equals the number of
 *  midpoints strictly less than `pos`; result is in [0, mids.length]. */
export function dropIndexFor(mids: number[], pos: number): number {
  let i = 0;
  while (i < mids.length && (mids[i] as number) < pos) i++;
  return i;
}
