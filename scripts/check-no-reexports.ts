// Pre-commit guard: flag bare re-exports (`export { x } from './y.ts'`
// and `export type { Foo } from './y.ts'`).
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
// Allowed patterns (NOT flagged): `export { x }` (declaration with
// inline definition or scoped to a same-file binding), and the
// `export *` star re-export which is rare and visually distinct.
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
const RE_NAMED_REEXPORT = /^export\s+(type\s+)?\{[^}]*\}\s*from\s+['"]/;

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
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      if (RE_NAMED_REEXPORT.test(line)) {
        findings.push({ file, line: i + 1, text: line.trim() });
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
    `\nWe control all callers — import directly from the defining module. If you have a load-bearing reason for a re-export, add the file path to ALLOWLIST in scripts/check-no-reexports.ts with a justification.`
  );
  process.exit(1);
}
console.log('No re-exports found.');
