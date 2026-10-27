// Grid and band markup for the block renderer: cells, column styles,
// the band section with its background picture and wave edge.

import { fallback, variants } from '../widgets/figure.ts';
import type { BlockNode } from './blocks.ts';
import { escapeAttr, type RenderCtx } from './content.ts';
import { GRID_MIN_REM, type GridSlots, gridLabel, readGridSlots } from './grid.ts';
import { renderPicture } from './widget-helpers.ts';

function gridStyle(g: GridSlots): string {
  const widths = g.widths ? `;--rkr-grid-widths:${g.widths.map((w) => `${w}fr`).join(' ')}` : '';
  return `--rkr-grid-cols:${g.cols};--rkr-grid-min:${GRID_MIN_REM[g.min]}rem${widths}`;
}

export const hasElement = (html: string): boolean =>
  /<[a-z]/i.test(html.replace(/<!--[\s\S]*?-->/g, ''));

function bandBackground(g: GridSlots, ctx: RenderCtx): string {
  const src = g.bg ? ctx.images.get(g.bg) : undefined;
  if (!src) return '';
  const picture = renderPicture({ src, variants, fallback, alt: '', lightbox: false });
  return `<div class="rkr-section-bg" aria-hidden="true">${picture}</div>\n`;
}

export function renderGrid(
  node: Extract<BlockNode, { type: 'grid' }>,
  kids: string[],
  ctx: RenderCtx,
  marked: boolean,
  rootClass = ''
): string {
  const extra = rootClass ? ` ${rootClass}` : '';
  // Readers get no empty cell for a child that renders only a comment; the
  // editor keeps one so the block can be selected and deleted.
  const inCell = (html: string): boolean => marked || hasElement(html);
  const present = kids.filter(Boolean);
  if (!marked && !present.some(hasElement)) return present.join('');
  const g = readGridSlots(node.slots);
  const inner = present.length
    ? present.map((c) => (inCell(c) ? `<div class="rkr-grid-cell">${c}</div>\n` : c)).join('')
    : '<p class="rkr-grid-empty" data-rkr-grid-empty>Empty grid: drag blocks here</p>\n';
  const stacked = g.widths !== null && g.cols > 1;
  const collapse = stacked ? ` rkr-collapse-${g.cols}-${g.min}` : '';
  const look = `${g.align === 'center' ? ' rkr-align-center' : ''}${g.box ? ' rkr-box' : ''}`;
  const outer = g.band ? '' : extra;
  const cls = `${g.band ? 'rkr-section-inner ' : ''}rkr-grid${collapse}${look}${stacked ? '' : outer}`;
  const label = marked ? ` data-rkr-grid-label="${escapeAttr(gridLabel(node.slots))}"` : '';
  const grid = `<div class="${cls}" style="${gridStyle(g)}"${stacked ? ' data-widths' : ''}${label}>\n${inner}</div>`;
  const body = stacked ? `<div class="rkr-grid-wrap${outer}">${grid}</div>` : grid;
  if (!g.band) return `${body}\n`;
  const bg = bandBackground(g, ctx);
  const wave = g.edge === 'wave' ? '\n<div class="rkr-section-wave" aria-hidden="true"></div>' : '';
  const theme = `rkr-theme-${escapeAttr(g.theme)}${bg ? ' has-bg' : ''}`;
  return `<section class="rkr-section ${theme}${extra}">\n${bg}${body}${wave}\n</section>\n`;
}
