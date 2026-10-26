import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Path } from '../../src/admin/block-tree-ops.ts';
import { mountBlockActions } from '../../src/admin/unified-block-actions.ts';
import type { BlockNode, BlockTree } from '../../src/lib/blocks.ts';

import { FakeDocument, type FakeElement, FakeEvent, marker, para } from './fake-dom.ts';

const text = (markdown: string): BlockNode => ({ type: 'text', markdown });

interface Harness {
  doc: FakeDocument;
  body: FakeElement;
  bar: () => FakeElement;
  applied: { tree: BlockTree; select?: Path }[];
  state: {
    tree: BlockTree;
    selected: Path | null;
    editing: boolean;
    configured: Path[];
    onFlush?: () => void;
  };
  log: string[];
  layout: FakeElement;
  actions: { refresh(): void; dispose(): void };
  press(key: string, mods?: Record<string, boolean>, target?: FakeElement): FakeEvent;
  click(action: string): void;
}

function harness(tree: BlockTree, selected: Path | null, paths: string[]): Harness {
  const doc = new FakeDocument();
  const layout = doc.createElement('div');
  const body = doc.createElement('div');
  layout.append(body);
  for (const p of paths) body.append(marker(doc, p), para(doc, `block ${p}`));
  for (const [i, p] of body.querySelectorAll('p').entries()) {
    p.setAttribute('data-rkr-path', paths[i] as string);
  }
  const state: Harness['state'] = { tree, selected, editing: true, configured: [] };
  const log: string[] = [];
  const applied: Harness['applied'] = [];
  const actions = mountBlockActions({
    body: body as unknown as Element,
    getTree: () => {
      log.push('getTree');
      return state.tree;
    },
    getSelected: () => state.selected,
    select: (path) => {
      state.selected = path;
      actions.refresh();
    },
    applyTree: async (next, opts) => {
      applied.push({ tree: next, select: opts?.select });
    },
    configure: (path) => {
      state.configured.push(path);
    },
    canConfigure: (node) => node.type === 'figure' || node.type === 'macro',
    flushText: () => {
      log.push('flush');
      state.onFlush?.();
    },
    isEditing: () => state.editing
  });
  actions.refresh();
  const bar = () => layout.querySelector('.rkr-block-toolbar') as FakeElement;
  return {
    doc,
    body,
    bar,
    applied,
    state,
    log,
    layout,
    actions,
    press(key, mods = {}, target = body) {
      const ev = Object.assign(new FakeEvent('keydown'), { key, ...mods });
      ev.target = target;
      doc.dispatchEvent(ev);
      return ev;
    },
    click(action) {
      bar().querySelector(`[data-action="${action}"]`)?.click();
    }
  };
}

const AB: BlockTree = { version: 1, body: [text('A'), text('B')] };
const md = (tree: BlockTree): unknown[] =>
  tree.body.map((n) => (n as { markdown?: string }).markdown);

