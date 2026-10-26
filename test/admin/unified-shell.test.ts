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

import { PALETTE_PRIMITIVES } from '../../src/admin/blocks-editor.ts';
import type { DraftRecord } from '../../src/admin/unified-draft.ts';
import { SaveConflict, SaveInvalid } from '../../src/admin/unified-save.ts';
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
  para,
  typeInto
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
  const titleEl = doc.createElement('span');
  titleEl.className = 'rkr-unified-title';
  titleEl.textContent = 'Old title';
  const settingsBtn = doc.createElement('button');
  settingsBtn.type = 'button';
  settingsBtn.className = 'rkr-unified-settings';
  settingsBtn.textContent = 'Page settings';
  toolbar.append(titleEl, settingsBtn);
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
          type: 'grid',
          slots: { cols: 1, band: true },
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
      PALETTE_PRIMITIVES.length + 1
    );
  });

  it('edit mode shows the palette and arms text leaves', () => {
    const tree: BlockTree = {
      version: 1,
      body: [
        { type: 'text', markdown: 'Hello' },
        {
          type: 'grid',
          slots: { cols: 1, band: true },
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

    assert.equal(f.root.querySelectorAll('.rkr-unified-config').length, 0, 'no per-block pills');
    const configure = () => f.root.querySelector('[data-action="configure"]');
    f.body.querySelector('figure')?.click();
    assert.deepEqual(shell.selectedPath, [1, 0]);
    assert.equal(configure()?.hidden, false, 'figures can be configured from the toolbar');
    f.body.querySelector('a')?.click();
    assert.equal(configure()?.hidden, false, 'buttons can be configured');
    f.body.querySelectorAll('section')[1]?.click();
    assert.equal(configure()?.hidden, false, 'macro instances can be configured');
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

  it('a click on a link is suppressed in edit mode and left alone in view mode', () => {
    const tree: BlockTree = { version: 1, body: [{ type: 'text', markdown: '[go](/x)' }] };
    const f = fixture((doc) => {
      const p = doc.createElement('p');
      const a = doc.createElement('a');
      a.setAttribute('href', '/x');
      a.append(doc.createTextNode('go'));
      p.append(a);
      return [marker(doc, '0'), p];
    });
    const shell = mount(f, tree);
    const link = f.body.querySelector('a') as FakeElement;
    const click = (): FakeEvent => {
      const ev = new FakeEvent('click');
      link.dispatchEvent(ev);
      return ev;
    };
    assert.equal(click().defaultPrevented, false, 'view mode follows the link');
    shell.setMode('edit');
    assert.equal(click().defaultPrevented, true, 'edit mode does not navigate');
  });

  it('palette click inserts right after the selected leaf', async () => {
    const tree: BlockTree = {
      version: 1,
      body: [
        { type: 'text', markdown: 'A' },
        { type: 'text', markdown: 'B' },
        { type: 'text', markdown: 'C' }
      ]
    };
    const saved: BlockTree[] = [];
    const f = fixture((doc) => [
      marker(doc, '0'),
      para(doc, 'A'),
      marker(doc, '1'),
      para(doc, 'B'),
      marker(doc, '2'),
      para(doc, 'C')
    ]);
    const shell = mount(f, tree, async (next) => {
      saved.push(next);
    });
    shell.setMode('edit');
    f.body.querySelectorAll('p')[0]?.click();
    f.dock
      .querySelectorAll('.rkr-blocks-palette-item')
      .find((btn) => btn.dataset.macro === 'primitive:button')
      ?.click();
    for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 0));
    assert.deepEqual(
      saved[0]?.body.map((n) => n.type),
      ['text', 'button', 'text', 'text']
    );
    assert.deepEqual(shell.selectedPath, [1]);
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
      .find((btn) => btn.dataset.macro === 'primitive:button');
    image?.click();
    for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 0));

    assert.equal(saved.length, 1, 'one save per insert');
    assert.deepEqual(
      saved[0]?.body.map((n) => n.type),
      ['text', 'button']
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
    typeInto(p, 'Hello edited');
    p.dispatchEvent(new FakeEvent('focusout'));
    await tick();
    assert.equal(saved.length, 1);
    assert.equal((saved[0]?.body[0] as { markdown?: string }).markdown, 'Hello edited');
    assert.equal(f.shellEl.getAttribute('data-save-state'), 'clean');
  });

  it('focus then blur on untouched punctuated text does not save', async () => {
    const source = "Hello, world. It's (mostly) fine - really.";
    const f = fixture((doc) => [marker(doc, '0'), para(doc, source)]);
    const saved: BlockTree[] = [];
    const shell = mount(
      f,
      { version: 1, body: [{ type: 'text', markdown: source }] },
      async (t) => {
        saved.push(t);
      }
    );
    shell.setMode('edit');
    const p = f.body.querySelector('p') as FakeElement;
    p.focus();
    p.dispatchEvent(new FakeEvent('focusout'));
    await tick();
    assert.equal(saved.length, 0);
  });

  it('focus then blur with no input never saves, even when the DOM differs', async () => {
    const { f, p, tree } = textOnly();
    const saved: BlockTree[] = [];
    const shell = mount(f, tree, async (t) => {
      saved.push(t);
    });
    shell.setMode('edit');
    p.textContent = 'Changed without an input event';
    p.focus();
    p.dispatchEvent(new FakeEvent('focusout'));
    await tick();
    assert.equal(saved.length, 0);
  });

  const mountRendered = async (
    tree: BlockTree,
    saved: BlockTree[] = []
  ): Promise<{ f: Fixture; shell: ReturnType<typeof mount> }> => {
    const html = await markedRender(tree);
    const f = fixture((doc) => {
      const holder = doc.createElement('div');
      holder.innerHTML = html;
      return [...holder.childNodes];
    });
    const shell = mount(f, tree, async (t) => {
      saved.push(t);
    });
    return { f, shell };
  };

  it('a text block that fails the markdown round trip is not editable in place', async () => {
    const { f, shell } = await mountRendered({
      version: 1,
      body: [
        { type: 'text', markdown: 'Look ![pic](/img/x.jpg) here' },
        { type: 'text', markdown: 'Plain words' }
      ]
    });
    shell.setMode('edit');
    const [rich, plain] = f.body.querySelectorAll('p');
    assert.equal(rich?.getAttribute('contenteditable'), null);
    assert.equal(plain?.getAttribute('contenteditable'), 'true');

    rich?.click();
    assert.deepEqual(shell.selectedPath, [0]);
    const note = f.root.querySelector('.rkr-block-note') as FakeElement;
    assert.equal(note.hidden, false);
    assert.equal(note.textContent, "This block has formatting the editor can't edit in place.");
    plain?.click();
    assert.equal(note.hidden, true);
  });

  it('images, quoted links and embeds stay byte-identical through focus and blur', async () => {
    const source = [
      'Look ![pic](/img/x.jpg) here',
      '> Quote with [a link](https://example.com)',
      '<iframe src="https://www.youtube.com/embed/x"></iframe>'
    ];
    const tree: BlockTree = {
      version: 1,
      body: [{ type: 'grid', children: source.map((markdown) => ({ type: 'text', markdown })) }]
    };
    const saved: BlockTree[] = [];
    const { f, shell } = await mountRendered(tree, saved);
    shell.setMode('edit');
    const leaves = f.body.querySelectorAll('[data-rkr-path]').filter((el) => {
      return el.getAttribute('data-rkr-path') !== '0';
    });
    assert.equal(leaves.length, 3);
    for (const el of leaves) {
      assert.equal(el.getAttribute('contenteditable'), null, el.tagName);
      el.focus();
      el.dispatchEvent(new FakeEvent('focusout'));
    }
    await tick();
    assert.equal(saved.length, 0);

    // A structural save carries the whole tree: the text leaves are untouched.
    f.dock
      .querySelectorAll('.rkr-blocks-palette-item')
      .find((btn) => btn.dataset.macro === 'primitive:button')
      ?.click();
    await tick();
    assert.equal(saved.length, 1);
    assert.equal(JSON.stringify(saved[0]?.body[0]), JSON.stringify(tree.body[0]));
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
    typeInto(p, 'First edit');
    p.dispatchEvent(new FakeEvent('focusout'));
    await tick(2);
    typeInto(p, 'Second edit');
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
    typeInto(p, 'Offline edit');
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
    f.body.querySelector('figure')?.click();
    f.root.querySelector('[data-action="configure"]')?.click();
    const dialog = f.root.querySelector('[data-rkr-dialog]');
    assert.ok(dialog, 'dialog opens on config click');
    const [alt, caption] = dialog.querySelectorAll('input');
    assert.ok(alt && caption, 'alt and caption inputs for the one image');
    (alt as unknown as { value: string }).value = 'new alt';
    alt.dispatchEvent(new FakeEvent('input'));
    (caption as unknown as { value: string }).value = 'new cap';
    caption.dispatchEvent(new FakeEvent('input'));
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

  function editedFigure(edit?: (f: Fixture) => void) {
    const { f, tree } = figureFixture();
    const saved: BlockTree[] = [];
    const renders: BlockTree[] = [];
    const shell = mountUnifiedShell(f.root as unknown as Element, {
      tree,
      macros: [],
      onSave: async (t) => {
        saved.push(t);
      },
      render: async (t) => {
        renders.push(t);
        return markedRender(t);
      },
      media: {
        pick: async () => [],
        thumbUrl: () => null,
        imageEditor: {
          open: () => {},
          apply: async () => true,
          close: () => {},
          dirty: () => false,
          previewUrl: () => 'blob:applied'
        }
      }
    });
    const run = async (): Promise<void> => {
      const tick = async () => {
        for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 0));
      };
      shell.setMode('edit');
      f.body.querySelector('figure')?.click();
      f.root.querySelector('[data-action="configure"]')?.click();
      const button = (label: string) =>
        f.root.querySelectorAll('button').find((b) => b.textContent === label);
      button('Edit image')?.click();
      button('Apply edits')?.click();
      await tick();
      edit?.(f);
      button('Cancel')?.click();
      await tick();
    };
    return { run, saved, renders };
  }

  it('cancel after applied image edits re-renders without saving', async () => {
    const h = editedFigure();
    await h.run();
    assert.equal(h.renders.length, 1, 'the page re-renders for the new derivatives');
    assert.equal(h.saved.length, 0, 'an unchanged tree is not saved');
  });

  it('cancel after applied image edits commits a focused text edit first', async () => {
    const h = editedFigure((f) => {
      const p = f.body.querySelectorAll('p').find((el) => el.textContent === 'Kept');
      assert.ok(p);
      typeInto(p, 'Kept edited');
      f.doc.activeElement = p;
    });
    await h.run();
    const last = h.saved.at(-1)?.body[1] as { markdown?: string } | undefined;
    assert.equal(last?.markdown, 'Kept edited');
    assert.equal(
      h.renders.at(-1)?.body[1] && (h.renders.at(-1)?.body[1] as { markdown?: string }).markdown,
      'Kept edited'
    );
  });

  it('inserting an image opens the picker and saves the picked ids', async () => {
    const f = fixture((doc) => [marker(doc, '0'), para(doc, 'Kept')]);
    const tree: BlockTree = { version: 1, body: [{ type: 'text', markdown: 'Kept' }] };
    const saved: BlockTree[] = [];
    const picks: string[] = [];
    const shell = mountUnifiedShell(f.root as unknown as Element, {
      tree,
      macros: [],
      onSave: async (t) => {
        saved.push(t);
      },
      render: markedRender,
      media: {
        pick: async (kind) => {
          picks.push(kind);
          return [IDS];
        },
        thumbUrl: () => null
      }
    });
    shell.setMode('edit');
    f.dock
      .querySelectorAll('button')
      .find((b) => b.querySelector('.rkr-palette-label')?.textContent === 'Image')
      ?.click();
    for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 0));
    assert.deepEqual(picks, ['image']);
    f.root
      .querySelectorAll('button')
      .find((b) => b.textContent === 'Save figure')
      ?.click();
    for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 0));
    assert.equal((saved.at(-1)?.body[1] as { slots?: { ids?: string } }).slots?.ids, IDS);
  });

  it('video blocks can be configured', () => {
    const f = fixture((doc) => [marker(doc, '0'), doc.createElement('figure')]);
    const tree: BlockTree = { version: 1, body: [{ type: 'video', slots: { ids: IDS } }] };
    const shell = mount(f, tree);
    shell.setMode('edit');
    f.body.querySelector('figure')?.click();
    const configure = f.root.querySelector('[data-action="configure"]');
    assert.equal(configure?.hidden, false);
    configure?.click();
    assert.ok(f.root.querySelectorAll('button').find((b) => b.textContent === 'Save video'));
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
    const btn = f.dock
      .querySelectorAll('button')
      .find((b) => b.querySelector('.rkr-palette-label')?.textContent === 'Button');
    assert.ok(btn, 'palette has the Button primitive');
    btn.dispatchEvent(
      Object.assign(new FakeEvent('dragstart'), {
        dataTransfer: { ...dragData('primitive:button'), setData: () => {} }
      })
    );
    target.dispatchEvent(
      Object.assign(new FakeEvent('dragover'), {
        clientY: 80,
        dataTransfer: dragData('primitive:button')
      })
    );
    target.dispatchEvent(
      Object.assign(new FakeEvent('drop'), {
        clientY: 80,
        dataTransfer: dragData('primitive:button')
      })
    );
    await tick();
    assert.equal(saved.length, 1);
    assert.deepEqual(
      saved[0]?.body.map((n) => n.type),
      ['text', 'button', 'text'],
      'figure lands after the first text leaf'
    );
  });

  it('dragging a block by its toolbar handle moves it below the target', async () => {
    const { f, tree } = twoText();
    const saved: BlockTree[] = [];
    const shell = mount(f, tree, async (t) => {
      saved.push(t);
    });
    shell.setMode('edit');
    const [one, two] = f.body.querySelectorAll('p');
    assert.ok(one && two);
    rectOf(two, 100, 40);
    one.click();
    const handle = f.root.querySelector('.rkr-block-drag');
    assert.ok(handle, 'the selected block shows a drag handle');
    handle.dispatchEvent(new FakeEvent('dragstart'));
    two.dispatchEvent(Object.assign(new FakeEvent('dragover'), { clientY: 130 }));
    assert.equal(two.getAttribute('data-drop'), 'after');
    two.dispatchEvent(Object.assign(new FakeEvent('drop'), { clientY: 130 }));
    await tick();
    assert.deepEqual(
      saved.at(-1)?.body.map((n) => (n as { markdown?: string }).markdown),
      ['Two', 'One']
    );
    assert.deepEqual(shell.selectedPath, [1]);
  });

  it('a block cannot be dropped into itself', async () => {
    const tree: BlockTree = {
      version: 1,
      body: [{ type: 'grid', slots: { cols: 2 }, children: [{ type: 'text', markdown: 'In' }] }]
    };
    const f = fixture(() => []);
    f.body.innerHTML = await markedRender(tree);
    const saved: BlockTree[] = [];
    const shell = mount(f, tree, async (t) => {
      saved.push(t);
    });
    shell.setMode('edit');
    const grid = f.body.querySelector('.rkr-grid');
    assert.ok(grid);
    rectOf(f.body.querySelector('.rkr-grid-cell') as FakeElement, 0, 90);
    grid.click();
    f.root.querySelector('.rkr-block-drag')?.dispatchEvent(new FakeEvent('dragstart'));
    const over = Object.assign(new FakeEvent('dragover'), { clientY: 45 });
    grid.dispatchEvent(over);
    assert.equal(over.defaultPrevented, false, 'a refused slot leaves the drop refused');
    grid.dispatchEvent(Object.assign(new FakeEvent('drop'), { clientY: 45 }));
    await tick();
    assert.equal(saved.length, 0);
  });

  it('a dropped image URL or other text inserts nothing', async () => {
    const { f, tree } = twoText();
    const saved: BlockTree[] = [];
    const shell = mount(f, tree, async (t) => {
      saved.push(t);
    });
    shell.setMode('edit');
    const [, two] = f.body.querySelectorAll('p');
    assert.ok(two);
    rectOf(two, 100, 40);
    for (const text of ['http://localhost:3010/img/abc.webp', 'some words']) {
      two.dispatchEvent(
        Object.assign(new FakeEvent('drop'), { clientY: 130, dataTransfer: dragData(text) })
      );
    }
    await tick();
    assert.equal(saved.length, 0);
  });

  it('a palette drag that ends refused leaves no name for a later foreign drop', async () => {
    const { f, tree } = twoText();
    const saved: BlockTree[] = [];
    const shell = mount(f, tree, async (t) => {
      saved.push(t);
    });
    shell.setMode('edit');
    const [, two] = f.body.querySelectorAll('p');
    assert.ok(two);
    rectOf(two, 100, 40);
    const btn = f.dock
      .querySelectorAll('button')
      .find((b) => b.querySelector('.rkr-palette-label')?.textContent === 'Button');
    assert.ok(btn);
    btn.dispatchEvent(new FakeEvent('dragstart'));
    btn.dispatchEvent(new FakeEvent('dragend'));
    two.dispatchEvent(
      Object.assign(new FakeEvent('drop'), { clientY: 130, dataTransfer: dragData('words') })
    );
    await tick();
    assert.equal(saved.length, 0);
  });

  it("the page's own images and links cannot start a native drag", () => {
    const { f, tree } = twoText();
    const shell = mount(f, tree, async () => {});
    shell.setMode('edit');
    const img = (f.body as unknown as { ownerDocument: FakeDocument }).ownerDocument.createElement(
      'img'
    );
    f.body.querySelector('p')?.append(img);
    const ev = new FakeEvent('dragstart');
    img.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true);
  });

  it('over the gap between stacked cells the drop lands between them', async () => {
    const tree: BlockTree = {
      version: 1,
      body: [
        {
          type: 'grid',
          children: [
            { type: 'text', markdown: 'One' },
            { type: 'text', markdown: 'Two' }
          ]
        }
      ]
    };
    const f = fixture(() => []);
    f.body.innerHTML = await markedRender(tree);
    const saved: BlockTree[] = [];
    const shell = mount(f, tree, async (t) => {
      saved.push(t);
    });
    shell.setMode('edit');
    const grid = f.body.querySelector('.rkr-grid');
    const [one, two] = f.body.querySelectorAll('.rkr-grid-cell');
    assert.ok(grid && one && two);
    rectOf(grid, 0, 1000);
    rectOf(one, 0, 100);
    rectOf(two, 600, 100);
    const over = { clientY: 560, dataTransfer: dragData('primitive:button') };
    const ev = Object.assign(new FakeEvent('dragover'), over);
    grid.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, true);
    assert.equal(one.getAttribute('data-drop'), 'after');
    assert.equal(one.getAttribute('data-drop-axis'), 'horizontal');
    assert.equal(grid.getAttribute('data-drop'), null, 'the grid edge is not marked');
    grid.dispatchEvent(Object.assign(new FakeEvent('drop'), over));
    assert.equal(one.getAttribute('data-drop'), null, 'the marker clears on drop');
    await tick();
    const kids = (saved.at(-1)?.body[0] as { children: BlockNode[] }).children;
    assert.deepEqual(
      kids.map((n) => n.type),
      ['text', 'button', 'text']
    );
  });

  it('a grid is refused at depth 3: no drop slot, and a click nudges', async () => {
    const tree: BlockTree = {
      version: 1,
      body: [
        {
          type: 'grid',
          slots: { cols: 1, band: true },
          children: [
            {
              type: 'grid',
              slots: { cols: 2 },
              children: [{ type: 'grid', children: [{ type: 'text', markdown: 'Deep' }] }]
            }
          ]
        }
      ]
    };
    const f = fixture(() => []);
    f.body.innerHTML = await markedRender(tree);
    let saves = 0;
    const shell = mount(f, tree, async () => {
      saves++;
    });
    shell.setMode('edit');
    const deep = f.body.querySelectorAll('.rkr-grid')[2];
    const cell = deep?.querySelector('.rkr-grid-cell');
    assert.ok(deep && cell);
    rectOf(cell, 0, 90);
    const over = { clientY: 120, dataTransfer: dragData('primitive:row') };
    const ev = Object.assign(new FakeEvent('dragover'), over);
    deep.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, false);
    assert.equal(cell.getAttribute('data-drop'), null);
    deep.dispatchEvent(Object.assign(new FakeEvent('drop'), over));
    await tick();
    assert.equal(saves, 0, 'refused insert saves nothing');
    f.body
      .querySelectorAll('p')
      .find((p) => p.textContent === 'Deep')
      ?.click();
    f.dock
      .querySelectorAll('button')
      .find((b) => b.querySelector('.rkr-palette-label')?.textContent === 'Row')
      ?.click();
    await tick();
    assert.equal(saves, 0);
    assert.match(f.shellEl.textContent ?? '', /grids nest at most 3 levels/);
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
        {
          type: 'grid',
          slots: { cols: 1, band: true },
          children: [{ type: 'text', markdown: 'In' }]
        },
        { type: 'text', markdown: 'After' }
      ]
    };
    const saved: BlockTree[] = [];
    const shell = mount(f, tree, async (t) => {
      saved.push(t);
    });
    shell.setMode('edit');
    f.body.querySelector('section')?.click();
    const btn = f.dock
      .querySelectorAll('button')
      .find((b) => b.querySelector('.rkr-palette-label')?.textContent === 'Text');
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
    f.body.querySelectorAll('[data-rkr-path]')[0]?.click();
    f.root.querySelector('[data-action="configure"]')?.click();
    const dialog = f.root.querySelector('[data-rkr-dialog]');
    assert.ok(dialog, 'dialog opens on macro config click');
    const heading = dialog
      .querySelectorAll('input')
      .find((i) => i.getAttribute('name') === 'heading');
    assert.ok(heading, 'heading field exists');
    (heading as unknown as { value: string }).value = 'New band';
    heading.dispatchEvent(new FakeEvent('input', { bubbles: true }));
    const saveBtn = f.root.querySelector('.rkr-dialog-primary');
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
    f.body.querySelector('[data-rkr-path]')?.click();
    f.root.querySelector('[data-action="configure"]')?.click();
    const dialog = f.root.querySelector('[data-rkr-dialog]');
    assert.ok(dialog);
    const sub = dialog.querySelectorAll('input').find((i) => i.getAttribute('name') === 'sub');
    assert.ok(sub);
    (sub as unknown as { value: string }).value = '';
    sub.dispatchEvent(new FakeEvent('input', { bubbles: true }));
    f.root.querySelector('.rkr-dialog-primary')?.click();
    await tick();
    assert.equal(saved.length, 1);
    assert.deepEqual((saved[0]?.body[0] as { slots?: unknown }).slots, { heading: 'Old' });
  });
});

