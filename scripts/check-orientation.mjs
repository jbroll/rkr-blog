#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
// check-orientation.mjs — verify every image rendered on a target site
// has the same landscape/portrait orientation as its WordPress source
// declares. Companion to walk-site.sh: that one only HEADs every image
// for a 2xx response, which passes for a photo rendered sideways
// because the bytes still resolve — they're just rotated 90°.
//
// Catches wp-import regressions where, for instance, WP's srcset entry
// `<file>-rotated.jpeg` (the orientation-baked variant) gets missed
// and the unrotated landscape master is fetched + ingested instead.
// See the wp-import.ts srcSet fix for the canonical bug.
//
// Usage:
//   scripts/check-orientation.mjs <wp-base> <target-base> [slug]
//
// Examples:
//   scripts/check-orientation.mjs \
//     https://roll-along.rkroll.com https://rkr-blog.fly.dev
//   scripts/check-orientation.mjs \
//     https://roll-along.rkroll.com https://rkr-blog.fly.dev first-2-days-on-the-boats
//
// Strategy per post:
//   1. Fetch the target's rendered HTML; collect each <img src> in
//      source order. Restricted to the /img/ derivative path the
//      figure widget emits, so off-site embeds don't pollute the
//      comparison.
//   2. Fetch the WordPress REST payload for the same slug; parse the
//      rendered content's <img width="W" height="H"> in source order.
//      Positional pairing: 1st target img ↔ 1st WP img, etc.
//   3. Fetch each target image's bytes, probe dimensions with sharp.
//      Compare aspect mode (landscape / portrait / square) against the
//      WP-declared dims.
//   4. Mismatch → print a per-image FAIL line + bump the exit-1 count.
//
// Aspect mode (not exact ratio) is the right granularity: rkroll's
// render pipeline resizes / changes the aspect ratio (output variant
// picks the biggest size that fits), but it doesn't flip orientation.
// A landscape ↔ portrait swap means the rotation pipeline dropped
// information somewhere.
//
// Exit codes:
//   0 — every paired image's orientation matches the WP source.
//   1 — at least one image's orientation flipped (regression detected).
//   2 — bad args, network failure, or per-post WP/target retrieval
//       failure (the run couldn't complete).

import sharp from 'sharp';

const [, , wpBase, targetBase, slugArg] = process.argv;
if (!wpBase || !targetBase) {
  console.error(
    'usage: scripts/check-orientation.mjs <wp-base> <target-base> [slug]'
  );
  process.exit(2);
}

const WP = wpBase.replace(/\/$/, '');
const TARGET = targetBase.replace(/\/$/, '');

/** Aspect mode at the granularity we actually care about. Anything
 * within 5% of square reads as square; a flip from landscape to
 * portrait (or back) is the only signal we want to flag. */
function aspectMode(w, h) {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 'unknown';
  const r = w / h;
  if (r > 1.05) return 'landscape';
  if (r < 0.95) return 'portrait';
  return 'square';
}

/** Slug list to walk. Either the operator-provided single slug, or
 * every published post on the target (same paginated index walk-site
 * uses). */
async function listTargetSlugs() {
  if (slugArg) return [slugArg];
  const slugs = [];
  for (let page = 1; page <= 200; page++) {
    const r = await fetch(`${TARGET}/?page=${page}`);
    if (!r.ok) {
      console.error(`ERROR: GET ${TARGET}/?page=${page} -> ${r.status}`);
      process.exit(2);
    }
    const html = await r.text();
    const found = new Set();
    // /<slug> hrefs, single segment, not /static /admin /img.
    const re = /href="\/([^"/]+)"/g;
    for (const m of html.matchAll(re)) {
      const s = m[1];
      if (!/^(static|admin|img)$/.test(s)) found.add(s);
    }
    if (found.size === 0) break;
    for (const s of found) if (!slugs.includes(s)) slugs.push(s);
  }
  return slugs;
}

