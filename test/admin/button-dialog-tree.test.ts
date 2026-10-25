import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  openButtonDialog,
  readButtonFields,
  validateButtonFields
} from '../../src/admin/button-dialog-tree.ts';
import type { BlockNode } from '../../src/lib/blocks.ts';
import { FakeDocument, type FakeElement } from './fake-dom.ts';

const NODE: BlockNode = {
  type: 'button',
  slots: { label: 'Join', href: '/join', variant: 'secondary' }
};

describe('button dialog fields', () => {
  it('reads label, link and style from the slots', () => {
    assert.deepEqual(readButtonFields(NODE), {
      label: 'Join',
      href: '/join',
      variant: 'secondary'
    });
  });

  it('defaults missing slots and unknown variants', () => {
    assert.deepEqual(readButtonFields({ type: 'button' }), {
      label: '',
      href: '',
      variant: 'primary'
    });
    const odd: BlockNode = { type: 'button', slots: { variant: 'huge' } };
    assert.equal(readButtonFields(odd).variant, 'primary');
  });

  it('round-trips through validate', () => {
    const result = validateButtonFields(readButtonFields(NODE));
    assert.deepEqual(result, {
      ok: true,
      slots: { label: 'Join', href: '/join', variant: 'secondary' }
    });
  });

  it('requires a link', () => {
    const result = validateButtonFields({ label: 'Go', href: '   ', variant: 'primary' });
    assert.equal(result.ok, false);
  });

  it('trims the link and label', () => {
    const result = validateButtonFields({ label: ' Go ', href: ' /x ', variant: 'primary' });
    assert.deepEqual(result, { ok: true, slots: { label: 'Go', href: '/x', variant: 'primary' } });
  });
});

describe('button dialog', () => {
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  function open() {
    const doc = new FakeDocument();
    const root = doc.createElement('div');
    const commits: unknown[] = [];
    const dialog = openButtonDialog(root as unknown as Element, {
      initial: readButtonFields(NODE),
      onCommit: (slots) => {
        commits.push(slots);
      },
      onCancel: () => {}
    });
    return { root, dialog, commits };
  }

  it('labels the fields Label, Link and Style', () => {
    const { root } = open();
    assert.deepEqual(
      root.querySelectorAll('label').map((l) => l.textContent),
      ['Label', 'Link', 'Style']
    );
  });

  it('keeps the dialog open and shows an error when the link is empty', async () => {
    const { root, dialog, commits } = open();
    dialog.setField('href', '');
    (root.querySelector('.rkr-dialog-primary') as FakeElement).click();
    await tick();
    assert.equal(commits.length, 0);
    assert.ok(root.querySelector('[data-rkr-dialog]'));
    assert.match(root.querySelector('.rkr-dialog-error')?.textContent ?? '', /link/i);
  });

  it('commits edited slots', async () => {
    const { root, dialog, commits } = open();
    dialog.setField('label', 'Sign up');
    dialog.setField('variant', 'primary');
    (root.querySelector('.rkr-dialog-primary') as FakeElement).click();
    await tick();
    assert.deepEqual(commits, [{ label: 'Sign up', href: '/join', variant: 'primary' }]);
    assert.equal(root.querySelector('[data-rkr-dialog]'), null);
  });
});
