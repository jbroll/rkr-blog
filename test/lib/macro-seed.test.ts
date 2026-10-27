import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import init from '../../src/cli/init.ts';
import { paths } from '../../src/lib/config.ts';
import {
  diffSeedMacros,
  loadMacroLibrary,
  seedMacrosDir,
  seedSiteMacros,
  updateSiteMacro
} from '../../src/lib/macro-library.ts';

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
  it('ships the section seeds, loads them without warnings, and has no page root macro', () => {
    const dir = seedMacrosDir();
    const names = [
      'hero',
      'cards',
      'logo-wall',
      'split',
      'photo-callout',
      'people-grid',
      'icon-grid',
      'marquee-band'
    ];
    for (const name of names) {
      assert.ok(fs.existsSync(path.join(dir, `${name}.json`)), `missing seed ${name}`);
    }
    assert.equal(fs.existsSync(path.join(dir, 'cards-3.json')), false);
    assert.equal(fs.existsSync(path.join(dir, 'page.json')), false);
    const warnings: string[] = [];
    const lib = loadMacroLibrary(dir, { warn: (_o, msg) => warnings.push(msg) });
    assert.deepEqual(warnings, []);
    assert.deepEqual([...lib.keys()].sort(), [...names].sort());
    for (const [name, def] of lib) {
      assert.ok(def.description, `${name} has no description`);
      assert.ok(def.fieldSchema, `${name} has no fieldSchema`);
    }
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

  it('diffSeedMacros lists a changed and a missing seed but not an identical one', (t: TestContext) => {
    const root = withSiteRoot(t);
    seedSiteMacros(root);
    assert.deepEqual(diffSeedMacros(root), []);
    fs.writeFileSync(path.join(root, 'macros', 'hero.json'), '{}\n');
    fs.rmSync(path.join(root, 'macros', 'split.json'));
    assert.deepEqual(diffSeedMacros(root), ['hero', 'split']);
  });

  it('seedSiteMacros never overwrites and updateSiteMacro replaces one file', (t: TestContext) => {
    const root = withSiteRoot(t);
    seedSiteMacros(root);
    const hero = path.join(root, 'macros', 'hero.json');
    const cards = path.join(root, 'macros', 'cards.json');
    fs.writeFileSync(hero, '{}\n');
    fs.writeFileSync(cards, '{}\n');
    assert.deepEqual(seedSiteMacros(root), []);
    assert.equal(fs.readFileSync(hero, 'utf8'), '{}\n');
    updateSiteMacro(root, 'hero');
    assert.deepEqual(diffSeedMacros(root), ['cards']);
    assert.throws(() => updateSiteMacro(root, 'nope'), /no seed macro/);
  });
});
