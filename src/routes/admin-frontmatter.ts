// Frontmatter helpers shared by the admin save/posts/status routes.
// Extracted from admin.ts so the route file stays under the 500-line
// size cap; nothing here needs Fastify or the route closure context.

import fs from 'node:fs';

/** Status precedence (the editor no longer carries a status select —
 * that's per-row on /admin/posts now):
 *   1. Body explicitly sent 'draft' or 'published': honour as-is.
 *   2. Updating an existing post with no status in the body:
 *      preserve the file's current status so a save doesn't silently
 *      un-publish a published post.
 *   3. Inserting a new post with no status: default 'draft'. */
export function resolveSavedStatus(raw: unknown, filePath: string): 'draft' | 'published' {
  if (raw === 'published' || raw === 'draft') return raw;
  if (!fs.existsSync(filePath)) return 'draft';
  const existing = fs.readFileSync(filePath, 'utf8');
  const m = /^status: (draft|published)$/m.exec(existing);
  return m?.[1] === 'published' ? 'published' : 'draft';
}

/** Date precedence — mirrors resolveSavedStatus:
 *   1. Body sent a non-blank `date`: honour it verbatim.
 *   2. Updating an existing post with no `date`: preserve the file's
 *      current date. Stamping a fresh `new Date()` on every dateless
 *      re-save would (a) silently move a post's publish date and
 *      (b) make every queued-entry replay produce different bytes,
 *      defeating the byte-identical lost-ACK self-heal (Task 8).
 *   3. Inserting a new post with no `date`: default to now. */
export function resolveSavedDate(raw: unknown, filePath: string): string {
  if (typeof raw === 'string' && raw.trim()) return raw;
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf8');
    const m = /^date: (.+)$/m.exec(existing);
    const captured = m?.[1]?.trim();
    if (captured) {
      // Frontmatter dates round-trip through yamlScalar; strip a
      // surrounding quote pair so the re-emitted scalar matches.
      const unquoted =
        captured.startsWith('"') && captured.endsWith('"')
          ? captured.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
          : captured;
      return unquoted;
    }
  }
  return new Date().toISOString();
}

/** Quote a string for emission as a YAML scalar. Conservative: any
 * char that could be parsed as YAML structure triggers quoting. */
export function yamlScalar(s: string): string {
  const safe = s.replace(/[\r\n\t]+/g, ' ');
  if (/[:#&*!|>'"%@`,[\]{}\n]/.test(safe) || /^[?]\s/.test(safe) || /^\s|\s$/.test(safe)) {
    return `"${safe.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return safe;
}

/**
 * Does the body open with a yaml frontmatter delimiter?
 *
 * Accepts: a leading BOM / unicode whitespace, then `---`, then a CR/LF,
 * then *something that resembles yaml content* — either another `---`
 * (empty frontmatter) or a `key:` mapping line. Matching only `---\n`
 * would false-positive on a leading `* * *` regression — we want to
 * reject the smuggling shape, not bare horizontal-rule punctuation.
 * CRLF and CR-only line endings are both handled.
 */
export function looksLikeFrontmatterDelimiter(s: string): boolean {
  const trimmed = s.replace(/^[﻿\s]+/, '');
  if (!trimmed.startsWith('---')) return false;
  const afterDashes = trimmed.slice(3);
  const eolMatch = /^[\t {2}]*(\r\n|\r|\n)/.exec(afterDashes);
  if (!eolMatch) return false;
  const rest = afterDashes.slice(eolMatch[0].length);
  for (const line of rest.split(/\r\n|\r|\n/)) {
    if (line.trim() === '') continue;
    if (line.trim() === '---') return true;
    if (/^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(line)) return true;
    return false;
  }
  return false;
}
