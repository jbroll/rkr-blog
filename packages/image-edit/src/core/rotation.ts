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

  const cos2 = c * c - s * s;
  // Fully constrained only when both conditions hold AND cos2 is not too small.
  // Near 45°, cos2 ≈ 0, making division unstable; use half-constrained instead.
  if (W * c > H * s && H * c > W * s && Math.abs(cos2) > 1e-6) {
    // Fully constrained: all 4 sides binding.
    rw = (W * c - H * s) / cos2;
    rh = (H * c - W * s) / cos2;
    // Half-constrained may give a larger rectangle in the mid-angle range.
    // Take whichever regime yields greater area.
    const rwHc = W >= H ? H / (2 * s) : W / (2 * c);
    const rhHc = W >= H ? H / (2 * c) : W / (2 * s);
    if (rwHc <= W && rhHc <= H && rwHc * rhHc > rw * rh) {
      rw = rwHc;
      rh = rhHc;
    }
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
