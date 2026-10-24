// Macro field dialog unit tests: field derivation from defaults,
// touched tracking, and empty-clears semantics.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openMacroDialog, readMacroFields } from '../../src/admin/macro-dialog-tree.ts';
import type { BlockNode } from '../../src/lib/blocks.ts';
import { FakeDocument } from './fake-dom.ts';

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
    const dialog = openMacroDialog(doc.createElement('div'), {
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
    const dialog = openMacroDialog(doc.createElement('div'), {
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
