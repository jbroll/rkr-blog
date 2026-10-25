import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { dropPosition } from '../../src/admin/unified-insert.ts';

const rect = { top: 100, height: 100 };

describe('dropPosition', () => {
  it('leaf drop splits at half', () => {
    assert.equal(dropPosition(140, rect, false), 'before');
    assert.equal(dropPosition(160, rect, false), 'after');
    assert.equal(dropPosition(150, rect, false), 'after');
  });

  it('container drop keeps thirds', () => {
    assert.equal(dropPosition(120, rect, true), 'before');
    assert.equal(dropPosition(150, rect, true), 'inside');
    assert.equal(dropPosition(180, rect, true), 'after');
  });
});
