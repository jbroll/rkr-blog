// DOM-level tests for admin/unified-shell.ts — the in-place editor
// shell that hydrates the server-rendered page (comments carrying
// `rkr:path=i,j` markers) back to block-tree paths, toggles View/Edit
// on the same DOM, and docks the palette on the right.
//
// The repo has no jsdom/happy-dom (see source-picker.test.ts), so the
// minimal fake DOM below covers exactly what the shell + palette use:
// element/comment/text nodes, attributes, classList, dataset,
// bubbling listeners, querySelector for simple selectors, and
// click/focus dispatch.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PRIMITIVE_MACROS } from '../../src/admin/blocks-editor.ts';
import { mountUnifiedShell } from '../../src/admin/unified-shell.ts';
import type { BlockNode, BlockTree } from '../../src/lib/blocks.ts';
import { renderBlockTree } from '../../src/lib/blocks-render.ts';
import type { ImageMap } from '../../src/lib/image-map.ts';
import { type VideoMapView, WidgetRegistry } from '../../src/lib/widgets.ts';

import {
  FakeDocument,
  type FakeElement,
  FakeEvent,
  type FakeNode,
  marker,
  para
} from './fake-dom.ts';

interface Fixture {
  doc: FakeDocument;
  root: FakeElement;
  shellEl: FakeElement;
  toolbar: FakeElement;
  body: FakeElement;
  dock: FakeElement;
}

/** Same mount points the edit template ships: shell > toolbar +
 * layout(body, palette dock). The body is built by the caller with
 * server-ordered markers. */
function fixture(buildBody: (doc: FakeDocument) => FakeNode[]): Fixture {
  const doc = new FakeDocument();
  const root = doc.createElement('div');
  root.id = 'rkr-blocks-edit-root';
  root.dataset.slug = 'saved';

  const shellEl = doc.createElement('div');
  shellEl.id = 'rkr-unified-shell';
  shellEl.className = 'rkr-unified-shell is-view';
  shellEl.setAttribute('data-mode', 'view');

  const toolbar = doc.createElement('div');
  toolbar.id = 'rkr-unified-toolbar';
  toolbar.className = 'rkr-unified-toolbar';
  const modes: ('view' | 'edit')[] = ['view', 'edit'];
  for (const mode of modes) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'rkr-unified-mode';
    btn.dataset.mode = mode;
    btn.textContent = mode === 'view' ? 'View' : 'Edit';
    btn.setAttribute('aria-pressed', String(mode === 'view'));
    toolbar.append(btn);
  }

  const layout = doc.createElement('div');
  layout.className = 'rkr-unified-layout';

  const body = doc.createElement('div');
  body.id = 'rkr-blocks-page-body';
  body.className = 'rkr-blocks-page-body';
  body.append(...buildBody(doc));

  const dock = doc.createElement('aside');
  dock.id = 'rkr-unified-dock';
  dock.className = 'rkr-blocks-palette-right';
  dock.hidden = true;

  layout.append(body, dock);
  shellEl.append(toolbar, layout);
  root.append(shellEl);

  return { doc, root, shellEl, toolbar, body, dock };
}

const renderCtx = {
  images: new Map() as ImageMap,
  videos: new Map() as VideoMapView,
  widgets: new WidgetRegistry()
};

/** The real server renderer with edit markers, so client hydration is
 * checked against the same marker rules the edit route uses. */
const markedRender = (tree: BlockTree): Promise<string> =>
  renderBlockTree(
    tree,
    renderCtx,
    { get: () => undefined },
    {
      mark: (p) => `<!--rkr:path=${p.join(',')}-->`
    }
  );

function mount(
  f: Fixture,
  tree: BlockTree,
  onSave?: (tree: BlockTree) => Promise<void>,
  macros: { name: string; label: string; defaults?: Record<string, unknown> }[] = [
    { name: 'hero', label: 'Hero' }
  ],
  render: (tree: BlockTree) => Promise<string> = markedRender
) {
  return mountUnifiedShell(f.root as unknown as Element, {
    tree,
    macros,
    onSave: onSave ?? (async () => {}),
    render
  });
}

