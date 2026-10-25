import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Path } from '../../src/admin/blocks-page-editor.ts';
import { mountBlockActions } from '../../src/admin/unified-block-actions.ts';
import type { BlockNode, BlockTree } from '../../src/lib/blocks.ts';

import { FakeDocument, type FakeElement, FakeEvent, marker, para } from './fake-dom.ts';

const text = (markdown: string): BlockNode => ({ type: 'text', markdown });

interface Harness {
  doc: FakeDocument;
  body: FakeElement;
  bar: () => FakeElement;
  applied: { tree: BlockTree; select?: Path }[];
  state: { tree: BlockTree; selected: Path | null; editing: boolean; configured: Path[] };
  actions: { refresh(): void };
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
  const state = { tree, selected, editing: true, configured: [] as Path[] };
  const applied: Harness['applied'] = [];
  const actions = mountBlockActions({
    body: body as unknown as Element,
    getTree: () => state.tree,
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
    const tree: BlockTree = { version: 1, body: [{ type: 'row', children: [text('x')] }] };
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
