// E2E coverage ratchet gate. Invoked from .githooks/pre-commit when a
// commit touches src/admin/** or src/site/**.
//
// Per-file rules:
//   1. New file (not in baseline + not in HEAD): require coverage
//      >= 75% lines.
//   2. Existing file at >= 75% in baseline: require >= 75% in this run.
//   3. Existing file below 75% in baseline: require uncovered-line
//      count to NOT increase. (Adding new lines is OK as long as you
//      cover them; pure code-deletion that drops coverage is OK.)
//
// On pass: the baseline file is rewritten with the current run's
// numbers and re-staged so the next commit sees the improved
// numbers. On fail: print the offending files and exit 1.
//
// Inputs:
//   - coverage/e2e/lcov.info       (produced by `npm run test:e2e`)
//   - scripts/coverage-baseline.json  (tracked in scripts/)
//   - argv: list of staged src/admin/** + src/site/** files
// Outputs:
//   - scripts/coverage-baseline.json  rewritten on pass
//   - exit 0/1

import { execSync } from 'node:child_process';
import fs from 'node:fs';

const FLOOR = 0.75;
const LCOV_PATH = 'coverage/e2e/lcov.info';
const BASELINE_PATH = 'scripts/coverage-baseline.json';

// Files exempt from the new-file gate. Worker/SW code runs in a
// separate thread that Playwright's page.coverage can't instrument.
// Type-only files have no executable lines and never appear in lcov.
const EXEMPT: ReadonlySet<string> = new Set([
  'src/site/sw-admin.ts',
  'src/site/sw-admin-register.ts',
  'src/admin/opfs-worker.ts',
  'src/admin/opfs-worker-msg.ts'
]);

interface FileMetric {
  linesFound: number;
  linesHit: number;
}

interface Baseline {
  version: 1;
  files: Record<string, FileMetric>;
}

/** Parse lcov.info into per-file LF/LH. mcr writes one stanza per
 * source file with the standard lcov record types; we only need SF
 * (source file path), LF (lines found), LH (lines hit). */
function parseLcov(text: string): Record<string, FileMetric> {
  const out: Record<string, FileMetric> = {};
  let currentSf: string | null = null;
  let lf = 0;
  let lh = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      currentSf = line.slice(3).trim();
      lf = 0;
      lh = 0;
    } else if (line.startsWith('LF:')) {
      lf = Number(line.slice(3));
    } else if (line.startsWith('LH:')) {
      lh = Number(line.slice(3));
    } else if (line === 'end_of_record' && currentSf) {
      out[currentSf] = { linesFound: lf, linesHit: lh };
      currentSf = null;
    }
  }
  return out;
}

function readBaseline(): Baseline {
  if (!fs.existsSync(BASELINE_PATH)) {
    return { version: 1, files: {} };
  }
  const raw = fs.readFileSync(BASELINE_PATH, 'utf8');
  const parsed = JSON.parse(raw) as Baseline;
  if (parsed.version !== 1) {
    throw new Error(`coverage-baseline.json: unsupported version ${parsed.version}`);
  }
  return parsed;
}

/** True iff the file existed in HEAD. Used to distinguish "new file
 * being added in this commit" from "existing file with no baseline
 * recorded yet" (which would be a new-baseline case). */
function existedInHead(filePath: string): boolean {
  try {
    execSync(`git cat-file -e HEAD:${filePath}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function pct(m: FileMetric): number {
  return m.linesFound === 0 ? 1 : m.linesHit / m.linesFound;
}

function uncovered(m: FileMetric): number {
  return m.linesFound - m.linesHit;
}

function fmtPct(p: number): string {
  return `${(p * 100).toFixed(2)}%`;
}

interface Failure {
  file: string;
  reason: string;
}

function checkOne(
  file: string,
  prev: FileMetric | undefined,
  cur: FileMetric | undefined
): Failure | null {
  if (EXEMPT.has(file)) return null;
  const inHead = existedInHead(file);

  // Case 1: brand-new file. Must hit the floor.
  if (!inHead) {
    if (!cur) {
      return { file, reason: 'new file is not exercised by any e2e spec (no LF/LH in lcov)' };
    }
    if (pct(cur) < FLOOR) {
      return {
        file,
        reason: `new file at ${fmtPct(pct(cur))} (${cur.linesHit}/${cur.linesFound}); must be >= ${fmtPct(FLOOR)}`
      };
    }
    return null;
  }

  // Case 2 + 3: existing file. cur may be missing if no e2e exercises
  // it (acceptable when prev was also untested; not acceptable when
  // prev had measured coverage).
  if (!cur) {
    if (prev) {
      return {
        file,
        reason: 'previously measured but not exercised by current e2e — coverage regressed to 0'
      };
    }
    // Existing file, never measured. Tolerate (warn-on-existing).
    return null;
  }

  if (!prev) {
    // Existing file with no baseline. First time we're seeing it.
    // Accept whatever it is; future commits will ratchet from here.
    return null;
  }

  // Was at or above the floor → must stay there.
  if (pct(prev) >= FLOOR) {
    if (pct(cur) < FLOOR) {
      return {
        file,
        reason: `regressed below floor: was ${fmtPct(pct(prev))}, now ${fmtPct(pct(cur))}`
      };
    }
    return null;
  }

  // Was below the floor → don't make it worse. Ratchet on absolute
  // uncovered-line count: new lines are fine if you cover them; pure
  // additions of uncovered lines are not.
  if (uncovered(cur) > uncovered(prev)) {
    return {
      file,
      reason: `more uncovered lines than baseline: ${uncovered(prev)} → ${uncovered(cur)} (${fmtPct(pct(prev))} → ${fmtPct(pct(cur))})`
    };
  }
  return null;
}

function main(): void {
  const stagedFiles = process.argv.slice(2);
  if (stagedFiles.length === 0) {
    // No admin/site files staged — gate is a no-op. (The caller
    // shouldn't have invoked us, but be defensive.)
    return;
  }

  if (!fs.existsSync(LCOV_PATH)) {
    console.error(`coverage ratchet: ${LCOV_PATH} missing — run \`npm run test:e2e\` first`);
    process.exit(2);
  }
  const lcov = parseLcov(fs.readFileSync(LCOV_PATH, 'utf8'));
  const baseline = readBaseline();

  const failures: Failure[] = [];
  for (const file of stagedFiles) {
    const fail = checkOne(file, baseline.files[file], lcov[file]);
    if (fail) failures.push(fail);
  }

  if (failures.length > 0) {
    console.error('e2e coverage ratchet failed:');
    for (const f of failures) {
      console.error(`  ${f.file}: ${f.reason}`);
    }
    console.error('\nAdd e2e coverage for the affected lines, or revisit the change.');
    process.exit(1);
  }

  // Pass: rewrite the baseline to incorporate this run's numbers AND
  // any other improvements present in lcov.info beyond just the
  // staged files. (Improvements anywhere should ratchet — the
  // baseline isn't scoped to staged files.)
  const next: Baseline = { version: 1, files: { ...baseline.files } };
  for (const [file, metric] of Object.entries(lcov)) {
    next.files[file] = metric;
  }
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
  // Stage the updated baseline so it travels with the commit.
  execSync(`git add ${BASELINE_PATH}`, { stdio: 'ignore' });

  const checked = stagedFiles
    .map((f) => {
      const cur = lcov[f];
      return cur ? `${f} ${fmtPct(pct(cur))}` : `${f} (not exercised)`;
    })
    .join(', ');
  console.log(`e2e coverage ratchet ok: ${checked}`);
}

main();