describe('unified editor shell', () => {
  it('zips markers to tree paths in document order', () => {
    const tree: BlockTree = {
      version: 1,
      body: [
        { type: 'text', markdown: 'One' },
        { type: 'text', markdown: 'Two' },
        { type: 'text', markdown: 'Three' }
      ]
    };
    const f = fixture((doc) => [
      marker(doc, '0'),
      para(doc, 'One'),
      doc.createTextNode('\n'),
      marker(doc, '1'),
      para(doc, 'Two'),
      doc.createTextNode('\n'),
      marker(doc, '2'),
      para(doc, 'Three')
    ]);
    const shell = mount(f, tree);

    const paragraphs = f.body.querySelectorAll('p');
    assert.deepEqual(
      paragraphs.map((p) => p.getAttribute('data-rkr-path')),
      ['0', '1', '2']
    );
    assert.equal(shell.selectedPath, null);

    paragraphs[1]?.click();
    assert.deepEqual(shell.selectedPath, [1], 'the 2nd marker selects path [1]');
  });

  it('blank text leaves hydrate through their edit placeholder', () => {
    const tree: BlockTree = {
      version: 1,
      body: [
        {
          type: 'section',
          children: [
            { type: 'text', markdown: 'A' },
            { type: 'text', markdown: '' },
            { type: 'text', markdown: 'B' }
          ]
        }
      ]
    };
    const f = fixture((doc) => {
      const section = doc.createElement('section');
      section.className = 'rkr-section';
      const inner = doc.createElement('div');
      inner.className = 'rkr-section-inner';
      const blank = doc.createElement('p');
      blank.className = 'rkr-unified-blank';
      blank.setAttribute('data-rkr-blank', '');
      inner.append(
        marker(doc, '0,0'),
        para(doc, 'A'),
        marker(doc, '0,1'),
        blank,
        marker(doc, '0,2'),
        para(doc, 'B')
      );
      section.append(inner);
      return [marker(doc, '0'), section];
    });
    const shell = mount(f, tree);

    assert.equal(f.body.querySelector('section')?.getAttribute('data-rkr-path'), '0');
    const paragraphs = f.body.querySelectorAll('p');
    assert.deepEqual(
      paragraphs.map((p) => p.getAttribute('data-rkr-path')),
      ['0,0', '0,1', '0,2']
    );
    shell.setMode('edit');
    assert.equal(paragraphs[1]?.getAttribute('contenteditable'), 'true');
    shell.setMode('view');

    paragraphs[2]?.click();
    assert.deepEqual(shell.selectedPath, [0, 2]);

    f.body.querySelector('section')?.click();
    assert.deepEqual(shell.selectedPath, [0], 'a container click selects its own path');
  });

  it('view mode hides the palette and disables editing', () => {
    const tree: BlockTree = { version: 1, body: [{ type: 'text', markdown: 'Hello' }] };
    const f = fixture((doc) => [marker(doc, '0'), para(doc, 'Hello')]);
    mount(f, tree);

    assert.equal(f.shellEl.getAttribute('data-mode'), 'view');
    assert.equal(f.dock.hidden, true, 'palette dock is hidden in view mode');
    assert.equal(f.body.querySelector('p')?.getAttribute('contenteditable'), null);
    assert.equal(f.root.querySelectorAll('.rkr-unified-config').length, 0);
    // The dock is mounted once and merely hidden: no re-mount on toggle.
    assert.equal(
      f.dock.querySelectorAll('.rkr-blocks-palette-item').length,
      PRIMITIVE_MACROS.length + 1
    );
  });

  it('edit mode shows the palette and arms text leaves', () => {
    const tree: BlockTree = {
      version: 1,
      body: [
        { type: 'text', markdown: 'Hello' },
        {
          type: 'section',
          children: [
            { type: 'figure', slots: { ids: 'abc' } },
            { type: 'button', slots: { label: 'Go' } },
            { type: 'macro', macro: 'hero' }
          ]
        }
      ]
    };
    const f = fixture((doc) => {
      const section = doc.createElement('section');
      section.className = 'rkr-section';
      const inner = doc.createElement('div');
      inner.append(
        marker(doc, '1,0'),
        doc.createElement('figure'),
        marker(doc, '1,1'),
        anchor(doc, 'Go'),
        marker(doc, '1,2'),
        doc.createElement('section')
      );
      section.append(inner);
      return [marker(doc, '0'), para(doc, 'Hello'), marker(doc, '1'), section];
    });

    const shell = mount(f, tree);
    f.toolbar.querySelectorAll('[data-mode]')[1]?.click();

    assert.equal(f.shellEl.getAttribute('data-mode'), 'edit');
    assert.equal(f.dock.hidden, false, 'palette dock is visible in edit mode');
    assert.equal(
      f.body.querySelector('p')?.getAttribute('contenteditable'),
      'true',
      'text leaves become editable in place'
    );

    const configs = f.root.querySelectorAll('.rkr-unified-config');
    assert.deepEqual(
      configs.map((btn) => btn.getAttribute('data-config-path')),
      ['1,0', '1,1', '1,2'],
      'figures, buttons, and macro instances get config buttons'
    );
    assert.equal(configs[0]?.getAttribute('aria-label'), 'Configure figure');
    assert.equal(configs[2]?.getAttribute('aria-label'), 'Configure macro hero');

    // Config buttons are siblings of the live node, so a figure's own
    // markup (caption, gallery) is never mutated.
    const figure = f.body.querySelector('figure');
    assert.equal((figure?.nextSibling as FakeElement | null)?.className, 'rkr-unified-node-tools');

    configs[0]?.click();
    assert.deepEqual(shell.selectedPath, [1, 0]);
  });

  it('flipping back to view removes editing affordances', () => {
    const tree: BlockTree = {
      version: 1,
      body: [
        { type: 'text', markdown: 'Hello' },
        { type: 'figure', slots: { ids: 'abc' } }
      ]
    };
    const f = fixture((doc) => [
      marker(doc, '0'),
      para(doc, 'Hello'),
      marker(doc, '1'),
      doc.createElement('figure')
    ]);
    const shell = mount(f, tree);
    const [viewBtn, editBtn] = f.toolbar.querySelectorAll('[data-mode]');

    shell.setMode('edit');
    assert.equal(editBtn?.getAttribute('aria-pressed'), 'true');
    assert.equal(viewBtn?.getAttribute('aria-pressed'), 'false');
    assert.ok(f.body.querySelector('p')?.getAttribute('contenteditable'));

    viewBtn?.click();
    assert.equal(f.shellEl.getAttribute('data-mode'), 'view');
    assert.equal(f.dock.hidden, true);
    assert.equal(f.body.querySelector('p')?.getAttribute('contenteditable'), null);
    assert.equal(f.root.querySelectorAll('.rkr-unified-config').length, 0);
  });

  it('palette click appends a node and saves the whole tree', async () => {
    const tree: BlockTree = { version: 1, body: [{ type: 'text', markdown: 'Hello' }] };
    const saved: BlockTree[] = [];
    const f = fixture((doc) => [marker(doc, '0'), para(doc, 'Hello')]);
    mount(f, tree, async (next) => {
      saved.push(next);
    });

    const image = f.dock
      .querySelectorAll('.rkr-blocks-palette-item')
      .find((btn) => btn.dataset.macro === 'primitive:figure');
    image?.click();
    for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 0));

    assert.equal(saved.length, 1, 'one save per insert');
    assert.deepEqual(
      saved[0]?.body.map((n) => n.type),
      ['text', 'figure']
    );
    assert.deepEqual(
      tree.body.map((n) => n.type),
      ['text'],
      'the mounted tree is never mutated in place'
    );
  });
});