describe('block actions toolbar', () => {
  it('move down swaps siblings', () => {
    const h = harness(AB, [0], ['0', '1']);
    h.click('move-down');
    assert.deepEqual(md(h.applied[0]?.tree as BlockTree), ['B', 'A']);
    assert.deepEqual(h.applied[0]?.select, [1]);
  });

  it('move up at index 0 is disabled', () => {
    const h = harness(AB, [0], ['0', '1']);
    assert.ok(h.bar().querySelector('[data-action="move-up"]')?.hasAttribute('disabled'));
    assert.ok(!h.bar().querySelector('[data-action="move-down"]')?.hasAttribute('disabled'));
    h.click('move-up');
    assert.equal(h.applied.length, 0);
  });

  it('duplicate inserts a deep copy after', () => {
    const tree: BlockTree = {
      version: 1,
      body: [{ type: 'grid', slots: { cols: 2 }, children: [text('x')] }]
    };
    const h = harness(tree, [0], ['0']);
    h.click('duplicate');
    const next = h.applied[0]?.tree as BlockTree;
    assert.equal(next.body.length, 2);
    assert.deepEqual(next.body[1], next.body[0]);
    assert.notEqual(next.body[1], next.body[0]);
    assert.deepEqual(h.applied[0]?.select, [1]);
  });

  it('delete selects the next sibling, else previous, else none', () => {
    const abc: BlockTree = { version: 1, body: [text('A'), text('B'), text('C')] };
    const first = harness(abc, [0], ['0', '1', '2']);
    first.click('delete');
    assert.deepEqual(md(first.applied[0]?.tree as BlockTree), ['B', 'C']);
    assert.deepEqual(first.state.selected, [0]);

    const last = harness(abc, [2], ['0', '1', '2']);
    last.click('delete');
    assert.deepEqual(last.state.selected, [1]);

    const only = harness({ version: 1, body: [text('A')] }, [0], ['0']);
    only.click('delete');
    assert.equal(only.state.selected, null);
    assert.equal(only.applied[0]?.select, undefined);
  });

  it('labels the block and hides configure for text', () => {
    const tree: BlockTree = {
      version: 1,
      body: [text('A'), { type: 'macro', macro: 'hero' }]
    };
    const h = harness(tree, [0], ['0', '1']);
    assert.equal(h.bar().querySelector('.rkr-block-type')?.textContent, 'Text');
    assert.ok(h.bar().querySelector('[data-action="configure"]')?.hidden);
    h.state.selected = [1];
    h.actions.refresh();
    assert.equal(h.bar().querySelector('.rkr-block-type')?.textContent, 'Hero');
    assert.ok(!h.bar().querySelector('[data-action="configure"]')?.hidden);
  });

  it('labels grids by their slots', () => {
    const grid = (slots?: Record<string, unknown>): BlockNode =>
      slots ? { type: 'grid', slots, children: [] } : { type: 'grid', children: [] };
    const tree: BlockTree = {
      version: 1,
      body: [
        grid({ cols: 2 }),
        grid({ cols: 1 }),
        grid({ cols: 1, band: true, theme: 'light', edge: 'straight' }),
        grid({ cols: 3, band: true }),
        grid()
      ]
    };
    const h = harness(tree, [0], ['0', '1', '2', '3', '4']);
    const labels = [0, 1, 2, 3, 4].map((i) => {
      h.state.selected = [i];
      h.actions.refresh();
      return h.bar().querySelector('.rkr-block-type')?.textContent;
    });
    assert.deepEqual(labels, ['Row (2 columns)', 'Column', 'Section', 'Section', 'Column']);
  });

  it('marks the selected block and hides the bar in view mode', () => {
    const h = harness(AB, [1], ['0', '1']);
    assert.equal(h.body.querySelectorAll('[data-rkr-selected]').length, 1);
    assert.equal(h.bar().hidden, false);
    h.state.editing = false;
    h.actions.refresh();
    assert.equal(h.bar().hidden, true);
    assert.equal(h.body.querySelectorAll('[data-rkr-selected]').length, 0);
  });

  it('every toolbar button has an aria-label', () => {
    const h = harness(AB, [0], ['0', '1']);
    const buttons = h.bar().querySelectorAll('button');
    assert.ok(buttons.length >= 6);
    for (const b of buttons) assert.ok(b.getAttribute('aria-label'));
  });
});

