// A list slot in the macro dialog: a fieldset of item rows, each built
// from the item field specs, with add, remove and move up/down.
//
// Browser-safe: no node:* imports.

import type { PaletteFieldSpec } from './blocks-editor.ts';
import { control, imageControl, type MacroField } from './macro-controls.ts';
import type { MediaPicker } from './media-source.ts';

type Item = Record<string, string>;

function itemField(name: string, spec: PaletteFieldSpec, value: string): MacroField {
  return {
    name,
    label: spec.label,
    value,
    placeholder: '',
    multiline: spec.type === 'markdown',
    options: spec.type === 'select' ? spec.options : undefined,
    image: spec.type === 'image'
  };
}

/** `set` receives a fresh copy of every row after each change. */
export function openListField(
  doc: Document,
  field: MacroField,
  media: MediaPicker | undefined,
  set: (items: Item[]) => void
): HTMLElement {
  const specs = Object.entries(field.list?.item ?? {});
  const items: Item[] = (field.list?.items ?? []).map((item) => ({ ...item }));

  const fieldset = doc.createElement('fieldset');
  fieldset.className = 'rkr-list-field';
  const legend = doc.createElement('legend');
  legend.textContent = field.label;
  const rows = doc.createElement('div');
  rows.className = 'rkr-list-rows';

  const changed = (): void => set(items.map((item) => ({ ...item })));
  const setValue = (index: number, key: string, value: string): void => {
    const item = items[index];
    if (!item) return;
    if (value === '') delete item[key];
    else item[key] = value;
    changed();
  };
  const restructure = (update: () => void): void => {
    update();
    render();
    changed();
  };
  const move = (from: number, to: number): void => {
    const item = items[from];
    if (!item || to < 0 || to >= items.length) return;
    restructure(() => {
      items.splice(from, 1);
      items.splice(to, 0, item);
    });
  };

  const button = (text: string, label: string, onClick: () => void, disabled = false) => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'rkr-edit-btn is-quiet';
    b.textContent = text;
    b.setAttribute('aria-label', label);
    if (disabled) b.setAttribute('disabled', '');
    b.addEventListener('click', onClick);
    return b;
  };

  const rowFor = (index: number): HTMLElement => {
    const n = index + 1;
    const row = doc.createElement('div');
    row.className = 'rkr-list-row';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', `Row ${n}`);
    for (const [key, spec] of specs) {
      const wrap = doc.createElement('div');
      wrap.className = 'rkr-field';
      const id = `rkr-list-${field.name}-${index}-${key}`;
      const label = doc.createElement('label');
      label.textContent = spec.label;
      const sub = itemField(key, spec, items[index]?.[key] ?? '');
      if (sub.image) {
        label.id = id;
        const picker = imageControl(doc, sub, media, (value) => setValue(index, key, value));
        picker.setAttribute('role', 'group');
        picker.setAttribute('aria-labelledby', id);
        wrap.append(label, picker);
      } else {
        label.setAttribute('for', id);
        const input = control(doc, sub);
        input.id = id;
        input.value = sub.value;
        input.setAttribute('name', key);
        const sync = (): void => setValue(index, key, input.value);
        input.addEventListener('input', sync);
        input.addEventListener('change', sync);
        wrap.append(label, input);
      }
      row.append(wrap);
    }
    row.append(
      button('Up', `Move row ${n} up`, () => move(index, index - 1), index === 0),
      button(
        'Down',
        `Move row ${n} down`,
        () => move(index, index + 1),
        index === items.length - 1
      ),
      button('Remove', `Remove row ${n}`, () => restructure(() => items.splice(index, 1)))
    );
    return row;
  };

  function render(): void {
    rows.replaceChildren(...items.map((_, i) => rowFor(i)));
  }

  const add = button('Add row', 'Add row', () => restructure(() => items.push({})));
  render();
  fieldset.append(legend, rows, add);
  return fieldset;
}