describe('unified shell saving', () => {
  const tick = async (n = 10): Promise<void> => {
    for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
  };

  function textOnly(): { f: Fixture; p: FakeElement; tree: BlockTree } {
    let p!: FakeElement;
    const f = fixture((doc) => {
      p = para(doc, 'Hello');
      return [marker(doc, '0'), p];
    });
    const tree: BlockTree = { version: 1, body: [{ type: 'text', markdown: 'Hello' }] };
    return { f, p, tree };
  }

  it('blur saves edited text and marks clean', async () => {
    const { f, p, tree } = textOnly();
    const saved: BlockTree[] = [];
    const shell = mount(f, tree, async (t) => {
      saved.push(t);
    });
    shell.setMode('edit');
    p.textContent = 'Hello edited';
    p.dispatchEvent(new FakeEvent('focusout'));
    await tick();
    assert.equal(saved.length, 1);
    assert.equal((saved[0]?.body[0] as { markdown?: string }).markdown, 'Hello edited');
    assert.equal(f.shellEl.getAttribute('data-save-state'), 'clean');
  });

  it('blur during in-flight save: second save wins, ends clean', async () => {
    const { f, p, tree } = textOnly();
    const snapshots: BlockTree[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const shell = mount(f, tree, async (t) => {
      snapshots.push(t);
      await gate;
    });
    shell.setMode('edit');
    p.textContent = 'First edit';
    p.dispatchEvent(new FakeEvent('focusout'));
    await tick(2);
    p.textContent = 'Second edit';
    p.dispatchEvent(new FakeEvent('focusout'));
    await tick(2);
    release();
    await tick(20);
    assert.equal(snapshots.length, 2);
    assert.equal((snapshots[0]?.body[0] as { markdown?: string }).markdown, 'First edit');
    assert.equal((snapshots[1]?.body[0] as { markdown?: string }).markdown, 'Second edit');
    assert.equal(f.shellEl.getAttribute('data-save-state'), 'clean');
  });

  it('failed save marks unsaved and retries on Save click', async () => {
    const { f, p, tree } = textOnly();
    const saved: BlockTree[] = [];
    let fail = true;
    const shell = mount(f, tree, async (t) => {
      if (fail) throw new Error('offline');
      saved.push(t);
    });
    shell.setMode('edit');
    p.textContent = 'Offline edit';
    p.dispatchEvent(new FakeEvent('focusout'));
    await tick();
    assert.equal(saved.length, 0);
    assert.equal(f.shellEl.getAttribute('data-save-state'), 'unsaved');
    fail = false;
    f.toolbar.querySelector('.rkr-unified-save')?.click();
    await tick();
    assert.equal(saved.length, 1);
    assert.equal(f.shellEl.getAttribute('data-save-state'), 'clean');
  });

  it('Save button is a no-op when clean', async () => {
    const { f, tree } = textOnly();
    let calls = 0;
    mount(f, tree, async () => {
      calls++;
    });
    await tick();
    const saveBtn = f.toolbar.querySelector('.rkr-unified-save');
    assert.ok(saveBtn, 'Save button exists in the toolbar');
    saveBtn.click();
    await tick();
    assert.equal(calls, 0);
  });
});

describe('unified shell figure dialog', () => {
  const IDS = 'ab'.repeat(32);
  function figureFixture() {
    const f = fixture((doc) => {
      const figure = doc.createElement('figure');
      figure.append(doc.createTextNode('pic'));
      return [marker(doc, '0'), figure, marker(doc, '1'), para(doc, 'Kept')];
    });
    const tree: BlockTree = {
      version: 1,
      body: [
        { type: 'figure', slots: { ids: IDS, custom: 'untouched', alts: 'old', captions: 'old' } },
        { type: 'text', markdown: 'Kept' }
      ]
    };
    return { f, tree };
  }

  it('figure config opens the dialog and commits only its slots with one save', async () => {
    const { f, tree } = figureFixture();
    const saved: BlockTree[] = [];
    const shell = mount(f, tree, async (t) => {
      saved.push(t);
    });
    shell.setMode('edit');
    const configs = f.root.querySelectorAll('.rkr-unified-config');
    assert.equal(configs.length, 1);
    assert.equal(configs[0]?.getAttribute('aria-label'), 'Configure figure');
    configs[0]?.click();
    const dialog = f.root.querySelector('.rkr-cell-dialog');
    assert.ok(dialog, 'dialog opens on config click');
    const inputs = dialog.querySelectorAll('input');
    assert.equal(inputs.length, 3, 'ids, alts, captions inputs');
    const alts = inputs[1];
    const caps = inputs[2];
    assert.ok(alts);
    assert.ok(caps);
    alts.textContent = '';
    (alts as unknown as { value: string }).value = 'new alt';
    alts.dispatchEvent(new FakeEvent('input'));
    caps.textContent = '';
    (caps as unknown as { value: string }).value = 'new cap';
    caps.dispatchEvent(new FakeEvent('input'));
    const saveBtn = f.root.querySelectorAll('button').find((b) => b.textContent === 'Save figure');
    assert.ok(saveBtn, 'dialog has a save button');
    saveBtn?.click();
    for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 0));
    assert.equal(saved.length, 1, 'exactly one save');
    const figure = saved[0]?.body[0] as { slots: Record<string, string> };
    assert.equal(figure.slots.alts, 'new alt');
    assert.equal(figure.slots.captions, 'new cap');
    assert.equal(figure.slots.ids, IDS);
    assert.equal(figure.slots.custom, 'untouched', 'unknown slot keys pass through');
    assert.equal((saved[0]?.body[1] as { markdown?: string }).markdown, 'Kept');
    assert.equal(f.shellEl.getAttribute('data-save-state'), 'clean');
  });
});

