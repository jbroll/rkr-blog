import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyGridSlots,
  type GridDialog,
  openGridDialog,
  readGridFields,
  validateGridFields
} from '../../src/admin/grid-dialog-tree.ts';
import type { MediaPicker } from '../../src/admin/media-source.ts';
import type { Slots } from '../../src/lib/blocks.ts';
import { FakeDocument, type FakeElement } from './fake-dom.ts';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const THEMES = ['light', 'light-bold', 'dark', 'dark-bold'];

function open(slots: Slots, canBand = true, themes = THEMES, media?: MediaPicker) {
  const doc = new FakeDocument();
  const root = doc.createElement('div');
  const commits: Slots[] = [];
  const dialog: GridDialog = openGridDialog(root as unknown as Element, {
    initial: readGridFields(slots),
    canBand,
    themes,
    media,
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
      [
        'Columns',
        'Narrowest cell',
        'Column widths',
        'Alignment',
        'Panel',
        'Full-width band',
        'Background',
        'Background image',
        'Bottom edge'
      ]
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

  it('keeps stored widths on a 5 or 6 column grid until Columns changes', async () => {
    const kept = open({ cols: 5, widths: '2 1 1 1 1', min: 'narrow' });
    kept.dialog.setField('min', 'wide');
    await kept.save();
    assert.deepEqual(kept.commits[0], { cols: 5, min: 'wide', widths: '2 1 1 1 1' });
    const changed = open({ cols: 6, widths: '1 1 1 1 1 2' });
    changed.dialog.setField('cols', '5');
    await changed.save();
    assert.deepEqual(changed.commits[0], { cols: 5 });
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

describe('grid dialog section look', () => {
  const optionsOf = (root: FakeElement, name: string): string[][] =>
    (root.querySelector(`#rkr-grid-field-${name}`) as FakeElement)
      .querySelectorAll('option')
      .map((o) => [o.getAttribute('value') ?? '', o.textContent ?? '']);

  it('lists the passed theme names with labels', () => {
    const { root } = open({ band: true }, true, [...THEMES, 'brand-red']);
    assert.deepEqual(optionsOf(root, 'theme'), [
      ['light', 'Light'],
      ['light-bold', 'Light bold'],
      ['dark', 'Dark'],
      ['dark-bold', 'Dark bold'],
      ['brand-red', 'Brand red']
    ]);
  });

  it('commits a chosen theme', async () => {
    const { dialog, commits, save } = open({ band: true });
    dialog.setField('theme', 'dark-bold');
    await save();
    assert.deepEqual(commits[0], { cols: 1, band: true, theme: 'dark-bold', edge: 'straight' });
  });

  it('round-trips align and panel, leaving defaults out', async () => {
    const set = open({ cols: 2, align: 'center', box: true });
    await set.save();
    assert.deepEqual(set.commits[0], { cols: 2, align: 'center', box: true });
    const off = open({ cols: 2, align: 'center', box: true });
    off.dialog.setField('align', 'start');
    off.dialog.setField('box', false);
    await off.save();
    assert.deepEqual(off.commits[0], { cols: 2 });
  });

  const picker = (ids: string[]): MediaPicker => ({
    pick: async () => ids,
    thumbUrl: (_kind, id) => `/t/${id}`
  });
  const button = (root: FakeElement, text: string): FakeElement =>
    root.querySelectorAll('button').find((b) => b.textContent === text) as FakeElement;

  it('picks and clears the background image', async () => {
    const { root, commits, save } = open({ band: true }, true, THEMES, picker(['abc123']));
    button(root, 'Choose image').click();
    await tick();
    await save();
    assert.equal(commits[0]?.bg, 'abc123');
    const again = open({ band: true, bg: 'abc123' }, true, THEMES, picker([]));
    button(again.root, 'Remove').click();
    await again.save();
    assert.equal('bg' in (again.commits[0] ?? {}), false);
  });

  it('keeps a stored background image and shows its row only for a band', async () => {
    const { dialog, root, commits, save } = open({ band: true, bg: 'abc123' });
    const row = (root.querySelector('.rkr-image-field') as FakeElement).parentNode as FakeElement;
    assert.equal(row.hidden, false);
    await save();
    assert.equal(commits[0]?.bg, 'abc123');
    dialog.setField('band', false);
    assert.equal(row.hidden, true);
  });

  it('drops the background image when the band is off', async () => {
    const { dialog, commits, save } = open({ band: true, bg: 'abc123' });
    dialog.setField('band', false);
    await save();
    assert.deepEqual(commits[0], { cols: 1 });
  });
});

describe('grid dialog band field', () => {
  const bandHidden = (root: FakeElement): boolean =>
    ((root.querySelector('#rkr-grid-field-band') as FakeElement).parentNode as FakeElement).hidden;

  it('hides Full-width band below page level', () => {
    assert.equal(bandHidden(open({ cols: 2 }, false).root), true);
  });

  it('keeps it for a grid that is already a band, and at page level', () => {
    assert.equal(bandHidden(open({ band: true }, false).root), false);
    assert.equal(bandHidden(open({ cols: 2 }, true).root), false);
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
