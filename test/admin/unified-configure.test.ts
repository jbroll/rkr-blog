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

  it('offers the band only for a grid at page level', () => {
    const nested: BlockTree = {
      version: 1,
      body: [{ type: 'grid', children: [{ type: 'grid', slots: { cols: 2 }, children: [] }] }]
    };
    const root = new FakeDocument().createElement('div');
    createConfigurator({
      root: root as unknown as Element,
      macros: [],
      getTree: () => nested,
      applyTree: async () => {},
      flushText: () => {},
      refuse: () => null
    }).configure([0, 0]);
    const row = (root.querySelector('#rkr-grid-field-band') as FakeElement)
      .parentNode as FakeElement;
    assert.equal(row.hidden, true);
  });

  it('passes the theme names and media to the grid dialog', async () => {
    const band: BlockTree = {
      version: 1,
      body: [{ type: 'grid', slots: { band: true }, children: [] }]
    };
    const root = new FakeDocument().createElement('div');
    const applied: BlockTree[] = [];
    createConfigurator({
      root: root as unknown as Element,
      macros: [],
      themes: ['light', 'brand-red'],
      media: { pick: async () => ['abc123'], thumbUrl: () => null },
      getTree: () => band,
      applyTree: async (next) => {
        applied.push(next);
      },
      flushText: () => {},
      refuse: () => null
    }).configure([0]);
    const options = (root.querySelector('#rkr-grid-field-theme') as FakeElement).querySelectorAll(
      'option'
    );
    assert.deepEqual(
      options.map((o) => o.textContent),
      ['Light', 'Brand red']
    );
    const choose = root
      .querySelectorAll('button')
      .find((b) => b.textContent === 'Choose image') as FakeElement;
    choose.click();
    await tick();
    (root.querySelector('.rkr-dialog-primary') as FakeElement).click();
    await tick();
    assert.equal((applied[0]?.body[0] as unknown as { slots: { bg: string } }).slots.bg, 'abc123');
  });

  it('ignores a path that is not a grid', () => {
    const { root, configurator } = setup();
    configurator.configure([5]);
    assert.equal(root.querySelector('[data-rkr-dialog]'), null);
  });
});

describe('configure a macro with a list field', () => {
  const macros = [
    {
      name: 'team',
      label: 'Team',
      defaults: { title: 'Our team', people: [] },
      fieldSchema: {
        title: { label: 'Title', type: 'text' },
        people: { label: 'People', type: 'list', item: { name: { label: 'Name', type: 'text' } } }
      }
    }
  ];

  async function run(slots: Record<string, unknown>, act: (root: FakeElement) => void) {
    const root = new FakeDocument().createElement('div');
    const tree: BlockTree = { version: 1, body: [{ type: 'macro', macro: 'team', slots }] };
    const applied: BlockTree[] = [];
    createConfigurator({
      root: root as unknown as Element,
      macros,
      getTree: () => tree,
      applyTree: async (next) => {
        applied.push(next);
      },
      flushText: () => {},
      refuse: () => null
    }).configure([0]);
    act(root);
    (root.querySelector('.rkr-dialog-primary') as FakeElement).click();
    await tick();
    return (applied[0]?.body[0] as { slots: Record<string, unknown> }).slots;
  }

  it('mergeMacroFields keeps arrays and clears the override for an empty list', async () => {
    const added = await run({ title: 'T' }, (root) => {
      (root.querySelector('[aria-label="Add row"]') as FakeElement).click();
    });
    assert.deepEqual(added, { title: 'T', people: [{}] });

    const cleared = await run({ title: 'T', people: [{ name: 'Ann' }] }, (root) => {
      (root.querySelector('[aria-label="Remove row 1"]') as FakeElement).click();
    });
    assert.deepEqual(cleared, { title: 'T' });
  });
});

describe('configure the small blocks', () => {
  async function run(
    node: BlockTree['body'][number],
    act: (root: FakeElement) => void
  ): Promise<Record<string, unknown> | undefined> {
    const root = new FakeDocument().createElement('div');
    const tree: BlockTree = { version: 1, body: [node] };
    const applied: BlockTree[] = [];
    const configurator = createConfigurator({
      root: root as unknown as Element,
      macros: [],
      getTree: () => tree,
      applyTree: async (next) => {
        applied.push(next);
      },
      flushText: () => {},
      refuse: () => null
    });
    assert.ok(configurator.canConfigure(node));
    configurator.configure([0]);
    act(root);
    (root.querySelector('.rkr-dialog-primary') as FakeElement).click();
    await tick();
    return (applied[0]?.body[0] as { slots?: Record<string, unknown> } | undefined)?.slots;
  }
  const type = (root: FakeElement, name: string, value: string): void => {
    const el = root.querySelector(`[name="${name}"]`) as FakeElement & { value: string };
    el.value = value;
    el.dispatchEvent(new FakeEvent('change'));
  };

  it('marquee', async () => {
    const slots = await run({ type: 'marquee', slots: { text: '' } }, (r) =>
      type(r, 'text', 'Hello')
    );
    assert.deepEqual(slots, { text: 'Hello' });
  });

  it('progress switching to this block drops the site source', async () => {
    const slots = await run({ type: 'progress', slots: { source: 'site' } }, (r) => {
      type(r, 'source', 'block');
      type(r, 'goal', '100');
    });
    assert.deepEqual(slots, { goal: 100, raised: 0 });
  });

  it('embed rewrites the url and drops a cleared height', async () => {
    const slots = await run(
      { type: 'embed', slots: { url: 'https://youtu.be/a', height: 500 } },
      (r) => {
        type(r, 'url', 'https://youtu.be/abc');
        type(r, 'height', '');
      }
    );
    assert.deepEqual(slots, { url: 'https://www.youtube-nocookie.com/embed/abc' });
  });

  it('accordion', async () => {
    const slots = await run(
      { type: 'accordion', slots: { items: [{ title: 'A', body: 'x' }] } },
      (r) => type(r, 'title', 'B')
    );
    assert.deepEqual(slots, { items: [{ title: 'B', body: 'x' }] });
  });

  it('button drops size and arrow when reset', async () => {
    const slots = await run(
      {
        type: 'button',
        slots: { label: 'Go', href: '/', variant: 'primary', size: 'large', arrow: true }
      },
      (r) => {
        type(r, 'size', 'normal');
        const arrow = r.querySelector('[name="arrow"]') as FakeElement & { checked: boolean };
        arrow.checked = false;
        arrow.dispatchEvent(new FakeEvent('change'));
      }
    );
    assert.deepEqual(slots, { label: 'Go', href: '/', variant: 'primary' });
  });
});