async function targetImageSrcs(slug) {
  const r = await fetch(`${TARGET}/${slug}`);
  if (!r.ok) throw new Error(`target post ${slug}: ${r.status}`);
  const html = await r.text();
  // Figure widget renders <img src="/img/<id>.<hash>.<fmt>">; restrict
  // the match so icons / off-site embeds don't slip into the list.
  const re = /<img [^>]*src="(\/img\/[^"]+)"/g;
  const out = [];
  for (const m of html.matchAll(re)) out.push(m[1]);
  return out;
}

async function wpImageDims(slug) {
  const r = await fetch(
    `${WP}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&_fields=content`
  );
  if (!r.ok) throw new Error(`WP REST ${slug}: ${r.status}`);
  const arr = await r.json();
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error(`WP REST ${slug}: no such post`);
  }
  const html = arr[0].content.rendered;
  const out = [];
  // WP serves `<img width="W" height="H">` for every block image.
  // Some embeds (older themes) omit dims; we skip those rather than
  // guess.
  const re = /<img\b[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"/g;
  for (const m of html.matchAll(re)) {
    out.push({ width: Number(m[1]), height: Number(m[2]) });
  }
  return out;
}

async function probeTargetImage(src) {
  const r = await fetch(`${TARGET}${src}`);
  if (!r.ok) throw new Error(`target img ${src}: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const meta = await sharp(buf).metadata();
  return { width: meta.width, height: meta.height };
}

let postCount = 0;
let mismatchCount = 0;
let mismatchedPosts = 0;
let skippedPosts = 0;

const slugs = await listTargetSlugs();
console.log(`==> checking ${slugs.length} post(s) against ${WP}`);

for (const slug of slugs) {
  postCount++;
  let targetSrcs, wpDims;
  try {
    [targetSrcs, wpDims] = await Promise.all([
      targetImageSrcs(slug),
      wpImageDims(slug)
    ]);
  } catch (err) {
    console.error(`SKIP ${slug}: ${err.message}`);
    skippedPosts++;
    continue;
  }
  if (targetSrcs.length === 0 && wpDims.length === 0) {
    console.log(`${slug.padEnd(45)} 0 images`);
    continue;
  }
  // Pair positionally up to the shorter list. A length mismatch flags
  // a separate kind of regression (some images dropped on import) but
  // doesn't necessarily mean an orientation bug for the pairs we can
  // compare.
  const pairs = Math.min(targetSrcs.length, wpDims.length);
  let postMismatches = 0;
  for (let i = 0; i < pairs; i++) {
    const wp = wpDims[i];
    const wpMode = aspectMode(wp.width, wp.height);
    let actual;
    try {
      actual = await probeTargetImage(targetSrcs[i]);
    } catch (err) {
      console.error(`  img ${i}: probe failed: ${err.message}`);
      postMismatches++;
      continue;
    }
    const actualMode = aspectMode(actual.width, actual.height);
    if (wpMode !== actualMode && wpMode !== 'unknown' && actualMode !== 'unknown') {
      postMismatches++;
      mismatchCount++;
      console.error(
        `  ${slug} img[${i}] FAIL: wp=${wp.width}×${wp.height} (${wpMode}) ` +
          `target=${actual.width}×${actual.height} (${actualMode}) ${targetSrcs[i]}`
      );
    }
  }
  if (postMismatches > 0) mismatchedPosts++;
  const lenNote =
    targetSrcs.length === wpDims.length
      ? `${pairs} paired`
      : `${pairs} paired (target ${targetSrcs.length} vs wp ${wpDims.length})`;
  const verdict = postMismatches === 0 ? 'ok' : `FAIL × ${postMismatches}`;
  console.log(`${slug.padEnd(45)} ${verdict}  · ${lenNote}`);
}

console.log('----');
console.log(
  `summary: posts=${postCount} mismatched_posts=${mismatchedPosts} ` +
    `mismatched_images=${mismatchCount} skipped_posts=${skippedPosts}`
);
if (mismatchCount > 0) process.exit(1);
if (skippedPosts > 0) process.exit(2);
