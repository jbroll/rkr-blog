// Writes static/admin/precache.json: the exact URL list the admin
// service worker installs into rkr-admin-<hash>. Generated because
// esbuild's --splitting chunk names aren't knowable ahead of the build.
//
// Cache keys include the query string, so each file is listed under the
// URL it is actually requested at:
//
//   static/admin/**  bare. esbuild's chunks reach each other through
//     relative imports, and relative resolution drops the query — from
//     /admin/static/admin/main.js?v=h, './chunk-A.js' is requested with
//     no query at all. Those names are content-hashed already.
//   everything else  ?v=<hash>, the form the templates stamp.
//
// A file the shell stamps is listed ONLY stamped: nothing relatively
// imports admin/main.js or admin/main.css (the import direction is
// main -> chunks), so a bare entry for them is 475 KB of cache key
// nothing ever requests.

import fs from 'node:fs';
import path from 'node:path';

import { shortGitHash } from '../src/lib/build-info.ts';

export interface Precache {
  hash: string;
  assets: string[];
}

/** Files the shell references by a fixed name. Theme sheets and the
 * static/admin/* build output are enumerated from disk instead.
 *
 * The webmanifest's own icon-192/icon-512 entries are deliberately
 * absent: the browser fetches them unversioned (no `?v=`) at
 * PWA-install time, which happens online, so a versioned precache
 * entry for them would just be a cache key nothing ever requests. */
const FIXED = [
  'base.css',
  'admin-manifest.webmanifest',
  'favicon.ico',
  'icon-32.png',
  'apple-touch-icon.png',
  'site/sw-admin-register.js',
  'site/lightbox.css'
];

function walk(dir: string, rel: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      walk(path.join(dir, entry.name), childRel, out);
    } else if (!entry.name.endsWith('.map') && entry.name !== 'precache.json') {
      out.push(childRel);
    }
  }
}

/** Build output the shell references by name, so it is only ever
 * requested with the stamp. Excluded from the bare walk below. */
const STAMPED = ['admin/main.js', 'admin/main.css'];

export function buildPrecache(repoRoot: string, hash: string): Precache {
  const staticDir = path.join(repoRoot, 'static');
  const walked: string[] = [];
  walk(path.join(staticDir, 'admin'), 'admin', walked);
  const stamped = new Set(STAMPED);
  const bare = walked.filter((r) => !stamped.has(r));

  // A missing file here means the build ran out of order (e.g.
  // build:admin's precache step ran before build:site emitted the file
  // it's referencing) — fail the build rather than ship a manifest
  // silently missing an entry the shell requests.
  const versioned: string[] = [];
  for (const f of STAMPED) {
    const abs = path.join(staticDir, f);
    if (!fs.existsSync(abs)) throw new Error(`gen-precache: missing build output ${abs}`);
    versioned.push(f);
  }

  const themesDir = path.join(staticDir, 'themes');
  if (fs.existsSync(themesDir)) {
    for (const f of fs.readdirSync(themesDir)) {
      // The active theme is runtime config, so every sheet ships.
      if (f.endsWith('.css')) versioned.push(`themes/${f}`);
    }
  }

  for (const f of FIXED) {
    const abs = path.join(staticDir, f);
    if (!fs.existsSync(abs)) throw new Error(`gen-precache: missing fixed asset ${abs}`);
    versioned.push(f);
  }

  const assets = [
    ...bare.map((r) => `/admin/static/${r}`),
    ...versioned.map((r) => `/admin/static/${r}?v=${hash}`)
  ];
  assets.sort();
  return { hash, assets };
}

export function writePrecache(repoRoot: string, hash: string): string {
  const out = path.join(repoRoot, 'static', 'admin', 'precache.json');
  fs.writeFileSync(out, `${JSON.stringify(buildPrecache(repoRoot, hash), null, 2)}\n`, 'utf8');
  return out;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const out = writePrecache(repoRoot, shortGitHash());
  process.stdout.write(`${out}\n`);
}
