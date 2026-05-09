// Pre-commit guard: catch the same `interface` / `type` / `enum` name
// declared at the top level of two or more source files. TypeScript
// scopes duplicates per-module, so cross-file dupes compile silently;
// biome has no rule for this. The check is regex-based on top-level
// declarations only — types declared inside functions, namespaces, or
// other scopes don't collide and aren't flagged.
//
// Usage:
//   node --experimental-strip-types scripts/check-duplicate-types.ts
//
// Exit codes: 0 clean, 1 dupes found, 2 invocation error.

import fs from 'node:fs';
import path from 'node:path';

const ROOTS = ['src', 'test', 'bin', 'scripts'];
const EXTS = ['.ts'];

// Names allowed to appear in multiple files because the duplication is
// load-bearing (e.g. browser-only vs server-only modules in different
// build trees) OR because the cleanup hasn't been done yet. Add a
// justification comment when extending. Resolve baseline entries by
// renaming, sharing via a common module, or accepting and removing
// from the list — whichever fits the case.
//
// Drained to empty as of 2026-05-09. New offenders are rejected: rename
// or share via a common module. Only re-add a name with a justification
// comment when the duplication is structurally load-bearing (e.g. a
// browser-only vs server-only declaration the bundler keeps separate).
const ALLOWLIST: ReadonlySet<string> = new Set([]);

interface Decl {
  file: string;
  line: number;
  kind: 'interface' | 'type' | 'enum';
  exported: boolean;
}

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

const RE = /^(export\s+)?(interface|type|enum)\s+([A-Z][A-Za-z0-9_]*)\b/;

const occurrences = new Map<string, Decl[]>();
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const m = line.match(RE);
      if (!m) continue;
      const exported = !!m[1];
      const kind = m[2] as Decl['kind'];
      const name = m[3] as string;
      const list = occurrences.get(name) ?? [];
      list.push({ file, line: i + 1, kind, exported });
      occurrences.set(name, list);
    }
  }
}

let dupes = 0;
const sorted = [...occurrences.entries()].sort(([a], [b]) => a.localeCompare(b));
for (const [name, list] of sorted) {
  if (list.length < 2) continue;
  if (ALLOWLIST.has(name)) continue;
  console.log(`\n  ${name} (${list.length} declarations):`);
  for (const o of list) {
    console.log(`    ${o.file}:${o.line}  ${o.exported ? 'export ' : ''}${o.kind}`);
  }
  dupes++;
}

if (dupes > 0) {
  console.error(`\nFound ${dupes} duplicated type name(s).`);
  console.error(
    'Rename one declaration, share the type via a common module, or add the name to ALLOWLIST in scripts/check-duplicate-types.ts with a comment.'
  );
  process.exit(1);
}
console.log('No duplicate type declarations found.');
