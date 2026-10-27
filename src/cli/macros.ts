// `site-admin macros [--update <name>]` — list seed macros whose site copy is
// missing or differs from the shipped file, or overwrite one from its seed.

import fs from 'node:fs';
import path from 'node:path';

import { paths } from '../lib/config.ts';
import { diffSeedMacros, updateSiteMacro } from '../lib/macro-library.ts';

export default async function macrosCmd(argv: string[]): Promise<void> {
  const root = paths().root;
  if (argv.length === 0) {
    for (const name of diffSeedMacros(root)) {
      const present = fs.existsSync(path.join(root, 'macros', `${name}.json`));
      console.log(`${name}\t${present ? 'differs' : 'missing'}`);
    }
    return;
  }
  const name = argv[1];
  if (argv[0] !== '--update' || !name || argv.length > 2) {
    throw new Error('usage: site-admin macros [--update <name>]');
  }
  updateSiteMacro(root, name);
  console.log(`macros: updated ${name}`);
}
