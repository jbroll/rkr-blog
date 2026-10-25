import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type ImageEditorHost,
  type MediaDialogDeps,
  openMediaDialog,
  validateFigureFields
} from '../../src/admin/figure-dialog-tree.ts';
import type { Slots } from '../../src/lib/blocks.ts';
import { FakeDocument, type FakeElement, FakeEvent } from './fake-dom.ts';

const A = 'aa'.repeat(32);
const B = 'bb'.repeat(32);
const C = 'cc'.repeat(32);

const tick = async (n = 5): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

interface Opened {
  root: FakeElement;
  commits: Slots[];
  cancels: boolean[];
  picks: string[];
  find(label: string): FakeElement | undefined;
  buttons(): string[];
  rows(): FakeElement[];
}

function open(
  kind: 'figure' | 'video',
  slots: Slots,
  over: Partial<MediaDialogDeps> & { fresh?: boolean; pickResult?: string[] } = {}
): Opened {
  const doc = new FakeDocument();
  const root = doc.createElement('div');
  const commits: Slots[] = [];
  const cancels: boolean[] = [];
  const picks: string[] = [];
  const media: MediaDialogDeps = {
    pick: async (k, multiple) => {
      picks.push(`${k}:${multiple}`);
      return over.pickResult ?? [];
    },
    thumbUrl: (_k, id) => `/admin/preview/${id}`,
    ...over
  };
  openMediaDialog(root as unknown as Element, {
    kind,
    slots,
    fresh: over.fresh,
    media,
    onCommit: (s) => commits.push(s),
    onCancel: (edited) => cancels.push(edited)
  });
  const all = () => root.querySelectorAll('button');
  return {
    root,
    commits,
    cancels,
    picks,
    find: (label) => all().find((b) => b.textContent === label),
    buttons: () => all().map((b) => b.textContent),
    rows: () => root.querySelectorAll('.rkr-media-row')
  };
}

const FIGURE: Slots = {
  ids: `${A},${B}`,
  alts: 'Dock,Boat',
  captions: 'Morning|Evening',
  matrix: 'justified',
  justify: 'left',
  custom: 'kept elsewhere'
};

describe('figure dialog', () => {
  it('dialog never renders an input containing a hex id', () => {
    const d = open('figure', FIGURE);
    const inputs = d.root.querySelectorAll('input');
    assert.ok(inputs.length >= 4, 'alt and caption inputs per row');
    for (const input of inputs) {
      const value = (input as unknown as { value?: string }).value ?? '';
      assert.doesNotMatch(value, /^[0-9a-f]{6,64}$/);
    }
    assert.doesNotMatch(d.root.textContent ?? '', /[0-9a-f]{12}/, 'no id in visible text');
  });

  it('has exactly one primary button, Save figure', () => {
    const d = open('figure', FIGURE);
    const primaries = d.root.querySelectorAll('.rkr-dialog-primary');
    assert.equal(primaries.length, 1);
    assert.equal(primaries[0]?.textContent, 'Save figure');
    assert.equal(d.buttons().filter((t) => /^Save/.test(t)).length, 1);
  });

  it('Save figure commits the list, layout and position', async () => {
    const d = open('figure', FIGURE);
    const alt = d.rows()[1]?.querySelector('input');
    assert.ok(alt);
    (alt as unknown as { value: string }).value = 'Sailboat';
    alt.dispatchEvent(new FakeEvent('input'));
    d.find('Save figure')?.click();
    await tick();
    assert.deepEqual(d.commits, [
      {
        ids: `${A},${B}`,
        alts: 'Dock,Sailboat',
        captions: 'Morning|Evening',
        matrix: 'justified',
        justify: 'left'
      }
    ]);
  });

  it('layout control writes the matching matrix', async () => {
    const d = open('figure', FIGURE);
    const labels = d.root.querySelectorAll('[role="radio"]').map((b) => b.textContent);
    assert.deepEqual(labels, ['Single', 'Grid', 'Carousel', 'Justified', 'Masonry']);
    d.find('Carousel')?.click();
    d.find('Save figure')?.click();
    await tick();
    assert.equal(d.commits[0]?.matrix, '1x1');
  });

  it('an empty figure opens the picker straight away when first inserted', async () => {
    const d = open('figure', { ids: '' }, { fresh: true, pickResult: [A, B] });
    await tick();
    assert.deepEqual(d.picks, ['image:true']);
    assert.equal(d.rows().length, 2);
    d.find('Save figure')?.click();
    await tick();
    assert.equal(d.commits[0]?.ids, `${A},${B}`);
    assert.equal(d.commits[0]?.matrix, 'justified', 'several new images default to justified');
  });

  it('Add images appends to the list', async () => {
    const d = open('figure', FIGURE, { pickResult: [C] });
    assert.deepEqual(d.picks, [], 'an existing figure does not open the picker');
    d.find('Add images')?.click();
    await tick();
    assert.equal(d.rows().length, 3);
  });

  it('cancel reports whether image edits were applied', () => {
    const d = open('figure', FIGURE);
    d.find('Cancel')?.click();
    assert.deepEqual(d.cancels, [false]);
    assert.deepEqual(d.commits, []);
  });

  it('bad ids are still rejected at commit time', () => {
    const r = validateFigureFields({ ids: 'not-hex!', alts: '', captions: '', justify: 'center' });
    assert.equal(r.ok, false);
  });

  it('unknown justify coerces to center', () => {
    const r = validateFigureFields({ ids: '', alts: '', captions: '', justify: 'sideways' });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.slots.justify, 'center');
  });
});

