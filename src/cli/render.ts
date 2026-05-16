// `site-admin render` — pre-warm the cache by rendering every declared
// (variant, output) for every sidecar (or the filtered subset).
//
// Flags:
//   --post <slug>      only images referenced by that post (Step 4 placeholder
//                       scan; full directive parsing lands in Step 5)
//   --since <iso-date> only sidecars whose source.fetched is ≥ the given date
//   --force            re-render existing cache files
//   --concurrency N    override default (os.cpus().length - 1, min 1)

import os from 'node:os';

import { paths } from '../lib/config.ts';
import { open } from '../lib/db.ts';
import { workQueue } from '../lib/jobs.ts';
import { migrate } from '../lib/migrate.ts';
import { imageIdsForPost, listSidecars } from '../lib/posts.ts';
import type { Op, Output, OutputFormat, Variant } from '../lib/render.ts';
import { renderDerivative } from '../lib/render.ts';

interface RenderFlags {
  post?: string;
  since?: string;
  force: boolean;
  concurrency: number;
}

function parseArgs(argv: string[]): RenderFlags {
  const flags: RenderFlags = {
    force: false,
    concurrency: Math.max(1, os.cpus().length - 1)
  };
  const takeValue = (i: number, flag: string): string => {
    if (i + 1 >= argv.length) throw new Error(`${flag} requires a value`);
    return argv[i + 1] as string;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--post') {
      flags.post = takeValue(i, '--post');
      i++;
    } else if (arg === '--since') {
      flags.since = takeValue(i, '--since');
      i++;
    } else if (arg === '--force') {
      flags.force = true;
    } else if (arg === '--concurrency') {
      const n = Number(takeValue(i, '--concurrency'));
      i++;
      if (!Number.isFinite(n) || n < 1) {
        throw new Error('--concurrency must be a positive integer');
      }
      flags.concurrency = n;
    } else {
      throw new Error(`unknown flag: ${String(arg)}`);
    }
  }
  return flags;
}

interface RenderTask {
  originalId: string;
  ops: Op[];
  variant: Variant;
  output: Output;
}

export default async function renderCmd(argv: string[]): Promise<void> {
  const flags = parseArgs(argv);
  await runRender(paths().root, flags);
}

/** Exposed for tests: run the render command logic against a given site root. */
export async function runRender(
  siteRoot: string,
  flags: Partial<RenderFlags> = {}
): Promise<{ rendered: number; cached: number; errors: number }> {
  const opts: RenderFlags = {
    force: flags.force ?? false,
    concurrency: flags.concurrency ?? Math.max(1, os.cpus().length - 1),
    ...(flags.post !== undefined ? { post: flags.post } : {}),
    ...(flags.since !== undefined ? { since: flags.since } : {})
  };

  const db = open(`${siteRoot}/data/site.db`);
  migrate(db);

  let sidecars = await listSidecars(siteRoot);

  if (opts.post) {
    const ids = imageIdsForPost(siteRoot, opts.post);
    if (ids === null) throw new Error(`no post with slug=${opts.post}`);
    sidecars = sidecars.filter((s) => ids.has(s.original));
  }

  if (opts.since) {
    const cutoff = Date.parse(opts.since);
    if (Number.isNaN(cutoff)) throw new Error(`--since: invalid date ${opts.since}`);
    sidecars = sidecars.filter((s) => {
      const fetched = s.source.fetched ? Date.parse(s.source.fetched) : 0;
      return fetched >= cutoff;
    });
  }

  // Build the task list: sidecar × variant × output.
  const tasks: RenderTask[] = [];
  for (const s of sidecars) {
    for (const v of s.variants) {
      const variant: Variant = {
        ...(v.w !== undefined ? { w: v.w } : {}),
        ...(v.h !== undefined ? { h: v.h } : {}),
        ...(v.fit !== undefined ? { fit: v.fit as Variant['fit'] } : {})
      };
      for (const o of s.outputs) {
        const output: Output = {
          format: o.format as OutputFormat,
          ...(o.quality !== undefined ? { quality: o.quality } : {})
        };
        tasks.push({
          originalId: s.original,
          ops: s.ops as Op[],
          variant,
          output
        });
      }
    }
  }

  let rendered = 0;
  let cached = 0;
  let errors = 0;

  await runWithConcurrency(tasks, opts.concurrency, async (t) => {
    try {
      const r = await renderDerivative({ ...t, siteRoot, force: opts.force });
      if (r.cached) cached++;
      else rendered++;
    } catch (err) {
      errors++;
      console.error(`render failed (${t.originalId.slice(0, 8)}…): ${(err as Error).message}`);
    }
  });

  console.log(
    `render: ${rendered} rendered, ${cached} cached, ${errors} errors ` +
      `(${sidecars.length} sidecars, ${tasks.length} variants)`
  );

  // Drain any queued jobs (e.g. classify) enqueued during or before this run.
  await workQueue({ db, ctx: { siteRoot, db }, drainAndExit: true }).done;

  db.close();

  return { rendered, cached, errors };
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      const item = items[idx];
      if (item === undefined) return;
      await fn(item);
    }
  });
  await Promise.all(workers);
}
