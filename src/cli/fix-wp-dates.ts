// fix-wp-dates — repair WP-imported post frontmatter dates.
//
// When an admin edits a WP-imported post via the editor *before* the date
// input was added, the server defaulted `date` to today, overwriting the
// original publication date in the frontmatter. The original date is still
// encoded in the filename prefix (YYYY-MM-DD-slug.md from the WP importer).
//
// This command reads every content/posts/*.md file, finds WP-imported posts
// (source_kind: wordpress) whose frontmatter date doesn't match the filename
// date prefix, and restores it to YYYY-MM-DDT00:00:00Z.

import fs from 'node:fs';
import path from 'node:path';

import { writeFileAtomicSync } from '../lib/atomic-write.ts';
import { paths } from '../lib/config.ts';

export interface FixWpDatesReport {
  fixed: number;
  skipped: number;
  errors: string[];
}

// Filename date prefix: YYYY-MM-DD-<anything>.md
const FILENAME_DATE_RE = /^(\d{4}-\d{2}-\d{2})-[^/]+\.md$/;

/** Repair WP-imported post dates using the filename prefix as the source of
 * truth. Returns a count of files fixed / skipped / errored. */
export function fixWpDates(siteRoot: string): FixWpDatesReport {
  const postsDir = path.join(siteRoot, 'content', 'posts');
  const report: FixWpDatesReport = { fixed: 0, skipped: 0, errors: [] };

  let files: string[];
  try {
    files = fs.readdirSync(postsDir).filter((f) => f.endsWith('.md'));
  } catch /* c8 ignore next */ {
    /* c8 ignore next */
    return report;
  }

  for (const filename of files) {
    const m = FILENAME_DATE_RE.exec(filename);
    if (!m?.[1]) continue; // No date prefix — editor-created post, skip.
    const fileDate = m[1]; // YYYY-MM-DD

    const fullPath = path.join(postsDir, filename);
    let raw: string;
    try {
      raw = fs.readFileSync(fullPath, 'utf8');
    } catch (err) /* c8 ignore start */ {
      report.errors.push(`${filename}: read error: ${(err as Error).message}`);
      continue;
    } /* c8 ignore stop */

    // Only touch WP-imported posts.
    if (!raw.includes('source_kind: wordpress')) continue;

    // Check existing date field.
    const dateMatch = /^date:\s*(.+)$/m.exec(raw);
    if (!dateMatch?.[1]) continue;
    const existingDate = dateMatch[1].trim();

    // Already correct if the existing date starts with the filename date.
    if (existingDate.startsWith(fileDate)) {
      report.skipped++;
      continue;
    }

    // Replace the date line.
    const corrected = raw.replace(/^date:\s*.+$/m, `date: ${fileDate}T00:00:00Z`);

    try {
      writeFileAtomicSync(fullPath, corrected);
      report.fixed++;
    } catch (err) /* c8 ignore start */ {
      report.errors.push(`${filename}: write error: ${(err as Error).message}`);
    } /* c8 ignore stop */
  }

  return report;
}

// ---- CLI entry point -------------------------------------------------------

export default async function fixWpDatesCmd(argv: string[]): Promise<void> {
  const siteRoot = argv[0] ?? paths().root;
  console.log(`Scanning ${path.join(siteRoot, 'content', 'posts')}…`);

  const report = fixWpDates(siteRoot);
  /* c8 ignore next 3 -- only reachable via the c8-ignored read/write error handlers */
  if (report.errors.length > 0) {
    for (const e of report.errors) console.error(`  error: ${e}`);
  }
  console.log(
    `Done. Fixed: ${report.fixed}  Already correct: ${report.skipped}  Errors: ${report.errors.length}`
  );
  if (report.fixed > 0) {
    console.log('Run `site-admin reindex` to update the SQLite index.');
  }
}
