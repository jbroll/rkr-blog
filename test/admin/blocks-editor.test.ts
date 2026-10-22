import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  depthLabel,
  duplicateOverrides,
  insertAllowed,
  isValidMacroName,
  MAX_MACRO_DEPTH,
  mountBlocksPalette,
  type PaletteMacro,
  PRIMITIVE_MACROS,
  primitiveNode
} from '../../src/admin/blocks-editor.ts';
import type { BlockNode } from '../../src/lib/blocks.ts';

const depth3Macro: BlockNode = {
  type: 'section',
  children: [
    {
      type: 'row',
      children: [{ type: 'col', children: [{ type: 'text', markdown: 'hi' }] }]
    }
  ]
};

describe('blocks editor', () => {
  it('blocks a 4th container level inside one macro', () => {
    assert.equal(insertAllowed(depth3Macro, 'row'), false);
    assert.equal(insertAllowed(depth3Macro, 'col'), false);
  });

  it('allows leaves and macros at any depth', () => {
    assert.equal(insertAllowed(depth3Macro, 'text'), true);
    assert.equal(insertAllowed(depth3Macro, 'figure'), true);
    assert.equal(insertAllowed(depth3Macro, 'macro'), true);
  });

  it('allows containers below depth 3', () => {
    const shallow: BlockNode = { type: 'section', children: [{ type: 'text' }] };
    assert.equal(insertAllowed(shallow, 'row'), true);
  });

  it('duplicate copies overrides only', () => {
    assert.deepEqual(duplicateOverrides({ title: 'X' }), { title: 'X' });
    const src = { items: [{ a: 1 }] };
    const copy = duplicateOverrides(src);
    assert.deepEqual(copy, src);
    assert.notEqual(copy.items, src.items);
  });

  it('labels depth for the meter', () => {
    assert.equal(depthLabel(2), 'Level 2 of 3');
    assert.equal(depthLabel(MAX_MACRO_DEPTH), `Level ${MAX_MACRO_DEPTH} of ${MAX_MACRO_DEPTH}`);
  });

  it('validates macro names', () => {
    assert.equal(isValidMacroName('hero-band'), true);
    assert.equal(isValidMacroName('Bad Name'), false);
  });

  it('mounts palette buttons and handles insert', () => {
    interface FakeButton {
      type: string;
      className: string;
      textContent: string;
      dataset: Record<string, string>;
      click: () => void;
      dblclick: () => void;
      keydown: (key: string) => void;
    }
    const buttons: FakeButton[] = [];
    const appended: unknown[] = [];
    let inserted: string | undefined;
    const macros: PaletteMacro[] = [{ name: 'hero', label: 'Hero' }];
    const fakeDocument = {
      createElement: (_tag: string) => {
        const listeners: Record<string, (ev?: { key?: string }) => void> = {};
        const el = {
          type: '',
          className: '',
          textContent: '',
          dataset: {} as Record<string, string>,
          setAttribute: (_k: string, _v: string) => {},
          addEventListener: (ev: string, fn: (ev?: { key?: string }) => void) => {
            listeners[ev] = fn;
          },
          append: (child: unknown) => {
            buttons.push(child as FakeButton);
          },
          click: () => listeners.click?.(),
          dblclick: () => listeners.dblclick?.(),
          keydown: (key: string) => listeners.keydown?.({ key })
        };
        return el;
      }
    };
    const root = {
      ownerDocument: fakeDocument,
      prepend: (el: unknown) => {
        appended.push(el);
      }
    } as unknown as Element;
    mountBlocksPalette(root, macros, (name) => {
      inserted = name;
    });
    assert.equal(appended.length, 1);
    assert.ok(buttons.length > 1);
    buttons[buttons.length - 1]?.click();
    assert.equal(inserted, 'hero');
  });

  it('shows primitives when no macros are configured', () => {
    const buttons: { dataset: Record<string, string> }[] = [];
    const appended: unknown[] = [];
    const fakeDocument = {
      createElement: (_tag: string) => ({
        type: '',
        className: '',
        textContent: '',
        dataset: {},
        setAttribute: (_k: string, _v: string) => {},
        addEventListener: (_ev: string, _fn: () => void) => {},
        append: (child: unknown) => {
          buttons.push(child as { dataset: Record<string, string> });
        }
      })
    };
    const root = {
      ownerDocument: fakeDocument,
      prepend: (el: unknown) => {
        appended.push(el);
      }
    } as unknown as Element;
    mountBlocksPalette(root, [], () => {});
    assert.equal(appended.length, 1);
    assert.equal(buttons.length, PRIMITIVE_MACROS.length);
  });

  it('double-click and Enter insert like click', () => {
    const listeners: Record<string, (ev?: { key?: string }) => void> = {};
    const fakeDocument = {
      createElement: (_tag: string) => ({
        dataset: {},
        setAttribute: (_k: string, _v: string) => {},
        addEventListener: (ev: string, fn: (ev?: { key?: string }) => void) => {
          listeners[ev] = fn;
        },
        append: (_child: unknown) => {},
        click: () => listeners.click?.(),
        dblclick: () => listeners.dblclick?.(),
        keydown: (key: string) => listeners.keydown?.({ key })
      })
    };
    const root = {
      ownerDocument: fakeDocument,
      prepend: (_el: unknown) => {}
    } as unknown as Element;
    const inserted: string[] = [];
    mountBlocksPalette(root, [{ name: 'hero', label: 'Hero' }], (name) => {
      inserted.push(name);
    });
    listeners.dblclick?.();
    listeners.keydown?.({ key: 'Enter' });
    listeners.keydown?.({ key: ' ' });
    assert.deepEqual(inserted, ['hero', 'hero']);
  });

  it('builds primitive nodes from palette names', () => {
    assert.equal(primitiveNode('primitive:text').type, 'text');
    assert.equal((primitiveNode('primitive:row') as { children: unknown[] }).children.length, 0);
    assert.throws(() => primitiveNode('hero'), /unknown primitive/);
  });
});
