// Attribute parsers for the ::figure directive. Each parser takes a
// raw attribute value (string | undefined) from the directive's
// attributes record and returns a typed, validated, defaulted value.
// Pure — no FS / no DOM / no async.
//
// Lives separately from the figure widget body so the widget stays
// under the 500-line size cap.

import { clampAlt } from '../lib/widget-helpers.ts';

// Matrix types + parser live in lib/matrix.ts (shared with the editor's
// visual control). Import directly from there — this file no longer
// re-exports them.

const VALID_JUSTIFY = new Set(['center', 'left', 'right', 'full', 'bleed', 'inline'] as const);
export type Justify = typeof VALID_JUSTIFY extends Set<infer T> ? T : never;

const VALID_FIT = new Set(['cover', 'contain'] as const);
export type Fit = typeof VALID_FIT extends Set<infer T> ? T : never;

export function parseJustify(raw: unknown): Justify {
  if (typeof raw === 'string' && VALID_JUSTIFY.has(raw as Justify)) return raw as Justify;
  return 'center';
}

export function parseFit(raw: unknown): Fit {
  if (typeof raw === 'string' && VALID_FIT.has(raw as Fit)) return raw as Fit;
  return 'cover';
}

/** CSS-ready width, e.g. "60%" or "400px". null means "use justify default". */
export function parseWidth(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // Explicit unit only — `width=200` is ambiguous (px? %?) and we won't guess.
  const m = /^(\d+)(px|%)$/.exec(raw.trim());
  if (!m) return null;
  return `${m[1]}${m[2]}`;
}

/** "W/H" string ready for the CSS `aspect-ratio` property. null → derive
 * from the first image's sidecar. */
export function parseAspect(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = /^(\d+)\s*[:x]\s*(\d+)$/.exec(raw.trim());
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return `${w}/${h}`;
}

/** Per-image captions: pipe-separated to avoid colliding with the comma
 * separators used by `ids` / `alts`. Trim each entry; empty → null. */
export function parsePerImageCaptions(raw: unknown): (string | null)[] {
  if (typeof raw !== 'string') return [];
  return raw.split('|').map((s) => {
    const t = s.trim();
    return t.length > 0 ? clampAlt(t) : null;
  });
}

/** Carousel autoplay seconds. 0 = manual advance only. Capped at 60
 * (anything bigger reads as "the author meant ms or made a typo"). */
const TIMER_CAP_SECONDS = 60;
export function parseTimer(raw: unknown): number {
  if (typeof raw !== 'string') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(TIMER_CAP_SECONDS, Math.floor(n));
}
