// Per-image rows for the figure and video dialogs, plus the slot
// encoding they read and write. Stored figures keep the `ids` / `alts` /
// `captions` / `matrix` / `justify` slots: ids and alts comma-separated
// (alts escape their commas), captions pipe-separated. Rows never show
// an id; the thumbnail stands in for it.
//
// Browser-safe: no node:* imports.

import type { Slots } from '../lib/blocks.ts';
import { joinAlts, splitAlts } from '../lib/widget-helpers.ts';

export interface FigureImageRow {
  id: string;
  alt: string;
  caption: string;
}

export type LayoutMode = 'single' | 'grid' | 'carousel' | 'justified' | 'masonry';

export interface LayoutChoice {
  mode: LayoutMode;
  rows: number;
  cols: number;
  /** The matrix string read from the slot, kept so an unchanged flow
   * parameter (`justified:240`) survives a save. */
  raw: string;
}

export const LAYOUT_LABELS: ReadonlyArray<readonly [LayoutMode, string]> = [
  ['single', 'Single'],
  ['grid', 'Grid'],
  ['carousel', 'Carousel'],
  ['justified', 'Justified'],
  ['masonry', 'Masonry']
];

const text = (slots: Slots, key: string): string => {
  const v = slots[key];
  return typeof v === 'string' ? v : '';
};

export function listFromFigureSlots(slots: Slots): FigureImageRow[] {
  const alts = splitAlts(text(slots, 'alts'));
  const captions = text(slots, 'captions').split('|');
  // Alts and captions are parallel to the raw id list, so pair them by
  // position before dropping empty id entries.
  return text(slots, 'ids')
    .split(',')
    .map((raw, i) => ({ id: raw.trim(), alt: alts[i] ?? '', caption: (captions[i] ?? '').trim() }))
    .filter((row) => row.id !== '');
}

/** Drop trailing empty entries so an untouched figure doesn't grow a
 * `,,` or `||` tail on every save. */
function trimTail(values: string[]): string[] {
  let end = values.length;
  while (end > 0 && values[end - 1] === '') end--;
  return values.slice(0, end);
}

export function figureSlotsFromList(
  rows: FigureImageRow[],
  layout: { matrix: string; justify: string }
): Slots {
  return {
    ids: rows.map((r) => r.id).join(','),
    // A trailing backslash would escape the separator after it.
    alts: joinAlts(trimTail(rows.map((r) => r.alt.trim().replace(/\\+$/, '')))),
    captions: trimTail(rows.map((r) => r.caption.trim().replace(/\|/g, '/'))).join('|'),
    matrix: layout.matrix,
    justify: layout.justify
  };
}

export function moveRow(rows: FigureImageRow[], from: number, to: number): FigureImageRow[] {
  if (to < 0 || to >= rows.length || from < 0 || from >= rows.length) return rows;
  const next = [...rows];
  const [row] = next.splice(from, 1);
  if (row) next.splice(to, 0, row);
  return next;
}

export function removeRow(rows: FigureImageRow[], index: number): FigureImageRow[] {
  return rows.filter((_, i) => i !== index);
}

export function layoutFromMatrix(raw: string): LayoutChoice {
  const s = raw.trim().toLowerCase();
  const base = { rows: 2, cols: 2, raw };
  if (s === '1x1') return { ...base, mode: 'carousel' };
  const grid = /^(\d+)x(\d+)$/.exec(s);
  if (grid) return { mode: 'grid', rows: Number(grid[1]), cols: Number(grid[2]), raw };
  if (/^justified(:\d+)?$/.test(s)) return { ...base, mode: 'justified' };
  if (/^masonry(:\d+)?$/.test(s)) return { ...base, mode: 'masonry' };
  return { ...base, mode: 'single' };
}

const clamp = (n: number): number => Math.min(12, Math.max(1, Math.floor(n) || 1));

export function matrixFromLayout(layout: LayoutChoice): string {
  switch (layout.mode) {
    case 'single':
      return '';
    case 'carousel':
      return '1x1';
    case 'grid':
      return `${clamp(layout.rows)}x${clamp(layout.cols)}`;
    default:
      return layout.raw.startsWith(layout.mode) ? layout.raw : layout.mode;
  }
}