describe('unified shell palette drop', () => {
  const tick = async (n = 10): Promise<void> => {
    for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
  };

  function twoText() {
    const f = fixture((doc) => [
      marker(doc, '0'),
      para(doc, 'One'),
      marker(doc, '1'),
      para(doc, 'Two')
    ]);
    const tree: BlockTree = {
      version: 1,
      body: [
        { type: 'text', markdown: 'One' },
        { type: 'text', markdown: 'Two' }
      ]
    };
    return { f, tree };
  }

  function dragData(name: string): Record<string, unknown> {
    return { getData: () => name, setData: () => {} };
  }

  function rectOf(el: FakeElement, top: number, height: number): void {
    (el as unknown as Record<string, unknown>).getBoundingClientRect = () => ({
      top,
      height,
      bottom: top + height,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: top,
      toJSON: () => ({})
    });
  }

  it('drop on a live node inserts at the resolved path', async () => {
    const { f, tree } = twoText();
    const saved: BlockTree[] = [];
    const shell = mount(f, tree, async (t) => {
      saved.push(t);
    });
    shell.setMode('edit');
    const target = f.body.querySelectorAll('p')[0];
    assert.ok(target);
    rectOf(target, 0, 90);
    const btn = f.dock.querySelectorAll('button').find((b) => b.textContent === 'Image');
    assert.ok(btn, 'palette has the Image primitive');
    btn.dispatchEvent(
      Object.assign(new FakeEvent('dragstart'), {
        dataTransfer: { ...dragData('primitive:figure'), setData: () => {} }
      })
    );
    target.dispatchEvent(
      Object.assign(new FakeEvent('dragover'), {
        clientY: 80,
        dataTransfer: dragData('primitive:figure')
      })
    );
    target.dispatchEvent(
      Object.assign(new FakeEvent('drop'), {
        clientY: 80,
        dataTransfer: dragData('primitive:figure')
      })
    );
    await tick();
    assert.equal(saved.length, 1);
    assert.deepEqual(
      saved[0]?.body.map((n) => n.type),
      ['text', 'figure', 'text'],
      'figure lands after the first text leaf'
    );
  });

  it('container refused at depth 3 with nudge', async () => {
    const doc = new FakeDocument();
    void doc;
    const f = fixture((d) => {
      const section = d.createElement('section');
      const row = d.createElement('div');
      row.className = 'rkr-row';
      const col = d.createElement('div');
      col.className = 'rkr-col';
      col.append(marker(d, '0,0,0,0'), para(d, 'Deep'));
      row.append(marker(d, '0,0,0'), col);
      section.append(marker(d, '0,0'), row);
      return [marker(d, '0'), section];
    });
    const tree: BlockTree = {
      version: 1,
      body: [
        {
          type: 'section',
          children: [
            {
              type: 'row',
              children: [{ type: 'col', blocks: [{ type: 'text', markdown: 'Deep' }] }]
            }
          ]
        }
      ]
    };
    let saves = 0;
    const shell = mount(f, tree, async () => {
      saves++;
    });
    shell.setMode('edit');
    const col = f.body.querySelector('.rkr-col');
    assert.ok(col);
    rectOf(col, 0, 90);
    col.dispatchEvent(
      Object.assign(new FakeEvent('dragover'), {
        clientY: 45,
        dataTransfer: dragData('primitive:section')
      })
    );
    col.dispatchEvent(
      Object.assign(new FakeEvent('drop'), {
        clientY: 45,
        dataTransfer: dragData('primitive:section')
      })
    );
    await tick();
    assert.equal(saves, 0, 'refused insert saves nothing');
    assert.match(f.shellEl.textContent ?? '', /save inner part as its own macro/);
  });

  it('click appends at the end of the focused container', async () => {
    const f = fixture((doc) => {
      const section = doc.createElement('section');
      section.className = 'rkr-section';
      section.append(marker(doc, '0,0'), para(doc, 'In'));
      return [marker(doc, '0'), section, marker(doc, '1'), para(doc, 'After')];
    });
    const tree: BlockTree = {
      version: 1,
      body: [
        { type: 'section', children: [{ type: 'text', markdown: 'In' }] },
        { type: 'text', markdown: 'After' }
      ]
    };
    const saved: BlockTree[] = [];
    const shell = mount(f, tree, async (t) => {
      saved.push(t);
    });
    shell.setMode('edit');
    f.body.querySelector('section')?.click();
    const btn = f.dock.querySelectorAll('button').find((b) => b.textContent === 'Text');
    assert.ok(btn);
    btn?.click();
    await tick();
    assert.equal(saved.length, 1);
    const section = saved[0]?.body[0] as { children?: BlockNode[] };
    assert.equal(section.children?.length, 2);
    assert.equal((section.children?.[1] as { type?: string }).type, 'text');
  });
});

