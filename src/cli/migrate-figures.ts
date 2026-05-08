// `site-admin migrate-figures` — one-shot rewriter that converts legacy
// image directives in content/posts/*.md to the unified ::figure form
// (spec.md §9 migration plan, step 5).
//
// Mapping mirrors the WP importer (Phase 4):
//   ::image{#ID alt="..." caption="..." position=POS}
//                                              → ::figure{ids="ID" alts="..." caption="..." [justify=POS]}
//   ::diptych{ids="..." ...}                    → ::figure{ids="..." matrix=1x2 ...}
//   ::triptych{ids="..." ...}                   → ::figure{ids="..." matrix=1x3 ...}
//   ::gallery{ids="..." layout=LAYOUT ...}      → ::figure{ids="..." matrix=LAYOUT_OR_NX1 ...}
//                                              (layout=justified|masonry|matrix → matrix=…)
//   ::carousel{ids="..." autoplay=N ...}        → ::figure{ids="..." matrix=1x1 timer=N ...}
//                                              (carousel was 1-image-at-a-time → matrix=1x1)
//
// Position → justify:
//   default → (omit)            full → full           inline → inline
//   left    → left              right → right
//
// Idempotent: re-running on already-migrated content is a no-op (no
// legacy directives to match). Files that contain no legacy directives
// are left untouched (mtime preserved).
//
// Default mode: dry-run, prints a summary. Pass --write to apply.
// Pass --backup to write `<file>.pre-migrate-figures.bak` alongside
// each rewritten file.
//
// Limitation: the parser uses simple regex for quoted attribute
// values (`"..."`). Inner backslash-escaped quotes (`caption="he said
// \"hi\""`) aren't recognised — the directive is left untouched and
// the operator can rewrite it manually after running --write. This
// keeps the rewriter's logic simple; the legacy widgets emit
// backslash-escaped inner quotes only for free-form caption text,
// which is rare in practice.

import fs from 'node:fs';
import path from 'node:path';

import { paths } from '../lib/config.ts';

interface CliOpts {
  write: boolean;
  backup: boolean;
  postsDir: string;
}

function parseArgs(argv: string[]): CliOpts {
  let write = false;
  let backup = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') write = true;
    else if (a === '--backup') backup = true;
    else if (a === '--help' || a === '-h') {
      throw new Error(
        'usage: site-admin migrate-figures [--write] [--backup]\n' +
          '  default mode is dry-run; --write applies the rewrite.\n' +
          '  --backup writes <file>.pre-migrate-figures.bak alongside each modified file.'
      );
    } else throw new Error(`unknown flag: ${a}`);
  }
  return { write, backup, postsDir: path.join(paths().root, 'content', 'posts') };
}

interface RewriteResult {
  newText: string;
  /** Per-directive change counts so the summary is informative. */
  counts: { image: number; diptych: number; triptych: number; gallery: number; carousel: number };
}

