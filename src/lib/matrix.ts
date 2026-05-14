// Shared types + parse/serialize for the figure `matrix` attribute.
// One module so the server-side widget and the editor's visual control
// can't drift in how they read or emit the wire format.
//
// Wire format:
//   ''            → Grid 1×1 (default; the renderer treats '' and
//                   '1x1' identically)
//   'NxM'         → Grid with N rows × M cols (each dim clamped 1..12)
//   'justified'   → Flickr-style flex rows at the default row height
//   'justified:H' → …at H pixels
//   'masonry'     → CSS column masonry at the default column count
//   'masonry:N'   → …at N columns

export interface MatrixGrid {
  kind: 'grid';
  rows: number;
  cols: number;
}
export interface MatrixFlow {
  kind: 'justified' | 'masonry';
  /** Row height (justified) / column count (masonry). */
  param: number;
}
export type MatrixSpec = MatrixGrid | MatrixFlow;

const MAX_GRID_DIM = 12;
export const FLOW_DEFAULTS = { justified: 180, masonry: 3 } as const;
const MATRIX_DEFAULT: MatrixGrid = { kind: 'grid', rows: 1, cols: 1 };

export function parseMatrix(raw: unknown): MatrixSpec {
  if (typeof raw !== 'string') return MATRIX_DEFAULT;
  const s = raw.trim().toLowerCase();
  if (s === '') return MATRIX_DEFAULT;
  const grid = /^(\d+)x(\d+)$/.exec(s);
  if (grid) {
    return { kind: 'grid', rows: clampDim(Number(grid[1])), cols: clampDim(Number(grid[2])) };
  }
  const flow = /^(justified|masonry)(?::(\d+))?$/.exec(s);
  if (flow) {
    const kind = flow[1] as 'justified' | 'masonry';
    return { kind, param: flow[2] ? Number(flow[2]) : FLOW_DEFAULTS[kind] };
  }
  return MATRIX_DEFAULT;
}

/** Serialize a spec back to the wire format. Grid 1×1 collapses to
 * the empty string so single-image figures don't grow a stray
 * `matrix=1x1` attribute on every edit. Flow params are omitted when
 * they match the default for cleaner markdown. */
export function serializeMatrix(spec: MatrixSpec): string {
  if (spec.kind === 'grid') {
    if (spec.rows === 1 && spec.cols === 1) return '';
    return `${spec.rows}x${spec.cols}`;
  }
  if (spec.param === FLOW_DEFAULTS[spec.kind]) return spec.kind;
  return `${spec.kind}:${spec.param}`;
}

export function clampDim(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_GRID_DIM, Math.floor(n));
}
