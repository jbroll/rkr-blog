// Shared shell for the small block dialogs (marquee, progress, embed):
// labelled text, number and select fields, an optional per-field
// visibility rule, validation on Save.
//
// Browser-safe: no node:* imports.

import type { Slots } from '../lib/blocks.ts';
import { openEditorDialog } from './editor-dialog.ts';

interface FieldDef<F> {
  name: keyof F & string;
  label: string;
  kind: 'text' | 'number' | 'select';
  options?: ReadonlyArray<readonly [string, string]>;
  placeholder?: string;
  showWhen?(values: F): boolean;
}

export type Validated = { ok: true; slots: Slots } | { ok: false; error: string; field?: string };

export interface FieldsDialogOpts<F> {
  title: string;
  idPrefix: string;
  fields: ReadonlyArray<FieldDef<F>>;
  initial: F;
  validate(values: F): Validated;
  onCommit(slots: Slots): void;
  /** Asked before committing; a message keeps the dialog open with it
   * as the error (e.g. offline), so nothing typed is lost. */
  refuse?(): string | null;
  onCancel?(): void;
}

export interface FieldsDialog<F> {
  setField(name: keyof F & string, value: string): void;
}

export function openFieldsDialog<F extends Record<string, string>>(
  root: Element,
  opts: FieldsDialogOpts<F>
): FieldsDialog<F> {
  const doc = root.ownerDocument;
  const values = { ...opts.initial };
  const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
  const rows = new Map<string, HTMLElement>();

  const form = doc.createElement('div');
  form.className = 'rkr-dialog-fields';

  const refresh = (): void => {
    for (const def of opts.fields) {
      const row = rows.get(def.name);
      if (row) row.hidden = def.showWhen ? !def.showWhen(values) : false;
    }
  };

  for (const def of opts.fields) {
    const row = doc.createElement('div');
    row.className = 'rkr-field';
    const id = `${opts.idPrefix}-${def.name}`;
    const label = doc.createElement('label');
    label.textContent = def.label;
    label.setAttribute('for', id);
    let input: HTMLInputElement | HTMLSelectElement;
    if (def.kind === 'select') {
      input = doc.createElement('select');
      for (const [value, text] of def.options ?? []) {
        const option = doc.createElement('option');
        option.value = value;
        option.setAttribute('value', value);
        option.textContent = text;
        input.append(option);
      }
    } else {
      input = doc.createElement('input');
      if (def.kind === 'number') input.setAttribute('inputmode', 'numeric');
      if (def.placeholder) input.setAttribute('placeholder', def.placeholder);
      input.setAttribute('autocomplete', 'off');
    }
    input.id = id;
    input.setAttribute('name', def.name);
    input.value = values[def.name] ?? '';
    const sync = (): void => {
      (values as Record<string, string>)[def.name] = input.value;
      refresh();
    };
    input.addEventListener('input', sync);
    input.addEventListener('change', sync);
    inputs.set(def.name, input);
    rows.set(def.name, row);
    row.append(label, input);
    form.append(row);
  }
  refresh();

  const dialog = openEditorDialog({
    root,
    title: opts.title,
    body: form,
    primaryLabel: 'Save',
    onPrimary: () => {
      const result = opts.validate(values);
      if (!result.ok) {
        const bad = result.field ? inputs.get(result.field) : undefined;
        bad?.setAttribute('aria-invalid', 'true');
        dialog.setError(result.error);
        bad?.focus?.();
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
      (values as Record<string, string>)[name] = value;
      const input = inputs.get(name);
      if (input) input.value = value;
      refresh();
    }
  };
}