describe('unified shell empty nodes', () => {
  it('marker with no elements gets a selectable placeholder', () => {
    const doc = new FakeDocument();
    const root = doc.createElement('div');
    root.id = 'rkr-blocks-edit-root';
    const shellEl = doc.createElement('div');
    shellEl.id = 'rkr-unified-shell';
    const toolbar = doc.createElement('div');
    toolbar.id = 'rkr-unified-toolbar';
    const layout = doc.createElement('div');
    const body = doc.createElement('div');
    body.id = 'rkr-blocks-page-body';
    const markerNode = doc.createComment('rkr:path=0');
    const gap = doc.createComment(' figure: no ids resolved ');
    body.append(markerNode, gap);
    const dock = doc.createElement('aside');
    dock.id = 'rkr-unified-dock';
    layout.append(body, dock);
    shellEl.append(toolbar, layout);
    root.append(shellEl);
    const tree: BlockTree = {
      version: 1,
      body: [{ type: 'figure', slots: { ids: '' } }]
    };
    const shell = mountUnifiedShell(root as unknown as Element, {
      tree,
      macros: [],
      onSave: async () => {},
      render: markedRender
    });
    const holder = body.querySelector('.rkr-unified-empty');
    assert.ok(holder, 'placeholder element planted for the empty figure');
    assert.equal(holder?.getAttribute('data-rkr-path'), '0');
    holder?.click();
    assert.deepEqual(shell.selectedPath, [0]);
  });
});

