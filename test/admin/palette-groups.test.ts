import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PALETTE_PRIMITIVES, type PaletteMacro } from '../../src/admin/blocks-editor.ts';
import { groupPalette } from '../../src/admin/palette-groups.ts';

describe('groupPalette', () => {
  it('orders Basics, Media, Layout, Sections and keeps item order inside groups', () => {
    const groups = groupPalette([
      ...PALETTE_PRIMITIVES,
      { name: 'hero', label: 'Hero', group: 'Sections', description: 'Opening band' }
    ]);
    assert.deepEqual(
      groups.map((g) => [g.group, g.items.map((i) => i.label)]),
      [
        ['Basics', ['Text', 'Button', 'Marquee', 'Accordion', 'Progress']],
        ['Media', ['Image', 'Video', 'Embed']],
        ['Layout', ['Section', 'Row', 'Column']],
        ['Sections', ['Hero']]
      ]
    );
  });

  it('puts macros without a group under Sections and drops empty groups', () => {
    const entries: PaletteMacro[] = [{ name: 'hero', label: 'Hero' }];
    const groups = groupPalette(entries);
    assert.deepEqual(
      groups.map((g) => g.group),
      ['Sections']
    );
  });

  it('every primitive has a group and description', () => {
    for (const p of PALETTE_PRIMITIVES) {
      assert.ok(p.group, p.name);
      assert.ok(p.description, p.name);
    }
  });
});
