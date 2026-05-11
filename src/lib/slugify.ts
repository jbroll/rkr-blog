// Slug derivation. Converts a free-form title into a kebab-case slug
// the server can write to disk and the public route can match.
//
// The route's slug regex is `^[a-z0-9][a-z0-9-]*$` with a 100-char
// cap (admin.ts MAX_SLUG_LENGTH). slugify() guarantees its output
// matches, even for edge-case titles (empty, all-symbol, all-emoji).

const MAX_LEN = 100;

/** Turn a title into a route-safe slug.
 *
 * - Lowercase
 * - Strip diacritics via Unicode NFD + diacritic-mark removal
 * - Replace any non-[a-z0-9] run with a single `-`
 * - Trim leading/trailing `-`
 * - Cap at MAX_LEN characters (trim trailing `-` after the cap so
 *   the slug ends on a word character, never on a hyphen)
 * - Falls back to `untitled-<ms>` when the input would yield an
 *   empty slug (all-symbol, all-emoji, etc.)
 */
export function slugify(title: string): string {
  const normalised = title
    .normalize('NFKD')
    // \p{M} matches the Unicode "mark" category — combining diacritics
    // peeled off by NFKD. Strip them so "café" → "cafe", "naïve" →
    // "naive". Requires the `u` flag.
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    // Anything that isn't a-z0-9 becomes a hyphen, then collapse runs.
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalised) return `untitled-${Date.now()}`;
  if (normalised.length <= MAX_LEN) return normalised;
  // Trim to cap, then re-trim any trailing hyphen the slice produced.
  return normalised.slice(0, MAX_LEN).replace(/-+$/, '') || normalised.slice(0, MAX_LEN);
}
