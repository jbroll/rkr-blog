// Pre-commit guard: flag re-exports.
//
// Two shapes:
//   1. `export { x } from './y.ts'` (and `export type { Foo } from …`)
//   2. `export { x };` after `import { x } from './y.ts'` — same effect,
//      different syntax. This is the pattern that previously slipped past
//      our first version of this check (originals.ts re-exporting
//      FORMAT_TO_EXT, etc.).
//
// We control all callers in this codebase, so re-exports add zero
// value and several costs:
//   - they hide where a symbol is *actually* defined, fooling
//     editor go-to-definition and grep
//   - they create import-path drift: half the codebase imports from
//     module A, the other half from re-exporter B, and the answer to
//     "where do I import this from" is now ambiguous
//   - they're a duplicate-typedef vector if the re-exporter renames
//
// Allowed: declarations with inline export (`export function foo`,
// `export const bar = …`, `export interface Baz`); the `export *`
// star re-export form (rare, visually distinct).
//
// Usage:
//   node --experimental-strip-types scripts/check-no-reexports.ts
//
// Exit codes: 0 clean, 1 re-exports found.

import fs from 'node:fs';
import path from 'node:path';

const ROOTS = ['src', 'test', 'bin', 'scripts'];
const EXTS = ['.ts'];

// Patterns intentionally allowed in specific files. Each entry must
// carry a justification. Empty for now.
const ALLOWLIST: ReadonlySet<string> = new Set();

function* walk(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (EXTS.some((e) => entry.name.endsWith(e))) {
      yield full;
    }
  }
}

// Match: `export { … } from '…'` and `export type { … } from '…'`.
// Anchor at column 0 so we only catch top-level statements (skips
// inside-function or inside-namespace declarations).
const RE_NAMED_REEXPORT_FROM = /^export\s+(?:type\s+)?\{[^}]*\}\s*from\s+['"]/;
// Match: `export { x };` (no `from`). Combined with the imports scan
// below, names that also appear in an import are flagged as re-exports.
// Pure local exports (e.g. `function foo() {}` followed by
// `export { foo };`) are caught too — they're a smell vs. inlining the
// `export` keyword on the declaration; cleanup is mechanical.
const RE_NAMED_EXPORT_NO_FROM = /^export\s+(?:type\s+)?\{([^}]*)\}\s*;?\s*$/;
// Match: `import { a, b as c, type d } from '…'`. We collect imported
// names so we can distinguish re-export-via-named-export from local
// named-export.
const RE_IMPORT_NAMED = /^import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]/;

function parseSpecifierNames(raw: string): string[] {
  // Each specifier is `x`, `x as y`, `type x`, or `type x as y`.
  // Strip whitespace, drop `type ` prefix, and take the original name
  // (the LHS of `as` if present, else the bare identifier).
  const names: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim().replace(/^type\s+/, '');
    if (!trimmed) continue;
    const original = trimmed.split(/\s+as\s+/)[0]?.trim();
    if (original) names.push(original);
  }
  return names;
}

interface Finding {
  file: string;
  line: number;
  text: string;
}

const findings: Finding[] = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    if (ALLOWLIST.has(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    // Pass 1: collect imported names so the named-export-no-from check
    // can distinguish "export of imported symbol" (a re-export) from
    // "export of locally-declared symbol" (style smell, but not a
    // re-export). Both are flagged; the message just clarifies why.
    const imported = new Set<string>();
    for (const line of lines) {
      const m = line.match(RE_IMPORT_NAMED);
      if (m?.[1]) for (const n of parseSpecifierNames(m[1])) imported.add(n);
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      if (RE_NAMED_REEXPORT_FROM.test(line)) {
        findings.push({ file, line: i + 1, text: line.trim() });
        continue;
      }
      const m = line.match(RE_NAMED_EXPORT_NO_FROM);
      if (m?.[1]) {
        const names = parseSpecifierNames(m[1]);
        if (names.some((n) => imported.has(n))) {
          findings.push({ file, line: i + 1, text: line.trim() });
        }
      }
    }
  }
}

if (findings.length > 0) {
  console.error('\nFound re-exports:');
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.text}`);
  }
  console.error(
    `\nWe control all callers — import directly from the defining module. For local exports, prefer inline form (\`export function foo\`). If you have a load-bearing reason for a re-export, add the file path to ALLOWLIST in scripts/check-no-reexports.ts with a justification.`
  );
  process.exit(1);
}
console.log('No re-exports found.');
