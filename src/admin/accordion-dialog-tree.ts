// Accordion config dialog for the unified editor: title and markdown
// body rows, edited through the macro dialog's list field.
//
// Browser-safe: no node:* imports.

import type { BlockNode, Slots } from '../lib/blocks.ts';
import { openEditorDialog } from './editor-dialog.ts';
import type { Validated } from './fields-dialog.ts';
import type { MacroField } from './macro-controls.ts';
import { openListField } from './macro-list-field.ts';

type Item = Record<string, string>;

export interface AccordionFields {
  items: Item[];
}

const ITEM_SPECS = {
  title: { label: 'Title', type: 'text' },
  body: { label: 'Body', type: 'markdown' }
};

const NEED_ITEM = 'Add at least one item.';

export function readAccordionFields(node: BlockNode): AccordionFields {
  const raw = (node as { slots?: Slots }).slots?.items;
  const items = Array.isArray(raw) ? raw : [];
  return {
    items: items
      .filter((it): it is Record<string, unknown> => typeof it === 'object' && it !== null)
      .map((it) =>
        Object.fromEntries(
          Object.entries(it).filter((e): e is [string, string] => typeof e[1] === 'string')
        )
      )
  };
}

export function validateAccordionFields(values: AccordionFields): Validated {
  const items = values.items.filter((it) => Object.keys(it).length > 0);
  if (items.length === 0) return { ok: false, error: NEED_ITEM };
  return { ok: true, slots: { items } };
}

interface AccordionDialogOpts {
  initial: AccordionFields;
  onCommit(slots: Slots): void;
  refuse?(): string | null;
  onCancel?(): void;
}

export function openAccordionDialog(root: Element, opts: AccordionDialogOpts): void {
  const doc = root.ownerDocument;
  let items = opts.initial.items.map((it) => ({ ...it }));
  const field: MacroField = {
    name: 'items',
    label: 'Items',
    value: '',
    placeholder: '',
    multiline: false,
    image: false,
    list: { item: ITEM_SPECS, items }
  };
  const form = doc.createElement('div');
  form.className = 'rkr-dialog-fields';
  form.append(
    openListField(doc, field, undefined, (next) => {
      items = next;
    })
  );

  const dialog = openEditorDialog({
    root,
    title: 'Edit accordion',
    body: form,
    primaryLabel: 'Save',
    wide: true,
    onPrimary: () => {
      const result = validateAccordionFields({ items });
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
}
