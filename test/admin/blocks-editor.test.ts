import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  depthLabel,
  duplicateOverrides,
  insertAllowed,
  isLayoutPreset,
  isValidMacroName,
  MAX_MACRO_DEPTH,
  mountBlocksPalette,
  PALETTE_PRIMITIVES,
  type PaletteMacro,
  primitiveNode
} from '../../src/admin/blocks-editor.ts';
import type { BlockNode } from '../../src/lib/blocks.ts';
import { FakeDocument, type FakeElement, FakeEvent } from './fake-dom.ts';

const depth3Macro: BlockNode = {
  type: 'grid',
  children: [
    {
      type: 'grid',
      children: [{ type: 'grid', children: [{ type: 'text', markdown: 'hi' }] }]
    }
  ]
};

describe('blocks editor', () => {
  it('blocks a 4th container level inside one macro', () => {
    assert.equal(insertAllowed(depth3Macro, 'primitive:row'), false);
    assert.equal(insertAllowed(depth3Macro, 'primitive:col'), false);
    assert.equal(insertAllowed(depth3Macro, 'primitive:section'), false);
  });

  it('allows leaves and macros at any depth', () => {
    assert.equal(insertAllowed(depth3Macro, 'primitive:text'), true);
    assert.equal(insertAllowed(depth3Macro, 'primitive:figure'), true);
    assert.equal(insertAllowed(depth3Macro, 'hero'), true);
    assert.equal(insertAllowed(depth3Macro, 'row'), true, 'node type names are not palette names');
  });

  it('allows containers below depth 3', () => {
    const shallow: BlockNode = { type: 'grid', children: [{ type: 'text' }] };
    assert.equal(insertAllowed(shallow, 'primitive:row'), true);
  });

  it('duplicate copies overrides only', () => {
    assert.deepEqual(duplicateOverrides({ title: 'X' }), { title: 'X' });
    const src = { items: [{ a: 1 }] };
    const copy = duplicateOverrides(src);
    assert.deepEqual(copy, src);
    assert.notEqual(copy.items, src.items);
  });

  it('labels depth for the meter', () => {
    assert.equal(depthLabel(2), 'Level 2 of 3');
    assert.equal(depthLabel(MAX_MACRO_DEPTH), `Level ${MAX_MACRO_DEPTH} of ${MAX_MACRO_DEPTH}`);
  });

  it('validates macro names', () => {
    assert.equal(isValidMacroName('hero-band'), true);
    assert.equal(isValidMacroName('Bad Name'), false);
  });

  function mount(macros: PaletteMacro[], onInsert: (name: string) => void) {
    const doc = new FakeDocument();
    const dock = doc.createElement('aside');
    mountBlocksPalette(dock as unknown as Element, macros, onInsert);
    return dock;
  }

  it('mounts grouped palette rows and handles insert', () => {
    let inserted: string | undefined;
    const dock = mount([{ name: 'hero', label: 'Hero', description: 'Opening band' }], (name) => {
      inserted = name;
    });
    assert.equal(dock.querySelector('.rkr-palette-title')?.textContent, 'Add block');
    assert.deepEqual(
      dock.querySelectorAll('.rkr-palette-group-title').map((t) => t.textContent),
      ['Basics', 'Media', 'Layout', 'Sections']
    );
    const items = dock.querySelectorAll('.rkr-blocks-palette-item');
    assert.equal(items.length, PALETTE_PRIMITIVES.length + 1);
    const hero = items[items.length - 1];
    assert.equal(hero?.querySelector('.rkr-palette-label')?.textContent, 'Hero');
    assert.equal(hero?.querySelector('.rkr-palette-desc')?.textContent, 'Opening band');
    hero?.click();
    assert.equal(inserted, 'hero');
  });

  it('Media offers Image and Video, and Video inserts an empty video node', () => {
    const dock = mount([], () => {});
    const media = dock.querySelectorAll('.rkr-palette-group')[1];
    assert.deepEqual(
      media?.querySelectorAll('.rkr-palette-label').map((l) => l.textContent),
      ['Image', 'Video']
    );
    assert.deepEqual(primitiveNode('primitive:video'), { type: 'video', slots: { ids: '' } });
  });

  it('shows primitives when no macros are configured', () => {
    const dock = mount([], () => {});
    assert.equal(
      dock.querySelectorAll('.rkr-blocks-palette-item').length,
      PALETTE_PRIMITIVES.length
    );
    assert.deepEqual(
      dock.querySelectorAll('.rkr-palette-group-title').map((t) => t.textContent),
      ['Basics', 'Media', 'Layout']
    );
  });

  it('inserts only on click, since a button turns Enter into a click itself', () => {
    const inserted: string[] = [];
    const dock = mount([{ name: 'hero', label: 'Hero' }], (name) => {
      inserted.push(name);
    });
    const hero = dock.querySelectorAll('.rkr-blocks-palette-item').pop() as FakeElement;
    hero.dispatchEvent(new FakeEvent('dblclick'));
    hero.dispatchEvent(Object.assign(new FakeEvent('keydown'), { key: 'Enter' }));
    assert.deepEqual(inserted, []);
    hero.click();
    assert.deepEqual(inserted, ['hero']);
  });

  it('builds primitive nodes from palette names', () => {
    assert.equal(primitiveNode('primitive:text').type, 'text');
    assert.throws(() => primitiveNode('hero'), /unknown primitive/);
  });

  it('layout presets insert grids', () => {
    assert.deepEqual(primitiveNode('primitive:row'), {
      type: 'grid',
      slots: { cols: 2 },
      children: []
    });
    assert.deepEqual(primitiveNode('primitive:col'), {
      type: 'grid',
      slots: { cols: 1 },
      children: []
    });
    assert.deepEqual(primitiveNode('primitive:section'), {
      type: 'grid',
      slots: { cols: 1, band: true, theme: 'light', edge: 'straight' },
      children: []
    });
    assert.equal(isLayoutPreset('primitive:section'), true);
    assert.equal(isLayoutPreset('primitive:figure'), false);
    assert.equal(isLayoutPreset('grid'), false);
  });

  it('keeps the palette labels Row, Column and Section', () => {
    const dock = mount([], () => {});
    const layout = dock.querySelectorAll('.rkr-palette-group')[2];
    assert.deepEqual(
      layout?.querySelectorAll('.rkr-palette-label').map((l) => l.textContent),
      ['Section', 'Row', 'Column']
    );
  });
});
