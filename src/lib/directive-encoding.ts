// Directive-attribute encoding for the prose ⇄ markdown converter.
// Shared by the figure and video directive emitters/parsers in
// prose-markdown.ts / prose-markdown-video.ts (split into its own
// module so those two don't import each other).

// remark-directive's quoted-attribute grammar (used to serialize a
// figure caption / alt into `::figure{caption="..."}`) is NOT
// backslash-escapable and it HTML-entity-decodes the value on parse.
// Empirically the following corrupt or split the directive on the
// editor-save round trip (prose → markdown → prose):
//   "  \  &  \n  \r   → directive lost or text mangled
// (`}` and `|` survive, but `&` is entity-decoded and `%XX` would be
// decoded by our own scheme, so both are folded in for a clean
// symmetric reversible encoding.)
//
// Scheme: percent-encode exactly this set on emit, decode exactly this
// set on parse-back. `%` is encoded first (and decoded last) so the
// mapping is unambiguous. Ordinary text — letters, spaces, `,`, `|`,
// unicode — is left verbatim so plain captions stay readable in the .md.
const ENCODE_RE = /[%&"\\}\n\r]/g;
const ENCODE_MAP: Record<string, string> = {
  '%': '%25',
  '&': '%26',
  '"': '%22',
  '\\': '%5C',
  '}': '%7D',
  '\n': '%0A',
  '\r': '%0D'
};
const DECODE_RE = /%(?:26|22|5C|7D|0A|0D|25)/g;
const DECODE_MAP: Record<string, string> = {
  '%26': '&',
  '%22': '"',
  '%5C': '\\',
  '%7D': '}',
  '%0A': '\n',
  '%0D': '\r',
  '%25': '%'
};

function directiveEncode(s: string): string {
  return s.replace(ENCODE_RE, (ch) => ENCODE_MAP[ch] ?? ch);
}

/** Inverse of `directiveEncode`, applied on the parse-back path so the
 * in-memory caption/alt is byte-identical after an editor-save round
 * trip. `%25` (the escaped `%`) is decoded last via the alternation
 * order in DECODE_RE so an authored literal `%7D` can't be mistaken
 * for an encoded `}`. */
export function directiveDecode(s: string): string {
  return s.replace(DECODE_RE, (m) => DECODE_MAP[m] ?? m);
}

export function quote(s: string): string {
  return `"${directiveEncode(s)}"`;
}
