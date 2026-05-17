// Turn a raw user query into a safe FTS5 MATCH string. Words are
// AND-ed; the last word is prefix-matched (the term being typed).
// All FTS5 syntax characters are stripped, which both avoids MATCH
// syntax errors and removes any injection vector. Returns null when
// nothing usable remains (caller renders the prompt state).

const MAX_LEN = 200;
// Keep letters, digits, underscore, and whitespace; drop everything
// else (", *, (, ), :, ^, -, +, ., /, and punctuation).
const STRIP = /[^\p{L}\p{N}_\s]+/gu;

export function buildFtsMatch(raw: string): string | null {
  const capped = raw.trim().slice(0, MAX_LEN);
  const tokens = capped.replace(STRIP, ' ').split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const last = tokens.length - 1;
  return tokens.map((t, i) => (i === last ? `${t}*` : t)).join(' ');
}
