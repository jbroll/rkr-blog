// Macro field dialog unit tests: field derivation from defaults,
// touched tracking, and empty-clears semantics.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openMacroDialog, readMacroFields } from '../../src/admin/macro-dialog-tree.ts';
import type { BlockNode } from '../../src/lib/blocks.ts';
import { FakeDocument, FakeEvent } from './fake-dom.ts';

const NODE: BlockNode = { type: 'macro', macro: 'hero', slots: { heading: 'Old' } };
const DEFAULTS = { heading: 'Fresh', sub: 'Default sub' };

describe('macro dialog fields', () => {
  it('prefills overrides and placeholders from defaults', () => {
    const fields = readMacroFields(NODE, DEFAULTS);
    assert.deepEqual(
      fields.map((f) => [f.name, f.value, f.placeholder]),
      [
        ['heading', 'Old', 'Fresh'],
        ['sub', '', 'Default sub']
      ]
    );
  });

  it('marks multiline for newline values', () => {
    const fields = readMacroFields(NODE, { body: 'a\nb' });
    assert.equal(fields[0]?.multiline, true);
  });

  it('commit is false when nothing was touched', () => {
    const doc = new FakeDocument();
    let commits = 0;
    const dialog = openMacroDialog(doc.createElement('div') as unknown as Element, {
      title: 'Edit hero',
      fields: readMacroFields(NODE, DEFAULTS),
      onCommit: () => {
        commits++;
      },
      onCancel: () => {}
    });
    assert.equal(dialog.commit(), false);
    assert.equal(commits, 0);
  });

  it('commit reports exactly the touched keys, including cleared ones', () => {
    const doc = new FakeDocument();
    const committed: unknown[] = [];
    const dialog = openMacroDialog(doc.createElement('div') as unknown as Element, {
      title: 'Edit hero',
      fields: readMacroFields(NODE, DEFAULTS),
      onCommit: (slots) => {
        committed.push(slots);
      },
      onCancel: () => {}
    });
    dialog.setField('heading', 'New band');
    dialog.setField('sub', '');
    assert.deepEqual(dialog.touched().sort(), ['heading', 'sub']);
    assert.equal(dialog.commit(), true);
    assert.deepEqual(committed[0], { heading: 'New band', sub: '' });
  });
});

describe('macro dialog schema', () => {
  const SCHEMA = {
    heading: { label: 'Heading', type: 'text' as const },
    text: { label: 'Body', type: 'markdown' as const }
  };

  it('labels come from fieldSchema and markdown fields are textareas', () => {
    const doc = new FakeDocument();
    const root = doc.createElement('div');
    openMacroDialog(root as unknown as Element, {
      title: 'Edit hero',
      fields: readMacroFields(NODE, { heading: 'Fresh', text: 'Body default' }, SCHEMA),
      onCommit: () => {},
      onCancel: () => {}
    });
    const labels = root.querySelectorAll('label').map((l) => l.textContent);
    assert.deepEqual(labels, ['Heading', 'Body']);
    const area = root.querySelector('textarea');
    assert.ok(area, 'markdown field renders a textarea');
    assert.equal(area.getAttribute('name'), 'text');
    assert.equal(area.getAttribute('rows'), '4');
    assert.equal(root.querySelector('input')?.getAttribute('name'), 'heading');
  });

  it('keys without a schema entry fall back to the key as label', () => {
    const fields = readMacroFields(NODE, { sub: 'x' }, SCHEMA);
    assert.equal(fields[0]?.label, 'sub');
  });

  it('keeps one labelled field per row', () => {
    const doc = new FakeDocument();
    const root = doc.createElement('div');
    openMacroDialog(root as unknown as Element, {
      title: 'Edit hero',
      fields: readMacroFields(NODE, { heading: 'Fresh', text: 'Body default' }, SCHEMA),
      onCommit: () => {},
      onCancel: () => {}
    });
    assert.equal(root.querySelectorAll('.rkr-field').length, 2);
  });
});

describe('macro dialog behaviour', () => {
  const open = (
    fields = readMacroFields(NODE, DEFAULTS),
    handlers: { onCommit?: (s: unknown) => void; onCancel?: () => void } = {}
  ) => {
    const doc = new FakeDocument();
    const root = doc.createElement('div');
    const dialog = openMacroDialog(root as unknown as Element, {
      title: 'Edit hero',
      fields,
      onCommit: handlers.onCommit ?? (() => {}),
      onCancel: handlers.onCancel ?? (() => {})
    });
    return { root, dialog };
  };

  it('renders a select with a default choice for select fields', () => {
    const fields = readMacroFields(
      NODE,
      { size: 'm' },
      {
        size: { label: 'Size', type: 'select', options: ['s', 'm'] }
      }
    );
    const { root } = open(fields);
    const select = root.querySelector('select');
    assert.ok(select);
    assert.deepEqual(
      select.querySelectorAll('option').map((o) => o.textContent),
      ['Default (m)', 's', 'm']
    );
  });

  it('close cancels and removes the dialog', () => {
    let cancels = 0;
    const { root, dialog } = open(undefined, { onCancel: () => cancels++ });
    dialog.close();
    assert.equal(cancels, 1);
    assert.equal(root.querySelector('[data-rkr-dialog]'), null);
  });

  it('Save commits touched fields from typing and closes', () => {
    const committed: unknown[] = [];
    const { root } = open(undefined, { onCommit: (s) => committed.push(s) });
    const input = root.querySelector('input');
    assert.ok(input);
    (input as unknown as { value: string }).value = 'Typed';
    input.dispatchEvent(new FakeEvent('input'));
    root.querySelector('.rkr-dialog-primary')?.click();
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        assert.deepEqual(committed, [{ heading: 'Typed' }]);
        assert.equal(root.querySelector('[data-rkr-dialog]'), null);
        resolve();
      }, 0)
    );
  });

  it('Save with nothing touched closes without committing', () => {
    let commits = 0;
    const { root } = open(undefined, { onCommit: () => commits++ });
    root.querySelector('.rkr-dialog-primary')?.click();
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        assert.equal(commits, 0);
        assert.equal(root.querySelector('[data-rkr-dialog]'), null);
        resolve();
      }, 0)
    );
  });

  it('setField ignores unknown names', () => {
    const { dialog } = open();
    dialog.setField('nope', 'x');
    assert.deepEqual(dialog.touched(), []);
  });
});