describe('unified shell button dialog and shortcuts', () => {
  const tick = async (n = 10): Promise<void> => {
    for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
  };
  const buttonFixture = () =>
    fixture((doc) => {
      const a = doc.createElement('a');
      a.className = 'rkr-btn is-primary';
      a.textContent = 'Join';
      return [marker(doc, '0'), a];
    });
  const BUTTON_TREE: BlockTree = {
    version: 1,
    body: [{ type: 'button', slots: { label: 'Join', href: '/join', variant: 'primary' } }]
  };

  it('button config commits label, link and style through one save', async () => {
    const f = buttonFixture();
    const saved: BlockTree[] = [];
    const shell = mount(f, BUTTON_TREE, async (t) => {
      saved.push(t);
    });
    shell.setMode('edit');
    f.body.querySelector('a')?.click();
    f.root.querySelector('[data-action="configure"]')?.click();
    const field = (name: string) =>
      f.root.querySelector('[data-rkr-dialog]')?.querySelector(`[name="${name}"]`);
    const label = field('label');
    assert.ok(label, 'dialog has a label field');
    (label as unknown as { value: string }).value = 'Sign up';
    label.dispatchEvent(new FakeEvent('input', { bubbles: true }));
    const style = field('variant');
    (style as unknown as { value: string }).value = 'secondary';
    style?.dispatchEvent(new FakeEvent('change', { bubbles: true }));
    f.root.querySelector('.rkr-dialog-primary')?.click();
    await tick(3);
    assert.equal(saved.length, 1);
    assert.deepEqual((saved[0]?.body[0] as { slots?: unknown }).slots, {
      label: 'Sign up',
      href: '/join',
      variant: 'secondary'
    });
  });

  it('button config with an empty link stays open and saves nothing', async () => {
    const f = buttonFixture();
    const saved: BlockTree[] = [];
    const shell = mount(f, BUTTON_TREE, async (t) => {
      saved.push(t);
    });
    shell.setMode('edit');
    f.body.querySelector('a')?.click();
    f.root.querySelector('[data-action="configure"]')?.click();
    const href = f.root.querySelector('[data-rkr-dialog]')?.querySelector('[name="href"]');
    assert.ok(href);
    (href as unknown as { value: string }).value = '';
    href.dispatchEvent(new FakeEvent('input', { bubbles: true }));
    f.root.querySelector('.rkr-dialog-primary')?.click();
    await tick(3);
    assert.equal(saved.length, 0);
    assert.ok(f.root.querySelector('[data-rkr-dialog]'), 'dialog still open');
  });

  const modKey = (key: string) =>
    Object.assign(new FakeEvent('keydown'), { key, ctrlKey: true, target: null });

  it('Mod+E toggles the mode and marks the page as editing', () => {
    const f = buttonFixture();
    mount(f, BUTTON_TREE);
    assert.equal(f.shellEl.getAttribute('data-mode'), 'view');
    f.doc.dispatchEvent(modKey('e'));
    assert.equal(f.shellEl.getAttribute('data-mode'), 'edit');
    assert.ok(f.doc.documentElement.hasAttribute('data-rkr-editing'));
    f.doc.dispatchEvent(modKey('e'));
    assert.equal(f.shellEl.getAttribute('data-mode'), 'view');
    assert.equal(f.doc.documentElement.hasAttribute('data-rkr-editing'), false);
  });

  it('Mod+S retries an unsaved page', async () => {
    const f = buttonFixture();
    let fail = true;
    const saved: BlockTree[] = [];
    const shell = mount(f, BUTTON_TREE, async (t) => {
      if (fail) throw new Error('offline');
      saved.push(t);
    });
    shell.setMode('edit');
    await shell.applyTree({ ...BUTTON_TREE });
    assert.equal(f.shellEl.getAttribute('data-save-state'), 'unsaved');
    fail = false;
    const ev = modKey('s');
    f.doc.dispatchEvent(ev);
    await tick(3);
    assert.equal(ev.defaultPrevented, true);
    assert.equal(saved.length, 1);
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
    const btn = f.dock
      .querySelectorAll('button')
      .find((b) => b.querySelector('.rkr-palette-label')?.textContent === label);
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

    typeInto(moved, 'Hello edited');
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
    paletteButton(f, 'Button').click();
    await tick(2);
    gates[0]?.();
    await tick();
    assert.equal(f.body.querySelectorAll('[data-rkr-blank]').length, 0, 'stale render discarded');
    assert.equal(renders.length, 2, 'the latest tree is rendered next');
    gates[1]?.();
    await tick();

    assert.deepEqual(
      renders[1]?.body.map((n) => n.type),
      ['text', 'text', 'button']
    );
    assert.equal(f.body.querySelectorAll('[data-rkr-blank]').length, 1);
    assert.ok(f.body.querySelector('[data-rkr-path="2"]'), 'the button is hydrated');
    assert.equal(saved.length, 1, 'one save, of the latest tree');
    assert.deepEqual(
      saved[0]?.body.map((n) => n.type),
      ['text', 'text', 'button']
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
    typeInto(p, 'Hello edited');
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
    typeInto(blank, 'New words');
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
    assert.equal(section.type, 'grid');
    assert.equal(section.children?.length, 1, 'the second insert lands inside the new section');
  });

  it('the toolbar follows an inserted node and hides in view mode', async () => {
    const { f, tree } = hello();
    const shell = mount(f, tree);
    shell.setMode('edit');
    paletteButton(f, 'Image').click();
    await tick();
    const bar = f.root.querySelector('.rkr-block-toolbar');
    assert.equal(bar?.hidden, false);
    assert.equal(f.root.querySelector('[data-action="configure"]')?.hidden, false);
    shell.setMode('view');
    assert.equal(bar?.hidden, true);
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
    f.body.querySelector('[data-rkr-path="1"]')?.click();
    f.root.querySelector('[data-action="configure"]')?.click();
    const heading = f.root
      .querySelector('[data-rkr-dialog]')
      ?.querySelectorAll('input')
      .find((i) => i.getAttribute('name') === 'heading');
    assert.ok(heading);
    (heading as unknown as { value: string }).value = 'New band';
    heading.dispatchEvent(new FakeEvent('input', { bubbles: true }));
    f.root.querySelector('.rkr-dialog-primary')?.click();
    await tick();
    assert.equal(reloads, 0);
    assert.equal(renders.length, 1);
    assert.deepEqual((renders[0]?.body[1] as { slots?: unknown }).slots, { heading: 'New band' });
    assert.equal(
      f.root.querySelector('[data-action="configure"]')?.hidden,
      false,
      'edit mode and selection are re-applied after the swap'
    );
  });
});

function anchor(doc: FakeDocument, label: string): FakeElement {
  const a = doc.createElement('a');
  a.className = 'rkr-btn';
  a.textContent = label;
  return a;
}

describe('unified shell drafts and offline', () => {
  const tick = async (n = 10): Promise<void> => {
    for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
  };
  const hello = (): { f: Fixture; tree: BlockTree } => ({
    f: fixture((doc) => [marker(doc, '0'), para(doc, 'Hello')]),
    tree: { version: 1, body: [{ type: 'text', markdown: 'Hello' }] }
  });

  function drafts(record: DraftRecord | null) {
    const store = {
      record,
      cleared: 0,
      load: async () => store.record,
      put: async (r: DraftRecord) => {
        store.record = r;
      },
      clear: async () => {
        store.cleared++;
        store.record = null;
      }
    };
    return store;
  }

  it('a stored draft that differs is restored, saved against its base, and noted', async () => {
    const { f, tree } = hello();
    const restored: BlockTree = { version: 1, body: [{ type: 'text', markdown: 'Offline words' }] };
    const store = drafts({ tree: restored, baseVersion: 'v1', savedAt: 5 });
    const saves: { tree: BlockTree; base?: string }[] = [];
    mountUnifiedShell(f.root as unknown as Element, {
      tree,
      macros: [],
      version: 'v1',
      drafts: store,
      onSave: async (t, base) => {
        saves.push({ tree: t, base });
        return 'v2';
      },
      render: markedRender
    });
    await tick();
    assert.equal(f.body.querySelector('p')?.textContent, 'Offline words');
    assert.equal(saves.length, 1);
    assert.equal(saves[0]?.base, 'v1');
    assert.equal(
      f.toolbar.querySelector('.rkr-unified-save-state')?.textContent,
      'Restored unsaved changes'
    );
    assert.equal(store.record, null);
  });

  it('a draft equal to the page is dropped without saving', async () => {
    const { f, tree } = hello();
    const store = drafts({ tree: structuredClone(tree), baseVersion: 'v0', savedAt: 5 });
    let saves = 0;
    mountUnifiedShell(f.root as unknown as Element, {
      tree,
      macros: [],
      version: 'v1',
      drafts: store,
      onSave: async () => {
        saves++;
      },
      render: markedRender
    });
    await tick();
    assert.equal(saves, 0);
    assert.equal(store.cleared, 1);
  });

  it('structural edits are refused offline; text edits still save', async (t) => {
    const nav = globalThis.navigator as { onLine?: boolean };
    Object.defineProperty(nav, 'onLine', { value: false, configurable: true });
    t.after(() => {
      delete nav.onLine;
    });
    const { f, tree } = hello();
    const saved: BlockTree[] = [];
    let renders = 0;
    const shell = mount(
      f,
      tree,
      async (next) => {
        saved.push(next);
      },
      undefined,
      async (next) => {
        renders++;
        return markedRender(next);
      }
    );
    shell.setMode('edit');
    const before = f.body.innerHTML;
    await shell.applyTree({ version: 1, body: [...tree.body, { type: 'text', markdown: '' }] });
    assert.equal(renders, 0);
    assert.equal(f.body.innerHTML, before);
    assert.equal(f.body.getAttribute('inert'), null);
    assert.equal(
      f.toolbar.querySelector('.rkr-unified-save-state')?.textContent,
      'Reconnect to add or move blocks'
    );

    const p = f.body.querySelector('p') as FakeElement;
    typeInto(p, 'Typed offline');
    p.dispatchEvent(new FakeEvent('focusout'));
    await tick();
    assert.deepEqual(saved.at(-1)?.body, [{ type: 'text', markdown: 'Typed offline' }]);
  });

  const goOffline = (t: { after(fn: () => void): void }): void => {
    const nav = globalThis.navigator as { onLine?: boolean };
    Object.defineProperty(nav, 'onLine', { value: false, configurable: true });
    t.after(() => {
      delete nav.onLine;
    });
  };
  const OFFLINE_DIALOG = "You're offline. Keep this open and save when you reconnect.";

  it('a failed render keeps the new tree in the draft', async () => {
    const { f, tree } = hello();
    const store = drafts(null);
    const shell = mountUnifiedShell(f.root as unknown as Element, {
      tree,
      macros: [],
      version: 'v1',
      drafts: store,
      onSave: async () => {},
      render: async () => {
        throw new Error('render 503');
      }
    });
    const next: BlockTree = { version: 1, body: [...tree.body, { type: 'text', markdown: '' }] };
    await shell.applyTree(next);
    await tick();
    assert.equal(f.shellEl.getAttribute('data-save-state'), 'unsaved');
    assert.equal(store.record?.tree, next);
    assert.equal(store.record?.baseVersion, 'v1');
  });

  it('a restored draft that conflicts names its time on this device', async () => {
    const { f, tree } = hello();
    const savedAt = Date.UTC(2026, 9, 20, 9, 5);
    const store = drafts({
      tree: { version: 1, body: [{ type: 'text', markdown: 'Old device words' }] },
      baseVersion: 'v1',
      savedAt
    });
    mountUnifiedShell(f.root as unknown as Element, {
      tree,
      macros: [],
      version: 'v2',
      drafts: store,
      onSave: async () => {
        throw new SaveConflict('v2');
      },
      render: markedRender
    });
    await tick();
    const dialog = f.root.querySelector('[data-rkr-dialog]');
    assert.ok(dialog);
    assert.ok(
      (dialog.textContent ?? '').includes(
        `Unsaved changes from ${new Date(savedAt).toLocaleString()} on this device`
      )
    );
    assert.equal(f.root.querySelector('.rkr-dialog-primary')?.textContent, 'Load latest');
  });

  it('pagehide commits the focused text and drafts it', () => {
    const { f, tree } = hello();
    const store = drafts(null);
    const win = new EventTarget();
    const shell = mountUnifiedShell(f.root as unknown as Element, {
      tree,
      macros: [],
      version: 'v1',
      drafts: store,
      win,
      onSave: () => new Promise(() => {}),
      render: markedRender
    });
    shell.setMode('edit');
    const p = f.body.querySelector('p') as FakeElement;
    typeInto(p, 'Typed before closing');
    f.doc.activeElement = p;
    win.dispatchEvent(new Event('pagehide'));
    assert.deepEqual(store.record?.tree.body, [{ type: 'text', markdown: 'Typed before closing' }]);
  });

  it('an offline figure dialog stays open with its edits', async (t) => {
    goOffline(t);
    const f = fixture((doc) => [marker(doc, '0'), doc.createElement('figure')]);
    const tree: BlockTree = {
      version: 1,
      body: [{ type: 'figure', slots: { ids: 'ab'.repeat(32), alts: 'old' } }]
    };
    const saved: BlockTree[] = [];
    const shell = mount(f, tree, async (next) => {
      saved.push(next);
    });
    shell.setMode('edit');
    f.body.querySelector('figure')?.click();
    f.root.querySelector('[data-action="configure"]')?.click();
    const alt = f.root.querySelector('[data-rkr-dialog]')?.querySelectorAll('input')[0];
    assert.ok(alt);
    (alt as unknown as { value: string }).value = 'typed offline';
    alt.dispatchEvent(new FakeEvent('input'));
    f.root
      .querySelectorAll('button')
      .find((b) => b.textContent === 'Save figure')
      ?.click();
    await tick();
    assert.equal(saved.length, 0);
    const dialog = f.root.querySelector('[data-rkr-dialog]');
    assert.ok(dialog, 'the dialog stays open');
    assert.equal(dialog.querySelector('.rkr-dialog-error')?.textContent, OFFLINE_DIALOG);
    assert.equal((alt as unknown as { value: string }).value, 'typed offline');
  });

  it('an offline macro dialog stays open with its edits', async (t) => {
    goOffline(t);
    const f = fixture((doc) => {
      const card = doc.createElement('div');
      card.append(doc.createTextNode('hero'));
      return [marker(doc, '0'), card];
    });
    const tree: BlockTree = { version: 1, body: [{ type: 'macro', macro: 'hero', slots: {} }] };
    const saved: BlockTree[] = [];
    const shell = mount(
      f,
      tree,
      async (next) => {
        saved.push(next);
      },
      [{ name: 'hero', label: 'Hero', defaults: { heading: 'Fresh' } }]
    );
    shell.setMode('edit');
    f.body.querySelector('[data-rkr-path]')?.click();
    f.root.querySelector('[data-action="configure"]')?.click();
    const heading = f.root
      .querySelector('[data-rkr-dialog]')
      ?.querySelectorAll('input')
      .find((i) => i.getAttribute('name') === 'heading');
    assert.ok(heading);
    (heading as unknown as { value: string }).value = 'Offline band';
    heading.dispatchEvent(new FakeEvent('input', { bubbles: true }));
    f.root.querySelector('.rkr-dialog-primary')?.click();
    await tick();
    assert.equal(saved.length, 0);
    const dialog = f.root.querySelector('[data-rkr-dialog]');
    assert.ok(dialog, 'the dialog stays open');
    assert.equal(dialog.querySelector('.rkr-dialog-error')?.textContent, OFFLINE_DIALOG);
  });

  it('an offline cancel after image edits keeps the pending text edit', async (t) => {
    goOffline(t);
    const f = fixture((doc) => [
      marker(doc, '0'),
      doc.createElement('figure'),
      marker(doc, '1'),
      para(doc, 'Kept')
    ]);
    const tree: BlockTree = {
      version: 1,
      body: [
        { type: 'figure', slots: { ids: 'ab'.repeat(32) } },
        { type: 'text', markdown: 'Kept' }
      ]
    };
    const saved: BlockTree[] = [];
    const store = drafts(null);
    const shell = mountUnifiedShell(f.root as unknown as Element, {
      tree,
      macros: [],
      drafts: store,
      onSave: async (next) => {
        saved.push(next);
      },
      render: markedRender,
      media: {
        pick: async () => [],
        thumbUrl: () => null,
        imageEditor: {
          open: () => {},
          apply: async () => true,
          close: () => {},
          dirty: () => false,
          previewUrl: () => null
        }
      }
    });
    shell.setMode('edit');
    f.body.querySelector('figure')?.click();
    f.root.querySelector('[data-action="configure"]')?.click();
    const button = (label: string) =>
      f.root.querySelectorAll('button').find((b) => b.textContent === label);
    button('Edit image')?.click();
    button('Apply edits')?.click();
    await tick();
    const p = f.body.querySelectorAll('p').find((el) => el.textContent === 'Kept');
    assert.ok(p);
    typeInto(p, 'Kept offline');
    f.doc.activeElement = p;
    button('Cancel')?.click();
    await tick();
    assert.equal((saved.at(-1)?.body[1] as { markdown?: string }).markdown, 'Kept offline');
    assert.equal(f.body.getAttribute('inert'), null);
  });
});

describe('unified shell page settings', () => {
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('commits fields into the tree, saves them and retitles the toolbar without re-rendering', async () => {
    const tree: BlockTree = {
      version: 1,
      body: [{ type: 'text', markdown: 'One' }],
      fields: { title: 'Old title', slug: 'saved', tags: ['x'] }
    };
    const f = fixture((doc) => [marker(doc, '0'), para(doc, 'One')]);
    const saved: BlockTree[] = [];
    let renders = 0;
    mount(
      f,
      tree,
      async (t) => {
        saved.push(t);
      },
      [],
      async (t) => {
        renders++;
        return markedRender(t);
      }
    );
    f.toolbar.querySelector('.rkr-unified-settings')?.click();
    const input = f.root
      .querySelector('[data-rkr-dialog]')
      ?.querySelectorAll('input')
      .find((i) => i.getAttribute('name') === 'title');
    assert.ok(input);
    (input as unknown as { value: string }).value = 'New title';
    input.dispatchEvent(new FakeEvent('input', { bubbles: true }));
    f.root.querySelector('.rkr-dialog-primary')?.click();
    await tick();
    await tick();
    assert.equal(renders, 0);
    assert.equal(f.toolbar.querySelector('.rkr-unified-title')?.textContent, 'New title');
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0]?.fields, {
      title: 'New title',
      slug: 'saved',
      tags: ['x'],
      status: 'draft',
      date: '',
      excerpt: '',
      subtitle: ''
    });
  });

  const mountWithDelete = (onDelete: () => Promise<void>) => {
    const tree: BlockTree = {
      version: 1,
      body: [{ type: 'text', markdown: 'One' }],
      fields: { title: 'Doomed', slug: 'saved' }
    };
    const f = fixture((doc) => [marker(doc, '0'), para(doc, 'One')]);
    mountUnifiedShell(f.root as unknown as Element, {
      tree,
      macros: [],
      onSave: async () => {},
      render: markedRender,
      onDelete
    });
    f.toolbar.querySelector('.rkr-unified-settings')?.click();
    f.root.querySelector('.rkr-page-delete')?.click();
    f.root.querySelector('.rkr-dialog-primary')?.click();
    return f;
  };

  it('Delete page in settings calls onDelete once confirmed', async () => {
    let deletes = 0;
    const f = mountWithDelete(async () => {
      deletes++;
    });
    await tick();
    await tick();
    assert.equal(deletes, 1);
    assert.equal(f.root.querySelector('[data-rkr-dialog]'), null);
  });

  it('a failed delete keeps the dialog open with a message', async () => {
    const f = mountWithDelete(async () => {
      throw new Error('delete page 500');
    });
    await tick();
    await tick();
    assert.match(
      f.root.querySelector('.rkr-dialog-error')?.textContent ?? '',
      /Couldn't delete the page/
    );
  });
});

