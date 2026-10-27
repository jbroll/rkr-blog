import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import macrosCmd from '../../src/cli/macros.ts';
import { seedMacrosDir, seedSiteMacros } from '../../src/lib/macro-library.ts';

function withSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-cli-macros-'));
  const prev = process.env.SITE_ROOT;
  process.env.SITE_ROOT = root;
  seedSiteMacros(root);
  t.after(() => {
    if (prev === undefined) delete process.env.SITE_ROOT;
    else process.env.SITE_ROOT = prev;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function captureLog(t: TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(console, 'log', (...a: unknown[]) => lines.push(a.join(' ')));
  return lines;
}

describe('site-admin macros', () => {
  it('prints nothing when every site copy matches', async (t: TestContext) => {
    withSiteRoot(t);
    const lines = captureLog(t);
    await macrosCmd([]);
    assert.deepEqual(lines, []);
  });

  it('prints one line per changed or missing seed', async (t: TestContext) => {
    const root = withSiteRoot(t);
    fs.writeFileSync(path.join(root, 'macros', 'hero.json'), '{"custom": true}\n');
    fs.rmSync(path.join(root, 'macros', 'split.json'));
    const lines = captureLog(t);
    await macrosCmd([]);
    assert.deepEqual(lines, ['hero\tdiffers', 'split\tmissing']);
  });

  it('--update replaces exactly the named file', async (t: TestContext) => {
    const root = withSiteRoot(t);
    const hero = path.join(root, 'macros', 'hero.json');
    const cards = path.join(root, 'macros', 'cards.json');
    fs.writeFileSync(hero, '{"custom": true}\n');
    fs.writeFileSync(cards, '{"custom": true}\n');
    captureLog(t);
    await macrosCmd(['--update', 'hero']);
    assert.equal(
      fs.readFileSync(hero, 'utf8'),
      fs.readFileSync(path.join(seedMacrosDir(), 'hero.json'), 'utf8')
    );
    assert.equal(fs.readFileSync(cards, 'utf8'), '{"custom": true}\n');
  });

  it('--update refuses an unknown name and leaves the site alone', async (t: TestContext) => {
    const root = withSiteRoot(t);
    await assert.rejects(macrosCmd(['--update', 'nope']), /no seed macro named nope/);
    await assert.rejects(macrosCmd(['--update', '../hero']), /no seed macro/);
    assert.equal(fs.existsSync(path.join(root, 'macros', 'nope.json')), false);
  });

  it('rejects other arguments with usage', async (t: TestContext) => {
    withSiteRoot(t);
    await assert.rejects(macrosCmd(['--update']), /usage/);
    await assert.rejects(macrosCmd(['--bogus']), /usage/);
  });
});