describe('unified shell macro dialog', () => {
  const tick = async (n = 10): Promise<void> => {
    for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
  };

  it('macro config edits overrides without touching defaults', async () => {
    const f = fixture((doc) => {
      const card = doc.createElement('div');
      card.className = 'rkr-macro';
      card.append(doc.createTextNode('hero'));
      return [marker(doc, '0'), card];
    });
    const tree: BlockTree = {
      version: 1,
      body: [{ type: 'macro', macro: 'hero', slots: { sub: 'Kept' } }]
    };
    const macros = [
      { name: 'hero', label: 'Hero', defaults: { heading: 'Fresh', sub: 'Default sub' } }
    ];
    const saved: BlockTree[] = [];
    const shell = mount(
      f,
      tree,
      async (t) => {
        saved.push(t);
      },
      macros
    );
    shell.setMode('edit');
    const configs = f.root.querySelectorAll('.rkr-unified-config');
    assert.equal(configs.length, 1);
    assert.equal(configs[0]?.getAttribute('aria-label'), 'Configure macro hero');
    configs[0]?.click();
    const dialog = f.root.querySelector('.rkr-macro-dialog');
    assert.ok(dialog, 'dialog opens on macro config click');
    const heading = dialog
      .querySelectorAll('input')
      .find((i) => i.getAttribute('name') === 'heading');
    assert.ok(heading, 'heading field exists');
    (heading as unknown as { value: string }).value = 'New band';
    heading.dispatchEvent(new FakeEvent('input', { bubbles: true }));
    const saveBtn = f.root.querySelectorAll('button').find((b) => b.textContent === 'Save macro');
    assert.ok(saveBtn, 'dialog has a save button');
    saveBtn?.click();
    await tick();
    assert.equal(saved.length, 1, 'exactly one save');
    assert.deepEqual((saved[0]?.body[0] as { slots?: unknown }).slots, {
      sub: 'Kept',
      heading: 'New band'
    });
  });

  it('clearing a macro field removes the override', async () => {
    const f = fixture((doc) => {
      const card = doc.createElement('div');
      card.append(doc.createTextNode('hero'));
      return [marker(doc, '0'), card];
    });
    const tree: BlockTree = {
      version: 1,
      body: [{ type: 'macro', macro: 'hero', slots: { heading: 'Old', sub: 'Gone' } }]
    };
    const macros = [
      { name: 'hero', label: 'Hero', defaults: { heading: 'Fresh', sub: 'Default' } }
    ];
    const saved: BlockTree[] = [];
    const shell = mount(
      f,
      tree,
      async (t) => {
        saved.push(t);
      },
      macros
    );
    shell.setMode('edit');
    f.root.querySelector('.rkr-unified-config')?.click();
    const dialog = f.root.querySelector('.rkr-macro-dialog');
    assert.ok(dialog);
    const sub = dialog.querySelectorAll('input').find((i) => i.getAttribute('name') === 'sub');
    assert.ok(sub);
    (sub as unknown as { value: string }).value = '';
    sub.dispatchEvent(new FakeEvent('input', { bubbles: true }));
    f.root
      .querySelectorAll('button')
      .find((b) => b.textContent === 'Save macro')
      ?.click();
    await tick();
    assert.equal(saved.length, 1);
    assert.deepEqual((saved[0]?.body[0] as { slots?: unknown }).slots, { heading: 'Old' });
  });
});

