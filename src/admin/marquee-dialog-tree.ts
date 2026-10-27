// Marquee config dialog for the unified editor: the scrolling text.
//
// Browser-safe: no node:* imports.

import type { BlockNode, Slots } from '../lib/blocks.ts';
import { type FieldsDialog, openFieldsDialog, type Validated } from './fields-dialog.ts';

export interface MarqueeFields extends Record<string, string> {
  text: string;
}

export function readMarqueeFields(node: BlockNode): MarqueeFields {
  const text = (node as { slots?: Slots }).slots?.text;
  return { text: typeof text === 'string' ? text : '' };
}

export function validateMarqueeFields(values: MarqueeFields): Validated {
  const text = values.text.trim();
  if (text === '') return { ok: false, error: 'Enter the text to scroll.', field: 'text' };
  return { ok: true, slots: { text } };
}

interface MarqueeDialogOpts {
  initial: MarqueeFields;
  onCommit(slots: Slots): void;
  refuse?(): string | null;
  onCancel?(): void;
}

export function openMarqueeDialog(
  root: Element,
  opts: MarqueeDialogOpts
): FieldsDialog<MarqueeFields> {
  return openFieldsDialog<MarqueeFields>(root, {
    ...opts,
    title: 'Edit marquee',
    idPrefix: 'rkr-marquee-field',
    fields: [{ name: 'text', label: 'Text', kind: 'text' }],
    validate: validateMarqueeFields
  });
}
