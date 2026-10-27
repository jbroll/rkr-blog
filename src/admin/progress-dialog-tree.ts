// Progress config dialog for the unified editor: the site campaign's
// figures, or goal and raised typed on this block.
//
// Browser-safe: no node:* imports.

import type { BlockNode, Slots } from '../lib/blocks.ts';
import { type FieldsDialog, openFieldsDialog, type Validated } from './fields-dialog.ts';

export interface ProgressFields extends Record<string, string> {
  source: 'site' | 'block';
  goal: string;
  raised: string;
}

const figure = (v: unknown): string =>
  typeof v === 'number' || typeof v === 'string' ? String(v) : '';

export function readProgressFields(node: BlockNode): ProgressFields {
  const slots = (node as { slots?: Slots }).slots ?? {};
  return {
    source: slots.source === 'site' ? 'site' : 'block',
    goal: figure(slots.goal),
    raised: figure(slots.raised)
  };
}

const whole = (text: string): number | null => {
  const t = text.trim();
  if (t === '') return 0;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export function validateProgressFields(values: ProgressFields): Validated {
  if (values.source === 'site') return { ok: true, slots: { source: 'site' } };
  const goal = whole(values.goal);
  if (goal === null || goal <= 0) {
    return { ok: false, error: 'Enter a goal greater than zero.', field: 'goal' };
  }
  const raised = whole(values.raised);
  if (raised === null) {
    return { ok: false, error: 'Raised must be a number.', field: 'raised' };
  }
  return { ok: true, slots: { goal, raised } };
}

interface ProgressDialogOpts {
  initial: ProgressFields;
  onCommit(slots: Slots): void;
  refuse?(): string | null;
  onCancel?(): void;
}

export function openProgressDialog(
  root: Element,
  opts: ProgressDialogOpts
): FieldsDialog<ProgressFields> {
  const own = (v: ProgressFields): boolean => v.source === 'block';
  return openFieldsDialog<ProgressFields>(root, {
    ...opts,
    title: 'Edit progress',
    idPrefix: 'rkr-progress-field',
    fields: [
      {
        name: 'source',
        label: 'Source',
        kind: 'select',
        options: [
          ['site', 'Site campaign'],
          ['block', 'This block']
        ]
      },
      { name: 'goal', label: 'Goal', kind: 'number', showWhen: own },
      { name: 'raised', label: 'Raised', kind: 'number', showWhen: own }
    ],
    validate: validateProgressFields
  });
}
