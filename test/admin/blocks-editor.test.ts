import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  depthLabel,
  duplicateOverrides,
  insertAllowed,
  isValidMacroName,
  MAX_MACRO_DEPTH,
  mountBlocksPalette,
  type PaletteMacro,
  PRIMITIVE_MACROS,
  primitiveNode
} from '../../src/admin/blocks-editor.ts';
import type { BlockNode } from '../../src/lib/blocks.ts';
import { FakeDocument, type FakeElement, FakeEvent } from './fake-dom.ts';

const depth3Macro: BlockNode = {
  type: 'section',
  children: [
    {
      type: 'row',
      children: [{ type: 'col', children: [{ type: 'text', markdown: 'hi' }] }]
    }
  ]
};

describe('blocks editor', () => {
  it('blocks a 4th container level inside one macro', () => {
    assert.equal(insertAllowed(depth3Macro, 'row'), false);
    assert.equal(insertAllowed(depth3Macro, 'col'), false);
  });

  it('allows leaves and macros at any depth', () => {
    assert.equal(insertAllowed(depth3Macro, 'text'), true);
    assert.equal(insertAllowed(depth3Macro, 'figure'), true);
    assert.equal(insertAllowed(depth3Macro, 'macro'), true);
  });

  it('allows containers below depth 3', () => {
    const shallow: BlockNode = { type: 'section', children: [{ type: 'text' }] };
    assert.equal(insertAllowed(shallow, 'row'), true);
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
    assert.equal(items.length, PRIMITIVE_MACROS.length + 1);
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
    assert.equal(dock.querySelectorAll('.rkr-blocks-palette-item').length, PRIMITIVE_MACROS.length);
    assert.deepEqual(
      dock.querySelectorAll('.rkr-palette-group-title').map((t) => t.textContent),
      ['Basics', 'Media', 'Layout']
    );
  });

  it('double-click and Enter insert like click', () => {
    const inserted: string[] = [];
    const dock = mount([{ name: 'hero', label: 'Hero' }], (name) => {
      inserted.push(name);
    });
    const hero = dock.querySelectorAll('.rkr-blocks-palette-item').pop() as FakeElement;
    hero.dispatchEvent(new FakeEvent('dblclick'));
    hero.dispatchEvent(Object.assign(new FakeEvent('keydown'), { key: 'Enter' }));
    hero.dispatchEvent(Object.assign(new FakeEvent('keydown'), { key: ' ' }));
    assert.deepEqual(inserted, ['hero', 'hero']);
  });

  it('builds primitive nodes from palette names', () => {
    assert.equal(primitiveNode('primitive:text').type, 'text');
    assert.equal((primitiveNode('primitive:row') as { children: unknown[] }).children.length, 0);
    assert.throws(() => primitiveNode('hero'), /unknown primitive/);
  });
});
