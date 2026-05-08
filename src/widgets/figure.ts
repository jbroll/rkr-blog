// Unified `::figure` directive widget. See spec.md §9 — one directive
// for image / diptych / triptych / gallery / carousel layouts, with
// `matrix=NxM | justified[:H] | masonry[:N]` controlling the layout
// algorithm and `justify=center|left|right|full|bleed|inline`
// controlling block placement.
//
// Phase 1 (this file): `matrix=NxM` only. `justified` / `masonry`
// layouts and carousel-on-overflow render as HTML comments noting the
// future support — once they land we delete the legacy widgets per
// the migration plan in spec.md §9.
//
// Forgiving-attributes rule (spec.md §9): parameters that don't apply
// to the chosen mode (e.g. `aspect` / `fit` under flow modes; `width`
// under full / bleed; `caption` / `matrix` under inline) are silently
// ignored. The directive should be cheap to author.

import { escapeAttr, escapeText } from '../lib/content.ts';
import { type Sidecar, read as sidecarRead } from '../lib/sidecar.ts';
import {
  clampAlt,
  extractDirectiveCaption,
  extractImageIdsAndAlts,
  getKnownIds,
  indent,
  pictureAspect,
  renderPicture,
  resolveIds
} from '../lib/widget-helpers.ts';
import type {
  DirectiveNode,
  FallbackSpec,
  VariantSpec,
  Widget,
  WidgetCtx
} from '../lib/widgets.ts';

export const name = 'figure';

// Variants × outputs intentionally union the existing widgets' shapes
// so the constants-alignment test (test/lib/widget-fallback-alignment)
// keeps every emitted (variant, output) pair backed by a sidecar
// declaration. After legacy widgets are deleted we can prune unused
// widths.
export const variants: VariantSpec[] = [
  { w: 320, formats: ['webp', 'avif'] },
  { w: 400, formats: ['webp', 'avif'] },
  { w: 640, formats: ['webp', 'avif'] },
  { w: 800, formats: ['webp', 'avif'] },
  { w: 1200, formats: ['webp', 'avif'] },
  { w: 1600, formats: ['webp', 'avif'] }
];

export const fallback: FallbackSpec = { w: 1200, format: 'jpeg', quality: 85 };

const VALID_JUSTIFY = new Set(['center', 'left', 'right', 'full', 'bleed', 'inline'] as const);
type Justify = typeof VALID_JUSTIFY extends Set<infer T> ? T : never;

const VALID_FIT = new Set(['cover', 'contain'] as const);
type Fit = typeof VALID_FIT extends Set<infer T> ? T : never;

interface MatrixGrid {
  kind: 'grid';
  rows: number;
  cols: number;
}
interface MatrixFlow {
  kind: 'justified' | 'masonry';
  /** Row height (justified) / column count (masonry). */
  param: number;
}
type MatrixSpec = MatrixGrid | MatrixFlow;

const MATRIX_DEFAULT: MatrixGrid = { kind: 'grid', rows: 1, cols: 1 };
const FLOW_DEFAULTS = { justified: 240, masonry: 3 } as const;
const MAX_MATRIX_DIM = 12; // sanity cap; 12×12=144 cells is more than any sane post

function parseMatrix(raw: unknown): MatrixSpec {
  if (typeof raw !== 'string') return MATRIX_DEFAULT;
  const s = raw.trim().toLowerCase();
  const grid = /^(\d+)x(\d+)$/.exec(s);
  if (grid) {
    const rows = clampDim(Number(grid[1]));
    const cols = clampDim(Number(grid[2]));
    return { kind: 'grid', rows, cols };
  }
  const flow = /^(justified|masonry)(?::(\d+))?$/.exec(s);
  if (flow) {
    const kind = flow[1] as 'justified' | 'masonry';
    const param = flow[2] ? Number(flow[2]) : FLOW_DEFAULTS[kind];
    return { kind, param };
  }
  return MATRIX_DEFAULT;
}

function clampDim(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_MATRIX_DIM, Math.floor(n));
}

function parseJustify(raw: unknown): Justify {
  if (typeof raw === 'string' && VALID_JUSTIFY.has(raw as Justify)) return raw as Justify;
  return 'center';
}

function parseFit(raw: unknown): Fit {
  if (typeof raw === 'string' && VALID_FIT.has(raw as Fit)) return raw as Fit;
  return 'cover';
}

interface ParsedWidth {
  /** CSS-ready value, e.g. "60%" or "400px". null means "use justify default". */
  css: string | null;
}

