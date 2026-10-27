// Macro field dialog unit tests: field derivation from defaults,
// touched tracking, and empty-clears semantics.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openMacroDialog, readMacroFields } from '../../src/admin/macro-dialog-tree.ts';
import type { BlockNode } from '../../src/lib/blocks.ts';
import { FakeDocument, type FakeElement, FakeEvent } from './fake-dom.ts';

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

  it('image fields show a thumbnail and Choose image, never the id', async () => {
    const OLD = 'ab'.repeat(32);
    const NEW = 'cd'.repeat(32);
    const node: BlockNode = { type: 'macro', macro: 'card', slots: { photo: OLD } };
    const fields = readMacroFields(
      node,
      { photo: '' },
      {
        photo: { label: 'Photo', type: 'image' }
      }
    );
    assert.equal(fields[0]?.image, true);
    const doc = new FakeDocument();
    const root = doc.createElement('div');
    const committed: unknown[] = [];
    const picks: boolean[] = [];
    openMacroDialog(root as unknown as Element, {
      title: 'Edit card',
      fields,
      media: {
        pick: async (_kind, multiple) => {
          picks.push(multiple);
          return [NEW, OLD];
        },
        thumbUrl: (_kind, id) => `/admin/preview/${id}`
      },
      onCommit: (s) => committed.push(s),
      onCancel: () => {}
    });
    assert.equal(root.querySelectorAll('input').length, 0, 'no text input for an image');
    assert.equal(root.querySelector('img')?.getAttribute('src'), `/admin/preview/${OLD}`);
    assert.doesNotMatch(root.textContent ?? '', /[0-9a-f]{12}/);
    const choose = root.querySelectorAll('button').find((b) => b.textContent === 'Choose image');
    assert.ok(choose);
    choose.click();
    await new Promise<void>((r) => setTimeout(r, 0));
    assert.deepEqual(picks, [false], 'single pick');
    assert.equal(root.querySelector('img')?.getAttribute('src'), `/admin/preview/${NEW}`);
    root.querySelector('.rkr-dialog-primary')?.click();
    await new Promise<void>((r) => setTimeout(r, 0));
    assert.deepEqual(committed, [{ photo: NEW }]);
  });

  it('Remove clears an image override', async () => {
    const node: BlockNode = { type: 'macro', macro: 'card', slots: { photo: 'ab'.repeat(32) } };
    const fields = readMacroFields(
      node,
      { photo: '' },
      { photo: { label: 'Photo', type: 'image' } }
    );
    const doc = new FakeDocument();
    const root = doc.createElement('div');
    const committed: unknown[] = [];
    openMacroDialog(root as unknown as Element, {
      title: 'Edit card',
      fields,
      onCommit: (s) => committed.push(s),
      onCancel: () => {}
    });
    root
      .querySelectorAll('button')
      .find((b) => b.textContent === 'Remove')
      ?.click();
    assert.equal(root.querySelector('img'), null);
    root.querySelector('.rkr-dialog-primary')?.click();
    await new Promise<void>((r) => setTimeout(r, 0));
    assert.deepEqual(committed, [{ photo: '' }]);
  });

  it('setField ignores unknown names', () => {
    const { dialog } = open();
    dialog.setField('nope', 'x');
    assert.deepEqual(dialog.touched(), []);
  });
});

