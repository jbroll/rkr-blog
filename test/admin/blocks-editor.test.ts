import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  depthLabel,
  duplicateOverrides,
  insertAllowed,
  isValidMacroName,
} from '../../src/admin/blocks-editor.ts';
import type { BlockNode } from '../../src/lib/blocks.ts';

const depth3Macro: BlockNode = {
  type: 'section',
  children: [
    {
      type: 'row',
      children: [{ type: 'col', children: [{ type: 'text', markdown: 'hi' }] }],
    },
  ],
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
  });

  it('validates macro names', () => {
    assert.equal(isValidMacroName('hero-band'), true);
    assert.equal(isValidMacroName('Bad Name'), false);
  });
});
