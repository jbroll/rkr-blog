import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MacroField } from '../../src/admin/macro-controls.ts';
import { openListField } from '../../src/admin/macro-list-field.ts';
import type { TagSource } from '../../src/lib/tag-source.ts';
import { FakeDocument, type FakeElement, FakeEvent } from './fake-dom.ts';

const ROWS = [{ name: 'Ann' }, { name: 'Bo' }];

function open(source?: TagSource) {
  const doc = new FakeDocument();
  const field: MacroField = {
    name: 'cards',
    label: 'Cards',
    value: '',
    placeholder: '',
    multiline: false,
    image: false,
    list: { item: { name: { label: 'Name', type: 'text' } }, items: ROWS, source }
  };
  const calls: unknown[] = [];
  const el = openListField(doc as unknown as Document, field, undefined, (v) => calls.push(v));
  const root = el as unknown as FakeElement;
  const control = (name: string) =>
    root.querySelector(`[name="${name}"]`) as unknown as {
      value: string;
      dispatchEvent(e: FakeEvent): void;
    };
  const enter = (name: string, value: string) => {
    const c = control(name);
    c.value = value;
    c.dispatchEvent(new FakeEvent('change'));
  };
  return { root, calls, control, enter };
}

describe('list field Fill from', () => {
  it('choosing Tag calls set with the tag source', () => {
    const { calls, enter } = open();
    enter('source', 'tag');
    enter('tag', 'board');
    assert.deepEqual(calls.at(-1), { tag: 'board' });
  });

  it('sort date and limit 3 are included', () => {
    const { calls, enter } = open();
    enter('source', 'tag');
    enter('tag', 'board');
    enter('sort', 'date');
    enter('limit', '3');
    assert.deepEqual(calls.at(-1), { tag: 'board', sort: 'date', limit: 3 });
  });

  it('back to Rows restores the opened rows', () => {
    const { calls, enter } = open();
    enter('source', 'tag');
    enter('tag', 'board');
    enter('source', 'rows');
    assert.deepEqual(calls.at(-1), ROWS);
  });

  it('hides the rows while Tag is selected', () => {
    const { root, enter } = open();
    const rows = root.querySelector('.rkr-list-rows') as FakeElement;
    assert.equal(rows.hidden, false);
    enter('source', 'tag');
    assert.equal(rows.hidden, true);
  });

  it('a saved tag source opens with Tag selected', () => {
    const { root, control } = open({ tag: 'board', sort: 'date', limit: 2 });
    assert.equal(control('source').value, 'tag');
    assert.equal(control('tag').value, 'board');
    assert.equal(control('sort').value, 'date');
    assert.equal(control('limit').value, '2');
    assert.equal((root.querySelector('.rkr-list-rows') as FakeElement).hidden, true);
  });
});
