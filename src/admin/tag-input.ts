// Tag-input widget: wraps a container div and manages a list of tag
// pills the user can add (type + Enter/comma) or remove (× button).
// Pure logic is exported separately so unit tests don't need a DOM.

/** Parse a raw input string into candidate tag names: split on commas,
 * trim whitespace, drop blanks and entries over MAX_TAG_LEN chars. */
const MAX_TAG_LEN = 32;

export function parseTagInput(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= MAX_TAG_LEN);
}

/** Deduplicate tags case-insensitively, keeping first occurrence. */
export function deduplicateTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const key = t.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}
