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

test('arbitrary rotate 15° is accepted', () => {
  const r = validateOps([{ type: 'rotate', degrees: 15 }], { width: 1920, height: 1080 });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.ops, [{ type: 'rotate', degrees: 15 }]);
});

test('arbitrary rotate normalises negative to [0,360)', () => {
  const r = validateOps([{ type: 'rotate', degrees: -15 }], { width: 1920, height: 1080 });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal((r.ops[0] as unknown as { degrees: number }).degrees, 345);
});

test('rotate 0° is dropped silently', () => {
  const r = validateOps([{ type: 'rotate', degrees: 0 }], { width: 1920, height: 1080 });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.ops.length, 0);
});

test('non-finite rotate degrees is rejected', () => {
  const r = validateOps([{ type: 'rotate', degrees: NaN }], { width: 1920, height: 1080 });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /finite/);
});

test('running dims updated after arbitrary rotate, downstream crop bounds-checked', () => {
  // 1920×1080 rotated 15° → inscribed is smaller. A crop of 1900×900 should fail.
  const r = validateOps(
    [
      { type: 'rotate', degrees: 15 },
      { type: 'crop', x: 0, y: 0, w: 1900, h: 900 }
    ],
    { width: 1920, height: 1080 }
  );
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /exceeds/);
});

test('running dims updated after arbitrary rotate, valid downstream crop accepted', () => {
  // 1920×1080 rotated 15° → inscribed is smaller. Crop 500×400 is fine.
  const r = validateOps(
    [
      { type: 'rotate', degrees: 15 },
      { type: 'crop', x: 0, y: 0, w: 500, h: 400 }
    ],
    { width: 1920, height: 1080 }
  );
  assert.equal(r.ok, true);
});
