// HTML entity decoding for text WordPress hands us entity-encoded
// (`title.rendered`, `content.rendered`). Shared by the WP importer and
// the `fix-wp-titles` repair command so a repaired title is byte-identical
// to a freshly imported one.
//
// Decoding happens once, when content is written to disk. Renderers
// escape on output; parsePost deliberately does not decode, so a stored
// `<` never becomes live markup in memory (see lib/content.ts).

/** Decode the small set of HTML entities WP stores in `title.rendered`.
 * Handles numeric (decimal + hex) codepoints and the named entities most
 * likely to appear in prose. An out-of-range or malformed numeric entity
 * is left literal rather than throwing (a bad WP import must not 500). */
export function decodeHtmlEntities(s: string): string {
  const fromCp = (literal: string, raw: string, radix: number): string => {
    const cp = parseInt(raw, radix);
    if (!Number.isInteger(cp) || cp < 0 || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff)
      return literal;
    return String.fromCodePoint(cp);
  };
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (m: string, n: string) => fromCp(m, n, 16))
    .replace(/&#(\d+);/g, (m: string, n: string) => fromCp(m, n, 10))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}
