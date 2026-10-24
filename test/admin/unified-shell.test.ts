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
import type { BlockTree } from '../../src/lib/blocks.ts';

type Listener = (ev: FakeEvent) => void;

class FakeEvent {
  readonly type: string;
  readonly bubbles: boolean;
  target: FakeNode | null = null;
  currentTarget: FakeNode | null = null;
  defaultPrevented = false;
  stopped = false;

  constructor(type: string, init: { bubbles?: boolean } = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? true;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.stopped = true;
  }
}

class FakeNode {
  readonly nodeType: number;
  nodeValue: string | null = null;
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(nodeType: number) {
    this.nodeType = nodeType;
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  get nextSibling(): FakeNode | null {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[i + 1] ?? null;
  }

  get textContent(): string {
    if (this.nodeType === 3 || this.nodeType === 8) return this.nodeValue ?? '';
    return this.childNodes.map((c) => c.textContent).join('');
  }

  set textContent(value: string) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    if (value !== '') {
      const text = new FakeNode(3);
      text.nodeValue = value;
      this.append(text);
    }
  }

  append(...nodes: FakeNode[]): void {
    for (const node of nodes) {
      node.parentNode?.removeChild(node);
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }

  prepend(...nodes: FakeNode[]): void {
    nodes.forEach((node, i) => {
      node.parentNode?.removeChild(node);
      node.parentNode = this;
      this.childNodes.splice(i, 0, node);
    });
  }

  insertBefore(node: FakeNode, ref: FakeNode | null): void {
    const at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, node);
  }

  removeChild(node: FakeNode): void {
    const at = this.childNodes.indexOf(node);
    if (at >= 0) this.childNodes.splice(at, 1);
    node.parentNode = null;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(ev: FakeEvent): boolean {
    ev.target ??= this;
    let node: FakeNode | null = this;
    while (node) {
      ev.currentTarget = node;
      for (const listener of [...(node.listeners.get(ev.type) ?? [])]) listener(ev);
      if (!ev.bubbles || ev.stopped) break;
      node = node.parentNode;
    }
    return !ev.defaultPrevented;
  }

  querySelectorAll(_selector: string): FakeElement[] {
    return [];
  }

  querySelector(_selector: string): FakeElement | null {
    return null;
  }
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function matches(el: FakeElement, selector: string): boolean {
  if (selector.startsWith('#')) return el.id === selector.slice(1);
  if (selector.startsWith('.')) return el.classList.contains(selector.slice(1));
  if (selector.startsWith('[') && selector.endsWith(']')) {
    const body = selector.slice(1, -1);
    const eq = body.indexOf('=');
    if (eq < 0) return el.hasAttribute(body);
    const value = body
      .slice(eq + 1)
      .replace(/^["']|["']$/g, '')
      .trim();
    return el.getAttribute(body.slice(0, eq)) === value;
  }
  return el.tagName === selector.toUpperCase();
}

class FakeElement extends FakeNode {
  readonly tagName: string;
  readonly ownerDocument: FakeDocument;
  readonly attributes = new Map<string, string>();
  readonly classList: {
    add(...names: string[]): void;
    remove(...names: string[]): void;
    contains(name: string): boolean;
    toggle(name: string, force?: boolean): boolean;
  };
  readonly dataset: Record<string, string>;
  type = '';

  constructor(tag: string, doc: FakeDocument) {
    super(1);
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
    this.classList = {
      add: (...names: string[]) => {
        for (const n of names) this.attributes.set('class', this.classNames(n, true).join(' '));
      },
      remove: (...names: string[]) => {
        for (const n of names) this.attributes.set('class', this.classNames(n, false).join(' '));
      },
      contains: (name: string) => this.classNames().includes(name),
      toggle: (name: string, force?: boolean) => {
        const on = force ?? !this.classNames().includes(name);
        this.attributes.set('class', this.classNames(name, on).join(' '));
        return on;
      }
    };
    this.dataset = new Proxy({} as Record<string, string>, {
      get: (_target, prop) => this.attributes.get(`data-${kebab(String(prop))}`),
      set: (_target, prop, value) => {
        this.attributes.set(`data-${kebab(String(prop))}`, String(value));
        return true;
      },
      deleteProperty: (_target, prop) => {
        this.attributes.delete(`data-${kebab(String(prop))}`);
        return true;
      },
      has: (_target, prop) => this.attributes.has(`data-${kebab(String(prop))}`)
    });
  }

  private classNames(change?: string, on = true): string[] {
    const current = (this.attributes.get('class') ?? '').split(/\s+/).filter(Boolean);
    if (!change) return current;
    const without = current.filter((c) => c !== change);
    return on ? [...without, change] : without;
  }

  get id(): string {
    return this.attributes.get('id') ?? '';
  }

  set id(value: string) {
    this.attributes.set('id', value);
  }

  get className(): string {
    return this.attributes.get('class') ?? '';
  }

  set className(value: string) {
    this.attributes.set('class', value);
  }

  get hidden(): boolean {
    return this.attributes.has('hidden');
  }

  set hidden(value: boolean) {
    if (value) this.attributes.set('hidden', '');
    else this.attributes.delete('hidden');
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  after(node: FakeNode): void {
    if (!this.parentNode) return;
    this.parentNode.insertBefore(node, this.nextSibling);
  }

  click(): void {
    this.dispatchEvent(new FakeEvent('click'));
  }

  focus(): void {
    this.dispatchEvent(new FakeEvent('focus'));
  }

  override querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (node: FakeNode): void => {
      for (const child of node.childNodes) {
        if (child instanceof FakeElement) {
          if (matches(child, selector)) out.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return out;
  }

  override querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class FakeDocument {
  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }

  createComment(value: string): FakeNode {
    const node = new FakeNode(8);
    node.nodeValue = value;
    return node;
  }

  createTextNode(value: string): FakeNode {
    const node = new FakeNode(3);
    node.nodeValue = value;
    return node;
  }
}

function marker(doc: FakeDocument, path: string): FakeNode {
  return doc.createComment(`rkr:path=${path}`);
}

function para(doc: FakeDocument, value: string): FakeElement {
  const p = doc.createElement('p');
  p.textContent = value;
  return p;
}

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

function mount(f: Fixture, tree: BlockTree, onSave?: (tree: BlockTree) => Promise<void>) {
  return mountUnifiedShell(f.root as unknown as Element, {
    tree,
    macros: [{ name: 'hero', label: 'Hero' }],
    onSave: onSave ?? (async () => {})
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

  it('skips empty text leaves so nested paths stay aligned', () => {
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
      inner.append(marker(doc, '0,0'), para(doc, 'A'), marker(doc, '0,2'), para(doc, 'B'));
      section.append(inner);
      return [marker(doc, '0'), section];
    });
    const shell = mount(f, tree);

    assert.equal(f.body.querySelector('section')?.getAttribute('data-rkr-path'), '0');
    const paragraphs = f.body.querySelectorAll('p');
    assert.deepEqual(
      paragraphs.map((p) => p.getAttribute('data-rkr-path')),
      ['0,0', '0,2'],
      'the empty text leaf at [0,1] emits no marker, so [0,2] must not shift'
    );

    paragraphs[1]?.click();
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
    await Promise.resolve();

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

function anchor(doc: FakeDocument, label: string): FakeElement {
  const a = doc.createElement('a');
  a.className = 'rkr-btn';
  a.textContent = label;
  return a;
}
