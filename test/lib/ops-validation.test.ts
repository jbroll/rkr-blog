import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateOps } from '../../src/lib/ops-validation.ts';

test('perspective op whose output area exceeds the pixel limit is rejected', () => {
  const corners = [
    [0, 0],
    [99999, 0],
    [99999, 99999],
    [0, 99999]
  ];
  const r = validateOps([{ type: 'perspective', corners }], { width: 100000, height: 100000 });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /perspective output .* exceeds/);
});

test('perspective op with a sane output area still validates', () => {
  const corners = [
    [0, 0],
    [800, 10],
    [790, 600],
    [5, 590]
  ];
  const r = validateOps([{ type: 'perspective', corners }], { width: 1000, height: 1000 });
  assert.equal(r.ok, true);
});

// Boundary: S=7071 → area=49,999,041 ≤ 50,000,000 (strict >, must PASS)
test('perspective boundary: 7071x7071 square output is exactly under the area limit', () => {
  const S = 7071;
  const corners = [
    [0, 0],
    [S, 0],
    [S, S],
    [0, S]
  ];
  const r = validateOps([{ type: 'perspective', corners }], { width: 8000, height: 8000 });
  assert.equal(r.ok, true);
});

// Boundary: S=7072 → area=50,013,184 > 50,000,000 (must FAIL)
test('perspective boundary: 7072x7072 square output exceeds the area limit', () => {
  const S = 7072;
  const corners = [
    [0, 0],
    [S, 0],
    [S, S],
    [0, S]
  ];
  const r = validateOps([{ type: 'perspective', corners }], { width: 8000, height: 8000 });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /exceeds/);
});
