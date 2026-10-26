import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  expandShorthand,
  GRID_MIN_REM,
  gridLabel,
  gridSlotProblem,
  readGridSlots
} from '../../src/lib/grid.ts';

describe('default.css collapse thresholds', () => {
  it('collapses a widths grid exactly when every column no longer fits at min', () => {
    const css = readFileSync(new URL('../../static/themes/default.css', import.meta.url), 'utf8');
    const gap = Number(/--rkr-gap:\s*([\d.]+)rem/.exec(css)?.[1]);
    const rules = [
      ...css.matchAll(
        /@container \(max-width: ([\d.]+)rem\) \{\s*\.rkr-grid\[data-widths\]\.rkr-collapse-(\d)-(\w+)/g
      )
    ];
    const found = new Map(rules.map((m) => [`${m[2]}-${m[3]}`, Number(m[1])]));
    const expected = new Map<string, number>();
    for (let n = 2; n <= 6; n++) {
      for (const [min, rem] of Object.entries(GRID_MIN_REM)) {
        expected.set(`${n}-${min}`, n * rem + (n - 1) * gap);
      }
    }
    assert.equal(gap, 1.25);
    assert.equal(rules.length, 15);
    assert.deepEqual(found, expected);
  });
});

describe('expandShorthand', () => {
  it('maps section theme and edge to a band grid', () => {
    const out = expandShorthand({
      type: 'section',
      slots: { theme: 'dark', edge: 'wave' },
      children: [{ type: 'text' }]
    });
    assert.deepEqual(out, {
      type: 'grid',
      slots: { cols: 1, band: true, theme: 'dark', edge: 'wave' },
      children: [{ type: 'text' }]
    });
  });

  it('sets row cols to the child count, capped at 6', () => {
    const kids = Array.from({ length: 8 }, () => ({ type: 'text' }));
    assert.equal(
      (expandShorthand({ type: 'row', children: kids }).slots as { cols: number }).cols,
      6
    );
    const two = expandShorthand({ type: 'row', children: kids.slice(0, 2) });
    assert.equal((two.slots as { cols: number }).cols, 2);
    const none = expandShorthand({ type: 'row', children: [] });
    assert.equal((none.slots as { cols: number }).cols, 1);
  });

  it('maps flow blocks and col children to one-column grid children', () => {
    const flow = expandShorthand({ type: 'flow', blocks: [{ type: 'text' }] });
    assert.deepEqual(flow, { type: 'grid', slots: { cols: 1 }, children: [{ type: 'text' }] });
    const col = expandShorthand({ type: 'col', children: [{ type: 'text' }] });
    assert.deepEqual(col, { type: 'grid', slots: { cols: 1 }, children: [{ type: 'text' }] });
  });

  it('leaves other types untouched', () => {
    const leaf = { type: 'text', markdown: 'x' };
    assert.equal(expandShorthand(leaf), leaf);
  });
});

describe('readGridSlots', () => {
  it('clamps cols', () => {
    assert.equal(readGridSlots({ cols: 0 }).cols, 1);
    assert.equal(readGridSlots({ cols: 9 }).cols, 6);
    assert.equal(readGridSlots({ cols: 'x' }).cols, 1);
    assert.equal(readGridSlots(undefined).cols, 1);
  });

  it('ignores widths unless there are exactly cols entries', () => {
    assert.equal(readGridSlots({ cols: 2, widths: '1 1 1' }).widths, null);
    assert.deepEqual(readGridSlots({ cols: 2, widths: '2 1' }).widths, [2, 1]);
    assert.equal(readGridSlots({ cols: 2, widths: '2 x' }).widths, null);
  });

  it('falls back to defaults for unknown min, theme and edge', () => {
    const g = readGridSlots({ min: 'huge', theme: 'Bad Theme', edge: 'zigzag' });
    assert.equal(g.min, 'medium');
    assert.equal(g.theme, 'light');
    assert.equal(g.edge, 'straight');
    assert.equal(g.band, false);
  });
});

describe('gridSlotProblem', () => {
  it('rejects out-of-range and malformed values', () => {
    assert.match(gridSlotProblem({ cols: 7 }) ?? '', /Columns/);
    assert.ok(gridSlotProblem({ cols: 2, widths: '2 x' }));
    assert.ok(gridSlotProblem({ cols: 2, widths: '1 1 1' }));
    assert.ok(gridSlotProblem({ min: 'huge' }));
    assert.ok(gridSlotProblem({ band: 'yes' }));
    assert.ok(gridSlotProblem({ theme: 'Bad Theme' }));
    assert.ok(gridSlotProblem({ edge: 'zigzag' }));
  });

  it('words the widths message for a single column in the singular', () => {
    assert.equal(
      gridSlotProblem({ cols: 1, widths: '1 1' }),
      'Column widths must be one positive number.'
    );
    assert.equal(
      gridSlotProblem({ cols: 3, widths: '1 1' }),
      'Column widths must be 3 positive numbers separated by spaces.'
    );
  });

  it('accepts valid and absent slots', () => {
    assert.equal(gridSlotProblem({ cols: 2, widths: '2 1' }), null);
    assert.equal(
      gridSlotProblem({ cols: 3, min: 'wide', band: true, theme: 'dark', edge: 'wave' }),
      null
    );
    assert.equal(gridSlotProblem(undefined), null);
  });
});

describe('gridLabel', () => {
  it('names band, column and row grids', () => {
    assert.equal(gridLabel({ band: true, cols: 3 }), 'Section');
    assert.equal(gridLabel({ cols: 1 }), 'Column');
    assert.equal(gridLabel({ cols: 3 }), 'Row (3 columns)');
  });
});
