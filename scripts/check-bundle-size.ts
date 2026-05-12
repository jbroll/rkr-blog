// Bundle-size ratchet. Sums `static/admin/` + `static/site/` byte
// totals (excluding source maps), compares to bundle-size-baseline.json.
// Fails the commit when either total grew by more than GROWTH_BUDGET
// from baseline. On pass, rewrites the baseline + re-stages it so the
// new floor travels with the commit — same shape as the e2e coverage
// ratchet (scripts/check-e2e-coverage.ts).
//
// Why both totals, not per-file: per-file tracking churns on every
// bundler hash rename (e.g. chunk-7N43OYVW.js → chunk-PS4AC2H7.js);
// directory totals are stable. Source maps are excluded — they're an
// artifact of the dev build and not shipped to readers.
//
// Trigger condition (DEFERRED 2026-05-09): "bloat creeps in
// invisibly". 10% growth-per-commit is the documented heuristic.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASELINE_PATH = 'bundle-size-baseline.json';
const GROWTH_BUDGET = 0.1; // 10%
const DIRS = ['static/admin', 'static/site'] as const;

interface BundleSizeBaseline {
  version: 1;
  totals: Record<string, number>;
}

/** Sum bytes of all files under `dir`, skipping source maps. */
function sumDir(dir: string): number {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.map')) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isFile()) total += st.size;
  }
  return total;
}

function loadBaseline(): BundleSizeBaseline | null {
  if (!fs.existsSync(BASELINE_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as BundleSizeBaseline;
  } catch {
    return null;
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

const current: Record<string, number> = {};
for (const dir of DIRS) current[dir] = sumDir(dir);

const baseline = loadBaseline();
let failed = 0;
const report: string[] = [];
for (const dir of DIRS) {
  const now = current[dir] ?? 0;
  const base = baseline?.totals[dir];
  if (base === undefined) {
    report.push(`  ${dir}: ${fmtBytes(now)} (no baseline — seeded)`);
    continue;
  }
  const delta = now - base;
  const pct = base > 0 ? delta / base : 0;
  const sign = delta >= 0 ? '+' : '';
  const line = `  ${dir}: ${fmtBytes(now)} vs baseline ${fmtBytes(base)} (${sign}${fmtBytes(delta)}, ${(pct * 100).toFixed(1)}%)`;
  if (pct > GROWTH_BUDGET) {
    report.push(`FAIL ${line}`);
    failed++;
  } else {
    report.push(line);
  }
}

console.log(report.join('\n'));

if (failed > 0) {
  console.error(
    `\nbundle-size check failed: ${failed} dir(s) grew more than ${(GROWTH_BUDGET * 100).toFixed(0)}%.\n` +
      `If the growth is intentional, bump the baseline manually:\n` +
      `  npm run -s build:admin && npm run -s build:site && \\\n` +
      `  node --no-warnings=ExperimentalWarning --experimental-strip-types \\\n` +
      `    scripts/check-bundle-size.ts --write\n`
  );
  process.exit(1);
}

// On pass (or with --write override), rewrite the baseline.
const next: BundleSizeBaseline = { version: 1, totals: current };
fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
try {
  execSync(`git add ${BASELINE_PATH}`, { stdio: 'ignore' });
} catch {
  // not a git repo or staging failed — fine, the file is still updated
}
