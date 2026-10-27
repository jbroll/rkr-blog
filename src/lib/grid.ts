// Grid container model: slot reading (clamping), strict save check, labels,
// and expansion of the legacy section/row/col/flow shorthand.

type GridMin = 'narrow' | 'medium' | 'wide';

const GRID_MAX_COLS = 6;

/** Grid levels allowed from the page body, or within one macro definition. */
export const MAX_GRID_LEVELS = 3;

export const GRID_MIN_REM: Record<GridMin, number> = { narrow: 10, medium: 16, wide: 24 };

export interface GridSlots {
  cols: number;
  min: GridMin;
  widths: number[] | null;
  band: boolean;
  theme: string;
  edge: 'straight' | 'wave';
  /** One image id for the band's background; always null off a band. */
  bg: string | null;
  align: 'start' | 'center';
  box: boolean;
  order: 'forward' | 'reverse';
}

export const THEME = /^[a-z-]+$/;
const IMAGE_ID = /^[0-9a-f]{6,64}$/;

function imageId(v: unknown): string | null {
  const id = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return IMAGE_ID.test(id) ? id : null;
}

function isMin(v: unknown): v is GridMin {
  return v === 'narrow' || v === 'medium' || v === 'wide';
}

function parseWidths(v: unknown): number[] | null {
  if (typeof v !== 'string') return null;
  const parts = v.trim().split(/\s+/);
  const nums = parts.map((p) => (/^\d+(\.\d+)?$/.test(p) ? Number(p) : Number.NaN));
  return nums.length > 0 && nums.every((n) => n > 0) ? nums : null;
}

function clampCols(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1;
  return Math.min(GRID_MAX_COLS, Math.max(1, Math.round(v)));
}

export function readGridSlots(slots: Record<string, unknown> | undefined): GridSlots {
  const s = slots ?? {};
  const cols = clampCols(s.cols);
  const widths = parseWidths(s.widths);
  const band = s.band === true;
  return {
    cols,
    min: isMin(s.min) ? s.min : 'medium',
    widths: widths && widths.length === cols ? widths : null,
    band,
    theme: typeof s.theme === 'string' && THEME.test(s.theme) ? s.theme : 'light',
    edge: s.edge === 'wave' ? 'wave' : 'straight',
    bg: band ? imageId(s.bg) : null,
    align: s.align === 'center' ? 'center' : 'start',
    box: s.box === true,
    order: s.order === 'reverse' ? 'reverse' : 'forward'
  };
}

/** First slot value outside the allowed set, as a message; null when all hold. */
export function gridSlotProblem(slots: Record<string, unknown> | undefined): string | null {
  const s = slots ?? {};
  if (s.cols !== undefined) {
    if (
      typeof s.cols !== 'number' ||
      !Number.isInteger(s.cols) ||
      s.cols < 1 ||
      s.cols > GRID_MAX_COLS
    ) {
      return 'Columns must be a whole number from 1 to 6.';
    }
  }
  if (s.min !== undefined && !isMin(s.min)) return 'Narrowest cell must be narrow, medium or wide.';
  if (s.widths !== undefined) {
    const widths = parseWidths(s.widths);
    const cols = typeof s.cols === 'number' ? s.cols : 1;
    if (!widths || widths.length !== cols) {
      return cols === 1
        ? 'Column widths must be one positive number.'
        : `Column widths must be ${cols} positive numbers separated by spaces.`;
    }
  }
  if (s.band !== undefined && typeof s.band !== 'boolean') return 'Band must be true or false.';
  if (s.theme !== undefined && !(typeof s.theme === 'string' && THEME.test(s.theme))) {
    return 'Background must be a theme name.';
  }
  if (s.edge !== undefined && s.edge !== 'straight' && s.edge !== 'wave') {
    return 'Bottom edge must be straight or wave.';
  }
  if (s.align !== undefined && s.align !== 'start' && s.align !== 'center') {
    return 'Alignment must be start or center.';
  }
  if (s.order !== undefined && s.order !== 'forward' && s.order !== 'reverse') {
    return 'Order must be forward or reverse.';
  }
  if (s.box !== undefined && typeof s.box !== 'boolean') return 'Panel must be true or false.';
  if (s.bg !== undefined && s.bg !== null && !imageId(s.bg)) {
    return 'Background image must be one image.';
  }
  return null;
}

export function gridLabel(slots: Record<string, unknown> | undefined): string {
  const g = readGridSlots(slots);
  if (g.band) return 'Section';
  return g.cols === 1 ? 'Column' : `Row (${g.cols} columns)`;
}

function childrenOf(node: Record<string, unknown>): unknown[] {
  if (Array.isArray(node.children)) return node.children;
  return Array.isArray(node.blocks) ? node.blocks : [];
}

/** Map a legacy container to a grid node; other types pass through. Children are not touched. */
export function expandShorthand(node: Record<string, unknown>): Record<string, unknown> {
  const kids = childrenOf(node);
  const slots =
    typeof node.slots === 'object' && node.slots && !Array.isArray(node.slots) ? node.slots : {};
  switch (node.type) {
    case 'section': {
      const { theme, edge } = slots as Record<string, unknown>;
      return {
        type: 'grid',
        slots: {
          cols: 1,
          band: true,
          ...(theme !== undefined ? { theme } : {}),
          ...(edge !== undefined ? { edge } : {})
        },
        children: kids
      };
    }
    case 'row':
      return {
        type: 'grid',
        slots: { cols: Math.max(1, Math.min(kids.length, GRID_MAX_COLS)) },
        children: kids
      };
    case 'col':
    case 'flow':
      return { type: 'grid', slots: { cols: 1 }, children: kids };
    default:
      return node;
  }
}