export interface ImageListOpts {
  rows: FigureImageRow[];
  kind: 'image' | 'video';
  /** Thumbnail for a row, read on every render so it is never a stale
   * (revoked) preview URL; null shows a placeholder. */
  thumbUrl(id: string): string | null;
  onChange(rows: FigureImageRow[]): void;
  /** Present only where the image editor is available. */
  onEdit?(index: number): void;
}

export interface ImageList {
  readonly element: HTMLElement;
  setRows(rows: FigureImageRow[]): void;
  /** Re-read every thumbnail URL (after an image edit). */
  refresh(): void;
}

let fieldCounter = 0;

/** Render one row per image: thumbnail, text fields and row actions.
 * Video rows have a caption only and no reorder or edit actions. */
export function mountImageList(doc: Document, opts: ImageListOpts): ImageList {
  const element = doc.createElement('ol');
  element.className = 'rkr-media-list';
  let rows = [...opts.rows];

  const change = (next: FigureImageRow[]): void => {
    rows = next;
    render();
    opts.onChange([...rows]);
  };

  const action = (label: string, onClick: () => void, disabled = false): HTMLButtonElement => {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'rkr-edit-btn is-quiet rkr-media-action';
    btn.textContent = label;
    if (disabled) btn.setAttribute('disabled', '');
    btn.addEventListener('click', onClick);
    return btn;
  };

  const field = (label: string, value: string, onInput: (v: string) => void): HTMLElement => {
    const wrap = doc.createElement('div');
    wrap.className = 'rkr-field';
    const id = `rkr-media-field-${++fieldCounter}`;
    const lab = doc.createElement('label');
    lab.textContent = label;
    lab.setAttribute('for', id);
    const input = doc.createElement('input');
    input.id = id;
    input.value = value;
    input.setAttribute('autocomplete', 'off');
    input.addEventListener('input', () => onInput(input.value));
    wrap.append(lab, input);
    return wrap;
  };

  const thumb = (id: string): HTMLElement => {
    const box = doc.createElement('div');
    box.className = 'rkr-media-thumb';
    const url = opts.thumbUrl(id);
    if (url) {
      const img = doc.createElement('img');
      img.setAttribute('src', url);
      img.setAttribute('alt', '');
      img.setAttribute('width', '72');
      img.setAttribute('height', '72');
      // A discard repaint can revoke the URL just after this render;
      // the getter then holds its replacement.
      img.addEventListener('error', () => {
        const next = opts.thumbUrl(id);
        if (next && next !== img.getAttribute('src')) img.setAttribute('src', next);
      });
      box.append(img);
    } else {
      box.textContent = opts.kind === 'video' ? 'Video' : 'Image';
    }
    return box;
  };

  const renderRow = (row: FigureImageRow, i: number): HTMLElement => {
    const li = doc.createElement('li');
    li.className = 'rkr-media-row';
    const fields = doc.createElement('div');
    fields.className = 'rkr-media-fields';
    const edit = (patch: Partial<FigureImageRow>): void => {
      rows = rows.map((r, j) => (j === i ? { ...r, ...patch } : r));
      opts.onChange([...rows]);
    };
    if (opts.kind === 'image') fields.append(field('Alt text', row.alt, (alt) => edit({ alt })));
    fields.append(field('Caption', row.caption, (caption) => edit({ caption })));
    const actions = doc.createElement('div');
    actions.className = 'rkr-media-actions';
    if (opts.kind === 'image') {
      actions.append(
        action('Move up', () => change(moveRow(rows, i, i - 1)), i === 0),
        action('Move down', () => change(moveRow(rows, i, i + 1)), i === rows.length - 1)
      );
      const onEdit = opts.onEdit;
      if (onEdit) actions.append(action('Edit image', () => onEdit(i)));
    }
    actions.append(action('Remove', () => change(removeRow(rows, i))));
    li.append(thumb(row.id), fields, actions);
    return li;
  };

  const render = (): void => {
    element.textContent = '';
    rows.forEach((row, i) => {
      element.append(renderRow(row, i));
    });
  };

  render();
  return {
    element,
    setRows(next) {
      rows = [...next];
      render();
    },
    refresh: render
  };
}
