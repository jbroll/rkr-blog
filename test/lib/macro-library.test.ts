import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import {
  expandMacro,
  type FieldSpec,
  getRootDefaults,
  loadMacroLibrary,
  type StoredMacro
} from '../../src/lib/macro-library.ts';

function freshDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-macros-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeMacro(dir: string, name: string, json: unknown): void {
  fs.writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(json, null, 2)}\n`);
}

describe('macro-library', () => {
  it('curried macro fixes some slots, leaves rest open', () => {
    const lib = loadMacroLibrary(
      (() => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-macros-cur-'));
        writeMacro(dir, 'cards', {
          defaults: { title: 'Cards', layout: 'grid' },
          tree: { type: 'list', slots: {} }
        });
        writeMacro(dir, 'cards-home', {
          defaults: {},
          tree: { type: 'macro', macro: 'cards', slots: { layout: 'cards' } }
        });
        return dir;
      })()
    );
    const node = expandMacro(lib, 'cards-home', { title: 'News' });
    assert.equal(node.slots?.title, 'News');
    assert.equal(node.slots?.layout, 'cards');
  });

  it('root page supplies chrome defaults', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-macros-root-'));
    writeMacro(dir, 'page', {
      defaults: { menu: [{ label: 'Join', target: '/join' }] },
      tree: { type: 'col', children: [] }
    });
    const lib = loadMacroLibrary(dir);
    const root = getRootDefaults(lib);
    assert.ok(Array.isArray(root.menu));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the tree inline slots when overrides are empty', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-macros-inline-'));
    writeMacro(dir, 'hero', {
      defaults: { heading: 'Default heading' },
      tree: { type: 'section', slots: { theme: 'dark' } }
    });
    const lib = loadMacroLibrary(dir);
    const node = expandMacro(lib, 'hero', {});
    assert.equal(node.slots?.theme, 'dark');
    assert.equal(node.slots?.heading, 'Default heading');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('unknown macro name throws', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-macros-unk-'));
    const lib = loadMacroLibrary(dir);
    assert.throws(() => expandMacro(lib, 'nope', {}), /unknown macro/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('loads macros from disk in sorted order', (t: TestContext) => {
    const dir = freshDir(t);
    writeMacro(dir, 'b-macro', { defaults: {}, tree: { type: 'text', markdown: 'b' } });
    writeMacro(dir, 'a-macro', { defaults: {}, tree: { type: 'text', markdown: 'a' } });
    const lib = loadMacroLibrary(dir);
    assert.deepEqual([...lib.keys()], ['a-macro', 'b-macro']);
  });

  it('types stored macros and field specs', () => {
    const spec: FieldSpec = { label: 'Title', type: 'text' };
    const stored: StoredMacro = {
      defaults: {},
      fieldSchema: { title: spec },
      tree: { type: 'text' }
    };
    assert.equal(stored.defaults && typeof stored, 'object');
  });
});
