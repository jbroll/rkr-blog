// test/lib/rotation.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inscribedRect } from '../../src/lib/rotation.ts';

test('inscribedRect: identity at 0°', () => {
  assert.deepEqual(inscribedRect(1920, 1080, 0), { iw: 1920, ih: 1080, left: 0, top: 0 });
});

test('inscribedRect: small angle — fully constrained, near-full image', () => {
  // 5° on 1920×1080: iw≈1846, ih≈922
  const r = inscribedRect(1920, 1080, 5);
  assert.ok(r.iw > 1800 && r.iw < 1920, `iw=${r.iw} expected ~1846`);
  assert.ok(r.ih > 900 && r.ih < 1080, `ih=${r.ih} expected ~922`);
  assert.ok(r.left > 0 && r.left < 100, `left=${r.left}`);
  assert.ok(r.top > 100 && r.top < 200, `top=${r.top}`);
});

test('inscribedRect: large angle on landscape — half constrained', () => {
  // 40° on 1920×1080: rw=H/(2sinθ)≈840, rh=H/(2cosθ)≈705
  const r = inscribedRect(1920, 1080, 40);
  assert.ok(r.iw > 830 && r.iw <= 840, `iw=${r.iw}`);
  assert.ok(r.ih > 695 && r.ih <= 705, `ih=${r.ih}`);
});

test('inscribedRect: square at 45° — half of diagonal', () => {
  // 100×100 at 45°: iw=ih=floor(100/√2)=70
  const r = inscribedRect(100, 100, 45);
  assert.equal(r.iw, 70);
  assert.equal(r.ih, 70);
});

test('inscribedRect: negative angle same as positive', () => {
  const pos = inscribedRect(1920, 1080, 15);
  const neg = inscribedRect(1920, 1080, -15);
  assert.deepEqual(pos, neg);
});

test('inscribedRect: portrait image', () => {
  // 1080×1920 at 5°: iw≈922, ih≈1846 (symmetric to landscape)
  const r = inscribedRect(1080, 1920, 5);
  assert.ok(r.iw > 900 && r.iw < 1080, `iw=${r.iw}`);
  assert.ok(r.ih > 1800 && r.ih < 1920, `ih=${r.ih}`);
});

test('inscribedRect: 180° treated as identity (no crop)', () => {
  // 180° normalizes to 0° after symmetry reduction
  const r = inscribedRect(1920, 1080, 180);
  assert.equal(r.iw, 1920);
  assert.equal(r.ih, 1080);
});

test('inscribedRect: inscribed rect fits inside bounding box', () => {
  for (const [W, H, a] of [
    [1920, 1080, 15],
    [800, 600, 30],
    [500, 500, 44]
  ]) {
    const { iw, ih, left, top } = inscribedRect(W as number, H as number, a as number);
    const θ = ((a as number) * Math.PI) / 180;
    const c = Math.cos(θ);
    const s = Math.sin(θ);
    const bw = (W as number) * c + (H as number) * s;
    const bh = (W as number) * s + (H as number) * c;
    // Rect must fit within bounding box
    assert.ok(left + iw <= Math.ceil(bw), `${W}×${H}@${a}°: left+iw=${left + iw} > bw=${bw}`);
    assert.ok(top + ih <= Math.ceil(bh), `${W}×${H}@${a}°: top+ih=${top + ih} > bh=${bh}`);
    // All four corners must lie within the rotated image's half-extents
    const hw = iw / 2;
    const hh = ih / 2;
    // Max |x·cos + y·sin| over corners = hw·cos + hh·sin ≤ W/2
    assert.ok(
      hw * c + hh * s <= (W as number) / 2 + 0.5,
      `${W}×${H}@${a}°: rotated-x constraint violated`
    );
    // Max |x·sin + y·cos| over corners = hw·sin + hh·cos ≤ H/2
    assert.ok(
      hw * s + hh * c <= (H as number) / 2 + 0.5,
      `${W}×${H}@${a}°: rotated-y constraint violated`
    );
  }
});
