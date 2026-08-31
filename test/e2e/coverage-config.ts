// Shared monocart-coverage-reports options. The per-test fixture
// (coverage-fixtures.ts) and the report generator (global-teardown.ts)
// both construct a CoverageReport, and mcr applies the filters at both
// add() and generate() time: if the two disagree the emitted report
// includes files the fixture dropped. One object, imported twice.

import fs from 'node:fs';
import path from 'node:path';

// Read source maps directly from disk instead of fetching via HTTP.
// The default resolver issues HTTP GETs to the running test server;
// in global-teardown the server is already stopped, and during tests
// the version query string on main.js and site bundles may confuse
// URL matching. Disk reads are reliable in both phases.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sourceMapResolver = async (url: string, defaultResolver: any): Promise<unknown> => {
  const match = url.match(/\/(static\/(?:admin|site)\/.+\.map)$/);
  if (match) {
    const localPath = path.join(process.cwd(), match[1]!);
    if (fs.existsSync(localPath)) {
      return JSON.parse(fs.readFileSync(localPath, 'utf8')) as unknown;
    }
  }
  return defaultResolver(url);
};

// esbuild emits runtime-helper chunks whose sourcemap carries no
// sources at all. Nothing unpacks out of them, so they survive
// sourceFilter and reach the report as raw dist files, which then seed
// the union ratchet baseline with keys that match no source file.
const mapSources = new Map<string, number>();
const hasOwnSources = (url: string): boolean => {
  const rel = url.split('?')[0]?.match(/\/(static\/(?:admin|site)\/.+\.js)$/)?.[1];
  if (!rel) return true;
  let count = mapSources.get(rel);
  if (count === undefined) {
    const mapPath = path.join(process.cwd(), `${rel}.map`);
    count = fs.existsSync(mapPath)
      ? ((JSON.parse(fs.readFileSync(mapPath, 'utf8')) as { sources?: unknown[] }).sources
          ?.length ?? 0)
      : 1;
    mapSources.set(rel, count);
  }
  return count > 0;
};

// Source filtering: keep only OUR code. Without this the report
// includes node_modules (TipTap, ProseMirror, PhotoSwipe).
// entryFilter narrows the V8 entries (bundle URLs); sourceFilter
// narrows source paths after sourcemap unpacking. src/lib/ files
// imported into the admin/site bundle are tracked too — server-only
// lib files (db.ts, migrate.ts, etc.) never reach the bundle so the
// V8 data won't include them. The workspace canvas layer is bundled
// into static/admin/main.js and is unreachable from the c8 unit gate
// (it needs a DOM), so e2e is the only place it can be measured.
const SOURCE_PREFIXES = ['src/admin/', 'src/site/', 'src/lib/', 'packages/image-edit/src/canvas/'];

export const coverageOptions = {
  name: 'rkroll e2e (admin SPA + public site)',
  outputDir: './coverage/e2e',
  reports: ['v8', 'lcovonly', 'console-details'],
  entryFilter: (entry: { url: string }) =>
    (entry.url.includes('/static/admin/') || entry.url.includes('/static/site/')) &&
    hasOwnSources(entry.url),
  sourceFilter: (sourcePath: string) =>
    !sourcePath.includes('node_modules/') && SOURCE_PREFIXES.some((p) => sourcePath.includes(p)),
  sourceMapResolver,
  // esbuild stores source paths relative to the bundle (e.g.
  // '../../src/admin/toast.ts' relative to static/admin/main.js).
  // monocart resolves these from process.cwd(), producing '../admin/toast.ts'
  // which fails the sourceFilter. Re-resolve against the dist dir instead.
  // The dist dir has to be anchored on the last 'static/' segment: the
  // admin shell loads main.js both as /static/admin/main.js and as
  // /admin/static/admin/main.js, and any host-relative slicing maps the
  // two URLs to different paths, splitting one file across two rows.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sourcePath: (sp: string, info: { distFile?: string; [key: string]: any }) => {
    const url: string | undefined = info.url;
    if (!url?.startsWith('../') || !info.distFile) return sp;
    const at = info.distFile.lastIndexOf('static/');
    if (at < 0) return sp;
    const anchored = info.distFile.slice(at);
    return path.normalize(path.join(path.dirname(anchored), url));
  }
};
