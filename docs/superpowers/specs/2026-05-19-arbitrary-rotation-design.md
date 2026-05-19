# Arbitrary Rotation Op

**Date:** 2026-05-19  
**Status:** Draft

## Summary

Extend the existing `rotate` op to accept any angle, not just 90° multiples. Non-orthogonal rotations apply a Lanczos resample (via sharp on the server) and auto-crop to the largest inscribed axis-aligned rectangle, producing a clean rectangular output with no empty corners. 90°/180°/270° remain on the existing lossless path.

## Op Schema

No schema change. The `rotate` op already accepts `{ type: 'rotate', degrees: number }`. What changes is the validation rule.

## Validation (`ops-validation.ts`)

- **Remove** the 90°-multiple check.
- **Keep** normalization to `[0, 360)` and silent drop of `0°`.
- **Running dimensions:** after a non-orthogonal rotation, apply the inscribed-rect formula to compute the new `{w, h}` for bounds-checking downstream `crop` ops. For 90°/270° keep the existing dimension-swap logic; for 180° dimensions are unchanged.

## Inscribed Rectangle Formula

For a W×H image rotated by angle θ (normalized to `[0°, 90°]` by symmetry), the largest axis-aligned rectangle centered at the same center that fits entirely inside the rotated image:

```
c = cos(θ_rad),  s = sin(θ_rad)

iw = (W·c − H·s) / cos(2θ)
ih = (H·c − W·s) / cos(2θ)
```

This formula is valid for all practical photo aspect ratios and straightening angles. The inscribed rect is centered at the rotated image's center; its top-left offset within the rotated bounding box is:

```
left = (boundingW − iw) / 2
top  = (boundingH − ih) / 2
```

where `boundingW = W·c + H·s` and `boundingH = W·s + H·c`.

This formula must be **identical on client and server** — implemented once as `src/lib/rotation.ts` (a pure, side-effect-free module) and imported by both `canvas.ts` and `render.ts`.

## Execution Paths

### 90° / 180° / 270°
Unchanged. Lossless on both client (existing canvas rotation) and server (libvips special-case in sharp).

### Arbitrary angles (client — canvas.ts `applyOne`)

1. Compute inscribed rect `{iw, ih, left, top}` from source dimensions + angle.
2. Create output canvas sized `iw × ih`.
3. Set `ctx.imageSmoothingQuality = 'high'` (bicubic).
4. `ctx.translate(iw/2, ih/2)` → `ctx.rotate(θ_rad)` → `ctx.translate(-W/2, -H/2)` → `ctx.drawImage(source)`.
5. The canvas is already cropped to `iw × ih` by construction — no separate extract step needed.

The canvas render is the **preview only**. The bake (uploaded on save) is the source of truth for published variants, same as all other ops.

### Arbitrary angles (server — render.ts)

1. Compute inscribed rect `{iw, ih, left, top}` from source dimensions + angle.
2. `sharp(input).rotate(degrees, { background: { r:0, g:0, b:0, alpha:0 } }).extract({ left, top, width: iw, height: ih })`.
3. Sharp's `rotate` expands the bounding box; `extract` crops to the inscribed rect.
4. Sharp uses Lanczos resampling from the lossless source — highest possible fidelity.

If a bake exists (uploaded by client on save), the server uses the bake and skips op execution, consistent with existing behavior.

## `describeOp` (`image-edit-ops.ts`)

Display angles > 180° as negative for readability:

```
degrees > 180 ? `Rotate ${degrees - 360}°` : `Rotate ${degrees}°`
```

e.g. `345° → "Rotate -15°"`, `90° → "Rotate 90°"`.

## UI

- Existing 90° CW/CCW buttons unchanged — emit `{ type: 'rotate', degrees: 90 }` / `270`.
- Add: range slider `[-45, 45]` + numeric input. Emits `{ type: 'rotate', degrees: normalizedAngle }` where `normalizedAngle` is converted to `[0, 360)` before storage (e.g. `-15° → 345°`).

## MAX_OPS

Arbitrary rotation counts as one op toward the existing limit of 8. No change.

## Fidelity Properties

| Angle | Client preview | Server render |
|-------|---------------|---------------|
| 90°/180°/270° | Lossless canvas rotation | Lossless (libvips) |
| Arbitrary | Bicubic canvas (preview) | Lanczos from original (published) |

The bake-first architecture means the published image is always derived from the highest-quality path available. For arbitrary angles this is sharp Lanczos from the original source.
