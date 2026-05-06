#!/usr/bin/env -S node --no-warnings=ExperimentalWarning --experimental-strip-types
// Coverage gate: runs `node --test` with coverage enabled, parses the
// per-file table, and enforces both a project-aggregate floor and a
// per-file floor. Exits non-zero on any gate breach with a list of
// failures.
//
// Per-file allow-list (PER_FILE_OVERRIDES) lets a specific file relax
// the default; every entry MUST carry a `reason` so an audit can tell
// real exceptions from forgotten gaps.

import { spawn } from 'node:child_process';

interface Thresholds {
  line: number;
  branch: number;
  function: number;
}

interface Override extends Partial<Thresholds> {
  reason: string;
}

const PROJECT_FLOOR: Thresholds = { line: 95, branch: 85, function: 95 };
const PER_FILE_FLOOR: Thresholds = { line: 90, branch: 75, function: 90 };

// Files that legitimately can't reach the per-file floor. Each override
// must explain WHY the gap is acceptable, not just THAT it exists.
const PER_FILE_OVERRIDES: Record<string, Override> = {
  // node:sqlite has no API to inject a rollback failure mid-transaction.
  // The catch on `raw.exec('ROLLBACK')` is a defense against an engine
  // fault we'd see only with a corrupted or disconnected db; not testable
  // without mocking node:sqlite itself.
  'src/lib/db.ts': {
    branch: 70,
    reason: 'rollback-failure swallow can only fire on engine fault'
  },

  // The post template's only branch is "if frontmatter.date emit a <time>
  // tag, else emit empty string". Both legs are pure string concatenation
  // and a dedicated test for the empty leg adds no behavioral signal.
  'src/templates/post.ts': {
    branch: 60,
    reason: 'sole branch is a trivial conditional in a template literal'
  },

  // ProseMirror node-type / mark-type switches each have a default arm
  // that returns "" or drops the node. Those defaults can only fire if
  // the editor schema accepts a node our converter doesn't know about,
  // which the editor configuration prevents at construction time. Lower
  // floor while we add converter tests for additional node types.
  'src/lib/prose-markdown.ts': {
    branch: 70,
    reason: 'switch defaults are unreachable from our editor schema'
  },

  // QUALITY_BY_FORMAT lookup falls back to 85 for unknown formats. The
  // widget only emits formats it declares (webp, avif), so the fallback
  // is practically dead code. Kept for defense in depth.
  'src/widgets/image.ts': {
    branch: 70,
    reason: 'QUALITY_BY_FORMAT fallback is unreachable from our enum'
  },

  // Templates have one or two trivial conditionals (pager show/hide,
  // date present/absent) — same justification as post.ts above.
  'src/templates/index.ts': {
    branch: 70,
    reason: 'pager + date conditionals in template literal'
  },

  // Two callbacks here only run under timing edges tests can't reliably
  // reproduce: (1) the setTimeout poll callback that fires after
  // POLL_INTERVAL_MS without a wake event, and (2) the drain-listener
  // wait that runs only when stop() is called with in-flight jobs.
  'src/lib/jobs.ts': {
    function: 80,
    reason: 'time-dependent callbacks (poll timer + drain wait)'
  },

  // Defensive `m.detail ? : ''` for hypothetical future no-detail
  // mismatches. All currently-emitted mismatches supply detail.
  'src/cli/verify.ts': {
    branch: 70,
    reason: 'defensive detail-present check for future mismatch shapes'
  }
};

const NODE_ARGS = [
  '--test',
  '--experimental-test-coverage',
  '--test-coverage-exclude=test/**',
  '--no-warnings=ExperimentalWarning',
  '--experimental-strip-types'
];

interface FileRow {
  path: string;
  line: number;
  branch: number;
  func: number;
}

interface Aggregate {
  line: number;
  branch: number;
  func: number;
}

