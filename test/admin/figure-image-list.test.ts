import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  figureSlotsFromList,
  layoutFromMatrix,
  listFromFigureSlots,
  matrixFromLayout,
  mountImageList,
  moveRow,
  removeRow
} from '../../src/admin/figure-image-list.ts';
import { FakeDocument, type FakeElement, FakeEvent } from './fake-dom.ts';

const ROWS = [
  { id: 'aaaaaa', alt: 'A', caption: 'one' },
  { id: 'bbbbbb', alt: 'B', caption: 'two' },
  { id: 'cccccc', alt: 'C', caption: 'three' }
];

describe('figure image list encoding', () => {
  it('list round-trips slot encoding', () => {
    const slots = {
      ids: 'aaaaaa,bbbbbb',
      alts: 'A,B',
      captions: 'one|two',
      matrix: '1x1',
      justify: 'center'
    };
    const rows = listFromFigureSlots(slots);
    assert.deepEqual(rows, [
      { id: 'aaaaaa', alt: 'A', caption: 'one' },
      { id: 'bbbbbb', alt: 'B', caption: 'two' }
    ]);
    assert.deepEqual(figureSlotsFromList(rows, { matrix: '1x1', justify: 'center' }), slots);
  });

  it('keeps commas in alt text and drops trailing empty entries', () => {
    const rows = [
      { id: 'aaaaaa', alt: 'Dock, dusk', caption: '' },
      { id: 'bbbbbb', alt: '', caption: '' }
    ];
    const slots = figureSlotsFromList(rows, { matrix: '', justify: 'left' });
    assert.equal(slots.alts, 'Dock\\, dusk');
    assert.equal(slots.captions, '');
    assert.deepEqual(listFromFigureSlots(slots), rows);
  });

  it('stores a pipe in a caption as a slash', () => {
    const slots = figureSlotsFromList([{ id: 'aaaaaa', alt: '', caption: 'left | right' }], {
      matrix: '',
      justify: 'center'
    });
    assert.equal(slots.captions, 'left / right');
  });

  it('a trailing backslash in an alt cannot escape the next comma', () => {
    const rows = [
      { id: 'aaaaaa', alt: 'path\\', caption: '' },
      { id: 'bbbbbb', alt: 'B', caption: '' }
    ];
    const slots = figureSlotsFromList(rows, { matrix: '', justify: 'center' });
    assert.deepEqual(
      listFromFigureSlots(slots).map((r) => r.alt),
      ['path', 'B']
    );
  });

  it('alts and captions keep their position when an id entry is empty', () => {
    const rows = listFromFigureSlots({ ids: 'aaaaaa,,bbbbbb', alts: 'A,X,B', captions: 'a|x|b' });
    assert.deepEqual(rows, [
      { id: 'aaaaaa', alt: 'A', caption: 'a' },
      { id: 'bbbbbb', alt: 'B', caption: 'b' }
    ]);
  });

  it('an empty figure reads as no rows', () => {
    assert.deepEqual(listFromFigureSlots({ ids: '' }), []);
    assert.deepEqual(listFromFigureSlots({}), []);
  });

  it('remove and reorder rewrite ids, alts and captions together', () => {
    const moved = moveRow(ROWS, 2, 0);
    assert.deepEqual(figureSlotsFromList(moved, { matrix: '', justify: 'center' }), {
      ids: 'cccccc,aaaaaa,bbbbbb',
      alts: 'C,A,B',
      captions: 'three|one|two',
      matrix: '',
      justify: 'center'
    });
    const removed = removeRow(ROWS, 1);
    assert.deepEqual(figureSlotsFromList(removed, { matrix: '', justify: 'center' }), {
      ids: 'aaaaaa,cccccc',
      alts: 'A,C',
      captions: 'one|three',
      matrix: '',
      justify: 'center'
    });
    assert.deepEqual(moveRow(ROWS, 0, -1), ROWS, 'out of range moves change nothing');
  });
});

describe('figure layout mapping', () => {
  it('maps matrix strings to layout choices and back', () => {
    assert.deepEqual(layoutFromMatrix(''), { mode: 'single', rows: 2, cols: 2, raw: '' });
    assert.deepEqual(layoutFromMatrix('1x1'), { mode: 'carousel', rows: 2, cols: 2, raw: '1x1' });
    assert.deepEqual(layoutFromMatrix('2x3'), { mode: 'grid', rows: 2, cols: 3, raw: '2x3' });
    assert.equal(layoutFromMatrix('justified:240').mode, 'justified');
    assert.equal(layoutFromMatrix('masonry').mode, 'masonry');
    assert.equal(matrixFromLayout({ mode: 'single', rows: 2, cols: 2, raw: '' }), '');
    assert.equal(matrixFromLayout({ mode: 'carousel', rows: 2, cols: 2, raw: '' }), '1x1');
    assert.equal(matrixFromLayout({ mode: 'grid', rows: 3, cols: 2, raw: '' }), '3x2');
    assert.equal(
      matrixFromLayout({ mode: 'justified', rows: 2, cols: 2, raw: 'justified:240' }),
      'justified:240',
      'an unchanged flow parameter is kept'
    );
    assert.equal(matrixFromLayout({ mode: 'masonry', rows: 2, cols: 2, raw: '2x2' }), 'masonry');
  });
});

