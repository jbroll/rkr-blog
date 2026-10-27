import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  depthLabel,
  duplicateOverrides,
  isValidMacroName,
  mountBlocksPalette,
  PALETTE_PRIMITIVES,
  type PaletteMacro,
  primitiveNode
} from '../../src/admin/blocks-editor.ts';
import { MAX_GRID_LEVELS } from '../../src/lib/grid.ts';
import { FakeDocument, type FakeElement, FakeEvent } from './fake-dom.ts';

describe('blocks editor', () => {
  it('duplicate copies overrides only', () => {
    assert.deepEqual(duplicateOverrides({ title: 'X' }), { title: 'X' });
    const src = { items: [{ a: 1 }] };
    const copy = duplicateOverrides(src);
    assert.deepEqual(copy, src);
    assert.notEqual(copy.items, src.items);
  });

  it('labels depth for the meter', () => {
    assert.equal(depthLabel(2), 'Level 2 of 3');
    assert.equal(depthLabel(MAX_GRID_LEVELS), `Level ${MAX_GRID_LEVELS} of ${MAX_GRID_LEVELS}`);
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

  it('Basics and Media list the small blocks and primitiveNode builds them', () => {
    const dock = mount([], () => {});
    const labels = dock
      .querySelectorAll('.rkr-palette-group')
      .map((g) => g.querySelectorAll('.rkr-palette-label').map((l) => l.textContent));
    assert.deepEqual(labels[0], ['Text', 'Button', 'Marquee', 'Accordion', 'Progress']);
    assert.deepEqual(labels[1], ['Image', 'Video', 'Embed']);
    assert.deepEqual(primitiveNode('primitive:marquee'), { type: 'marquee', slots: { text: '' } });
    assert.deepEqual(primitiveNode('primitive:accordion'), {
      type: 'accordion',
      slots: { items: [] }
    });
    assert.deepEqual(primitiveNode('primitive:progress'), {
      type: 'progress',
      slots: { source: 'site' }
    });
    assert.deepEqual(primitiveNode('primitive:embed'), { type: 'embed', slots: { url: '' } });
  });

  it('Media offers Image and Video, and Video inserts an empty video node', () => {
    const dock = mount([], () => {});
    const media = dock.querySelectorAll('.rkr-palette-group')[1];
    assert.deepEqual(
      media?.querySelectorAll('.rkr-palette-label').map((l) => l.textContent),
      ['Image', 'Video', 'Embed']
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
