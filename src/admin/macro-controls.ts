// Field controls shared by the macro dialog and its list rows.
//
// Browser-safe: no node:* imports.

import type { PaletteFieldSpec } from './blocks-editor.ts';
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
  /** Set for `list` fields: the item field specs and the saved rows. */
  list?: { item: Record<string, PaletteFieldSpec>; items: Record<string, string>[] };
}

export type ValueControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

export function control(doc: Document, f: MacroField): ValueControl {
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
export function imageControl(
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
