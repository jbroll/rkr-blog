// `site-admin jobs:failed` — list jobs with state='failed' from the
// jobs queue. Useful for diagnosing renders that never landed (e.g.
// the user's "missing after an hour" symptom): each row carries the
// error message + payload so an operator can see why the worker
// gave up.

import path from 'node:path';

import { paths } from '../lib/config.ts';
import { open } from '../lib/db.ts';

interface FailedRow {
  id: number;
  kind: string;
  payload: string;
  attempts: number;
  error: string | null;
  updated_at: string;
  cache_key: string | null;
}

export default async function jobsCmd(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (sub !== 'failed') {
    console.error('usage: site-admin jobs failed');
    process.exit(2);
  }
  const dbPath = path.join(paths().root, 'data', 'site.db');
  const db = open(dbPath);
  try {
    const rows = db
      .prepare<FailedRow>(
        `SELECT id, kind, payload, attempts, error, updated_at, cache_key
           FROM jobs
          WHERE state = 'failed'
          ORDER BY updated_at DESC
          LIMIT 200`
      )
      .all();
    if (rows.length === 0) {
      console.log('no failed jobs');
      return;
    }
    console.log(`${rows.length} failed job(s):`);
    for (const r of rows) {
      const errLine = (r.error ?? '').replace(/\n/g, ' ').slice(0, 200);
      console.log(
        `#${r.id} ${r.kind} attempts=${r.attempts} updated=${r.updated_at} cache_key=${
          r.cache_key ?? '-'
        }`
      );
      if (errLine) console.log(`  error: ${errLine}`);
    }
  } finally {
    db.close();
  }
}