describe('unified shell add-block sheet', () => {
  it('makes the page body inert while open and restores it on close', () => {
    const f = fixture((doc) => [marker(doc, '0'), para(doc, 'Hi')]);
    mount(f, { version: 1, body: [{ type: 'text', markdown: 'Hi' }] });
    const fab = f.root.querySelector('.rkr-add-fab') as FakeElement;
    const close = f.root.querySelector('.rkr-sheet-close') as FakeElement;
    fab.click();
    assert.equal(f.body.hasAttribute('inert'), true);
    assert.equal(f.dock.classList.contains('is-open'), true);
    close.click();
    assert.equal(f.body.hasAttribute('inert'), false);
    assert.equal(f.dock.classList.contains('is-open'), false);
  });

  const deferred = () => {
    let resolve!: (html: string) => void;
    const promise = new Promise<string>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  const setup = () => {
    const tree: BlockTree = { version: 1, body: [{ type: 'text', markdown: 'Hi' }] };
    const f = fixture((doc) => [marker(doc, '0'), para(doc, 'Hi')]);
    const pending = deferred();
    const shell = mount(f, tree, undefined, undefined, () => pending.promise);
    const next: BlockTree = { version: 1, body: [{ type: 'text', markdown: 'Hi!' }] };
    return {
      f,
      pending,
      render: () => shell.applyTree(next),
      fab: f.root.querySelector('.rkr-add-fab') as FakeElement,
      close: f.root.querySelector('.rkr-sheet-close') as FakeElement
    };
  };
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 0));
  };

  it('closing the sheet mid-render leaves the body inert until the render lands', async () => {
    const { f, pending, render, fab, close } = setup();
    const done = render();
    fab.click();
    close.click();
    assert.equal(f.body.hasAttribute('inert'), true, 'render still holds it');
    pending.resolve('<!--rkr:path=0--><p>Hi!</p>');
    await done;
    assert.equal(f.body.hasAttribute('inert'), false);
  });

  it('a render landing under an open sheet leaves the body inert until it closes', async () => {
    const { f, pending, render, fab, close } = setup();
    const done = render();
    fab.click();
    pending.resolve('<!--rkr:path=0--><p>Hi!</p>');
    await done;
    await settle();
    assert.equal(f.body.hasAttribute('inert'), true, 'sheet still holds it');
    close.click();
    assert.equal(f.body.hasAttribute('inert'), false);
  });
});

