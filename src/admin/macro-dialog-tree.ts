// Macro field dialog for the unified editor: edit an instance's slot
// overrides without touching the macro defaults.
//
// Fields come from the macro's declared defaults, labelled and typed by
// its fieldSchema when it has one. Each input starts empty with the
// default as its placeholder, so untouched fields stay unset and follow
// the defaults. Clearing a touched field removes the override. Commit
// merges touched keys over the instance's existing slots (never a
// wholesale replace) and reports exactly the touched set, so the shell
// can save once.
//
// Browser-safe: no node:* imports. Tests pass a structurally compatible
// fake DOM root.

import type { BlockNode, Slots } from '../lib/blocks.ts';
import type { PaletteFieldSpec } from './blocks-editor.ts';
import { openEditorDialog } from './editor-dialog.ts';
import { control, imageControl, type MacroField, type ValueControl } from './macro-controls.ts';
import { openListField } from './macro-list-field.ts';
import type { MediaPicker } from './media-source.ts';

function savedItems(raw: unknown): Record<string, string>[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) =>
      Object.fromEntries(
        Object.entries(item).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      )
    );
}

/** One editor per default key, prefilled with the instance override
 * (or empty when the instance follows the default; list rows start from
 * the default list). Markdown fields and
 * newline-carrying values are multiline; a `select` schema entry keeps
 * its options. */
export function readMacroFields(
  node: BlockNode,
  defaults: Slots,
  schema: Record<string, PaletteFieldSpec> = {}
): MacroField[] {
  const slots = (node as { slots?: Slots }).slots ?? {};
  return Object.keys(defaults).map((name) => {
    const raw = slots[name];
    const value = typeof raw === 'string' ? raw : '';
    const hint = defaults[name];
    const placeholder = typeof hint === 'string' ? hint : '';
    const spec = schema[name];
    return {
      name,
      label: spec?.label ?? name,
      value,
      placeholder,
      multiline:
        spec?.type === 'markdown' ||
        value.includes('\n') ||
        placeholder.includes('\n') ||
        name === 'markdown',
      options: spec?.type === 'select' ? spec.options : undefined,
      image: spec?.type === 'image',
      list:
        spec?.type === 'list'
          ? { item: spec.item ?? {}, items: savedItems(Array.isArray(raw) ? raw : hint) }
          : undefined
    };
  });
}

export interface MacroDialog {
  /** Programmatic field edit (tests + future rich pickers). */
  setField(name: string, value: string): void;
  /** Commit touched fields; returns false when nothing was touched. */
  commit(): boolean;
  close(): void;
  /** Names touched since open (override set or cleared). */
  touched(): string[];
  /** List-field row edits for tests; rows are 0-based, ignored when out of range. */
  addRow(name: string): void;
  removeRow(name: string, index: number): void;
  moveUp(name: string, index: number): void;
  moveDown(name: string, index: number): void;
  setItemField(name: string, index: number, key: string, value: string): void;
}

export interface MacroDialogOpts {
  title: string;
  fields: MacroField[];
  onCommit(slots: Slots): void;
  /** Asked before committing; a message keeps the dialog open with it
   * as the error (e.g. offline), so nothing typed is lost. */
  refuse?(): string | null;
  onCancel(): void;
  /** Image fields pick through this; without it they can only be removed. */
  media?: MediaPicker;
}

/** Open the macro field dialog inside `root`. */
export function openMacroDialog(root: Element, opts: MacroDialogOpts): MacroDialog {
  const doc = root.ownerDocument;
  const values = new Map<string, unknown>();
  const touched = new Set<string>();
  const inputs = new Map<string, ValueControl>();
  const lists = new Map<string, HTMLElement>();
  for (const f of opts.fields) values.set(f.name, f.value);

  const form = doc.createElement('div');
  form.className = 'rkr-dialog-fields';
  for (const [i, f] of opts.fields.entries()) {
    const row = doc.createElement('div');
    row.className = 'rkr-field';
    if (f.list) {
      const fieldset = openListField(doc, f, opts.media, (items) => {
        values.set(f.name, items);
        touched.add(f.name);
      });
      lists.set(f.name, fieldset);
      row.append(fieldset);
      form.append(row);
      continue;
    }
    const id = `rkr-macro-field-${i}`;
    const label = doc.createElement('label');
    label.textContent = f.label;
    if (f.image) {
      label.id = id;
      const control = imageControl(doc, f, opts.media, (value) => {
        values.set(f.name, value);
        touched.add(f.name);
      });
      control.setAttribute('role', 'group');
      control.setAttribute('aria-labelledby', id);
      row.append(label, control);
      form.append(row);
      continue;
    }
    label.setAttribute('for', id);
    const input = control(doc, f);
    input.id = id;
    input.value = f.value;
    if (f.placeholder && !f.options) input.setAttribute('placeholder', f.placeholder);
    input.setAttribute('name', f.name);
    const sync = (): void => {
      values.set(f.name, input.value);
      touched.add(f.name);
    };
    input.addEventListener('input', sync);
    input.addEventListener('change', sync);
    inputs.set(f.name, input);
    row.append(label, input);
    form.append(row);
  }

  const collect = (): Slots => {
    const slots: Slots = {};
    for (const name of touched) slots[name] = values.get(name) ?? '';
    return slots;
  };

  const click = (name: string, label: string): void => {
    lists.get(name)?.querySelector<HTMLElement>(`[aria-label="${label}"]`)?.click();
  };

  const driver: MacroDialog = {
    addRow: (name) => click(name, 'Add row'),
    removeRow: (name, index) => click(name, `Remove row ${index + 1}`),
    moveUp: (name, index) => click(name, `Move row ${index + 1} up`),
    moveDown: (name, index) => click(name, `Move row ${index + 1} down`),
    setItemField(name, index, key, value) {
      const rows = lists.get(name)?.querySelectorAll('.rkr-list-row');
      const input = rows?.[index]?.querySelector(`[name="${key}"]`);
      if (!input) return;
      (input as unknown as ValueControl).value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    setField(name, value) {
      if (!values.has(name) || lists.has(name)) return;
      values.set(name, value);
      touched.add(name);
      const input = inputs.get(name);
      if (input) input.value = value;
    },
    commit(): boolean {
      if (touched.size === 0) return false;
      opts.onCommit(collect());
      dialog.close();
      return true;
    },
    close() {
      dialog.close();
      opts.onCancel();
    },
    touched() {
      return [...touched];
    }
  };

  const dialog = openEditorDialog({
    root,
    title: opts.title,
    body: form,
    primaryLabel: 'Save',
    wide: opts.fields.some((f) => f.multiline),
    onPrimary: () => {
      if (touched.size === 0) return true;
      const refusal = opts.refuse?.();
      if (refusal) {
        dialog.setError(refusal);
        return false;
      }
      opts.onCommit(collect());
      return true;
    },
    onCancel: opts.onCancel
  });
  return driver;
}
