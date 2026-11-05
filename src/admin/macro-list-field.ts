// A list slot in the macro dialog: a fieldset of item rows, each built
// from the item field specs, with add, remove and move up/down.
//
// Browser-safe: no node:* imports.

import type { TagSource } from '../lib/tag-source.ts';
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

/** `set` receives a fresh copy of every row after each change, or the tag
 * source while the list is filled from a tag. */
export function openListField(
  doc: Document,
  field: MacroField,
  media: MediaPicker | undefined,
  set: (value: Item[] | TagSource) => void
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
  fieldset.append(legend);
  if (!field.list?.rowsOnly) fieldset.append(sourceControls());
  fieldset.append(rows, add);
  return fieldset;

  function sourceControls(): HTMLElement {
    const saved = field.list?.source;
    const box = doc.createElement('div');
    box.className = 'rkr-list-source';
    box.hidden = !saved;

    const labelled = (text: string, name: string, input: HTMLElement): HTMLElement => {
      const wrap = doc.createElement('div');
      wrap.className = 'rkr-field';
      const id = `rkr-list-${field.name}-${name}`;
      const label = doc.createElement('label');
      label.textContent = text;
      label.setAttribute('for', id);
      input.id = id;
      input.setAttribute('name', name);
      wrap.append(label, input);
      return wrap;
    };
    const select = (choices: [string, string][]): HTMLSelectElement => {
      const el = doc.createElement('select');
      for (const [value, text] of choices) {
        const option = doc.createElement('option');
        option.setAttribute('value', value);
        option.textContent = text;
        el.append(option);
      }
      return el;
    };

    const from = select([
      ['rows', 'Rows'],
      ['tag', 'Tag']
    ]);
    const tag = doc.createElement('input');
    tag.setAttribute('autocomplete', 'off');
    const sort = select([
      ['order', 'Order'],
      ['date', 'Date']
    ]);
    const limit = doc.createElement('input');
    limit.setAttribute('type', 'number');
    limit.setAttribute('min', '1');
    from.value = saved ? 'tag' : 'rows';
    tag.value = saved?.tag ?? '';
    sort.value = saved?.sort ?? 'order';
    limit.value = saved?.limit ? String(saved.limit) : '';

    const emit = (): void => {
      if (from.value !== 'tag') {
        changed();
        return;
      }
      const source: TagSource = { tag: tag.value };
      if (sort.value === 'date') source.sort = 'date';
      if (limit.value !== '') source.limit = Number(limit.value);
      set(source);
    };
    const sync = (): void => {
      const tagMode = from.value === 'tag';
      box.hidden = !tagMode;
      rows.hidden = tagMode;
      add.hidden = tagMode;
      emit();
    };
    from.addEventListener('change', sync);
    for (const input of [tag, sort, limit]) {
      input.addEventListener('input', emit);
      input.addEventListener('change', emit);
    }
    rows.hidden = add.hidden = !!saved;

    box.append(
      labelled('Tag', 'tag', tag),
      labelled('Sort', 'sort', sort),
      labelled('Limit', 'limit', limit)
    );
    const wrap = doc.createElement('div');
    wrap.append(labelled('Fill from', 'source', from), box);
    return wrap;
  }
}