describe('macro dialog list fields', () => {
  const SCHEMA = {
    people: {
      label: 'People',
      type: 'list',
      item: {
        name: { label: 'Name', type: 'text' },
        photo: { label: 'Photo', type: 'image' }
      }
    }
  };
  const node = (people?: unknown): BlockNode => ({
    type: 'macro',
    macro: 'team',
    slots: people === undefined ? {} : { people }
  });
  const SAVED = [{ name: 'Ann' }, { name: 'Bo' }];

  const open = (
    people: unknown = SAVED,
    media?: Parameters<typeof openMacroDialog>[1]['media']
  ) => {
    const root = new FakeDocument().createElement('div');
    const committed: Record<string, unknown>[] = [];
    const dialog = openMacroDialog(root as unknown as Element, {
      title: 'Edit team',
      fields: readMacroFields(node(people), { people: [] }, SCHEMA),
      media,
      onCommit: (s) => committed.push(s),
      onCancel: () => {}
    });
    return { root, dialog, committed };
  };
  const names = (root: FakeElement) =>
    root.querySelectorAll('input').map((i) => (i as unknown as { value: string }).value);

  it('renders one row per item with the item field specs', () => {
    const { root } = open();
    assert.equal(root.querySelectorAll('fieldset').length, 1);
    assert.equal(root.querySelectorAll('.rkr-list-row').length, 2);
    assert.deepEqual(names(root), ['Ann', 'Bo']);
    assert.equal(root.querySelectorAll('.rkr-image-field').length, 2);
    const labels = root.querySelectorAll('label').map((l) => l.textContent);
    assert.deepEqual(labels, ['Name', 'Photo', 'Name', 'Photo']);
  });

  it('shows no rows for a missing or non-array value', () => {
    assert.equal(open(null).root.querySelectorAll('.rkr-list-row').length, 0);
    assert.equal(open('oops').root.querySelectorAll('.rkr-list-row').length, 0);
  });

  it('add, remove, move up and move down change the committed array', () => {
    const { dialog, committed } = open();
    dialog.addRow('people');
    dialog.setItemField('people', 2, 'name', 'Cy');
    dialog.moveUp('people', 2);
    assert.equal(dialog.commit(), true);
    assert.deepEqual(committed[0]?.people, [{ name: 'Ann' }, { name: 'Cy' }, { name: 'Bo' }]);
  });

  it('move down and remove reorder and drop rows', () => {
    const { dialog, committed } = open();
    dialog.moveDown('people', 0);
    dialog.removeRow('people', 1);
    dialog.commit();
    assert.deepEqual(committed[0]?.people, [{ name: 'Bo' }]);
  });

  it('typing into a row field and the row buttons both commit', () => {
    const { root, committed } = open();
    const first = root.querySelectorAll('input')[0] as unknown as { value: string } & FakeElement;
    first.value = 'Ada';
    first.dispatchEvent(new FakeEvent('input'));
    root.querySelector('[aria-label="Move row 1 down"]')?.click();
    root.querySelector('[aria-label="Remove row 1"]')?.click();
    root.querySelector('[aria-label="Add row"]')?.click();
    root.querySelector('.rkr-dialog-primary')?.click();
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        assert.deepEqual(committed[0]?.people, [{ name: 'Ada' }, {}]);
        resolve();
      }, 0)
    );
  });

  it('out-of-range row moves and unknown lists do nothing', () => {
    const { dialog, committed } = open();
    dialog.moveUp('people', 0);
    dialog.moveDown('people', 1);
    dialog.removeRow('people', 9);
    dialog.addRow('nope');
    dialog.setItemField('people', 9, 'name', 'x');
    dialog.setItemField('nope', 0, 'name', 'x');
    assert.equal(dialog.commit(), false);
    assert.equal(committed.length, 0);
  });

  it('an image item field opens the media picker and stores the picked id', async () => {
    const NEW = 'cd'.repeat(32);
    const picks: boolean[] = [];
    const { root, committed } = open([{ name: 'Ann' }], {
      pick: async (_kind, multiple) => {
        picks.push(multiple);
        return [NEW];
      },
      thumbUrl: (_kind, id) => `/admin/preview/${id}`
    });
    root
      .querySelectorAll('button')
      .find((b) => b.textContent === 'Choose image')
      ?.click();
    await new Promise<void>((r) => setTimeout(r, 0));
    assert.deepEqual(picks, [false]);
    assert.equal(root.querySelector('img')?.getAttribute('src'), `/admin/preview/${NEW}`);
    root.querySelector('.rkr-dialog-primary')?.click();
    await new Promise<void>((r) => setTimeout(r, 0));
    assert.deepEqual(committed[0]?.people, [{ name: 'Ann', photo: NEW }]);
  });

  it('reopening the dialog shows the saved rows', () => {
    const first = open();
    first.dialog.addRow('people');
    first.dialog.setItemField('people', 2, 'name', 'Cy');
    first.dialog.commit();
    assert.deepEqual(names(open(first.committed[0]?.people).root), ['Ann', 'Bo', 'Cy']);
  });

  it('drops non-string item values when reading saved rows', () => {
    const fields = readMacroFields(node([{ name: 'Ann', n: 3 }, 'junk']), { people: [] }, SCHEMA);
    assert.deepEqual(fields[0]?.list?.items, [{ name: 'Ann' }]);
  });
});