describe('block actions keyboard', () => {
  const ABC: BlockTree = { version: 1, body: [text('A'), text('B'), text('C')] };

  it('Alt+Arrow moves, Mod+D duplicates, Delete deletes', () => {
    const h = harness(ABC, [1], ['0', '1', '2']);
    h.press('ArrowUp', { altKey: true });
    assert.deepEqual(md(h.applied[0]?.tree as BlockTree), ['B', 'A', 'C']);
    h.press('ArrowDown', { altKey: true });
    assert.deepEqual(md(h.applied[1]?.tree as BlockTree), ['A', 'C', 'B']);
    const dup = h.press('d', { ctrlKey: true });
    assert.equal(h.applied[2]?.tree.body.length, 4);
    assert.ok(dup.defaultPrevented);
    h.press('Delete');
    assert.equal(h.applied[3]?.tree.body.length, 2);
    h.press('Backspace');
    assert.equal(h.applied.length, 5);
  });

  it('plain arrows move the selection, Escape clears it', () => {
    const h = harness(ABC, [1], ['0', '1', '2']);
    h.press('ArrowDown');
    assert.deepEqual(h.state.selected, [2]);
    h.press('ArrowDown');
    assert.deepEqual(h.state.selected, [2]);
    h.press('ArrowUp');
    h.press('ArrowUp');
    assert.deepEqual(h.state.selected, [0]);
    h.press('Escape');
    assert.equal(h.state.selected, null);
    assert.equal(h.applied.length, 0);
  });

  it('Enter opens configure for configurable blocks only', () => {
    const tree: BlockTree = { version: 1, body: [text('A'), { type: 'macro', macro: 'hero' }] };
    const h = harness(tree, [0], ['0', '1']);
    h.press('Enter');
    assert.deepEqual(h.state.configured, []);
    h.state.selected = [1];
    h.press('Enter');
    assert.deepEqual(h.state.configured, [[1]]);
  });

  it('ignores keys typed into editable text, but Escape selects the block', () => {
    const h = harness(ABC, [2], ['0', '1', '2']);
    const p = h.body.querySelectorAll('p')[1] as FakeElement;
    p.setAttribute('contenteditable', 'true');
    h.press('Delete', {}, p);
    h.press('ArrowUp', { altKey: true }, p);
    assert.equal(h.applied.length, 0);
    h.press('Escape', {}, p);
    assert.deepEqual(h.state.selected, [1]);
  });

  it('ignores keys while a render is pending', () => {
    const h = harness(ABC, [1], ['0', '1', '2']);
    h.body.setAttribute('inert', '');
    h.press('Delete');
    assert.equal(h.applied.length, 0);
  });

  it('ignores keys in view mode and in form fields', () => {
    const h = harness(ABC, [1], ['0', '1', '2']);
    const input = h.doc.createElement('input');
    h.press('Delete', {}, input);
    h.state.editing = false;
    h.press('Delete');
    assert.equal(h.applied.length, 0);
  });
});

