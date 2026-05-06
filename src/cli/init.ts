// `site-admin init` — create $SITE_ROOT directory tree if absent, run migrations.

import fs from 'node:fs';

import { paths } from '../lib/config.ts';
import { open } from '../lib/db.ts';
import { migrate } from '../lib/migrate.ts';
import { ensureSecretKey } from '../lib/secrets.ts';

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

  const generatedKey = ensureSecretKey(p.root);

  const db = open(p.db);
  try {
    const applied = migrate(db);
    const migMsg =
      applied.length === 0 ? 'no migrations to apply' : `applied migrations: ${applied.join(', ')}`;
    const keyMsg = generatedKey ? '; generated data/secret.key' : '';
    console.log(`init complete: ${p.root} (${migMsg})${keyMsg}`);
  } finally {
    db.close();
  }
}