describe('unified shell media-first insert and refused saves', () => {
  const IDS = 'cd'.repeat(32);
  const tick = async (n = 10): Promise<void> => {
    for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
  };
  const button = (f: Fixture, label: string): FakeElement | undefined =>
    f.root.querySelectorAll('button').find((b) => b.textContent === label);
  const palette = (f: Fixture, label: string): FakeElement => {
    const btn = f.dock
      .querySelectorAll('button')
      .find((b) => b.querySelector('.rkr-palette-label')?.textContent === label);
    assert.ok(btn, `palette has ${label}`);
    return btn;
  };

  interface MediaOpts {
    failFirstSave?: boolean;
    gateRenders?: boolean;
  }

  function mediaShell(picked: string[], opts: MediaOpts = {}) {
    const f = fixture((doc) => [marker(doc, '0'), para(doc, 'Kept')]);
    const tree: BlockTree = { version: 1, body: [{ type: 'text', markdown: 'Kept' }] };
    const saved: BlockTree[] = [];
    const renders: BlockTree[] = [];
    const puts: DraftRecord[] = [];
    const gates: (() => void)[] = [];
    const win = new EventTarget();
    let sends = 0;
    const shell = mountUnifiedShell(f.root as unknown as Element, {
      tree,
      macros: [],
      win,
      onSave: async (t) => {
        sends++;
        if (opts.failFirstSave && sends === 1) throw new Error('save page 500');
        saved.push(t);
      },
      render: (t) => {
        renders.push(t);
        if (!opts.gateRenders) return markedRender(t);
        return new Promise<string>((resolve) => {
          gates.push(() => resolve(markedRender(t)));
        });
      },
      drafts: {
        load: async () => null,
        put: async (r) => {
          puts.push(r);
        },
        clear: async () => {}
      },
      media: { pick: async () => picked, thumbUrl: () => null }
    });
    shell.setMode('edit');
    const openGates = (): void => {
      for (const open of gates.splice(0)) open();
    };
    return { f, shell, saved, renders, puts, win, openGates, sends: () => sends };
  }

  /** Type into the first paragraph and blur it. */
  const editKept = (f: Fixture, text: string): void => {
    const p = f.body.querySelector('p');
    assert.ok(p);
    typeInto(p, text);
    p.dispatchEvent(new FakeEvent('focusout'));
  };

  it('Configure on an existing figure refuses to save it empty', async () => {
    const f = fixture((doc) => [marker(doc, '0'), doc.createElement('figure')]);
    const tree: BlockTree = { version: 1, body: [{ type: 'figure', slots: { ids: IDS } }] };
    const saved: BlockTree[] = [];
    const shell = mount(f, tree, async (t) => {
      saved.push(t);
    });
    shell.setMode('edit');
    f.body.querySelector('figure')?.click();
    f.root.querySelector('[data-action="configure"]')?.click();
    button(f, 'Remove')?.click();
    button(f, 'Save figure')?.click();
    await tick();
    assert.equal(saved.length, 0);
    assert.ok(f.root.querySelector('[data-rkr-dialog]'), 'the dialog stays open');
    assert.match(
      f.root.querySelector('[data-rkr-dialog]')?.textContent ?? '',
      /Pick an image, or delete the block\./
    );
  });

  it('cancelling an Image that superseded a pending insert still saves that insert', async () => {
    const h = mediaShell([], { gateRenders: true });
    palette(h.f, 'Text').click();
    await tick(2);
    palette(h.f, 'Image').click();
    await tick(2);
    button(h.f, 'Cancel')?.click();
    await tick(2);
    h.openGates();
    await tick();
    h.openGates();
    await tick();
    assert.deepEqual(
      h.saved.at(-1)?.body.map((n) => n.type),
      ['text', 'text']
    );
  });

  it('Cancel while offline drops the block from the tree at once', async (t) => {
    const h = mediaShell([]);
    palette(h.f, 'Image').click();
    await tick();
    const nav = globalThis.navigator as { onLine?: boolean };
    Object.defineProperty(nav, 'onLine', { value: false, configurable: true });
    t.after(() => {
      delete nav.onLine;
    });
    const rendersBefore = h.renders.length;
    button(h.f, 'Cancel')?.click();
    await tick();
    assert.equal(h.renders.length, rendersBefore, 'no render offline');
    assert.equal(h.f.body.getAttribute('inert'), '', 'the stale page is inert');
    delete nav.onLine;
    h.win.dispatchEvent(new Event('online'));
    await tick();
    assert.deepEqual(
      h.renders.at(-1)?.body.map((n) => n.type),
      ['text']
    );
    assert.equal(h.f.body.getAttribute('inert'), null);
    editKept(h.f, 'Kept online');
    await tick();
    assert.deepEqual(
      h.saved.at(-1)?.body.map((n) => n.type),
      ['text']
    );
  });

  it('Retry while the picker is open sends nothing', async () => {
    const h = mediaShell([], { failFirstSave: true });
    editKept(h.f, 'Kept edited');
    await tick();
    assert.equal(h.f.shellEl.getAttribute('data-save-state'), 'unsaved');
    palette(h.f, 'Image').click();
    await tick();
    h.f.root.querySelector('.rkr-unified-save')?.click();
    await tick();
    assert.equal(h.sends(), 1, 'the pending block is never sent');
    button(h.f, 'Cancel')?.click();
    await tick();
    assert.equal(h.sends(), 2, 'Cancel saves the earlier edit');
    assert.deepEqual(h.saved.at(-1)?.body, [{ type: 'text', markdown: 'Kept edited' }]);
  });

  it('pagehide while the picker is open drafts the tree without the block', async () => {
    const h = mediaShell([], { failFirstSave: true });
    editKept(h.f, 'Kept edited');
    await tick();
    palette(h.f, 'Image').click();
    await tick();
    h.win.dispatchEvent(new Event('pagehide'));
    await tick();
    assert.deepEqual(h.puts.at(-1)?.tree.body, [{ type: 'text', markdown: 'Kept edited' }]);
  });

  it('Image then Cancel saves nothing and removes the block', async () => {
    const h = mediaShell([]);
    palette(h.f, 'Image').click();
    await tick();
    assert.deepEqual(
      h.renders[0]?.body.map((n) => n.type),
      ['text', 'figure'],
      'the block renders while the picker is open'
    );
    assert.ok(h.f.root.querySelector('[data-rkr-dialog]'));
    button(h.f, 'Cancel')?.click();
    await tick();
    assert.equal(h.saved.length, 0);
    assert.equal(h.puts.length, 0, 'no draft either');
    assert.deepEqual(
      h.renders.at(-1)?.body.map((n) => n.type),
      ['text']
    );
    assert.equal(h.f.shellEl.getAttribute('data-save-state'), 'clean');
    const p = h.f.body.querySelector('p');
    assert.ok(p);
    typeInto(p, 'Kept edited');
    p.dispatchEvent(new FakeEvent('focusout'));
    await tick();
    assert.deepEqual(
      h.saved.at(-1)?.body.map((n) => n.type),
      ['text'],
      'the cancelled block never reaches a later save'
    );
  });

  it('Image then a pick saves once with the ids', async () => {
    const h = mediaShell([IDS]);
    palette(h.f, 'Image').click();
    await tick();
    assert.equal(h.saved.length, 0, 'nothing saves before the dialog commits');
    button(h.f, 'Save figure')?.click();
    await tick();
    assert.equal(h.saved.length, 1);
    assert.equal((h.saved[0]?.body[1] as { slots?: { ids?: string } }).slots?.ids, IDS);
    assert.deepEqual(h.shell.selectedPath, [1]);
  });

  it('committing the dialog with nothing picked inserts nothing', async () => {
    const h = mediaShell([]);
    palette(h.f, 'Video').click();
    await tick();
    button(h.f, 'Save video')?.click();
    await tick();
    assert.equal(h.saved.length, 0);
    assert.deepEqual(
      h.renders.at(-1)?.body.map((n) => n.type),
      ['text']
    );
  });

  it('a dropped Image opens the picker before anything saves', async () => {
    const h = mediaShell([]);
    const p = h.f.body.querySelector('p');
    assert.ok(p);
    const data = { getData: () => 'primitive:figure', setData: () => {} };
    p.dispatchEvent(Object.assign(new FakeEvent('drop'), { clientY: 0, dataTransfer: data }));
    await tick();
    assert.ok(h.f.root.querySelector('[data-rkr-dialog]'));
    assert.equal(h.saved.length, 0);
    button(h.f, 'Cancel')?.click();
    await tick();
    assert.equal(h.saved.length, 0);
  });

  it('a refused save selects and notes the block until the tree changes', async () => {
    const message =
      "This block can't be saved: the macro ghost no longer exists. Delete it to save.";
    const f = fixture((doc) => [
      marker(doc, '0'),
      para(doc, 'A'),
      marker(doc, '1'),
      doc.createElement('section')
    ]);
    const tree: BlockTree = {
      version: 1,
      body: [
        { type: 'text', markdown: 'A' },
        { type: 'macro', macro: 'ghost' }
      ]
    };
    let sends = 0;
    const shell = mount(f, tree, async () => {
      sends++;
      if (sends === 1) throw new SaveInvalid(message, [1]);
    });
    shell.setMode('edit');
    const p = f.body.querySelector('p');
    assert.ok(p);
    typeInto(p, 'A edited');
    p.dispatchEvent(new FakeEvent('focusout'));
    await tick();
    assert.deepEqual(shell.selectedPath, [1]);
    const note = f.root.querySelector('.rkr-block-note');
    assert.equal(note?.hidden, false);
    assert.equal(note?.textContent, message);
    assert.equal(f.shellEl.getAttribute('data-save-state'), 'unsaved');
    f.root.querySelector('.rkr-unified-save')?.click();
    await tick();
    assert.equal(sends, 1, 'no retry until the tree changes');
    p.click();
    typeInto(p, 'A again');
    p.dispatchEvent(new FakeEvent('focusout'));
    await tick();
    assert.equal(sends, 2);
    f.body.querySelector('section')?.click();
    assert.equal(f.root.querySelector('.rkr-block-note')?.hidden, true, 'the note is cleared');
    assert.equal(f.shellEl.getAttribute('data-save-state'), 'clean');
  });

  it('Section inserts at page level after the selected block in a grid', async () => {
    const tree: BlockTree = {
      version: 1,
      body: [
        { type: 'grid', slots: { cols: 2 }, children: [{ type: 'text', markdown: 'In' }] },
        { type: 'text', markdown: 'After' }
      ]
    };
    const f = fixture((doc) => {
      const grid = doc.createElement('div');
      grid.className = 'rkr-grid';
      grid.append(marker(doc, '0,0'), para(doc, 'In'));
      return [marker(doc, '0'), grid, marker(doc, '1'), para(doc, 'After')];
    });
    const saved: BlockTree[] = [];
    const shell = mount(f, tree, async (t) => {
      saved.push(t);
    });
    shell.setMode('edit');
    f.body.querySelector('p')?.click();
    assert.deepEqual(shell.selectedPath, [0, 0]);
    palette(f, 'Section').click();
    await tick();
    const body = saved.at(-1)?.body ?? [];
    assert.deepEqual(
      body.map((n) => n.type),
      ['grid', 'grid', 'text']
    );
    assert.equal((body[1] as { slots?: { band?: boolean } }).slots?.band, true);
    assert.equal((body[0] as { children: unknown[] }).children.length, 1);
    assert.deepEqual(shell.selectedPath, [1]);
  });

  it('a selected band grid reads Section in the toolbar', async () => {
    const tree: BlockTree = {
      version: 1,
      body: [
        {
          type: 'grid',
          slots: { cols: 1, band: true, theme: 'light', edge: 'straight' },
          children: [{ type: 'text', markdown: 'Inside' }]
        }
      ]
    };
    const f = fixture(() => []);
    f.body.innerHTML = await markedRender(tree);
    const shell = mount(f, tree);
    shell.setMode('edit');
    const band = f.body.querySelector('section');
    assert.equal(band?.getAttribute('data-rkr-path'), '0');
    band?.click();
    assert.equal(f.root.querySelector('.rkr-block-type')?.textContent, 'Section');
  });
});
