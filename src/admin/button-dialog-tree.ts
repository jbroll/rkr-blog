// Button config dialog for the unified editor: label, link and style,
// committed as the button's slots through the shell's applyTree.
//
// Browser-safe: no node:* imports.

import type { BlockNode, Slots } from '../lib/blocks.ts';
import { openEditorDialog } from './editor-dialog.ts';

type Variant = 'primary' | 'secondary';

export interface ButtonFields {
  label: string;
  href: string;
  variant: Variant;
}

const VARIANTS: ReadonlyArray<readonly [Variant, string]> = [
  ['primary', 'Primary'],
  ['secondary', 'Secondary']
];

const LINK_REQUIRED = 'Enter a link for the button.';

export function readButtonFields(node: BlockNode): ButtonFields {
  const slots = (node as { slots?: Slots }).slots ?? {};
  const text = (key: string): string => {
    const v = slots[key];
    return typeof v === 'string' ? v : '';
  };
  return {
    label: text('label'),
    href: text('href'),
    variant: text('variant') === 'secondary' ? 'secondary' : 'primary'
  };
}

export type ValidatedButtonFields = { ok: true; slots: Slots } | { ok: false; error: string };

export function validateButtonFields(values: ButtonFields): ValidatedButtonFields {
  const href = values.href.trim();
  if (href === '') return { ok: false, error: LINK_REQUIRED };
  return { ok: true, slots: { label: values.label.trim(), href, variant: values.variant } };
}

export interface ButtonDialog {
  setField(name: keyof ButtonFields, value: string): void;
}

interface ButtonDialogOpts {
  initial: ButtonFields;
  onCommit(slots: Slots): void;
  onCancel?(): void;
}

export function openButtonDialog(root: Element, opts: ButtonDialogOpts): ButtonDialog {
  const doc = root.ownerDocument;
  const values: ButtonFields = { ...opts.initial };
  const inputs = new Map<keyof ButtonFields, HTMLInputElement | HTMLSelectElement>();

  const form = doc.createElement('div');
  form.className = 'rkr-dialog-fields';

  const addField = (
    name: keyof ButtonFields,
    labelText: string,
    input: HTMLInputElement | HTMLSelectElement
  ): void => {
    const row = doc.createElement('div');
    row.className = 'rkr-field';
    const id = `rkr-button-field-${name}`;
    const label = doc.createElement('label');
    label.textContent = labelText;
    label.setAttribute('for', id);
    input.id = id;
    input.setAttribute('name', name);
    const sync = (): void => {
      (values as unknown as Record<string, string>)[name] = input.value;
    };
    input.addEventListener('input', sync);
    input.addEventListener('change', sync);
    inputs.set(name, input);
    row.append(label, input);
    form.append(row);
  };

  const label = doc.createElement('input');
  label.value = values.label;
  addField('label', 'Label', label);

  const href = doc.createElement('input');
  href.value = values.href;
  href.setAttribute('placeholder', '/join or https://example.com');
  href.setAttribute('autocomplete', 'off');
  addField('href', 'Link', href);

  const style = doc.createElement('select');
  for (const [value, text] of VARIANTS) {
    const option = doc.createElement('option');
    option.value = value;
    option.setAttribute('value', value);
    option.textContent = text;
    style.append(option);
  }
  style.value = values.variant;
  addField('variant', 'Style', style);

  const dialog = openEditorDialog({
    root,
    title: 'Edit button',
    body: form,
    primaryLabel: 'Save',
    onPrimary: () => {
      const result = validateButtonFields(values);
      if (!result.ok) {
        href.setAttribute('aria-invalid', 'true');
        dialog.setError(result.error);
        href.focus?.();
        return false;
      }
      opts.onCommit(result.slots);
      return true;
    },
    onCancel: opts.onCancel
  });

  return {
    setField(name, value) {
      (values as unknown as Record<string, string>)[name] = value;
      const input = inputs.get(name);
      if (input) input.value = value;
    }
  };
}