function parseWidth(raw: unknown): ParsedWidth {
  if (typeof raw !== 'string') return { css: null };
  // Explicit unit only — `width=200` is ambiguous (px? %?) and we won't guess.
  const m = /^(\d+)(px|%)$/.exec(raw.trim());
  if (!m) return { css: null };
  return { css: `${m[1]}${m[2]}` };
}

interface ParsedAspect {
  /** "W/H" string ready for the CSS `aspect-ratio` property. null → derive
   * from the first image's sidecar. */
  css: string | null;
}

function parseAspect(raw: unknown): ParsedAspect {
  if (typeof raw !== 'string') return { css: null };
  const m = /^(\d+)\s*[:x]\s*(\d+)$/.exec(raw.trim());
  if (!m) return { css: null };
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return { css: null };
  return { css: `${w}/${h}` };
}

/** Per-image captions: pipe-separated to avoid colliding with the comma
 * separators used by `ids` / `alts`. Trim each entry; empty → null. */
function parsePerImageCaptions(raw: unknown): (string | null)[] {
  if (typeof raw !== 'string') return [];
  return raw.split('|').map((s) => {
    const t = s.trim();
    return t.length > 0 ? clampAlt(t) : null;
  });
}

interface CellInput {
  id: string | null; // null → unresolved id; render as a placeholder comment
  rawId: string;
  alt: string;
  caption: string | null;
}

function buildCells(node: DirectiveNode, ctx: WidgetCtx): CellInput[] {
  const idsAndAlts = extractImageIdsAndAlts(node.attributes?.ids, node.attributes?.alts);
  const captions = parsePerImageCaptions(node.attributes?.captions);
  const known = getKnownIds(ctx);
  const inputs = idsAndAlts.map((ia) => ia.id);
  const resolved = resolveIds(inputs, known);
  return idsAndAlts.map((ia, i) => ({
    id: resolved[i] ?? null,
    rawId: ia.id,
    alt: ia.alt,
    caption: captions[i] ?? null
  }));
}

async function loadFirstSidecar(cells: CellInput[], ctx: WidgetCtx): Promise<Sidecar | null> {
  for (const c of cells) {
    if (!c.id) continue;
    const s = await sidecarRead(ctx.siteRoot, c.id);
    if (s) return s;
  }
  return null;
}

interface RenderShellArgs {
  justify: Justify;
  fit: Fit;
  widthCss: string | null;
  aspectCss: string | null;
  inner: string;
  blockCaption: string | null;
  /** Override the wrapper element. Inline justify uses <span>. */
  tag?: 'figure' | 'span';
}

function renderShell(args: RenderShellArgs): string {
  const tag = args.tag ?? 'figure';
  const cls = [`rkr-figure`, `rkr-justify-${args.justify}`, `rkr-fit-${args.fit}`].join(' ');
  // inline mode: width / aspect-ratio don't apply.
  const styleParts: string[] = [];
  if (args.tag !== 'span') {
    if (args.widthCss) styleParts.push(`width: ${args.widthCss}`);
    if (args.aspectCss) styleParts.push(`--rkr-cell-aspect: ${args.aspectCss}`);
  }
  const style = styleParts.length ? ` style="${styleParts.join('; ')}"` : '';
  // inline mode: block-level caption is suppressed (spec).
  const captionBlock =
    args.blockCaption && tag !== 'span'
      ? `\n  <figcaption>${escapeText(args.blockCaption)}</figcaption>`
      : '';
  return `<${tag} class="${cls}"${style}>\n${args.inner}${captionBlock}\n</${tag}>`;
}

async function renderCell(cell: CellInput, ctx: WidgetCtx): Promise<string> {
  if (!cell.id) {
    return `<!-- figure: unresolved id ${escapeText(cell.rawId)} -->`;
  }
  const sidecar = await sidecarRead(ctx.siteRoot, cell.id);
  if (!sidecar) {
    return `<!-- figure: no sidecar for ${escapeAttr(cell.id)} -->`;
  }
  const alt = escapeAttr(cell.alt);
  const picture = renderPicture({ id: cell.id, sidecar, variants, fallback, alt });
  const cap = cell.caption ? `\n${escapeText(cell.caption)}` : '';
  // Each cell carries the image's native aspect as a CSS variable for
  // CLS-friendly layout reservation in flow modes; matrix mode uses
  // the figure-level --rkr-cell-aspect instead.
  const cellAspect = pictureAspect(sidecar);
  const cellAttr = ` style="--rkr-image-aspect: ${cellAspect}"`;
  return `<div class="rkr-figure-cell"${cellAttr}>\n${indent(picture, '  ')}${cap}\n</div>`;
}