describe('block actions flush and guards', () => {
  const ABC: BlockTree = { version: 1, body: [text('A'), text('B'), text('C')] };
  const MACRO: BlockTree = { version: 1, body: [text('A'), { type: 'macro', macro: 'hero' }] };

  const cases: [string, (h: Harness) => void, BlockTree, Path][] = [
    ['Move down button', (h) => h.click('move-down'), ABC, [0]],
    ['Duplicate button', (h) => h.click('duplicate'), ABC, [0]],
    ['Delete button', (h) => h.click('delete'), ABC, [0]],
    ['Configure button', (h) => h.click('configure'), MACRO, [1]],
    ['Alt+ArrowDown', (h) => h.press('ArrowDown', { altKey: true }), ABC, [0]],
    ['Mod+D', (h) => h.press('d', { ctrlKey: true }), ABC, [0]],
    ['Delete key', (h) => h.press('Delete'), ABC, [0]],
    ['Enter key', (h) => h.press('Enter'), MACRO, [1]]
  ];

  for (const [name, run, tree, selected] of cases) {
    it(`${name} flushes text before reading the tree`, () => {
      const h = harness(
        tree,
        selected,
        tree.body.map((_, i) => String(i))
      );
      h.log.length = 0;
      run(h);
      const flush = h.log.indexOf('flush');
      assert.ok(flush >= 0, 'flushText ran');
      assert.ok(flush < h.log.indexOf('getTree'), 'flushText ran before getTree');
    });
  }

  it('dragstart flushes text', () => {
    const h = harness(ABC, [0], ['0', '1', '2']);
    h.log.length = 0;
    h.bar().querySelector('[data-action="drag"]')?.dispatchEvent(new FakeEvent('dragstart'));
    assert.deepEqual(h.log, ['flush']);
  });

  it('dragstart uses a shrunken, unmarked copy of the block as the drag image', async () => {
    const h = harness(ABC, [0], ['0', '1', '2']);
    const source = h.body.querySelector('[data-rkr-path="0"]') as FakeElement;
    const copy = h.doc.createElement('p');
    copy.setAttribute('data-rkr-path', '0');
    copy.setAttribute('data-rkr-selected', '');
    Object.assign(source, {
      getBoundingClientRect: () => ({
        top: 0,
        left: 0,
        right: 900,
        bottom: 400,
        width: 900,
        height: 400
      }),
      cloneNode: () => copy
    });
    const images: Array<{ el: unknown; x: number; y: number }> = [];
    const ev = Object.assign(new FakeEvent('dragstart'), {
      dataTransfer: {
        effectAllowed: '',
        setData: () => {},
        setDragImage: (el: unknown, x: number, y: number) => images.push({ el, x, y })
      }
    });
    h.bar().querySelector('[data-action="drag"]')?.dispatchEvent(ev);
    assert.equal(images.length, 1);
    assert.equal(images[0]?.el, copy);
    assert.equal(copy.getAttribute('data-rkr-path'), null);
    assert.equal(copy.getAttribute('data-rkr-selected'), null);
    assert.match(copy.getAttribute('style') ?? '', /width:320px/);
    assert.ok(copy.parentNode, 'ghost is in the document while the browser snapshots it');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(copy.parentNode, null, 'ghost removed after dragstart');
  });

  it('the applied tree reflects what the flush committed', () => {
    const h = harness(ABC, [0], ['0', '1', '2']);
    h.state.onFlush = () => {
      h.state.tree = { version: 1, body: [text('A typed'), text('B'), text('C')] };
    };
    h.click('duplicate');
    assert.deepEqual(md(h.applied[0]?.tree as BlockTree), ['A typed', 'A typed', 'B', 'C']);
  });

  it('ignores block keys with focus inside an editor dialog', () => {
    const h = harness(ABC, [1], ['0', '1', '2']);
    const dialog = h.doc.createElement('div');
    dialog.setAttribute('data-rkr-dialog', '');
    const save = h.doc.createElement('button');
    dialog.append(save);
    h.layout.append(dialog);
    for (const key of ['Delete', 'Backspace', 'Escape', 'Enter']) h.press(key, {}, save);
    assert.equal(h.applied.length, 0);
    assert.deepEqual(h.state.selected, [1]);
    assert.deepEqual(h.state.configured, []);
  });

  it('Enter does nothing when the node cannot be configured', () => {
    const tree: BlockTree = { version: 1, body: [{ type: 'button', slots: { label: 'Go' } }] };
    const h = harness(tree, [0], ['0']);
    assert.ok(h.bar().querySelector('[data-action="configure"]')?.hidden);
    h.press('Enter');
    assert.deepEqual(h.state.configured, []);
  });

  it('dispose removes the key listener and the toolbar', () => {
    const h = harness(ABC, [0], ['0', '1', '2']);
    assert.equal(h.doc.listenerCount('keydown'), 1);
    h.actions.dispose();
    assert.equal(h.doc.listenerCount('keydown'), 0);
    assert.equal(h.layout.querySelector('.rkr-block-toolbar'), null);
  });
});

