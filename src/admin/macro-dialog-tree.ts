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
import type { MediaPicker } from './media-source.ts';

export interface MacroField {
  name: string;
  label: string;
  value: string;
  placeholder: string;
  multiline: boolean;
  options?: string[];
  /** The slot holds an image id: shown as a thumbnail, never as text. */
  image: boolean;
}

/** One editor per default key, prefilled with the instance override
 * (or empty when the instance follows the default). Markdown fields and
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
      image: spec?.type === 'image'
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
}

export interface MacroDialogOpts {
  title: string;
  fields: MacroField[];
  onCommit(slots: Slots): void;
  onCancel(): void;
  /** Image fields pick through this; without it they can only be removed. */
  media?: MediaPicker;
}

type ValueControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function control(doc: Document, f: MacroField): ValueControl {
  if (f.options) {
    const select = doc.createElement('select');
    for (const optionValue of ['', ...f.options]) {
      const option = doc.createElement('option');
      option.value = optionValue;
      option.setAttribute('value', optionValue);
      option.textContent =
        optionValue === '' ? `Default (${f.placeholder || 'none'})` : optionValue;
      select.append(option);
    }
    return select;
  }
  if (f.multiline) {
    const area = doc.createElement('textarea');
    area.setAttribute('rows', '4');
    return area;
  }
  return doc.createElement('input');
}

/** Thumbnail plus Choose image and Remove. `set` records the new id
 * ('' clears the override so the default shows again). */
function imageControl(
  doc: Document,
  f: MacroField,
  media: MediaPicker | undefined,
  set: (id: string) => void
): HTMLElement {
  const wrap = doc.createElement('div');
  wrap.className = 'rkr-image-field';
  const preview = doc.createElement('div');
  preview.className = 'rkr-media-thumb';
  const choose = doc.createElement('button');
  choose.type = 'button';
  choose.className = 'rkr-edit-btn';
  choose.textContent = 'Choose image';
  const remove = doc.createElement('button');
  remove.type = 'button';
  remove.className = 'rkr-edit-btn is-quiet';
  remove.textContent = 'Remove';
  const show = (id: string): void => {
    preview.textContent = '';
    const url = id ? (media?.thumbUrl('image', id) ?? `/admin/preview/${id}`) : null;
    if (url) {
      const img = doc.createElement('img');
      img.setAttribute('src', url);
      img.setAttribute('alt', '');
      img.setAttribute('width', '72');
      img.setAttribute('height', '72');
      preview.append(img);
    } else {
      preview.textContent = f.placeholder ? 'Default image' : 'No image';
    }
    remove.hidden = id === '';
  };
  if (media) {
    choose.addEventListener('click', () => {
      choose.setAttribute('disabled', '');
      void media
        .pick('image', false)
        .then(([id]) => {
          if (!id) return;
          set(id);
          show(id);
        })
        .catch((err: unknown) => console.error('macro image pick:', err))
        .finally(() => choose.removeAttribute('disabled'));
    });
  } else {
    choose.hidden = true;
  }
  remove.addEventListener('click', () => {
    set('');
    show('');
  });
  show(f.value);
  wrap.append(preview, choose, remove);
  return wrap;
}

/** Open the macro field dialog inside `root`. */
export function openMacroDialog(root: Element, opts: MacroDialogOpts): MacroDialog {
  const doc = root.ownerDocument;
  const values = new Map<string, string>();
  const touched = new Set<string>();
  const inputs = new Map<string, ValueControl>();
  for (const f of opts.fields) values.set(f.name, f.value);

  const form = doc.createElement('div');
  form.className = 'rkr-dialog-fields';
  for (const [i, f] of opts.fields.entries()) {
    const row = doc.createElement('div');
    row.className = 'rkr-field';
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

  const driver: MacroDialog = {
    setField(name, value) {
      if (!values.has(name)) return;
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
      if (touched.size > 0) opts.onCommit(collect());
      return true;
    },
    onCancel: opts.onCancel
  });
  return driver;
}