describe('unified shell live re-render', () => {
  const tick = async (n = 10): Promise<void> => {
    for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
  };

  const hello = (): { f: Fixture; tree: BlockTree } => ({
    f: fixture((doc) => [marker(doc, '0'), para(doc, 'Hello')]),
    tree: { version: 1, body: [{ type: 'text', markdown: 'Hello' }] }
  });

  const paletteButton = (f: Fixture, label: string): FakeElement => {
    const btn = f.dock.querySelectorAll('button').find((b) => b.textContent === label);
    assert.ok(btn, `palette has ${label}`);
    return btn;
  };

  function dropBefore(target: FakeElement, name: string): void {
    (target as unknown as Record<string, unknown>).getBoundingClientRect = () => ({
      top: 0,
      height: 90
    });
    const dataTransfer = { getData: () => name, setData: () => {} };
    target.dispatchEvent(Object.assign(new FakeEvent('drop'), { clientY: 5, dataTransfer }));
  }

  it('insert re-renders and reindexes', async () => {
    const { f, tree } = hello();
    const saved: BlockTree[] = [];
    const renders: BlockTree[] = [];
    const shell = mount(
      f,
      tree,
      async (t) => {
        saved.push(t);
      },
      undefined,
      async (t) => {
        renders.push(t);
        return markedRender(t);
      }
    );
    shell.setMode('edit');
    const first = f.body.querySelector('p');
    assert.ok(first);
    dropBefore(first, 'primitive:text');
    await tick();

    assert.equal(renders.length, 1, 'the insert renders the new tree once');
    assert.equal(f.body.querySelectorAll('[data-rkr-blank]').length, 1);
    assert.equal(f.root.querySelectorAll('.rkr-unified-placeholder').length, 0);
    const moved = f.body.querySelector('[data-rkr-path="1"]');
    assert.ok(moved, 'the original paragraph is reindexed to [1]');
    assert.equal(moved.textContent, 'Hello');
    assert.equal(moved.getAttribute('contenteditable'), 'true', 'edit mode is re-applied');

    moved.textContent = 'Hello edited';
    moved.dispatchEvent(new FakeEvent('focusout'));
    await tick();
    assert.deepEqual(saved.at(-1)?.body, [
      { type: 'text', markdown: '' },
      { type: 'text', markdown: 'Hello edited' }
    ]);
    assert.equal(renders.length, 1, 'a text blur does not re-render');
  });

  it('failed render keeps the tree change and leaves the DOM as it was', async () => {
    const { f, tree } = hello();
    const saved: BlockTree[] = [];
    let fail = true;
    const shell = mount(
      f,
      tree,
      async (t) => {
        saved.push(t);
      },
      undefined,
      async (t) => {
        if (fail) throw new Error('render 503');
        return markedRender(t);
      }
    );
    shell.setMode('edit');
    const before = f.body.innerHTML;
    paletteButton(f, 'Text').click();
    await tick();

    assert.equal(f.body.innerHTML, before, 'no half-applied DOM');
    assert.equal(saved.length, 0);
    assert.equal(f.shellEl.getAttribute('data-save-state'), 'unsaved');
    assert.match(
      f.toolbar.querySelector('.rkr-unified-save-state')?.textContent ?? '',
      /Couldn't refresh/
    );

    fail = false;
    f.toolbar.querySelector('.rkr-unified-save')?.click();
    await tick();
    assert.equal(f.body.querySelectorAll('[data-rkr-blank]').length, 1, 'retry renders');
    assert.deepEqual(
      saved.at(-1)?.body.map((n) => n.type),
      ['text', 'text'],
      'the kept tree change is saved on retry'
    );
    assert.equal(f.shellEl.getAttribute('data-save-state'), 'clean');
  });

  it('latest structural change wins while a render is in flight', async () => {
    const { f, tree } = hello();
    const saved: BlockTree[] = [];
    const renders: BlockTree[] = [];
    const gates: (() => void)[] = [];
    const shell = mount(
      f,
      tree,
      async (t) => {
        saved.push(t);
      },
      undefined,
      (t) => {
        renders.push(t);
        return new Promise<string>((resolve) => {
          gates.push(() => resolve(markedRender(t)));
        });
      }
    );
    shell.setMode('edit');
    paletteButton(f, 'Text').click();
    await tick(2);
    paletteButton(f, 'Image').click();
    await tick(2);
    gates[0]?.();
    await tick();
    assert.equal(f.body.querySelectorAll('[data-rkr-blank]').length, 0, 'stale render discarded');
    assert.equal(renders.length, 2, 'the latest tree is rendered next');
    gates[1]?.();
    await tick();

    assert.deepEqual(
      renders[1]?.body.map((n) => n.type),
      ['text', 'text', 'figure']
    );
    assert.equal(f.body.querySelectorAll('[data-rkr-blank]').length, 1);
    assert.equal(f.body.querySelector('.rkr-unified-empty')?.getAttribute('data-rkr-path'), '2');
    assert.equal(saved.length, 1, 'one save, of the latest tree');
    assert.deepEqual(
      saved[0]?.body.map((n) => n.type),
      ['text', 'text', 'figure']
    );
  });

  it('a render failure stays unsaved when an earlier save resolves', async () => {
    const { f, tree } = hello();
    const saved: BlockTree[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let gated = true;
    let fail = true;
    const shell = mount(
      f,
      tree,
      async (t) => {
        if (gated) {
          gated = false;
          await gate;
        }
        saved.push(t);
      },
      undefined,
      async (t) => {
        if (fail) throw new Error('render 503');
        return markedRender(t);
      }
    );
    shell.setMode('edit');
    const p = f.body.querySelector('p');
    assert.ok(p);
    p.textContent = 'Hello edited';
    p.dispatchEvent(new FakeEvent('focusout'));
    await tick(2);
    paletteButton(f, 'Text').click();
    await tick();
    release();
    await tick();

    assert.equal(saved.length, 1, 'the earlier blur save landed');
    assert.equal(f.shellEl.getAttribute('data-save-state'), 'unsaved');
    assert.match(
      f.toolbar.querySelector('.rkr-unified-save-state')?.textContent ?? '',
      /Couldn't refresh/
    );

    fail = false;
    f.toolbar.querySelector('.rkr-unified-save')?.click();
    await tick();
    assert.equal(f.body.querySelectorAll('[data-rkr-blank]').length, 1, 'retry re-renders');
    assert.equal(f.body.getAttribute('inert'), null, 'the body is unlocked');
    assert.deepEqual(
      saved.at(-1)?.body.map((n) => n.type),
      ['text', 'text']
    );
    assert.equal(f.shellEl.getAttribute('data-save-state'), 'clean');
  });

  it('typing into a new blank block clears its blank marking', async () => {
    const { f, tree } = hello();
    const shell = mount(f, tree);
    shell.setMode('edit');
    paletteButton(f, 'Text').click();
    await tick();
    const blank = f.body.querySelector('[data-rkr-blank]');
    assert.ok(blank);
    blank.textContent = 'New words';
    blank.dispatchEvent(new FakeEvent('focusout'));
    await tick();
    shell.setMode('view');
    assert.equal(blank.hasAttribute('data-rkr-blank'), false);
    assert.equal(blank.classList.contains('rkr-unified-blank'), false);
  });

  it('a palette click during a pending render targets the new selection', async () => {
    const f = fixture((doc) => [
      marker(doc, '0'),
      para(doc, 'A'),
      marker(doc, '1'),
      para(doc, 'B')
    ]);
    const tree: BlockTree = {
      version: 1,
      body: [
        { type: 'text', markdown: 'A' },
        { type: 'text', markdown: 'B' }
      ]
    };
    const saved: BlockTree[] = [];
    const gates: (() => void)[] = [];
    const shell = mount(
      f,
      tree,
      async (t) => {
        saved.push(t);
      },
      undefined,
      (t) =>
        new Promise<string>((resolve) => {
          gates.push(() => resolve(markedRender(t)));
        })
    );
    shell.setMode('edit');
    f.body.querySelectorAll('p')[1]?.click();
    paletteButton(f, 'Section').click();
    await tick(2);
    assert.deepEqual(shell.selectedPath, [2], 'selection follows the pending insert');
    paletteButton(f, 'Text').click();
    await tick(2);
    for (const open of gates) open();
    await tick();
    const section = saved.at(-1)?.body[2] as { type: string; children?: BlockNode[] };
    assert.equal(section.type, 'section');
    assert.equal(section.children?.length, 1, 'the second insert lands inside the new section');
  });

  it('view mode clears config tools for inserted nodes', async () => {
    const { f, tree } = hello();
    const shell = mount(f, tree);
    shell.setMode('edit');
    paletteButton(f, 'Image').click();
    await tick();
    const configs = f.root.querySelectorAll('.rkr-unified-config');
    assert.deepEqual(
      configs.map((c) => c.getAttribute('data-config-path')),
      ['1']
    );
    shell.setMode('view');
    assert.equal(f.root.querySelectorAll('.rkr-unified-config').length, 0);
    assert.equal(f.root.querySelectorAll('.rkr-unified-node-tools').length, 0);
  });

  it('dialog commit re-renders in place without reloading', async (t) => {
    let reloads = 0;
    const g = globalThis as { location?: unknown };
    const saved = g.location;
    g.location = {
      reload: () => {
        reloads++;
      }
    };
    t.after(() => {
      g.location = saved;
    });
    const f = fixture((doc) => [
      marker(doc, '0'),
      para(doc, 'Kept'),
      marker(doc, '1'),
      doc.createElement('section')
    ]);
    const tree: BlockTree = {
      version: 1,
      body: [
        { type: 'text', markdown: 'Kept' },
        { type: 'macro', macro: 'hero', slots: {} }
      ]
    };
    const renders: BlockTree[] = [];
    const shell = mount(
      f,
      tree,
      undefined,
      [{ name: 'hero', label: 'Hero', defaults: { heading: 'Fresh' } }],
      async (next) => {
        renders.push(next);
        return markedRender(next);
      }
    );
    shell.setMode('edit');
    f.root.querySelector('.rkr-unified-config')?.click();
    const heading = f.root
      .querySelector('.rkr-macro-dialog')
      ?.querySelectorAll('input')
      .find((i) => i.getAttribute('name') === 'heading');
    assert.ok(heading);
    (heading as unknown as { value: string }).value = 'New band';
    heading.dispatchEvent(new FakeEvent('input', { bubbles: true }));
    f.root
      .querySelectorAll('button')
      .find((b) => b.textContent === 'Save macro')
      ?.click();
    await tick();
    assert.equal(reloads, 0);
    assert.equal(renders.length, 1);
    assert.deepEqual((renders[0]?.body[1] as { slots?: unknown }).slots, { heading: 'New band' });
    assert.equal(
      f.root.querySelectorAll('.rkr-unified-config').length,
      1,
      'edit mode is re-applied after the swap'
    );
  });
});

function anchor(doc: FakeDocument, label: string): FakeElement {
  const a = doc.createElement('a');
  a.className = 'rkr-btn';
  a.textContent = label;
  return a;
}
