# Arbitrary Rotation Op Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing `rotate` op to accept any angle, auto-cropping to the largest inscribed axis-aligned rectangle, while keeping 90°/180°/270° on the existing lossless path.

**Architecture:** A new pure module `src/lib/rotation.ts` exports the inscribed-rect formula and is imported by `ops-validation.ts` (dimension tracking), `canvas.ts` (client preview), and `render.ts` (server execution). The `rotate` op schema is unchanged; only the validation rule, canvas handler, and sharp pipeline handler are updated.

**Tech Stack:** TypeScript, Canvas 2D API (client), sharp/libvips (server), Node test runner + assert/strict

---

## File Map

| File | Change |
|------|--------|
| `src/lib/rotation.ts` | **Create** — pure `inscribedRect(W, H, angleDeg)` formula |
| `test/lib/rotation.test.ts` | **Create** — unit tests for the formula |
| `src/lib/ops-validation.ts` | **Modify** — remove 90°-multiple check; use `inscribedRect` for running dims |
| `src/lib/image-edit-ops.ts` | **Modify** — `describeOp` shows negative angles for > 180° |
| `src/admin/canvas.ts` | **Modify** — `applyRotate` arbitrary-angle branch |
| `src/lib/render.ts` | **Modify** — `applyOp` rotate case + dim tracking in `renderDerivative` |
| `src/templates/admin.ts` | **Modify** — add tilt slider + number input + button HTML |
| `src/admin/image-edit-panel.ts` | **Modify** — wire tilt controls; add to `ImageEditPanelDeps` |
| `src/admin/main.ts` | **Modify** — query and pass tilt DOM elements |

---

## Task 1: Create `src/lib/rotation.ts`

**Files:**
- Create: `src/lib/rotation.ts`
- Test: `test/lib/rotation.test.ts`

### The formula

Two-regime algorithm. For a W×H image rotated by `angleDeg` about its center, `inscribedRect` returns the largest axis-aligned rectangle centered at the same center that fits entirely within the rotated image.

Normalize the angle to `[0°, 90°)` by symmetry (the inscribed rect shape is the same in all four quadrants and mirrors at 45°).

**Regime 1 — fully constrained** (inscribed rect corners touch all 4 sides):  
Active when `W·cos > H·sin` AND `H·cos > W·sin`.
```
cos2 = cos²θ − sin²θ
rw   = (W·cosθ − H·sinθ) / cos2
rh   = (H·cosθ − W·sinθ) / cos2
```

**Regime 2 — half constrained** (one pair of sides is binding):  
Active for larger angles. For landscape (W ≥ H), the H sides are binding:
```
rw = H / (2·sinθ)
rh = H / (2·cosθ)
```
For portrait (H > W), the W sides are binding:
```
rw = W / (2·cosθ)
rh = W / (2·sinθ)
```

Position within the sharp bounding box (bw = W·cos + H·sin, bh = W·sin + H·cos):
```
left = floor((bw − iw) / 2)
top  = floor((bh − ih) / 2)
```

- [ ] **Step 1: Write the failing test**

```typescript
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
  assert.ok(r.top > 0 && r.top < 100, `top=${r.top}`);
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
  for (const [W, H, a] of [[1920, 1080, 15], [800, 600, 30], [500, 500, 44]]) {
    const { iw, ih, left, top } = inscribedRect(W as number, H as number, a as number);
    const θ = ((a as number) * Math.PI) / 180;
    const bw = (W as number) * Math.cos(θ) + (H as number) * Math.sin(θ);
    const bh = (W as number) * Math.sin(θ) + (H as number) * Math.cos(θ);
    assert.ok(left + iw <= Math.ceil(bw), `${W}×${H}@${a}°: left+iw=${left+iw} > bw=${bw}`);
    assert.ok(top + ih <= Math.ceil(bh), `${W}×${H}@${a}°: top+ih=${top+ih} > bh=${bh}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test test/lib/rotation.test.ts
```
Expected: FAIL — `inscribedRect is not a function`

- [ ] **Step 3: Implement `src/lib/rotation.ts`**

```typescript
// src/lib/rotation.ts

/**
 * For a W×H image rotated by `angleDeg` degrees about its center,
 * returns the largest axis-aligned rectangle centered at the same
 * center that fits entirely within the rotated image.
 *
 * Two regimes:
 *   Fully constrained (small angles): corners touch all 4 sides.
 *   Half constrained (larger angles): corners touch only the binding pair.
 *
 * All returned values are floored to integers. `left` and `top` are the
 * offsets within the sharp bounding box (W·cosθ + H·sinθ) × (W·sinθ + H·cosθ).
 */