async function renderInline(
  cells: CellInput[],
  ctx: WidgetCtx,
  justify: Justify,
  fit: Fit
): Promise<string> {
  // Inline mode: only the first cell renders; the rest are dropped.
  // Caption / matrix / aspect / fit / width all ignored (spec).
  const first = cells[0];
  if (!first?.id) {
    return '<!-- figure: inline mode requires a resolvable id -->';
  }
  const sidecar = await sidecarRead(ctx.siteRoot, first.id);
  if (!sidecar) return `<!-- figure: no sidecar for ${escapeAttr(first.id)} -->`;
  const alt = escapeAttr(first.alt);
  const picture = renderPicture({ id: first.id, sidecar, variants, fallback, alt });
  return renderShell({
    justify,
    fit,
    widthCss: null,
    aspectCss: null,
    inner: indent(picture, '  '),
    blockCaption: null,
    tag: 'span'
  });
}

async function renderGrid(
  matrix: MatrixGrid,
  cells: CellInput[],
  ctx: WidgetCtx,
  justify: Justify,
  fit: Fit,
  widthCss: string | null,
  aspectCss: string | null,
  blockCaption: string | null
): Promise<string> {
  const visibleCount = matrix.rows * matrix.cols;
  const visibleCells = cells.slice(0, visibleCount);
  const overflowCount = cells.length - visibleCells.length;

  // Resolve the auto-aspect from the first resolvable image when no
  // explicit aspect was given.
  let resolvedAspectCss = aspectCss;
  if (resolvedAspectCss === null) {
    const firstSidecar = await loadFirstSidecar(visibleCells, ctx);
    if (firstSidecar) {
      const w = firstSidecar.metadata.width ?? 1;
      const h = firstSidecar.metadata.height ?? 1;
      resolvedAspectCss = `${w}/${h}`;
    }
  }

  const rendered = await Promise.all(visibleCells.map((c) => renderCell(c, ctx)));
  const overflowComment =
    overflowCount > 0
      ? `\n  <!-- figure: ${overflowCount} ids exceed matrix capacity; carousel mode lands in a follow-up commit -->`
      : '';

  const gridStyle = [
    `grid-template-columns: repeat(${matrix.cols}, 1fr)`,
    `grid-template-rows: repeat(${matrix.rows}, auto)`
  ].join('; ');

  const inner = [
    `  <div class="rkr-figure-grid" style="${gridStyle}">`,
    indent(rendered.join('\n'), '    '),
    `  </div>${overflowComment}`
  ].join('\n');

  return renderShell({
    justify,
    fit,
    widthCss,
    aspectCss: resolvedAspectCss,
    inner,
    blockCaption
  });
}

async function render(node: DirectiveNode, ctx: WidgetCtx): Promise<string> {
  const cells = buildCells(node, ctx);
  if (cells.length === 0) {
    return '<!-- figure: no valid ids -->';
  }
  if (cells.every((c) => c.id === null)) {
    return '<!-- figure: no ids resolved -->';
  }

  const justify = parseJustify(node.attributes?.justify);
  const fit = parseFit(node.attributes?.fit);
  const widthCss = parseWidth(node.attributes?.width).css;
  const aspectCss = parseAspect(node.attributes?.aspect).css;
  const blockCaption = extractDirectiveCaption(node);

  if (justify === 'inline') {
    return renderInline(cells, ctx, justify, fit);
  }

  // `width` only applies to left/right/center; full/bleed take their
  // width from the surrounding layout.
  const effectiveWidth = justify === 'full' || justify === 'bleed' ? null : widthCss;

  const matrix = parseMatrix(node.attributes?.matrix);

  if (matrix.kind === 'grid') {
    return renderGrid(matrix, cells, ctx, justify, fit, effectiveWidth, aspectCss, blockCaption);
  }
  // Phase 1 stub: justified / masonry render as a comment + a 1xN
  // grid fallback so the page doesn't lose the images entirely.
  // The flow algorithms land in a follow-up commit.
  const fallbackGrid: MatrixGrid = {
    kind: 'grid',
    rows: 1,
    cols: Math.min(MAX_MATRIX_DIM, Math.max(1, cells.filter((c) => c.id).length))
  };
  const stub = await renderGrid(
    fallbackGrid,
    cells,
    ctx,
    justify,
    fit,
    effectiveWidth,
    aspectCss,
    blockCaption
  );
  return `<!-- figure: matrix=${matrix.kind} not yet implemented; rendering as a 1×N grid -->\n${stub}`;
}

const widget: Widget = { name, variants, fallback, render };
export default widget;