describe('figure dialog image editor', () => {
  function host() {
    const calls: string[] = [];
    const editor: ImageEditorHost = {
      open: (id, into) => {
        calls.push(`open:${id === B ? 'B' : id}`);
        const panel = (into as unknown as FakeElement).ownerDocument.createElement('div');
        panel.className = 'fake-editor';
        (into as unknown as FakeElement).append(panel);
      },
      apply: async () => {
        calls.push('apply');
        return 'blob:rotated';
      },
      close: (discard) => {
        calls.push(`close:${discard}`);
      }
    };
    return { editor, calls };
  }

  it('Edit image swaps to the editor with Back to figure and Apply edits', async () => {
    const h = host();
    const d = open('figure', FIGURE, { imageEditor: h.editor });
    const row = d.rows()[1];
    row
      ?.querySelectorAll('button')
      .find((b) => b.textContent === 'Edit image')
      ?.click();
    assert.deepEqual(h.calls, ['open:B']);
    assert.ok(d.root.querySelector('.fake-editor'), 'editor mounted in the dialog body');
    assert.equal(d.rows().length, 0, 'list is swapped out');
    assert.ok(d.find('Back to figure'));
    assert.equal(d.root.querySelector('.rkr-dialog-primary')?.textContent, 'Apply edits');

    d.find('Apply edits')?.click();
    await tick();
    assert.deepEqual(h.calls, ['open:B', 'apply', 'close:false']);
    assert.equal(d.rows().length, 2, 'back on the list');
    assert.equal(d.rows()[1]?.querySelector('img')?.getAttribute('src'), 'blob:rotated');
    assert.equal(d.root.querySelector('.rkr-dialog-primary')?.textContent, 'Save figure');

    d.find('Cancel')?.click();
    assert.deepEqual(d.cancels, [true], 'applied edits are reported on cancel');
  });

  it('Back to figure discards unapplied edits', () => {
    const h = host();
    const d = open('figure', FIGURE, { imageEditor: h.editor });
    d.rows()[0]
      ?.querySelectorAll('button')
      .find((b) => b.textContent === 'Edit image')
      ?.click();
    d.find('Back to figure')?.click();
    assert.deepEqual(h.calls.slice(-1), ['close:true']);
    assert.equal(d.rows().length, 2);
    assert.equal(d.commits.length, 0);
  });

  it('rows offer no Edit image without an editor', () => {
    const d = open('figure', FIGURE);
    assert.equal(d.buttons().includes('Edit image'), false);
  });
});

describe('video dialog', () => {
  const VIDEO: Slots = { ids: C, caption: 'Launch day', justify: 'center', loop: 'true' };

  it('shows a single item with no layout control and no image editor', () => {
    const d = open('video', VIDEO);
    assert.equal(d.rows().length, 1);
    assert.equal(d.root.querySelectorAll('[role="radio"]').length, 0);
    assert.equal(d.buttons().includes('Edit image'), false);
    assert.equal(d.root.querySelector('.rkr-dialog-primary')?.textContent, 'Save video');
    assert.deepEqual(
      d
        .rows()[0]
        ?.querySelectorAll('label')
        .map((l) => l.textContent),
      ['Caption']
    );
  });

  it('Replace video picks one and Save commits ids, caption and position', async () => {
    const d = open('video', VIDEO, { pickResult: [A, B] });
    d.find('Replace video')?.click();
    await tick();
    assert.deepEqual(d.picks, ['video:false']);
    d.find('Save video')?.click();
    await tick();
    assert.deepEqual(d.commits, [{ ids: A, caption: 'Launch day', justify: 'center' }]);
  });

  it('an empty video opens the picker when first inserted', async () => {
    const d = open('video', { ids: '' }, { fresh: true, pickResult: [B] });
    await tick();
    assert.deepEqual(d.picks, ['video:false']);
    assert.equal(d.rows().length, 1);
  });
});
