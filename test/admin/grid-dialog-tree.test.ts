import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyGridSlots,
  type GridDialog,
  openGridDialog,
  readGridFields,
  validateGridFields
} from '../../src/admin/grid-dialog-tree.ts';
import type { Slots } from '../../src/lib/blocks.ts';
import { FakeDocument, type FakeElement } from './fake-dom.ts';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function open(slots: Slots) {
  const doc = new FakeDocument();
  const root = doc.createElement('div');
  const commits: Slots[] = [];
  const dialog: GridDialog = openGridDialog(root as unknown as Element, {
    initial: readGridFields(slots),
    onCommit: (next) => {
      commits.push(next);
    }
  });
  const save = async (): Promise<void> => {
    (root.querySelector('.rkr-dialog-primary') as FakeElement).click();
    await tick();
  };
  return { root, dialog, commits, save };
}

describe('grid dialog', () => {
  it('labels the fields', () => {
    const { root } = open({ cols: 2 });
    assert.deepEqual(
      root.querySelectorAll('label').map((l) => l.textContent),
      ['Columns', 'Narrowest cell', 'Column widths', 'Full-width band', 'Background', 'Bottom edge']
    );
  });

  it('commits columns and narrowest cell', async () => {
    const { dialog, commits, save, root } = open({});
    dialog.setField('cols', '3');
    dialog.setField('min', 'wide');
    await save();
    assert.deepEqual(commits, [{ cols: 3, min: 'wide' }]);
    assert.equal(root.querySelector('[data-rkr-dialog]'), null);
  });

  it('keeps the dialog open with the slot message for bad widths', async () => {
    const { dialog, commits, save, root } = open({ cols: 3 });
    dialog.setField('widths', '2 x');
    await save();
    assert.equal(commits.length, 0);
    assert.ok(root.querySelector('[data-rkr-dialog]'));
    assert.match(root.querySelector('.rkr-dialog-error')?.textContent ?? '', /3 positive numbers/);
  });

  it('shows the message when a column change leaves the widths short', async () => {
    const { dialog, commits, save, root } = open({ cols: 2, widths: '2 1' });
    dialog.setField('cols', '3');
    await save();
    assert.equal(commits.length, 0);
    assert.match(root.querySelector('.rkr-dialog-error')?.textContent ?? '', /3 positive numbers/);
  });

  it('commits widths and Equal removes them', async () => {
    const { dialog, commits, save } = open({ cols: 2, widths: '2 1' });
    await save();
    assert.deepEqual(commits[0], { cols: 2, widths: '2 1' });
    const again = open({ cols: 2, widths: '2 1' });
    again.dialog.setField('widths', '');
    await again.save();
    assert.deepEqual(again.commits[0], { cols: 2 });
    assert.equal(dialog === again.dialog, false);
  });

  it('offers widths only for 2 to 4 columns and drops them otherwise', async () => {
    const { dialog, commits, save, root } = open({ cols: 2, widths: '2 1' });
    const row = (root.querySelector('#rkr-grid-field-widths') as FakeElement)
      .parentNode as FakeElement;
    assert.equal(row.hidden, false);
    dialog.setField('cols', '5');
    assert.equal(row.hidden, true);
    await save();
    assert.deepEqual(commits[0], { cols: 5 });
  });

  it('commits theme and edge only with the band on', async () => {
    const on = open({ cols: 1, band: true, theme: 'dark', edge: 'wave' });
    await on.save();
    assert.deepEqual(on.commits[0], { cols: 1, band: true, theme: 'dark', edge: 'wave' });
    const off = open({ cols: 1, band: true, theme: 'dark', edge: 'wave' });
    off.dialog.setField('band', false);
    await off.save();
    assert.deepEqual(off.commits[0], { cols: 1 });
  });

  it('shows the background and edge rows only with the band on', () => {
    const { dialog, root } = open({});
    const hidden = (name: string): boolean =>
      ((root.querySelector(`#rkr-grid-field-${name}`) as FakeElement).parentNode as FakeElement)
        .hidden;
    assert.equal(hidden('theme'), true);
    dialog.setField('band', true);
    assert.equal(hidden('theme'), false);
    assert.equal(hidden('edge'), false);
  });
});

describe('grid fields', () => {
  it('validates through gridSlotProblem', () => {
    const fields = readGridFields({ cols: 2 });
    assert.equal(validateGridFields({ ...fields, widths: '1 0' }).ok, false);
  });

  it('keeps unrelated slots when applying', () => {
    assert.deepEqual(
      applyGridSlots({ cols: 2, theme: 'dark', band: true, other: 'x' }, { cols: 1 }),
      {
        other: 'x',
        cols: 1
      }
    );
  });
});