function parseCoverage(stdout: string): { files: FileRow[]; total: Aggregate | null } {
  const files: FileRow[] = [];
  let total: Aggregate | null = null;
  const pathStack: string[] = [];

  for (const raw of stdout.split('\n')) {
    if (!raw.startsWith('# ')) continue;
    const content = raw.slice(2);

    // Match: leading-spaces filename pipe percentages (or empty cells)
    const m = content.match(
      /^(\s*)(\S.*?)\s*\|\s*([0-9.]+)?\s*\|\s*([0-9.]+)?\s*\|\s*([0-9.]+)?\s*\|/
    );
    if (!m) continue;

    const indent = (m[1] ?? '').length;
    const name = m[2] ?? '';
    const lineCell = m[3];
    const branchCell = m[4];
    const funcCell = m[5];

    if (name === 'file' || name === 'all files') {
      if (name === 'all files' && lineCell && branchCell && funcCell) {
        total = {
          line: Number.parseFloat(lineCell),
          branch: Number.parseFloat(branchCell),
          func: Number.parseFloat(funcCell)
        };
      }
      continue;
    }

    if (lineCell === undefined || branchCell === undefined || funcCell === undefined) {
      // Folder header (no metrics). Maintain the path stack at this depth.
      pathStack.length = indent;
      pathStack[indent] = name;
      continue;
    }

    // File row.
    const dirParts = pathStack.slice(0, indent).filter(Boolean);
    files.push({
      path: [...dirParts, name].join('/'),
      line: Number.parseFloat(lineCell),
      branch: Number.parseFloat(branchCell),
      func: Number.parseFloat(funcCell)
    });
  }

  return { files, total };
}

function checkFile(row: FileRow): string[] {
  const ov: Override | undefined = PER_FILE_OVERRIDES[row.path];
  const lineFloor = ov?.line ?? PER_FILE_FLOOR.line;
  const branchFloor = ov?.branch ?? PER_FILE_FLOOR.branch;
  const funcFloor = ov?.function ?? PER_FILE_FLOOR.function;
  const reason = ov ? ` (override: ${ov.reason})` : '';

  const fails: string[] = [];
  if (row.line < lineFloor) {
    fails.push(`  ${row.path} line ${row.line.toFixed(2)}% < ${lineFloor}%${reason}`);
  }
  if (row.branch < branchFloor) {
    fails.push(`  ${row.path} branch ${row.branch.toFixed(2)}% < ${branchFloor}%${reason}`);
  }
  if (row.func < funcFloor) {
    fails.push(`  ${row.path} function ${row.func.toFixed(2)}% < ${funcFloor}%${reason}`);
  }
  return fails;
}

function checkProject(total: Aggregate): string[] {
  const fails: string[] = [];
  if (total.line < PROJECT_FLOOR.line) {
    fails.push(`  project line ${total.line.toFixed(2)}% < ${PROJECT_FLOOR.line}%`);
  }
  if (total.branch < PROJECT_FLOOR.branch) {
    fails.push(`  project branch ${total.branch.toFixed(2)}% < ${PROJECT_FLOOR.branch}%`);
  }
  if (total.func < PROJECT_FLOOR.function) {
    fails.push(`  project function ${total.func.toFixed(2)}% < ${PROJECT_FLOOR.function}%`);
  }
  return fails;
}

function main(): void {
  const child = spawn('node', NODE_ARGS, { stdio: ['ignore', 'pipe', 'inherit'] });
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => {
    const s = chunk.toString();
    stdout += s;
    process.stdout.write(s);
  });

  child.on('exit', (code) => {
    if (code !== 0) {
      console.error(`\n[coverage-gate] tests failed (exit ${code})`);
      process.exit(code ?? 1);
    }

    const { files, total } = parseCoverage(stdout);
    const failures: string[] = [];

    if (!total) {
      failures.push('  could not parse "all files" aggregate row');
    } else {
      failures.push(...checkProject(total));
    }

    for (const row of files) failures.push(...checkFile(row));

    if (failures.length > 0) {
      console.error('\n[coverage-gate] FAIL');
      for (const f of failures) console.error(f);
      console.error('');
      process.exit(1);
    }

    console.log(
      `\n[coverage-gate] OK — ${files.length} files checked` +
        (total
          ? ` (project: ${total.line.toFixed(2)}/${total.branch.toFixed(2)}/${total.func.toFixed(2)})`
          : '')
    );
  });
}

main();
