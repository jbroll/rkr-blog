import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createConfigurator } from '../../src/admin/unified-configure.ts';
import type { BlockTree } from '../../src/lib/blocks.ts';
import { FakeDocument, type FakeElement, FakeEvent } from './fake-dom.ts';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('configure a grid', () => {
  const tree: BlockTree = {
    version: 1,
    body: [{ type: 'grid', slots: { cols: 2, widths: '2 1', other: 'x' }, children: [] }]
  };

  function setup() {
    const root = new FakeDocument().createElement('div');
    const applied: { tree: BlockTree; select?: number[] }[] = [];
    const configurator = createConfigurator({
      root: root as unknown as Element,
      macros: [],
      getTree: () => tree,
      applyTree: async (next, opts) => {
        applied.push({ tree: next, select: opts.select });
      },
      flushText: () => {},
      refuse: () => null
    });
    return { root, applied, configurator };
  }

  it('is configurable and saves the dialog slots over the old ones', async () => {
    const { root, applied, configurator } = setup();
    assert.ok(configurator.canConfigure(tree.body[0] as never));
    configurator.configure([0]);
    const widths = root.querySelector('#rkr-grid-field-widths') as FakeElement & { value: string };
    widths.value = '';
    widths.dispatchEvent(new FakeEvent('input'));
    (root.querySelector('.rkr-dialog-primary') as FakeElement).click();
    await tick();
    assert.deepEqual((applied[0]?.tree.body[0] as { slots: unknown }).slots, {
      other: 'x',
      cols: 2
    });
    assert.deepEqual(applied[0]?.select, [0]);
  });

  it('ignores a path that is not a grid', () => {
    const { root, configurator } = setup();
    configurator.configure([5]);
    assert.equal(root.querySelector('[data-rkr-dialog]'), null);
  });
});
