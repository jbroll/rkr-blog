// Shared constants for the admin post routes. The slug rules are
// the URL's source of truth — kebab-case, alpha-leading, capped at
// 100 chars — so admin.ts (save), admin-posts.ts (list / delete /
// status flip), and admin-post-bundle.ts (offline pin) all agree
// without three drift-prone copies.

// Hard cap on slug length + allowed character set. The cap matches
// what the public-side URL list can render inline at a glance;
// SLUG_RE mirrors the kebab-case derivation in src/lib/slugify.ts
// so a round-trip never produces a slug the validator would reject.
// Kept module-private — the only thing other modules need is the
// combined predicate below.
const MAX_SLUG_LENGTH = 100;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;

/** Slug must be a non-empty kebab-case identifier, at most 100
 * characters, starting with an alphanumeric. The combined check
 * replaces three drift-prone copies across the post route files. */
export function isValidSlug(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= MAX_SLUG_LENGTH && SLUG_RE.test(s);
}