export function rewriteMarkdown(src: string): RewriteResult {
  const counts = { image: 0, diptych: 0, triptych: 0, gallery: 0, carousel: 0 };

  // Single-image: ::image{#ID alt="..." caption="..." position=POS}
  // The shorthand `#ID` form (no `id="..."`) is the form prose-markdown
  // emits, so we match it specifically. We also handle the rarer
  // `id="..."` form for completeness.
  let out = src.replace(
    /::image\{#([0-9a-f]{6,64})((?:\s+[a-z]+=(?:"[^"]*"|[^\s}]+))*)\}/gi,
    (_match, id: string, attrTail: string) => {
      counts.image++;
      const attrs = parseAttrPairs(attrTail);
      const altsAttr = attrs.alt ? ` alts=${quoteCsv(attrs.alt)}` : '';
      const captionAttr = attrs.caption ? ` caption=${quoteCsv(attrs.caption)}` : '';
      const justifyAttr = positionToJustify(attrs.position);
      // Single id → no matrix attribute (defaults to 1x1).
      return `::figure{ids="${id}"${altsAttr}${captionAttr}${justifyAttr}}`;
    }
  );

  out = out.replace(
    /::image\{((?:\s*[a-z]+=(?:"[^"]*"|[^\s}]+))*?\s*)\}/gi,
    (match, attrTail: string) => {
      const attrs = parseAttrPairs(attrTail);
      if (!attrs.id) return match; // no id, leave alone (will render as a comment)
      counts.image++;
      const altsAttr = attrs.alt ? ` alts=${quoteCsv(attrs.alt)}` : '';
      const captionAttr = attrs.caption ? ` caption=${quoteCsv(attrs.caption)}` : '';
      const justifyAttr = positionToJustify(attrs.position);
      return `::figure{ids="${attrs.id}"${altsAttr}${captionAttr}${justifyAttr}}`;
    }
  );

  // Multi-image: ::diptych / ::triptych / ::gallery / ::carousel
  // Match the directive name + the entire {...} body.
  out = out.replace(
    /::(diptych|triptych|gallery|carousel)\{([^}]*)\}/gi,
    (_match, kind: string, body: string) => {
      const attrs = parseAttrPairs(body);
      if (!attrs.ids) return _match; // no ids, leave alone
      const k = kind.toLowerCase() as 'diptych' | 'triptych' | 'gallery' | 'carousel';
      counts[k]++;
      return rewriteMultiImage(k, attrs);
    }
  );

  return { newText: out, counts };
}

function rewriteMultiImage(
  kind: 'diptych' | 'triptych' | 'gallery' | 'carousel',
  attrs: Record<string, string>
): string {
  const idsAttr = `ids="${attrs.ids ?? ''}"`;
  const altsAttr = attrs.alts ? ` alts=${quoteCsv(attrs.alts)}` : '';
  const captionAttr = attrs.caption ? ` caption=${quoteCsv(attrs.caption)}` : '';

  let matrixAttr = '';
  let timerAttr = '';

  if (kind === 'diptych') {
    matrixAttr = ' matrix=1x2';
  } else if (kind === 'triptych') {
    matrixAttr = ' matrix=1x3';
  } else if (kind === 'gallery') {
    // Legacy gallery had layout=justified | masonry | matrix. Map
    // straight across — the unified directive accepts the same names
    // as matrix= values.
    const layout = attrs.layout ?? 'justified';
    if (layout === 'matrix') {
      // Legacy matrix-layout gallery had no shape; pick a reasonable
      // default. ceil(sqrt(N)) rows × cols but we don't know N here
      // without parsing ids — fall back to 1xN-style by leaving matrix
      // unset (default 1x1 with overflow → carousel). The author can
      // fix the matrix manually.
      matrixAttr = '';
    } else {
      matrixAttr = ` matrix=${layout}`;
    }
  } else if (kind === 'carousel') {
    // Legacy carousel was one-image-at-a-time (matrix=1x1) with
    // optional autoplay. autoplay=N → timer=N.
    matrixAttr = ' matrix=1x1';
    if (attrs.autoplay) {
      const n = Number(attrs.autoplay);
      if (Number.isFinite(n) && n > 0) timerAttr = ` timer=${Math.min(60, Math.floor(n))}`;
    }
  }

  return `::figure{${idsAttr}${matrixAttr}${altsAttr}${captionAttr}${timerAttr}}`;
}

/**
 * Map a legacy ::image position attribute to a ::figure justify
 * attribute. The `default` and `inline` positions both have direct
 * justify equivalents; `full` / `left` / `right` are unchanged.
 */
function positionToJustify(position: string | undefined): string {
  if (!position || position === 'default') return ''; // center is the default; omit
  if (position === 'full' || position === 'left' || position === 'right' || position === 'inline') {
    return ` justify=${position}`;
  }
  return '';
}

/**
 * Parse the attribute portion of a directive body (everything between
 * `{` and `}`, or after the leading `#id`) into a record of key→value.
 * Quoted values may contain spaces and `=` signs; bare values may not.
 */
function parseAttrPairs(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-z][a-z0-9-]*)=(?:"([^"]*)"|([^\s}]+))/gi;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-loop idiom
  while ((m = re.exec(body)) !== null) {
    const key = (m[1] ?? '').toLowerCase();
    const val = m[2] !== undefined ? m[2] : (m[3] ?? '');
    out[key] = val;
  }
  return out;
}

/**
 * Quote a value for emission — same rules as the legacy quote helper:
 * escape backslashes and double-quotes, wrap in `"..."`. The argument
 * is already-decoded text from a parsed attribute, so we don't double-
 * escape `\\"` etc.
 */
function quoteCsv(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export default async function migrateFiguresCmd(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  if (!fs.existsSync(opts.postsDir)) {
    console.log(`migrate-figures: posts dir does not exist (${opts.postsDir}); nothing to do.`);
    return;
  }

  const files = fs.readdirSync(opts.postsDir).filter((f) => f.endsWith('.md'));
  if (files.length === 0) {
    console.log(`migrate-figures: no .md files in ${opts.postsDir}; nothing to do.`);
    return;
  }

  const totals = { image: 0, diptych: 0, triptych: 0, gallery: 0, carousel: 0 };
  let changedFiles = 0;
  for (const filename of files) {
    const full = path.join(opts.postsDir, filename);
    const src = fs.readFileSync(full, 'utf8');
    const { newText, counts } = rewriteMarkdown(src);
    const changed =
      counts.image + counts.diptych + counts.triptych + counts.gallery + counts.carousel;
    if (changed === 0 || newText === src) continue;
    changedFiles++;
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += counts[k];

    const summary = `${filename}: image=${counts.image} diptych=${counts.diptych} triptych=${counts.triptych} gallery=${counts.gallery} carousel=${counts.carousel}`;
    if (opts.write) {
      if (opts.backup) {
        fs.writeFileSync(`${full}.pre-migrate-figures.bak`, src, 'utf8');
      }
      fs.writeFileSync(full, newText, 'utf8');
      console.log(`  rewrote ${summary}`);
    } else {
      console.log(`  would rewrite ${summary}`);
    }
  }

  const totalDirs =
    totals.image + totals.diptych + totals.triptych + totals.gallery + totals.carousel;
  const verb = opts.write ? 'rewrote' : 'would rewrite';
  console.log(
    `migrate-figures: ${verb} ${changedFiles} file(s), ${totalDirs} directive(s) total ` +
      `(image=${totals.image} diptych=${totals.diptych} triptych=${totals.triptych} ` +
      `gallery=${totals.gallery} carousel=${totals.carousel})${opts.write ? '' : ' — re-run with --write to apply'}.`
  );
}
