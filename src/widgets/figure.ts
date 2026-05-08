// Unified `::figure` directive widget (spec.md §9). One widget for
// every image layout — single image, diptych, triptych, gallery,
// carousel — controlled by `matrix=NxM | justified[:H] | masonry[:N]`
// and `justify=center|left|right|full|bleed|inline`.
// `matrix=NxM` is grid-with-carousel-on-overflow; `justified[:H]` is
// Flickr-style flex rows at row-height H; `masonry[:N]` is
// Pinterest-style multi-column flow. Flow modes are CSS-only
// (flexbox + columns); `aspect` and `fit` silently ignored there.
//
// Forgiving-attributes rule (spec.md §9): parameters that don't apply
// to the chosen mode (e.g. `aspect` / `fit` under flow modes; `width`
// under full / bleed; `caption` / `matrix` under inline) are silently
// ignored. The directive should be cheap to author.

import { escapeAttr, escapeText } from '../lib/content.ts';
import { read as sidecarRead } from '../lib/sidecar.ts';
import type { Sidecar } from '../lib/sidecar-types.ts';
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

const name = 'figure';

// Variants × outputs cover every (matrix, justify) shape the figure
// renderer can emit; the constants-alignment test
// (test/lib/widget-fallback-alignment) keeps every emitted
// (variant, output) pair backed by a sidecar declaration.
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

/** Carousel autoplay seconds. 0 = manual advance only. Capped at 60
 * (anything bigger reads as "the author meant ms or made a typo"). */
