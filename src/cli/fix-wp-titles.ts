// fix-wp-titles — decode HTML entities left in WP-imported frontmatter titles.
//
// Posts imported before the WP importer decoded entities kept WordPress's
// encoded form on disk (`title: "Day 12 &#8211; 31 Years!"`). Renderers
// escape titles on output, so the entity reaches the browser literally.
// parsePost deliberately does not decode (lib/content.ts), so the fix
// belongs in the stored file.
//
// Only `title:` and `subtitle:` inside the frontmatter block are rewritten;
// bodies are untouched. There is no provenance gate: posts pushed through
// /admin/posts carry no `source_kind`, so the affected files cannot be
// identified that way. Every change is listed, and `--dry-run` shows the
// list without writing.

import fs from 'node:fs';
import path from 'node:path';

import { writeFileAtomicSync } from '../lib/atomic-write.ts';
import { paths } from '../lib/config.ts';
import { decodeHtmlEntities } from '../lib/html-entities.ts';

export interface TitleChange {
  file: string;
  field: string;
  from: string;
  to: string;
}

export interface FixWpTitlesReport {
  fixed: number;
  skipped: number;
  errors: string[];
  changes: TitleChange[];
}

export interface FixWpTitlesOpts {
  dryRun?: boolean;
}

const FIELD_RE = /^(title|subtitle):[ \t]*(.*)$/;

/** Read a YAML double-quoted scalar back to its literal value. Unquoted
 * scalars are taken verbatim — the importer always quotes, but a
 * hand-edited file may not. */
function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return v;
}

/** Quote exactly as lib/wp-import.ts renderFrontmatter does, so a repaired
 * title is byte-identical to a freshly imported one. */
function quote(value: string): string {
  return `"${value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')}"`;
}

export interface Repair {
  text: string;
  fields: Array<{ field: string; from: string; to: string }>;
}

/** Decode entities in the title/subtitle lines of one file's frontmatter.
 * Returns null when nothing changes. */
export function repairFrontmatter(raw: string): Repair | null {
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) return null;

  const fields: Repair['fields'] = [];
  for (let i = 1; i < end; i++) {
    const line = lines[i] as string;
    const m = FIELD_RE.exec(line);
    if (!m) continue;
    const value = unquote(m[2] as string);
    const decoded = decodeHtmlEntities(value);
    if (decoded === value) continue;
    lines[i] = `${m[1]}: ${quote(decoded)}`;
    fields.push({ field: m[1] as string, from: value, to: decoded });
  }
  return fields.length > 0 ? { text: lines.join('\n'), fields } : null;
}

/** Rewrite every WP-imported post whose frontmatter title or subtitle still
 * carries HTML entities. */
export function fixWpTitles(siteRoot: string, opts: FixWpTitlesOpts = {}): FixWpTitlesReport {
  const postsDir = path.join(siteRoot, 'content', 'posts');
  const report: FixWpTitlesReport = { fixed: 0, skipped: 0, errors: [], changes: [] };

  let files: string[];
  try {
    files = fs
      .readdirSync(postsDir)
      .filter((f) => f.endsWith('.md'))
      .sort();
  } catch {
    return report;
  }

  for (const filename of files) {
    const fullPath = path.join(postsDir, filename);
    let raw: string;
    try {
      raw = fs.readFileSync(fullPath, 'utf8');
    } catch (err) /* c8 ignore start */ {
      report.errors.push(`${filename}: read error: ${(err as Error).message}`);
      continue;
    } /* c8 ignore stop */

    const repaired = repairFrontmatter(raw);
    if (repaired === null) {
      report.skipped++;
      continue;
    }
    for (const f of repaired.fields) {
      report.changes.push({ file: filename, field: f.field, from: f.from, to: f.to });
    }

    if (opts.dryRun) {
      report.fixed++;
      continue;
    }

    try {
      writeFileAtomicSync(fullPath, repaired.text);
      report.fixed++;
    } catch (err) /* c8 ignore start */ {
      report.errors.push(`${filename}: write error: ${(err as Error).message}`);
    } /* c8 ignore stop */
  }

  return report;
}

// ---- CLI entry point -------------------------------------------------------

export default async function fixWpTitlesCmd(argv: string[]): Promise<void> {
  const dryRun = argv.includes('--dry-run');
  const siteRoot = argv.find((a) => !a.startsWith('--')) ?? paths().root;
  console.log(`Scanning ${path.join(siteRoot, 'content', 'posts')}…`);

  const report = fixWpTitles(siteRoot, { dryRun });
  for (const c of report.changes) {
    console.log(`  ${c.file} ${c.field}:`);
    console.log(`    - ${c.from}`);
    console.log(`    + ${c.to}`);
  }
  /* c8 ignore next 3 -- only reachable via the c8-ignored read/write error handlers */
  if (report.errors.length > 0) {
    for (const e of report.errors) console.error(`  error: ${e}`);
  }
  console.log(
    `Done. ${dryRun ? 'Would fix' : 'Fixed'}: ${report.fixed}  Already clean: ${report.skipped}  Errors: ${report.errors.length}`
  );
  if (report.fixed > 0 && !dryRun) {
    console.log('Run `site-admin reindex` to update the SQLite index.');
  }
}
