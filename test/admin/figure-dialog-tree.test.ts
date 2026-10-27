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

  it('Mask and Link write their slots', async () => {
    const d = open('figure', FIGURE);
    const mask = d.root.querySelector('#rkr-media-mask') as unknown as { value: string };
    const href = d.root.querySelector('#rkr-media-href') as unknown as { value: string };
    mask.value = 'circle';
    href.value = ' /about ';
    d.find('Save figure')?.click();
    await tick();
    assert.equal(d.commits[0]?.mask, 'circle');
    assert.equal(d.commits[0]?.href, '/about');
  });

  it('emptying Mask and Link clears slots that were set', async () => {
    const d = open('figure', { ...FIGURE, mask: 'rounded', href: '/x' });
    const mask = d.root.querySelector('#rkr-media-mask') as unknown as { value: string };
    const href = d.root.querySelector('#rkr-media-href') as unknown as { value: string };
    assert.equal(mask.value, 'rounded');
    assert.equal(href.value, '/x');
    mask.value = '';
    href.value = '';
    d.find('Save figure')?.click();
    await tick();
    assert.equal(d.commits[0]?.mask, '');
    assert.equal(d.commits[0]?.href, '');
  });

  it('untouched Mask and Link add no slots; video has no such controls', async () => {
    const d = open('figure', FIGURE);
    d.find('Save figure')?.click();
    await tick();
    assert.equal('mask' in (d.commits[0] ?? {}), false);
    assert.equal('href' in (d.commits[0] ?? {}), false);
    const v = open('video', { ids: A });
    assert.equal(v.root.querySelector('#rkr-media-mask'), null);
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
  /** Mirrors canvas-loaders: every repaint mints a new blob URL for the
   * id and revokes the previous one. */
  function host() {
    const calls: string[] = [];
    const revoked = new Set<string>();
    const urls = new Map<string, string>();
    let minted = 0;
    let unapplied = false;
    const repaint = (id: string): void => {
      const old = urls.get(id);
      if (old) revoked.add(old);
      urls.set(id, `blob:${++minted}`);
    };
    let active = '';
    const editor: ImageEditorHost = {
      open: (id, into) => {
        active = id;
        calls.push(`open:${id === B ? 'B' : id}`);
        repaint(id);
        const panel = (into as unknown as FakeElement).ownerDocument.createElement('div');
        panel.className = 'fake-editor';
        (into as unknown as FakeElement).append(panel);
      },
      apply: async () => {
        calls.push('apply');
        repaint(active);
        unapplied = false;
        return true;
      },
      close: (discard) => {
        calls.push(`close:${discard}`);
        if (discard) repaint(active);
        unapplied = false;
      },
      dirty: () => unapplied,
      previewUrl: (id) => urls.get(id) ?? null
    };
    return {
      editor,
      calls,
      revoked,
      edit: () => {
        unapplied = true;
      }
    };
  }

  const editButton = (d: Opened, i: number) =>
    d
      .rows()
      [i]?.querySelectorAll('button')
      .find((b) => b.textContent === 'Edit image');

  it('Edit image swaps to the editor with Back to figure and Apply edits', async () => {
    const h = host();
    const d = open('figure', FIGURE, { imageEditor: h.editor });
    editButton(d, 1)?.click();
    assert.deepEqual(h.calls, ['open:B']);
    assert.ok(d.root.querySelector('.fake-editor'), 'editor mounted in the dialog body');
    assert.equal(d.rows().length, 0, 'list is swapped out');
    assert.ok(d.find('Back to figure'));
    assert.equal(d.root.querySelector('.rkr-dialog-primary')?.textContent, 'Apply edits');

    d.find('Apply edits')?.click();
    await tick();
    assert.deepEqual(h.calls, ['open:B', 'apply', 'close:false']);
    assert.equal(d.rows().length, 2, 'back on the list');
    assert.equal(d.rows()[1]?.querySelector('img')?.getAttribute('src'), 'blob:2');
    assert.equal(d.root.querySelector('.rkr-dialog-primary')?.textContent, 'Save figure');

    d.find('Cancel')?.click();
    assert.deepEqual(d.cancels, [true], 'applied edits are reported on cancel');
  });

  it('row thumbnails never point at a revoked preview URL', async () => {
    const h = host();
    const d = open('figure', FIGURE, { imageEditor: h.editor });
    const thumbs = () => d.rows().map((r) => r.querySelector('img')?.getAttribute('src') ?? '');
    editButton(d, 1)?.click();
    h.edit();
    d.find('Apply edits')?.click();
    await tick();
    editButton(d, 1)?.click();
    d.find('Back to figure')?.click();
    await tick();
    d.rows()[0]
      ?.querySelectorAll('button')
      .find((b) => b.textContent === 'Move down')
      ?.click();
    assert.ok(h.revoked.size >= 2, 'the fake revoked earlier URLs');
    for (const src of thumbs()) assert.equal(h.revoked.has(src), false, `${src} is live`);
    assert.equal(thumbs()[0], h.editor.previewUrl(B));
  });

  it('Back to figure with no unapplied edits leaves directly', () => {
    const h = host();
    const d = open('figure', FIGURE, { imageEditor: h.editor });
    editButton(d, 0)?.click();
    d.find('Back to figure')?.click();
    assert.deepEqual(h.calls.slice(-1), ['close:true']);
    assert.equal(d.rows().length, 2);
    assert.equal(d.commits.length, 0);
    assert.equal(d.root.querySelectorAll('[data-rkr-dialog]').length, 1, 'no confirm');
  });

  it('Back to figure with unapplied edits asks first', async () => {
    const h = host();
    const d = open('figure', FIGURE, { imageEditor: h.editor });
    editButton(d, 0)?.click();
    h.edit();
    d.find('Back to figure')?.click();
    await tick();
    const confirm = () =>
      d.root
        .querySelectorAll('[data-rkr-dialog]')
        .find((el) => el.textContent?.includes('Discard unapplied edits?'));
    assert.ok(confirm(), 'confirm dialog opens');
    assert.equal(d.rows().length, 0, 'still in the editor');
    d.find('Keep editing')?.click();
    await tick();
    assert.equal(confirm(), undefined);
    assert.ok(d.root.querySelector('.fake-editor'), 'kept editing');

    d.find('Back to figure')?.click();
    await tick();
    d.find('Discard')?.click();
    await tick();
    assert.deepEqual(h.calls.slice(-1), ['close:true']);
    assert.equal(d.rows().length, 2, 'back on the list');
  });

  it('closing the dialog with unapplied edits asks first', async () => {
    const h = host();
    const d = open('figure', FIGURE, { imageEditor: h.editor });
    editButton(d, 0)?.click();
    h.edit();
    d.root.querySelector('.rkr-dialog-close')?.click();
    await tick();
    assert.deepEqual(d.cancels, [], 'not closed yet');
    d.find('Discard')?.click();
    await tick();
    assert.deepEqual(d.cancels, [false]);
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
    const positions = d.root.querySelectorAll('option').map((o) => o.getAttribute('value'));
    assert.equal(positions.includes('inline'), false, 'the renderer maps inline to center');
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
