// Grid config dialog for the unified editor: columns, narrowest cell,
// column widths and the full-width band, committed as the grid's slots.
//
// Browser-safe: no node:* imports.

import type { Slots } from '../lib/blocks.ts';
import { gridSlotProblem, readGridSlots } from '../lib/grid.ts';
import { openEditorDialog } from './editor-dialog.ts';

export interface GridFields {
  cols: string;
  min: string;
  widths: string;
  band: boolean;
  theme: string;
  edge: string;
}

const GRID_SLOT_KEYS = ['cols', 'min', 'widths', 'band', 'theme', 'edge'] as const;

const MINS: ReadonlyArray<readonly [string, string]> = [
  ['narrow', 'Narrow'],
  ['medium', 'Medium'],
  ['wide', 'Wide']
];
const EDGES: ReadonlyArray<readonly [string, string]> = [
  ['straight', 'Straight'],
  ['wave', 'Wave']
];
const THEMES: ReadonlyArray<readonly [string, string]> = [
  ['light', 'Light'],
  ['dark', 'Dark']
];
const COLS = [1, 2, 3, 4, 5, 6];

const widthsOffered = (cols: string): boolean => Number(cols) >= 2 && Number(cols) <= 4;

export function readGridFields(slots: Slots | undefined): GridFields {
  const g = readGridSlots(slots);
  return {
    cols: String(g.cols),
    min: g.min,
    widths: g.widths ? g.widths.join(' ') : '',
    band: g.band,
    theme: g.theme,
    edge: g.edge
  };
}

export type ValidatedGridFields = { ok: true; slots: Slots } | { ok: false; error: string };

/** Slots for the dialog's values. Defaults are left out, and `theme`,
 * `edge` and `widths` only appear where they apply. Stored widths the
 * dialog does not offer (5 or 6 columns) survive while Columns is unchanged. */
export function validateGridFields(values: GridFields, initial?: GridFields): ValidatedGridFields {
  const slots: Slots = { cols: Number(values.cols) };
  if (values.min !== 'medium') slots.min = values.min;
  const kept = initial?.cols === values.cols ? initial.widths : '';
  const widths = (widthsOffered(values.cols) ? values.widths : kept).trim();
  if (widths !== '') slots.widths = widths.split(/\s+/).join(' ');
  if (values.band) {
    slots.band = true;
    slots.theme = values.theme;
    slots.edge = values.edge;
  }
  const error = gridSlotProblem(slots);
  return error ? { ok: false, error } : { ok: true, slots };
}

/** The grid's slots with the dialog's keys replaced by `fields`. */
export function applyGridSlots(current: Slots, fields: Slots): Slots {
  const rest = { ...current };
  for (const key of GRID_SLOT_KEYS) delete rest[key];
  return { ...rest, ...fields };
}

export interface GridDialog {
  setField(name: keyof GridFields, value: string | boolean): void;
}

interface GridDialogOpts {
  initial: GridFields;
  /** A band belongs at page level; below it the checkbox shows only for a band that is already on. */
  canBand?: boolean;
  onCommit(slots: Slots): void;
  /** A message keeps the dialog open with it as the error (e.g. offline). */
  refuse?(): string | null;
  onCancel?(): void;
}

type Input = HTMLInputElement | HTMLSelectElement;

export function openGridDialog(root: Element, opts: GridDialogOpts): GridDialog {
  const doc = root.ownerDocument;
  const values: GridFields = { ...opts.initial };
  const inputs = new Map<keyof GridFields, Input>();
  const rows = new Map<keyof GridFields, HTMLElement>();

  const form = doc.createElement('div');
  form.className = 'rkr-dialog-fields';

  const readValue = (name: keyof GridFields, input: Input): void => {
    if (name === 'band') values.band = (input as HTMLInputElement).checked;
    else values[name] = input.value;
  };

  const syncVisibility = (): void => {
    const bandRow = rows.get('band');
    if (bandRow) bandRow.hidden = !(opts.canBand ?? true) && !opts.initial.band;
    const widths = rows.get('widths');
    if (widths) widths.hidden = !widthsOffered(values.cols);
    for (const name of ['theme', 'edge'] as const) {
      const row = rows.get(name);
      if (row) row.hidden = !values.band;
    }
  };

  const addField = (name: keyof GridFields, labelText: string, input: Input): void => {
    const row = doc.createElement('div');
    row.className = 'rkr-field';
    const id = `rkr-grid-field-${name}`;
    const label = doc.createElement('label');
    label.textContent = labelText;
    label.setAttribute('for', id);
    input.id = id;
    input.setAttribute('name', name);
    const sync = (): void => {
      readValue(name, input);
      syncVisibility();
    };
    input.addEventListener('input', sync);
    input.addEventListener('change', sync);
    inputs.set(name, input);
    rows.set(name, row);
    row.append(label, input);
    form.append(row);
  };

  const select = (
    name: keyof GridFields,
    labelText: string,
    options: ReadonlyArray<readonly [string, string]>
  ): void => {
    const el = doc.createElement('select');
    const known = options.some(([v]) => v === values[name]);
    const all = known ? options : [...options, [String(values[name]), String(values[name])]];
    for (const [value, text] of all) {
      const option = doc.createElement('option');
      option.value = value;
      option.setAttribute('value', value);
      option.textContent = text;
      el.append(option);
    }
    el.value = String(values[name]);
    addField(name, labelText, el);
  };

  select(
    'cols',
    'Columns',
    COLS.map((n) => [String(n), String(n)] as const)
  );
  select('min', 'Narrowest cell', MINS);

  const widths = doc.createElement('input');
  widths.value = values.widths;
  widths.setAttribute('placeholder', 'Equal, or e.g. 2 1');
  widths.setAttribute('autocomplete', 'off');
  addField('widths', 'Column widths', widths);

  const band = doc.createElement('input');
  band.setAttribute('type', 'checkbox');
  band.checked = values.band;
  addField('band', 'Full-width band', band);

  select('theme', 'Background', THEMES);
  select('edge', 'Bottom edge', EDGES);
  syncVisibility();

  const dialog = openEditorDialog({
    root,
    title: 'Edit grid',
    body: form,
    primaryLabel: 'Save',
    onPrimary: () => {
      const result = validateGridFields(values, opts.initial);
      if (!result.ok) {
        dialog.setError(result.error);
        return false;
      }
      const refusal = opts.refuse?.();
      if (refusal) {
        dialog.setError(refusal);
        return false;
      }
      opts.onCommit(result.slots);
      return true;
    },
    onCancel: opts.onCancel
  });

  return {
    setField(name, value) {
      if (name === 'band') values.band = Boolean(value);
      else values[name] = String(value);
      const input = inputs.get(name);
      if (!input) return;
      if (name === 'band') (input as HTMLInputElement).checked = values.band;
      else input.value = String(value);
      syncVisibility();
    }
  };
}
