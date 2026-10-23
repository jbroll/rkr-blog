// Guard for the JSON cutover: the markdown editor and its write
// endpoints were retired in Task 3. E2E specs must exercise a live
// surface (the blocks editor or the public pages), never the removed
// URLs — a stale spec would look green only because its request 404s
// silently in a setup helper.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const E2E_DIR = path.join(import.meta.dirname, 'e2e');

// Built from pieces so this guard file cannot match itself if it ever
// moves under test/e2e/.
const RETIRED_ROUTES = ['/admin/' + 'editor', '/admin/' + 'posts', '/admin/' + 'post-bundle'];

test('e2e specs do not reference retired markdown routes', () => {
  const offenders: string[] = [];
  for (const file of fs.readdirSync(E2E_DIR)) {
    if (!file.endsWith('.ts')) continue;
    // Regex literals escape slashes (`\/admin\/editor`); normalise so
    // both string and regex forms are caught.
    const content = fs.readFileSync(path.join(E2E_DIR, file), 'utf8').replaceAll('\\', '');
    const hit = RETIRED_ROUTES.find((route) => content.includes(route));
    if (hit) offenders.push(`${file}: ${hit}`);
  }
  assert.deepEqual(offenders, []);
});
