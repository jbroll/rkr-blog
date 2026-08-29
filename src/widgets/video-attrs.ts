// Attribute parsers + validator for the ::video directive. Same split
// as figure-attrs.ts: pure functions, no FS / DOM / async. Parsers the
// figure already has (justify, width) are reused; video adds the trim /
// poster / controls family.

import { extractDirectiveCaption } from '../lib/widget-helpers.ts';
import { type Justify, parseJustify, parseWidth } from './figure-attrs.ts';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const TRIM_RE = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/;

/** "2.0-45.5" (seconds) -> {startMs, endMs}; null when malformed or
 * start >= end. The upper bound vs duration is checked at render,
 * where the sidecar duration is known. */
export function parseTrim(s: string): { startMs: number; endMs: number } | null {
  const m = TRIM_RE.exec(s.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    return null;
  }
  return { startMs: Math.round(start * 1000), endMs: Math.round(end * 1000) };
}

/** Poster time in seconds -> ms. null when not a non-negative number. */
export function parsePoster(s: string): number | null {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1000);
}

/** CSS-ready width, reusing the figure parser. */
export function parseVideoWidth(raw: unknown): string | null {
  return parseWidth(raw);
}

/** Forgiving boolean: bare attr / true / 1 -> true; false / 0 -> false;
 * anything else -> defaultValue. */
function parseBool(raw: unknown, defaultValue: boolean): boolean {
  if (typeof raw !== 'string') return defaultValue;
  const t = raw.trim().toLowerCase();
  if (t === '' || t === 'true' || t === '1') return true;
  if (t === 'false' || t === '0') return false;
  return defaultValue;
}

interface VideoAttrs {
  /** Full 64-hex lowercase id; the VideoMap rejects prefixes. */
  ids: string;
  /** Author trim in ms; range vs duration checked at render. */
  trim: { startMs: number; endMs: number } | null;
  /** Poster time in ms; null -> sidecar's poster.timeMs. */
  poster: number | null;
  controls: boolean;
  autoplay: boolean;
  muted: boolean;
  loop: boolean;
  caption: string | null;
  justify: Justify;
  /** CSS-ready width (e.g. "50%"), or null for the justify default. */
  width: string | null;
}

export type VideoAttrsValidateResult =
  | { ok: true; attrs: VideoAttrs }
  | { ok: false; error: string };

/** Validate a ::video directive's raw attributes. Strict on ids and
 * trim (neither has a safe fallback); forgiving elsewhere. */
export function validateVideoAttrs(
  raw: Record<string, string | null | undefined>
): VideoAttrsValidateResult {
  const ids = typeof raw.ids === 'string' ? raw.ids.trim().toLowerCase() : '';
  if (!SHA256_HEX.test(ids)) {
    return { ok: false, error: 'ids must be a single 64-char lowercase sha256 hex id' };
  }

  let trim: VideoAttrs['trim'] = null;
  if (typeof raw.trim === 'string' && raw.trim.trim() !== '') {
    trim = parseTrim(raw.trim);
    if (!trim) {
      return { ok: false, error: 'trim must be "start-end" in seconds with start < end' };
    }
  }

  let poster: VideoAttrs['poster'] = null;
  if (typeof raw.poster === 'string' && raw.poster.trim() !== '') {
    poster = parsePoster(raw.poster);
    if (poster === null) {
      return { ok: false, error: 'poster must be a non-negative number of seconds' };
    }
  }

  return {
    ok: true,
    attrs: {
      ids,
      trim,
      poster,
      controls: parseBool(raw.controls, true),
      autoplay: parseBool(raw.autoplay, false),
      muted: parseBool(raw.muted, false),
      loop: parseBool(raw.loop, false),
      caption: extractDirectiveCaption({ attributes: raw }),
      justify: parseJustify(raw.justify),
      width: parseVideoWidth(raw.width)
    }
  };
}
