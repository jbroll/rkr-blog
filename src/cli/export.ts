import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { exportArchive } from '../lib/archive.ts';
import { paths } from '../lib/config.ts';

export default function run(argv: string[]): void {
  let outPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--output' || argv[i] === '-o') && argv[i + 1]) {
      outPath = argv[++i];
    }
  }

  const p = paths();
  if (!fs.existsSync(p.db)) {
    console.error('export: no database found — run migrate first');
    process.exit(1);
  }

  const date = new Date().toISOString().slice(0, 10);
  const dest = outPath ?? path.join(process.cwd(), `rkr-blog-${date}.sqlite`);

  const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  console.error(`exporting to ${dest} …`);
  try {
    const stats = exportArchive(p.root, tmp);
    fs.renameSync(tmp, dest);
    console.error(
      `done: ${stats.files} files, ${stats.comments} comments, ${stats.users} users, ${stats.invites} invites`
    );
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