const TIMER_CAP_SECONDS = 60;
function parseTimer(raw: unknown): number {
  if (typeof raw !== 'string') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(TIMER_CAP_SECONDS, Math.floor(n));
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

async function resolveAutoAspect(
  cells: CellInput[],
  ctx: WidgetCtx,
  aspectCss: string | null
): Promise<string | null> {
  if (aspectCss !== null) return aspectCss;
  const firstSidecar = await loadFirstSidecar(cells, ctx);
  if (!firstSidecar) return null;
  const w = firstSidecar.metadata.width ?? 1;
  const h = firstSidecar.metadata.height ?? 1;
  return `${w}/${h}`;
}

function gridStyle(rows: number, cols: number): string {
  return [
    `grid-template-columns: repeat(${cols}, 1fr)`,
    `grid-template-rows: repeat(${rows}, auto)`
  ].join('; ');
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
  // No-overflow grid: spec says over-allocated matrices render the
  // empty cells (no auto-shrink). Excess ids beyond cell count never
  // reach this function — render() routes those to renderCarousel.
  const visibleCells = cells.slice(0, matrix.rows * matrix.cols);
  const resolvedAspectCss = await resolveAutoAspect(visibleCells, ctx, aspectCss);

  const rendered = await Promise.all(visibleCells.map((c) => renderCell(c, ctx)));

  const inner = [
    `  <div class="rkr-figure-grid" style="${gridStyle(matrix.rows, matrix.cols)}">`,
    indent(rendered.join('\n'), '    '),
    '  </div>'
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

/**
 * Carousel mode: `len(ids) > matrix.rows * matrix.cols`. Slice the
 * cells into pages of `matrix.rows × matrix.cols` and render each page
 * as one `.rkr-carousel-slide` (the same class the legacy ::carousel
 * widget uses), so static/site/carousel.js drives prev/next/dots/keyboard
 * /autoplay unmodified. The last page may have fewer cells — empty
 * grid slots stay empty per the no-auto-shrink rule.
 *
 * The author-controlled `aspect` and `fit` apply per cell within each
 * page; pages themselves all share the same matrix dimensions, so the
 * viewport never resizes between slides.
 */
async function renderCarousel(
  matrix: MatrixGrid,
  cells: CellInput[],
  ctx: WidgetCtx,
  justify: Justify,
  fit: Fit,
  widthCss: string | null,
  aspectCss: string | null,
  blockCaption: string | null,
  timer: number
): Promise<string> {
  const cellsPerPage = matrix.rows * matrix.cols;
  const pageCount = Math.ceil(cells.length / cellsPerPage);
  const pages: CellInput[][] = [];
  for (let i = 0; i < pageCount; i++) {
    pages.push(cells.slice(i * cellsPerPage, (i + 1) * cellsPerPage));
  }

  const resolvedAspectCss = await resolveAutoAspect(cells, ctx, aspectCss);
  const pageGridStyle = gridStyle(matrix.rows, matrix.cols);

  // Render pages in parallel — each page renders its cells in parallel
  // too. ctx-level sidecar caching means the underlying FS work is
  // bounded.
  const renderedPages = await Promise.all(
    pages.map(async (pageCells, pageIdx) => {
      const renderedCells = await Promise.all(pageCells.map((c) => renderCell(c, ctx)));
      return [
        `    <div class="rkr-carousel-slide rkr-figure-page" data-index="${pageIdx}" role="listitem" style="${pageGridStyle}">`,
        indent(renderedCells.join('\n'), '      '),
        '    </div>'
      ].join('\n');
    })
  );

  const dotsHtml = pages
    .map(
      (_p, i) =>
        `      <button type="button" class="rkr-carousel-dot" data-target="${i}" aria-label="Page ${i + 1}"></button>`
    )
    .join('\n');
  const playPauseHtml = timer
    ? `      <button type="button" class="rkr-carousel-play" aria-label="Pause slideshow" aria-pressed="true">⏸</button>\n`
    : '';
  const autoplayAttr = timer ? ` data-autoplay="${timer}"` : '';

  // The class list intentionally carries BOTH `rkr-carousel` (so the
  // existing browser-side controller picks it up) AND `rkr-figure` /
  // `rkr-figure-carousel` (so figure-specific CSS targets it). When
  // we delete the legacy carousel widget, the JS stays — only the
  // legacy widget file goes.
  const inner = [
    `  <div class="rkr-carousel-track" role="list">`,
    renderedPages.join('\n'),
    '  </div>',
    `  <nav class="rkr-carousel-nav" aria-label="Carousel controls">`,
    `    <button type="button" class="rkr-carousel-prev" aria-label="Previous page">&larr;</button>`,
    `    <div class="rkr-carousel-dots" role="tablist">`,
    dotsHtml,
    '    </div>',
    `${playPauseHtml}    <button type="button" class="rkr-carousel-next" aria-label="Next page">&rarr;</button>`,
    '  </nav>'
  ].join('\n');

  // Custom shell — adds carousel classes + ARIA + autoplay data attr.
  const cls = [
    'rkr-figure',
    'rkr-figure-carousel',
    'rkr-carousel',
    `rkr-justify-${justify}`,
    `rkr-fit-${fit}`
  ].join(' ');
  const styleParts: string[] = [];
  if (widthCss) styleParts.push(`width: ${widthCss}`);
  if (resolvedAspectCss) styleParts.push(`--rkr-cell-aspect: ${resolvedAspectCss}`);
  const style = styleParts.length ? ` style="${styleParts.join('; ')}"` : '';
  const captionBlock = blockCaption
    ? `\n  <figcaption>${escapeText(blockCaption)}</figcaption>`
    : '';

  return `<figure class="${cls}" tabindex="0" aria-roledescription="carousel"${autoplayAttr}${style}>\n${inner}${captionBlock}\n</figure>`;
}

/**
 * Flow layouts (justified / masonry). Each image keeps its native
 * aspect — the whole point of these layouts — so we render every
 * resolvable cell into a flex / multi-column container. `aspect` and
 * `fit` are silently ignored per spec; the figure-level CSS class
 * picks the algorithm.
 *
 * Unresolved cells become `<!-- ... -->` comments rather than empty
 * grid slots: in flow modes there's no slot to leave empty, so a
 * dropped image just shrinks the row / column count.
 */
async function renderFlow(
  matrix: MatrixFlow,
  cells: CellInput[],
  ctx: WidgetCtx,
  justify: Justify,
  widthCss: string | null,
  blockCaption: string | null
): Promise<string> {
  const renderedCells = await Promise.all(cells.map((c) => renderCell(c, ctx)));

  // The flow modes' algorithm-tunable goes on the figure-level style
  // as a CSS variable; CSS reads it. Names mirror the directive's
  // attribute meaning ("row height" / "column count") rather than
  // collapsing to a generic --rkr-flow-param.
  const algoVar =
    matrix.kind === 'justified'
      ? `--rkr-row-height: ${matrix.param}px`
      : `--rkr-cols: ${matrix.param}`;

  const cls = ['rkr-figure', `rkr-figure-${matrix.kind}`, `rkr-justify-${justify}`].join(' ');
  const styleParts: string[] = [algoVar];
  if (widthCss) styleParts.unshift(`width: ${widthCss}`);
  const style = ` style="${styleParts.join('; ')}"`;
  const captionBlock = blockCaption
    ? `\n  <figcaption>${escapeText(blockCaption)}</figcaption>`
    : '';

  const inner = [
    `  <div class="rkr-figure-flow">`,
    indent(renderedCells.join('\n'), '    '),
    '  </div>'
  ].join('\n');

  return `<figure class="${cls}"${style}>\n${inner}${captionBlock}\n</figure>`;
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
  const timer = parseTimer(node.attributes?.timer);

  if (justify === 'inline') {
    return renderInline(cells, ctx, justify, fit);
  }

  // `width` only applies to left/right/center; full/bleed take their
  // width from the surrounding layout.
  const effectiveWidth = justify === 'full' || justify === 'bleed' ? null : widthCss;

  const matrix = parseMatrix(node.attributes?.matrix);

  if (matrix.kind === 'grid') {
    const cellsPerPage = matrix.rows * matrix.cols;
    if (cells.length > cellsPerPage) {
      return renderCarousel(
        matrix,
        cells,
        ctx,
        justify,
        fit,
        effectiveWidth,
        aspectCss,
        blockCaption,
        timer
      );
    }
    return renderGrid(matrix, cells, ctx, justify, fit, effectiveWidth, aspectCss, blockCaption);
  }
  // Flow modes — aspect / fit are ignored per spec; the layout is
  // intrinsically based on each image's native aspect.
  return renderFlow(matrix, cells, ctx, justify, effectiveWidth, blockCaption);
}

const widget: Widget = { name, variants, fallback, render };
export default widget;