describe('figure image list rows', () => {
  function mount(rows = ROWS, onEdit: (i: number) => void = () => {}) {
    const doc = new FakeDocument();
    const changes: unknown[] = [];
    const list = mountImageList(doc as unknown as Document, {
      rows,
      kind: 'image',
      thumbUrl: (id) => `/admin/preview/${id}`,
      onChange: (next) => changes.push(next),
      onEdit
    });
    return { el: list.element as unknown as FakeElement, list, changes };
  }

  const button = (row: FakeElement, label: string): FakeElement => {
    const found = row.querySelectorAll('button').find((b) => b.textContent === label);
    assert.ok(found, `row has ${label}`);
    return found;
  };

  it('each row shows a thumbnail, alt, caption and its actions', () => {
    const { el } = mount();
    const rows = el.querySelectorAll('.rkr-media-row');
    assert.equal(rows.length, 3);
    const first = rows[0] as FakeElement;
    assert.equal(first.querySelector('img')?.getAttribute('src'), '/admin/preview/aaaaaa');
    assert.deepEqual(
      first.querySelectorAll('label').map((l) => l.textContent),
      ['Alt text', 'Caption']
    );
    for (const label of ['Move up', 'Move down', 'Edit image', 'Remove']) button(first, label);
  });

  it('typing an alt reports the edited list', () => {
    const { el, changes } = mount();
    const alt = (el.querySelectorAll('.rkr-media-row')[1] as FakeElement).querySelector('input');
    assert.ok(alt);
    (alt as unknown as { value: string }).value = 'New B';
    alt.dispatchEvent(new FakeEvent('input'));
    const last = changes.at(-1) as { alt: string }[];
    assert.equal(last[1]?.alt, 'New B');
  });

  it('move down and remove rerender the rows', () => {
    const { el, changes } = mount();
    button(el.querySelectorAll('.rkr-media-row')[0] as FakeElement, 'Move down').click();
    assert.deepEqual(
      (changes.at(-1) as { id: string }[]).map((r) => r.id),
      ['bbbbbb', 'aaaaaa', 'cccccc']
    );
    button(el.querySelectorAll('.rkr-media-row')[2] as FakeElement, 'Remove').click();
    assert.deepEqual(
      (changes.at(-1) as { id: string }[]).map((r) => r.id),
      ['bbbbbb', 'aaaaaa']
    );
    assert.equal(el.querySelectorAll('.rkr-media-row').length, 2);
  });

  it('edit image reports the row index and refresh re-reads thumbnails', () => {
    const edits: number[] = [];
    const doc = new FakeDocument();
    let url = 'blob:before';
    const list = mountImageList(doc as unknown as Document, {
      rows: ROWS,
      kind: 'image',
      thumbUrl: () => url,
      onChange: () => {},
      onEdit: (i) => edits.push(i)
    });
    const el = list.element as unknown as FakeElement;
    button(el.querySelectorAll('.rkr-media-row')[1] as FakeElement, 'Edit image').click();
    assert.deepEqual(edits, [1]);
    url = 'blob:after';
    list.refresh();
    const img = (el.querySelectorAll('.rkr-media-row')[1] as FakeElement).querySelector('img');
    assert.equal(img?.getAttribute('src'), 'blob:after');
  });

  it('a thumbnail that fails to load re-reads its URL', () => {
    const doc = new FakeDocument();
    let url = 'blob:revoked';
    const list = mountImageList(doc as unknown as Document, {
      rows: ROWS.slice(0, 1),
      kind: 'image',
      thumbUrl: () => url,
      onChange: () => {}
    });
    const img = (list.element as unknown as FakeElement).querySelector('img');
    assert.ok(img);
    url = 'blob:current';
    img.dispatchEvent(new FakeEvent('error'));
    assert.equal(img.getAttribute('src'), 'blob:current');
  });

  it('a server thumbnail that fails falls back to the local copy once', async () => {
    const doc = new FakeDocument();
    const asked: string[] = [];
    const list = mountImageList(doc as unknown as Document, {
      rows: ROWS.slice(0, 1),
      kind: 'image',
      thumbUrl: (id) => `/admin/preview/${id}`,
      localThumbUrl: async (id) => {
        asked.push(id);
        return 'blob:local';
      },
      onChange: () => {}
    });
    const img = (list.element as unknown as FakeElement).querySelector('img');
    assert.ok(img);
    img.dispatchEvent(new FakeEvent('error'));
    await new Promise<void>((r) => setTimeout(r, 0));
    assert.equal(img.getAttribute('src'), 'blob:local');
    img.dispatchEvent(new FakeEvent('error'));
    await new Promise<void>((r) => setTimeout(r, 0));
    assert.equal(asked.length, 1, 'a failing local copy is not retried in a loop');
  });

  it('no input ever holds an id', () => {
    const { el } = mount();
    for (const input of el.querySelectorAll('input')) {
      const value = (input as unknown as { value?: string }).value ?? '';
      assert.doesNotMatch(value, /^[0-9a-f]{6,64}$/);
    }
  });
});
