// `site-admin wp-dump <dump.sql> <out.db>` — convert a mysqldump /
// mariadb-dump file into a SQLite database the importer can read
// (`import-wp --from-dump`). One-shot and idempotent.

import { convertDump } from '../lib/wp-dump.ts';

export default async function wpDumpCmd(argv: string[]): Promise<void> {
  const sqlPath = argv[0];
  const dbPath = argv[1];
  if (!sqlPath || !dbPath) {
    throw new Error('usage: site-admin wp-dump <dump.sql> <out.db>');
  }
  const stats = convertDump(sqlPath, dbPath);
  console.log(`${stats.tables} tables, ${stats.rows} rows → ${dbPath}`);
}