describe('wrap and unwrap', () => {
  const grid = (slots: Record<string, unknown>, children: BlockNode[]): BlockNode => ({
    type: 'grid',
    slots,
    children
  });
  const shown = (h: Harness, action: string): boolean =>
    h.bar().querySelector(`[data-action="${action}"]`)?.hidden === false;

  it('wrap in row and in column select the new grid', () => {
    const row = harness(AB, [1], ['0', '1']);
    row.click('wrap-row');
    assert.deepEqual((row.applied[0]?.tree.body[1] as { slots: unknown }).slots, { cols: 2 });
    assert.deepEqual(row.applied[0]?.select, [1]);
    const col = harness(AB, [0], ['0', '1']);
    col.click('wrap-column');
    assert.deepEqual((col.applied[0]?.tree.body[0] as { slots: unknown }).slots, { cols: 1 });
  });

  it('wrap past three levels changes nothing and shows the nudge', () => {
    const deep = grid({ cols: 2 }, [grid({ cols: 2 }, [grid({ cols: 2 }, [text('x')])])]);
    const h = harness({ version: 1, body: [deep] }, [0, 0, 0, 0], ['0,0,0,0']);
    h.click('wrap-row');
    assert.equal(h.applied.length, 0);
    assert.match(
      h.bar().querySelector('.rkr-block-note')?.textContent ?? '',
      /nest at most 3 levels/
    );
  });

  it('hides Wrap in column under a one-column grid, but not at page level', () => {
    const under = harness({ version: 1, body: [grid({ cols: 1 }, [text('x')])] }, [0, 0], ['0,0']);
    assert.equal(shown(under, 'wrap-column'), false);
    assert.equal(shown(under, 'wrap-row'), true);
    const top = harness(AB, [0], ['0', '1']);
    assert.equal(shown(top, 'wrap-column'), true);
  });

  it('hides both wraps on a band grid', () => {
    const h = harness({ version: 1, body: [grid({ band: true }, [])] }, [0], ['0']);
    assert.equal(shown(h, 'wrap-row'), false);
    assert.equal(shown(h, 'wrap-column'), false);
    assert.equal(shown(h, 'unwrap'), true);
  });

  it('unwrap is for grids and selects the first lifted child', () => {
    assert.equal(shown(harness(AB, [0], ['0', '1']), 'unwrap'), false);
    const tree: BlockTree = { version: 1, body: [grid({ cols: 2 }, [text('a'), text('b')])] };
    const h = harness(tree, [0], ['0']);
    h.click('unwrap');
    assert.deepEqual(md(h.applied[0]?.tree as BlockTree), ['a', 'b']);
    assert.deepEqual(h.applied[0]?.select, [0]);
  });

  it('unwrap of an empty grid selects nothing', () => {
    const h = harness({ version: 1, body: [grid({ cols: 2 }, [])] }, [0], ['0']);
    h.click('unwrap');
    assert.deepEqual(h.applied[0]?.tree.body, []);
    assert.equal(h.state.selected, null);
    assert.equal(h.applied[0]?.select, undefined);
  });
});

describe('toolbar while dragging', () => {
  it('lets drops through from dragstart until dragend', async () => {
    const h = harness(AB, [0], ['0', '1']);
    h.doc.dispatchEvent(new FakeEvent('dragstart'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(h.bar().hasAttribute('data-dragging'));
    h.doc.dispatchEvent(new FakeEvent('dragend'));
    assert.ok(!h.bar().hasAttribute('data-dragging'));
  });

  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('stays clear when another handler cancels the dragstart', async () => {
    const h = harness(AB, [0], ['0', '1']);
    h.doc.addEventListener('dragstart', (ev) => ev.preventDefault());
    h.doc.dispatchEvent(new FakeEvent('dragstart'));
    await tick();
    assert.ok(!h.bar().hasAttribute('data-dragging'));
  });

  it('stays clear when the dragstart is cancelled after the listener ran', async () => {
    const h = harness(AB, [0], ['0', '1']);
    const ev = new FakeEvent('dragstart');
    h.doc.dispatchEvent(ev);
    ev.preventDefault();
    await tick();
    assert.ok(!h.bar().hasAttribute('data-dragging'));
  });

  it('a drop clears the flag', async () => {
    const h = harness(AB, [0], ['0', '1']);
    h.doc.dispatchEvent(new FakeEvent('dragstart'));
    await tick();
    h.doc.dispatchEvent(new FakeEvent('drop'));
    assert.ok(!h.bar().hasAttribute('data-dragging'));
  });

  it('a pointerup clears a stale flag', async () => {
    const h = harness(AB, [0], ['0', '1']);
    h.doc.dispatchEvent(new FakeEvent('dragstart'));
    await tick();
    assert.ok(h.bar().hasAttribute('data-dragging'));
    h.doc.dispatchEvent(new FakeEvent('pointerup'));
    assert.ok(!h.bar().hasAttribute('data-dragging'));
  });
});