export function inscribedRect(
  W: number,
  H: number,
  angleDeg: number
): { iw: number; ih: number; left: number; top: number } {
  // Normalise to [0°, 90°) — geometry is symmetric across quadrants.
  let a = ((angleDeg % 360) + 360) % 360;
  if (a > 180) a = 360 - a;
  if (a > 90) a = 180 - a;

  if (a === 0) return { iw: W, ih: H, left: 0, top: 0 };

  const θ = (a * Math.PI) / 180;
  const c = Math.cos(θ);
  const s = Math.sin(θ);

  let rw: number;
  let rh: number;

  if (W * c > H * s && H * c > W * s) {
    // Fully constrained: all 4 sides binding.
    const cos2 = c * c - s * s;
    rw = (W * c - H * s) / cos2;
    rh = (H * c - W * s) / cos2;
  } else if (W >= H) {
    // Half constrained, landscape: H sides binding.
    rw = H / (2 * s);
    rh = H / (2 * c);
  } else {
    // Half constrained, portrait: W sides binding.
    rw = W / (2 * c);
    rh = W / (2 * s);
  }

  const iw = Math.max(1, Math.floor(rw));
  const ih = Math.max(1, Math.floor(rh));

  const bw = W * c + H * s;
  const bh = W * s + H * c;

  const left = Math.max(0, Math.floor((bw - iw) / 2));
  const top = Math.max(0, Math.floor((bh - ih) / 2));

  return { iw, ih, left, top };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test test/lib/rotation.test.ts
```
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add src/lib/rotation.ts test/lib/rotation.test.ts
git commit -m "feat: add inscribedRect formula for arbitrary rotation"
```

---

## Task 2: Update `ops-validation.ts`

Remove the 90°-multiple check and track running dims using `inscribedRect` for non-orthogonal angles.

**Files:**
- Modify: `src/lib/ops-validation.ts:110-124`
- Test: `test/lib/ops-validation.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/lib/ops-validation.test.ts`:

```typescript
import { validateOps } from '../../src/lib/ops-validation.ts';

test('arbitrary rotate 15° is accepted', () => {
  const r = validateOps([{ type: 'rotate', degrees: 15 }], { width: 1920, height: 1080 });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.ops, [{ type: 'rotate', degrees: 15 }]);
});

test('arbitrary rotate normalises negative to [0,360)', () => {
  const r = validateOps([{ type: 'rotate', degrees: -15 }], { width: 1920, height: 1080 });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal((r.ops[0] as { degrees: number }).degrees, 345);
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
  // 1920×1080 rotated 15° → inscribed ≈ 1787×927. A crop of 1900×900 should fail.
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
  // 1920×1080 rotated 15° → inscribed ≈ 1787×927. Crop 500×400 is fine.
  const r = validateOps(
    [
      { type: 'rotate', degrees: 15 },
      { type: 'crop', x: 0, y: 0, w: 500, h: 400 }
    ],
    { width: 1920, height: 1080 }
  );
  assert.equal(r.ok, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test test/lib/ops-validation.test.ts 2>&1 | grep -E "FAIL|pass|fail" | head -20
```
Expected: the new tests fail (arbitrary rotate rejected with "multiple of 90" error)

- [ ] **Step 3: Update the rotate branch in `src/lib/ops-validation.ts`**

Replace lines 110–124 (the `rotate` branch):

```typescript
    } else if (type === 'rotate') {
      const degrees = Number(op.degrees ?? 0);
      if (!Number.isFinite(degrees)) {
        return { ok: false, error: `ops[${i}] rotate degrees must be a finite number` };
      }
      const norm = ((degrees % 360) + 360) % 360;
      if (norm === 0) continue; // no-op; drop silently
      out.push({ type: 'rotate', degrees: norm });
      if (norm === 90 || norm === 270) {
        [curW, curH] = [curH, curW];
      } else if (norm !== 180) {
        const { iw, ih } = inscribedRect(curW, curH, norm);
        curW = iw;
        curH = ih;
      }
    }
```

Also add the import at the top of the file:

```typescript
import { inscribedRect } from './rotation.ts';
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test test/lib/ops-validation.test.ts
```
Expected: all pass (including existing tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/ops-validation.ts test/lib/ops-validation.test.ts
git commit -m "feat: allow arbitrary rotate degrees in ops-validation"
```

---

## Task 3: Update `describeOp` in `image-edit-ops.ts`

**Files:**
- Modify: `src/lib/image-edit-ops.ts:91-93`
- Test: `test/lib/image-edit-ops.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/lib/image-edit-ops.test.ts`:

```typescript
import { describeOp } from '../../src/lib/image-edit-ops.ts';

test('describeOp rotate: positive angle shown as-is', () => {
  assert.equal(describeOp({ type: 'rotate', degrees: 15 }), 'rotate 15°');
});

test('describeOp rotate: 90 shown as 90', () => {
  assert.equal(describeOp({ type: 'rotate', degrees: 90 }), 'rotate 90°');
});

test('describeOp rotate: > 180 shown as negative', () => {
  assert.equal(describeOp({ type: 'rotate', degrees: 345 }), 'rotate -15°');
});

test('describeOp rotate: 180 shown as 180', () => {
  assert.equal(describeOp({ type: 'rotate', degrees: 180 }), 'rotate 180°');
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

```bash
node --test test/lib/image-edit-ops.test.ts
```
Expected: the `345 → -15°` test fails (current code returns "rotate 345°")

- [ ] **Step 3: Update `describeOp` rotate case**

Replace the `case 'rotate':` branch in `src/lib/image-edit-ops.ts`:

```typescript
    case 'rotate': {
      const d = Number(op.degrees ?? 0);
      const display = d > 180 ? d - 360 : d;
      return `rotate ${display}°`;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test test/lib/image-edit-ops.test.ts
```
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add src/lib/image-edit-ops.ts test/lib/image-edit-ops.test.ts
git commit -m "feat: describeOp shows negative angle for rotate > 180°"
```

---

## Task 4: Update `canvas.ts` client-side `applyRotate`

Canvas.ts is DOM-dependent — no unit tests. The existing orthogonal path is preserved unchanged. The new branch uses `inscribedRect` for sizing and bicubic drawing.

**Files:**
- Modify: `src/admin/canvas.ts:139-154`

- [ ] **Step 1: Add the import**

At the top of `src/admin/canvas.ts`, alongside the existing imports from `canvas-math.ts`, add:

```typescript
import { inscribedRect } from '../lib/rotation.ts';
```

- [ ] **Step 2: Replace `applyRotate`**

Replace the entire `applyRotate` function (lines 139–154):

```typescript
function applyRotate(input: HTMLCanvasElement, op: SidecarOp): HTMLCanvasElement {
  const degrees = Number(op.degrees ?? 0);
  if (!Number.isFinite(degrees)) return input;
  const norm = ((degrees % 360) + 360) % 360;
  if (norm === 0) return input;

  if (norm === 90 || norm === 180 || norm === 270) {
    // Lossless orthogonal path — unchanged.
    const swap = norm === 90 || norm === 270;
    const out = document.createElement('canvas');
    out.width = swap ? input.height : input.width;
    out.height = swap ? input.width : input.height;
    const ctx = out.getContext('2d');
    if (!ctx) throw new Error('canvas: 2d context unavailable');
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate((norm * Math.PI) / 180);
    ctx.drawImage(input, -input.width / 2, -input.height / 2);
    return out;
  }

  // Arbitrary angle: bicubic rotate into a canvas sized to the inscribed rect.
  // The output canvas is already iw×ih, centered on the same center as the
  // input — no separate extract step needed.
  const { iw, ih } = inscribedRect(input.width, input.height, norm);
  const out = document.createElement('canvas');
  out.width = iw;
  out.height = ih;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('canvas: 2d context unavailable');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(iw / 2, ih / 2);
  ctx.rotate((norm * Math.PI) / 180);
  ctx.drawImage(input, -input.width / 2, -input.height / 2);
  return out;
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/admin/canvas.ts
git commit -m "feat: canvas applyRotate handles arbitrary angles"
```

---

## Task 5: Update `render.ts` server-side execution

The `applyOp` rotate case needs the current image dimensions to compute the inscribed rect. Add an optional `dims` parameter and track running dims in `renderDerivative`.

**Files:**
- Modify: `src/lib/render.ts:200-232`
- Test: `test/lib/render.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/lib/render.test.ts`. The file already has `freshSiteRoot(t)`, `makeJpeg()`, and `ingest()` helpers — use them directly:

```typescript
test('renderDerivative: arbitrary rotate 15° crops to inscribed rect dimensions', async (t) => {
  const root = freshSiteRoot(t);
  // 400×200 source. inscribedRect(400, 200, 15) fully constrained:
  // rw=(400·cos15−200·sin15)/cos30 ≈ (386.4−51.8)/0.866 ≈ 386, rh≈(200·cos15−400·sin15)/cos30 ≈ 86
  const { id } = await ingest(root, await makeJpeg({ width: 400, height: 200 }));
  const result = await renderDerivative({
    siteRoot: root,
    originalId: id,
    ops: [{ type: 'rotate', degrees: 15 }],
    variant: {},
    output: { format: 'png' }
  });
  const meta = await sharp(result.path).metadata();
  assert.ok((meta.width ?? 0) > 360 && (meta.width ?? 0) < 400, `width=${meta.width}`);
  assert.ok((meta.height ?? 0) > 70  && (meta.height ?? 0) < 100, `height=${meta.height}`);
});

test('renderDerivative: arbitrary rotate 40° on landscape uses half-constrained formula', async (t) => {
  const root = freshSiteRoot(t);
  // 400×200 at 40°: half-constrained (H-sides binding).
  // rw=H/(2·sin40°)=200/(2·0.643)≈155, rh=H/(2·cos40°)=200/(2·0.766)≈130
  const { id } = await ingest(root, await makeJpeg({ width: 400, height: 200 }));
  const result = await renderDerivative({
    siteRoot: root,
    originalId: id,
    ops: [{ type: 'rotate', degrees: 40 }],
    variant: {},
    output: { format: 'png' }
  });
  const meta = await sharp(result.path).metadata();
  assert.ok((meta.width ?? 0) > 140 && (meta.width ?? 0) <= 155, `width=${meta.width}`);
  assert.ok((meta.height ?? 0) > 120 && (meta.height ?? 0) <= 130, `height=${meta.height}`);
});
```

- [ ] **Step 2: Run the new test to verify it fails**

```bash
node --test test/lib/render.test.ts 2>&1 | grep -E "arb-rotate|FAIL" | head -5
```
Expected: FAIL — output dimensions equal full bounding box (sharp.rotate expands without extract)

- [ ] **Step 3: Add `inscribedRect` import to `render.ts`**

```typescript
import { inscribedRect } from './rotation.ts';
```

- [ ] **Step 4: Update `applyOp` signature and rotate case**

Change the `applyOp` signature and rotate case:

```typescript
export function applyOp(
  p: sharp.Sharp,
  op: Op,
  dims: { w: number; h: number } = { w: 0, h: 0 }
): sharp.Sharp {
  switch (op.type) {
    case 'crop':
      return p.extract({ left: op.x, top: op.y, width: op.w, height: op.h });
    case 'resample':
      return p.resize({
        width: op.w,
        height: op.h,
        fit: op.fit ?? 'inside',
        withoutEnlargement: true
      });
    case 'rotate': {
      const norm = (((op.degrees ?? 0) % 360) + 360) % 360;
      if (norm === 0) return p;
      if (norm === 90 || norm === 180 || norm === 270) {
        return p.rotate(norm);
      }
      // Arbitrary angle: expand canvas then extract inscribed rect.
      const { iw, ih, left, top } = inscribedRect(dims.w, dims.h, norm);
      return p
        .rotate(norm, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .extract({ left, top, width: iw, height: ih });
    }
    case 'flip':
      return op.axis === 'horizontal' ? p.flop() : p.flip();
    case 'perspective':
      throw new Error(
        'renderDerivative: perspective op requires a bake (run Save edits in the editor)'
      );
    default: {
      const exhaustive: never = op;
      throw new Error(`renderDerivative: unknown op type ${(exhaustive as Op).type}`);
    }
  }
}
```

- [ ] **Step 5: Add `nextDims` helper and update the ops loop in `renderDerivative`**

Add this helper function near the bottom of `render.ts` (before `applyVariant`):

```typescript
function nextDims(op: Op, w: number, h: number): { w: number; h: number } {
  switch (op.type) {
    case 'crop':
      return { w: op.w, h: op.h };
    case 'rotate': {
      const norm = (((op.degrees ?? 0) % 360) + 360) % 360;
      if (norm === 90 || norm === 270) return { w: h, h: w };
      if (norm === 0 || norm === 180) return { w, h };
      const { iw, ih } = inscribedRect(w, h, norm);
      return { w: iw, h: ih };
    }
    case 'flip':
      return { w, h };
    case 'resample': {
      if (op.w !== undefined && op.h !== undefined) return { w: op.w, h: op.h };
      if (op.w !== undefined) return { w: op.w, h: h > 0 ? Math.floor((h * op.w) / w) : op.w };
      if (op.h !== undefined) return { w: w > 0 ? Math.floor((w * op.h) / h) : op.h, h: op.h };
      return { w, h };
    }
    case 'perspective':
      return { w, h };
  }
}
```

Update the ops loop in `renderDerivative` (the `!useBake` branch, around line 172):

```typescript
  if (!useBake) {
    let curW = info.width ?? 0;
    let curH = info.height ?? 0;
    for (const op of ops) {
      pipeline = applyOp(pipeline, op, { w: curW, h: curH });
      ({ w: curW, h: curH } = nextDims(op, curW, curH));
    }
  }
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
node --test test/lib/render.test.ts
```
Expected: all pass including the new arbitrary-rotate test

- [ ] **Step 7: Commit**

```bash
git add src/lib/render.ts test/lib/render.test.ts
git commit -m "feat: render.ts applies arbitrary rotation via sharp + inscribed rect"
```

---

## Task 6: Add tilt UI

Wire a slider + number input into the image-edit panel.

**Files:**
- Modify: `src/templates/admin.ts:169-173`
- Modify: `src/admin/image-edit-panel.ts`
- Modify: `src/admin/main.ts`

- [ ] **Step 1: Add HTML to the template**

In `src/templates/admin.ts`, after the existing resample block (after line 173):

```typescript
      <label for="rkr-image-tilt-input">Tilt (°)</label>
      <span class="rkr-image-actions">
        <input id="rkr-image-tilt-slider" type="range" min="-45" max="45" step="0.1" value="0" style="width:8em"/>
        <input id="rkr-image-tilt-input" type="number" min="-45" max="45" step="0.1" value="0" style="width:4em"/>
        <button type="button" id="rkr-image-tilt-btn">Apply</button>
      </span>
```

- [ ] **Step 2: Add `tiltSlider` and `tiltInput` to `ImageEditPanelDeps` in `image-edit-panel.ts`**

In `src/admin/image-edit-panel.ts`, add to `ImageEditPanelButtons`:

```typescript
  tilt: HTMLButtonElement;
```

Add to `ImageEditPanelDeps` (alongside `resampleInput`):

```typescript
  tiltSlider: HTMLInputElement;
  tiltInput: HTMLInputElement;
```

- [ ] **Step 3: Wire the tilt handlers in `image-edit-panel.ts`**

In the `mount` function, destructure `tiltSlider` and `tiltInput` from `deps`. Add handlers after the existing `buttons.resample` handler:

```typescript
  tiltSlider.addEventListener('input', () => {
    tiltInput.value = tiltSlider.value;
  });
  tiltInput.addEventListener('input', () => {
    const v = Math.max(-45, Math.min(45, Number(tiltInput.value) || 0));
    tiltSlider.value = String(v);
  });
  buttons.tilt.addEventListener('click', () => {
    const deg = Math.max(-45, Math.min(45, Number(tiltInput.value) || 0));
    if (deg === 0) return;
    const norm = ((deg % 360) + 360) % 360;
    runEdit('tilt', (ops) => [...ops, { type: 'rotate', degrees: norm }]);
  });
```

- [ ] **Step 4: Wire the DOM elements in `main.ts`**

In `src/admin/main.ts`, after the existing `attrResampleInput`/`attrResampleBtn` queries (around line 75):

```typescript
  const attrTiltSlider = $<HTMLInputElement>('rkr-image-tilt-slider');
  const attrTiltInput = $<HTMLInputElement>('rkr-image-tilt-input');
  const attrTiltBtn = $<HTMLButtonElement>('rkr-image-tilt-btn');
```

Pass them to the panel mount call (find the `mountImageEditPanel` call, around line 415):

```typescript
      tilt: attrTiltBtn,           // inside buttons object
    ...
    tiltSlider: attrTiltSlider,    // top-level dep
    tiltInput: attrTiltInput,
```

- [ ] **Step 5: Verify TypeScript compiles and pre-commit hook passes**

```bash
npx tsc --noEmit && npm test
```
Expected: clean

- [ ] **Step 6: Commit**

```bash
git add src/templates/admin.ts src/admin/image-edit-panel.ts src/admin/main.ts
git commit -m "feat: add tilt slider UI to image editor"
```

---

## Manual Verification Checklist

After all tasks are committed, verify end-to-end in the browser:

- [ ] Open admin, select an image
- [ ] Set tilt slider to ~10°, click Apply — preview updates, op appears in edits list as "rotate 10°"
- [ ] Set tilt slider to -10°, click Apply — edits list shows "rotate -10°"
- [ ] Click Rotate 90° button — still works (lossless path unchanged)
- [ ] Save — bake uploads; published image reflects the rotation
- [ ] Undo tilt op — preview reverts correctly
- [ ] Chain: crop → tilt 10° → verify tilt preview is of the cropped image, not original
