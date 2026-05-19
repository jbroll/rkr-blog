import fs from 'node:fs';

import { importArchive } from '../lib/archive.ts';
import { paths } from '../lib/config.ts';

export default function run(argv: string[]): void {
  let archivePath: string | undefined;
  let replace = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--replace') {
      replace = true;
    } else if (!argv[i]?.startsWith('-')) {
      if (archivePath !== undefined) {
        throw new Error(`unexpected extra argument: ${argv[i]}`);
      }
      archivePath = argv[i];
    } else {
      throw new Error(`unknown flag: ${argv[i]}`);
    }
  }

  if (!archivePath) {
    console.error('usage: site-admin import <archive.sqlite> [--replace]');
    process.exit(1);
  }

  if (!fs.existsSync(archivePath)) {
    console.error(`import: file not found: ${archivePath}`);
    process.exit(1);
  }

  const p = paths();

  if (replace) {
    console.error('import: --replace will overwrite all files and wipe comments/users/invites');
  }

  console.error(`importing ${archivePath} …`);
  const stats = importArchive(p.root, archivePath, { replace });
  console.error(
    `done: ${stats.filesWritten} files written, ${stats.filesSkipped} skipped, ` +
      `${stats.comments} comments, ${stats.users} users, ${stats.invites} invites`
  );
}
