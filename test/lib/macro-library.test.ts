import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import type { FieldSpec } from '../../src/lib/blocks.ts';
import { expandMacro, loadMacroLibrary, type StoredMacro } from '../../src/lib/macro-library.ts';

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

  it('keeps a field schema and skips non-JSON files', (t: TestContext) => {
    const dir = freshDir(t);
    writeMacro(dir, 'hero', {
      defaults: {},
      fieldSchema: { heading: { label: 'Heading', type: 'text' } },
      tree: { type: 'section', children: [] }
    });
    fs.writeFileSync(path.join(dir, 'README.md'), 'not a macro');
    const lib = loadMacroLibrary(dir);
    assert.deepEqual([...lib.keys()], ['hero']);
    assert.equal(lib.get('hero')?.fieldSchema?.heading?.label, 'Heading');
  });

  it('skips and logs a malformed macro file, naming it, and keeps the rest', (t: TestContext) => {
    const cases: [unknown, RegExp][] = [
      ['{not json', /bad\.json is not valid JSON/],
      [{ defaults: [], tree: { type: 'text' } }, /bad\.json needs object defaults/],
      [{ defaults: {}, tree: { type: 'nope' } }, /bad\.json.*unknown block type nope/],
      [{ defaults: {}, tree: 'text' }, /bad\.json.*needs a string type/],
      [{ defaults: {}, tree: { type: 'macro' } }, /bad\.json.*macro instance needs a macro name/],
      [
        { defaults: {}, tree: { type: 'section', children: [{ type: 'mystery' }] } },
        /bad\.json.*unknown block type mystery/
      ]
    ];
    for (const [json, error] of cases) {
      const dir = freshDir(t);
      fs.writeFileSync(
        path.join(dir, 'bad.json'),
        typeof json === 'string' ? json : JSON.stringify(json)
      );
      writeMacro(dir, 'good', { defaults: {}, tree: { type: 'text', markdown: 'ok' } });
      const warnings: string[] = [];
      const lib = loadMacroLibrary(dir, { warn: (_o, m) => warnings.push(m) });
      assert.deepEqual([...lib.keys()], ['good']);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? '', error);
    }
  });

  it('logs to console.warn when no logger is passed', (t: TestContext) => {
    const dir = freshDir(t);
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
    const warned: string[] = [];
    t.mock.method(console, 'warn', (...a: unknown[]) => {
      warned.push(a.map(String).join(' '));
    });
    assert.equal(loadMacroLibrary(dir).size, 0);
    assert.match(warned.join('\n'), /bad\.json/);
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
