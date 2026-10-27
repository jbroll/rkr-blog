// Mask and Link controls for the figure dialog.

import type { Slots } from '../lib/blocks.ts';

const MASKS: readonly (readonly [string, string])[] = [
  ['', 'None'],
  ['circle', 'Circle'],
  ['rounded', 'Rounded']
];

const text = (slots: Slots, key: string): string => {
  const v = slots[key];
  return typeof v === 'string' ? v : '';
};

export interface AppearanceFields {
  element: HTMLElement;
  /** Slots to merge into the node. A key is written when it has a value
   * or the node already carried one, so emptying a field clears it. */
  slots(): Slots;
}

export function appearanceFields(doc: Document, current: Slots): AppearanceFields {
  const wrap = doc.createElement('div');
  wrap.className = 'rkr-media-appearance';

  const maskWrap = doc.createElement('div');
  maskWrap.className = 'rkr-field';
  const maskLabel = doc.createElement('label');
  maskLabel.textContent = 'Mask';
  maskLabel.setAttribute('for', 'rkr-media-mask');
  const mask = doc.createElement('select');
  mask.id = 'rkr-media-mask';
  for (const [value, label] of MASKS) {
    const option = doc.createElement('option');
    option.value = value;
    option.setAttribute('value', value);
    option.textContent = label;
    mask.append(option);
  }
  mask.value = MASKS.some(([v]) => v === text(current, 'mask')) ? text(current, 'mask') : '';
  maskWrap.append(maskLabel, mask);

  const linkWrap = doc.createElement('div');
  linkWrap.className = 'rkr-field';
  const linkLabel = doc.createElement('label');
  linkLabel.textContent = 'Link';
  linkLabel.setAttribute('for', 'rkr-media-href');
  const href = doc.createElement('input');
  href.id = 'rkr-media-href';
  href.type = 'text';
  href.placeholder = 'Opens the image larger when empty';
  href.value = text(current, 'href');
  linkWrap.append(linkLabel, href);

  wrap.append(maskWrap, linkWrap);

  return {
    element: wrap,
    slots: () => {
      const out: Slots = {};
      const values: Slots = { mask: mask.value, href: href.value.trim() };
      for (const [key, value] of Object.entries(values)) {
        if (value !== '' || text(current, key) !== '') out[key] = value;
      }
      return out;
    }
  };
}
