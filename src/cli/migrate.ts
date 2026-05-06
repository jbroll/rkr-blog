// `site-admin migrate` — run pending migrations against $SITE_ROOT/data/site.db.

import fs from 'node:fs';
import path from 'node:path';

import { paths } from '../lib/config.ts';
import { open } from '../lib/db.ts';
import { migrate } from '../lib/migrate.ts';

export default function runMigrate(): void {
  const p = paths();
  fs.mkdirSync(path.dirname(p.db), { recursive: true });

  const db = open(p.db);
  try {
    const applied = migrate(db);
    if (applied.length === 0) {
      console.log('migrate: nothing to apply (database up to date)');
    } else {
      console.log(`migrate: applied ${applied.join(', ')}`);
    }
  } finally {
    db.close();
  }
}
