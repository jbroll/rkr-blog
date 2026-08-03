// Writes static/admin/precache.json: the exact URL list the admin
// service worker installs into rkr-admin-<hash>. Generated because
// esbuild's --splitting chunk names aren't knowable ahead of the build.
//
// Every URL carries the ?v=<hash> suffix the templates stamp — cache
// keys include the query string, so an entry without it would never
// match the request the page actually makes.

import fs from 'node:fs';
import path from 'node:path';

import { resolveGitHash } from '../src/lib/build-info.ts';

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

export function buildPrecache(repoRoot: string, hash: string): Precache {
  const staticDir = path.join(repoRoot, 'static');
  const rels: string[] = [];
  walk(path.join(staticDir, 'admin'), 'admin', rels);

  const themesDir = path.join(staticDir, 'themes');
  if (fs.existsSync(themesDir)) {
    for (const f of fs.readdirSync(themesDir)) {
      // The active theme is runtime config, so every sheet ships.
      if (f.endsWith('.css')) rels.push(`themes/${f}`);
    }
  }

  for (const f of FIXED) {
    // A missing fixed asset means the build ran out of order (e.g.
    // build:admin's precache step ran before build:site emitted the
    // file it's referencing) — fail the build rather than ship a
    // manifest silently missing an entry the shell requests.
    const abs = path.join(staticDir, f);
    if (!fs.existsSync(abs)) throw new Error(`gen-precache: missing fixed asset ${abs}`);
    rels.push(f);
  }

  rels.sort();
  return { hash, assets: rels.map((r) => `/admin/static/${r}?v=${hash}`) };
}

export function writePrecache(repoRoot: string, hash: string): string {
  const out = path.join(repoRoot, 'static', 'admin', 'precache.json');
  fs.writeFileSync(out, `${JSON.stringify(buildPrecache(repoRoot, hash), null, 2)}\n`, 'utf8');
  return out;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const out = writePrecache(repoRoot, resolveGitHash().slice(0, 12));
  process.stdout.write(`${out}\n`);
}
