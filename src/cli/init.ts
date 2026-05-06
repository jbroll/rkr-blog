// `site-admin init` — create $SITE_ROOT directory tree if absent, run migrations.

import fs from 'node:fs';

import { paths } from '../lib/config.ts';
import { open } from '../lib/db.ts';
import { migrate } from '../lib/migrate.ts';

export default function init(): void {
  const p = paths();

  const dirs = [
    p.root,
    p.originals,
    p.sidecars,
    p.cache,
    p.cacheImg,
    p.content,
    p.contentPosts,
    p.data,
    p.static
  ];

  for (const d of dirs) {
    fs.mkdirSync(d, { recursive: true });
  }

  const db = open(p.db);
  try {
    const applied = migrate(db);
    if (applied.length === 0) {
      console.log(`init complete: ${p.root} (no migrations to apply)`);
    } else {
      console.log(`init complete: ${p.root} (applied migrations: ${applied.join(', ')})`);
    }
  } finally {
    db.close();
  }
}
