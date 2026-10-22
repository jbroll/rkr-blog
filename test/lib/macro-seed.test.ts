import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import init from '../../src/cli/init.ts';
import { paths } from '../../src/lib/config.ts';
import { loadMacroLibrary, seedMacrosDir } from '../../src/lib/macro-library.ts';

function withSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-macro-seed-'));
  const prev = process.env.SITE_ROOT;
  process.env.SITE_ROOT = root;
  t.after(() => {
    if (prev === undefined) delete process.env.SITE_ROOT;
    else process.env.SITE_ROOT = prev;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

describe('macro seeding', () => {
  it('ships page, hero, cards-3, and logo-wall seeds', () => {
    const dir = seedMacrosDir();
    for (const name of ['page', 'hero', 'cards-3', 'logo-wall']) {
      assert.ok(fs.existsSync(path.join(dir, `${name}.json`)), `missing seed ${name}`);
    }
    const lib = loadMacroLibrary(dir);
    assert.ok(lib.has('page') && lib.has('hero'));
  });

  it('init copies seeds into a fresh site root without overwriting', (t: TestContext) => {
    const root = withSiteRoot(t);
    init();
    const macrosDir = paths().macros;
    assert.ok(fs.existsSync(path.join(macrosDir, 'hero.json')));
    assert.equal(loadMacroLibrary(macrosDir).has('hero'), true);
    void root;
  });

  it('init leaves customized macros alone', (t: TestContext) => {
    withSiteRoot(t);
    init();
    const heroPath = path.join(paths().macros, 'hero.json');
    fs.writeFileSync(heroPath, '{"custom": true}\n');
    init();
    assert.equal(fs.readFileSync(heroPath, 'utf8'), '{"custom": true}\n');
  });
});
