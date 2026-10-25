// Tree-backed figure dialog: pure field read/validate plus a minimal
// DOM dialog driven by the shell. No TipTap dependency — the legacy
// figure-attr panel keeps serving the retired editor bundle untouched.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  openFigureDialog,
  readFigureFields,
  validateFigureFields
} from '../../src/admin/figure-dialog-tree.ts';
import type { BlockNode } from '../../src/lib/blocks.ts';
import { FakeDocument } from './fake-dom.ts';

const FIGURE: BlockNode = {
  type: 'figure',
  slots: { ids: 'aa'.repeat(32), alts: 'old alt', captions: 'old cap', justify: 'left' }
};

describe('figure dialog fields', () => {
  it('reads current slots into fields', () => {
    assert.deepEqual(readFigureFields(FIGURE), {
      ids: 'aa'.repeat(32),
      alts: 'old alt',
      captions: 'old cap',
      justify: 'left'
    });
  });

  it('rejects non-hex ids', () => {
    const r = validateFigureFields({ ids: 'not-hex!', alts: '', captions: '', justify: 'center' });
    assert.equal(r.ok, false);
  });

  it('coerces unknown justify to center', () => {
    const r = validateFigureFields({ ids: '', alts: '', captions: '', justify: 'sideways' });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.slots.justify, 'center');
  });

  it('dialog commit delivers exactly the edited slots', () => {
    const doc = new FakeDocument();
    const root = doc.createElement('div');
    const commits: unknown[] = [];
    const dialog = openFigureDialog(root, {
      initial: readFigureFields(FIGURE),
      onCommit: (slots) => {
        commits.push(slots);
      },
      onCancel: () => {}
    });
    dialog.setField('captions', 'new cap');
    dialog.setField('alts', 'new alt');
    dialog.commit();
    assert.equal(commits.length, 1);
    assert.deepEqual(commits[0], {
      ids: 'aa'.repeat(32),
      alts: 'new alt',
      captions: 'new cap',
      justify: 'left'
    });
  });

  it('dialog carries the figure-dialog class and labelled full-width fields', () => {
    const doc = new FakeDocument();
    const root = doc.createElement('div');
    openFigureDialog(root, {
      initial: readFigureFields(FIGURE),
      onCommit: () => {},
      onCancel: () => {}
    });
    const dialog = root.querySelector('.rkr-figure-dialog');
    assert.ok(dialog, 'dialog has .rkr-figure-dialog');
    assert.match(dialog.className, /\brkr-cell-dialog\b/);
    assert.equal(root.querySelectorAll('.rkr-figure-field').length, 4);
  });

  it('justify select offers every position and selects the current one', () => {
    const doc = new FakeDocument();
    const root = doc.createElement('div');
    openFigureDialog(root, {
      initial: readFigureFields(FIGURE),
      onCommit: () => {},
      onCancel: () => {}
    });
    const dialog = root.querySelector('.rkr-figure-dialog');
    assert.ok(dialog);
    const select = dialog.querySelector('select');
    assert.ok(select, 'justify select exists');
    const options = select.querySelectorAll('option');
    assert.deepEqual(
      options.map((o) => o.getAttribute('value')),
      ['center', 'full', 'bleed', 'left', 'right', 'inline']
    );
    const selected = options.filter((o) => o.hasAttribute('selected'));
    assert.equal(selected.length, 1, 'exactly one option selected');
    assert.equal(selected[0]?.getAttribute('value'), 'left');
  });

  it('dialog commit with bad ids reports errors and commits nothing', () => {
    const doc = new FakeDocument();
    const root = doc.createElement('div');
    let commits = 0;
    const dialog = openFigureDialog(root, {
      initial: readFigureFields(FIGURE),
      onCommit: () => {
        commits++;
      },
      onCancel: () => {}
    });
    dialog.setField('ids', 'zzz');
    dialog.commit();
    assert.equal(commits, 0);
    assert.ok(dialog.errors().length > 0);
  });
});
