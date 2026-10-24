// JSON page editor state + card rendering for the blocks editor shell.
// Browser-safe: no node:* imports. Tree ops are pure and immutable so
// drag-drop, palette insert, and undo all share one code path: compute
// the next tree, re-render, then save the whole tree at once.

import type { BlockNode, BlockTree, Slots } from '../lib/blocks.ts';
import { mountBlocksPalette, type PaletteMacro, primitiveNode } from './blocks-editor.ts';

export type Path = number[];

const CONTAINERS: ReadonlySet<string> = new Set(['section', 'row', 'col', 'flow']);

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#39' }[c]};`
  );
}

function kids(node: BlockNode): BlockNode[] {
  if (node.type === 'macro') return [];
  const n = node as { children?: BlockNode[]; blocks?: BlockNode[] };
  return n.children ?? n.blocks ?? [];
}

/** Node at `path` (indices from the page body). Null when missing. */
export function getAtPath(tree: BlockTree, path: Path): BlockNode | null {
  let level: BlockNode[] = tree.body;
  let node: BlockNode | null = null;
  for (const i of path) {
    node = level[i] ?? null;
    if (!node) return null;
    level = kids(node);
  }
  return node;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function updateList(
  tree: BlockTree,
  parentPath: Path,
  fn: (list: BlockNode[]) => BlockNode[]
): BlockTree {
  const next = clone(tree);
  if (parentPath.length === 0) {
    next.body = fn(next.body);
    return next;
  }
  const parent = getAtPath(next, parentPath);
  if (!parent || !CONTAINERS.has(parent.type)) {
    throw new Error('blocks editor: bad parent');
  }
  const n = parent as unknown as Record<string, BlockNode[] | undefined>;
  const list = [...kids(parent)];
  if (Array.isArray(n.children)) n.children = fn(list);
  else if (Array.isArray(n.blocks)) n.blocks = fn(list);
  else n.children = fn(list);
  return next;
}

/** Copy of the tree with one slot set on the node at `path`. */
export function setSlotAtPath(tree: BlockTree, path: Path, key: string, value: string): BlockTree {
  const node = getAtPath(tree, path);
  if (!node || node.type === 'macro') throw new Error('blocks editor: path not found');
  return updateList(tree, path.slice(0, -1), (list) =>
    list.map((n, i) => {
      if (i !== (path[path.length - 1] as number)) return n;
      if (key === 'markdown') return { ...n, markdown: value };
      return { ...n, slots: { ...((n as { slots?: Slots }).slots ?? {}), [key]: value } };
    })
  );
}

/** Copy of the tree with `update` applied to the slots at `path`.
 * Unlike setSlotAtPath (single key, always present), the updater owns
 * the whole slots object: it may merge, and it may delete keys to
 * un-set an override so the macro default flows through again. */
export function updateSlotsAtPath(
  tree: BlockTree,
  path: Path,
  update: (slots: Slots) => Slots
): BlockTree {
  const node = getAtPath(tree, path);
  if (!node) {
    throw new Error('blocks editor: path not found');
  }
  return updateList(tree, path.slice(0, -1), (list) =>
    list.map((n, i) => {
      if (i !== (path[path.length - 1] as number)) return n;
      return { ...n, slots: update({ ...((n as { slots?: Slots }).slots ?? {}) }) };
    })
  );
}

/** Copy of the tree with `node` inserted into the parent at `index`. */
export function insertAtPath(
  tree: BlockTree,
  parentPath: Path,
  index: number,
  node: BlockNode
): BlockTree {
  return updateList(tree, parentPath, (list) => {
    const at = Math.max(0, Math.min(index, list.length));
    return [...list.slice(0, at), clone(node), ...list.slice(at)];
  });
}

/** Copy of the tree without the node at `path`. */
export function removeAtPath(tree: BlockTree, path: Path): BlockTree {
  if (path.length === 0) throw new Error('blocks editor: cannot remove root');
  const idx = path[path.length - 1] as number;
  return updateList(tree, path.slice(0, -1), (list) => list.filter((_, i) => i !== idx));
}

function isPrefix(prefix: Path, full: Path): boolean {
  return prefix.length < full.length && prefix.every((v, i) => full[i] === v);
}

/** Relocate the node at `fromPath` into `toParentPath` at `index`. */
export function moveNode(
  tree: BlockTree,
  fromPath: Path,
  toParentPath: Path,
  index: number
): BlockTree {
  if (isPrefix(fromPath, [...toParentPath, index])) {
    throw new Error('blocks editor: cannot move into its own descendant');
  }
  const node = getAtPath(tree, fromPath);
  if (!node) throw new Error('blocks editor: path not found');
  const without = removeAtPath(tree, fromPath);
  // Adjust the target index when removing from the same list first.
  const sameParent = fromPath.slice(0, -1).join(',') === toParentPath.join(',');
  const fromIdx = fromPath[fromPath.length - 1] as number;
  return insertAtPath(
    without,
    toParentPath,
    sameParent && fromIdx < index ? index - 1 : index,
    node
  );
}

export type DropPosition = 'before' | 'after' | 'inside';

/** Resolve a drop onto the card at `targetPath` to an insertion point.
 * before/after land in the target's parent; inside lands at the end of
 * the target, and only containers accept it — leaves and macro
 * instances (whose internals are not editable here) return null. */
export function resolveDrop(
  tree: BlockTree,
  targetPath: Path,
  position: DropPosition
): { parentPath: Path; index: number } | null {
  const target = getAtPath(tree, targetPath);
  if (!target) return null;
  if (position === 'inside') {
    if (!CONTAINERS.has(target.type)) return null;
    return { parentPath: targetPath, index: kids(target).length };
  }
  const parentPath = targetPath.slice(0, -1);
  const idx = targetPath[targetPath.length - 1] as number;
  return { parentPath, index: position === 'after' ? idx + 1 : idx };
}

/** Short header for a collapsed card. */
export function labelFor(node: BlockNode): string {
  if (node.type === 'macro') return `Macro: ${node.macro}`;
  const first = node.type[0]?.toUpperCase() ?? '';
  return first + node.type.slice(1);
}

function summaryFor(node: BlockNode): string {
  if (node.type === 'text') return (node.markdown ?? '').split('\n')[0]?.slice(0, 60) ?? '';
  if (node.type === 'button') return String(node.slots?.label ?? '');
  if (node.type === 'macro') return '';
  if (node.type === 'figure') return String(node.slots?.ids ?? '');
  return '';
}

/** One collapsed card. Children render nested; values are escaped. */
export function renderCard(node: BlockNode, path: Path): string {
  const inner =
    node.type === 'macro'
      ? ''
      : kids(node)
          .map((k, i) => renderCard(k, [...path, i]))
          .join('');
  return `<div class="rkr-block-card" data-path="${esc(path.join(','))}"><div class="rkr-block-card-head">${esc(labelFor(node))}<span>${esc(summaryFor(node))}</span></div>${inner}</div>`;
}

/** @internal Retained only until the tree-view UI is retired (Task 7). */
interface PageEditorOpts {
  loadPage: () => Promise<{ title: string; tree: BlockTree }>;
  loadMacros: () => Promise<PaletteMacro[]>;
  savePage: (tree: BlockTree) => Promise<void>;
  renderPreview: (tree: BlockTree, width: number) => Promise<string>;
}

/** Mount the tree-view shell: nested cards, palette insert, inline
 * fields, phone preview, save. Double-click (or Enter) on a palette
 * item inserts at the focused slot; drag onto drop targets lands in
 * follow-up work — the tree ops above already support it. */
/** @public Retained only until the tree-view UI is retired (Task 7):
 * the unified shell replaced this mount in the blocks edit page, and
 * nothing imports it any more. The pure tree ops below stay. */
export async function mountBlocksPageEditor(root: Element, opts: PageEditorOpts): Promise<void> {
  const doc = root.ownerDocument;
  const { tree } = await opts.loadPage();
  let state = tree;
  let selected: Path | null = null;

  const shell = doc.createElement('div');
  shell.className = 'rkr-blocks-editor';
  shell.innerHTML = `<div class="rkr-blocks-tree"></div><div class="rkr-blocks-side"><div class="rkr-blocks-fields"></div><div class="rkr-blocks-preview"></div></div>`;
  root.prepend(shell);
  const treeEl = shell.querySelector('.rkr-blocks-tree') as Element;
  const fieldsEl = shell.querySelector('.rkr-blocks-fields') as Element;
  const previewEl = shell.querySelector('.rkr-blocks-preview') as Element;

  async function refresh() {
    treeEl.innerHTML = state.body.map((n, i) => renderCard(n, [i])).join('');
    previewEl.innerHTML = await opts.renderPreview(state, 390);
  }

  function editFields(path: Path) {
    const node = getAtPath(state, path);
    if (!node || node.type === 'macro' || kids(node).length > 0) {
      fieldsEl.innerHTML = node ? `<p>${esc(labelFor(node))}</p>` : '';
      return;
    }
    const keys = node.type === 'text' ? ['markdown'] : Object.keys(node.slots ?? {});
    fieldsEl.innerHTML = keys
      .map((k) => {
        const v =
          k === 'markdown'
            ? ((node as { markdown?: string }).markdown ?? '')
            : String(node.slots?.[k] ?? '');
        return `<label>${esc(k)}<input data-field="${esc(k)}" value="${esc(v)}"/></label>`;
      })
      .join('');
    for (const input of fieldsEl.querySelectorAll('input')) {
      input.addEventListener('change', () => {
        const el = input as HTMLInputElement;
        state = setSlotAtPath(state, path, el.dataset.field ?? '', el.value);
        void refresh();
      });
    }
  }

  treeEl.addEventListener('click', (ev) => {
    const card = (ev.target as Element).closest?.('[data-path]');
    if (!card) return;
    selected = String((card as Element).getAttribute('data-path'))
      .split(',')
      .filter((s) => s !== '')
      .map(Number);
    editFields(selected);
  });

  const macros = await opts.loadMacros();
  const insertByName = (name: string, at: Path | null) => {
    const node: BlockNode = name.startsWith('primitive:')
      ? primitiveNode(name)
      : { type: 'macro', macro: name };
    const parent =
      at && getAtPath(state, at) && getAtPath(state, at)?.type !== 'text' ? (at as Path) : [];
    const list = parent.length === 0 ? state.body : kids(getAtPath(state, parent) as BlockNode);
    state = insertAtPath(state, parent, list.length, node);
    void refresh();
  };
  mountBlocksPalette(root, macros, (name) => {
    insertByName(name, selected);
  });

  // Palette drag: buttons carry the macro name; dropping on a card
  // resolves to an insertion point via resolveDrop. Containers accept
  // inside drops; leaves and macro instances only before/after.
  let dragName: string | null = null;
  const clearDropMarks = () => {
    for (const el of treeEl.querySelectorAll('[data-drop]')) el.removeAttribute('data-drop');
  };
  const cardPath = (card: Element): Path =>
    String(card.getAttribute('data-path'))
      .split(',')
      .filter((s) => s !== '')
      .map(Number);
  for (const btn of root.querySelectorAll('.rkr-blocks-palette-item')) {
    (btn as HTMLElement).draggable = true;
    btn.addEventListener('dragstart', (ev) => {
      dragName = (btn as HTMLElement).dataset.macro ?? null;
      (ev as DragEvent).dataTransfer?.setData('text/plain', dragName ?? '');
    });
  }
  treeEl.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    clearDropMarks();
    if (!dragName) return;
    const card = (ev.target as Element).closest?.('[data-path]');
    if (!card) return;
    const rect = (card as Element).getBoundingClientRect();
    const y = (ev as DragEvent).clientY;
    const pos: DropPosition =
      y < rect.top + rect.height / 3
        ? 'before'
        : y > rect.bottom - rect.height / 3
          ? 'after'
          : 'inside';
    if (!resolveDrop(state, cardPath(card as Element), pos)) return;
    (card as Element).setAttribute('data-drop', pos);
  });
  treeEl.addEventListener('drop', (ev) => {
    ev.preventDefault();
    const name = dragName;
    dragName = null;
    const card = (ev.target as Element).closest?.('[data-path]');
    clearDropMarks();
    if (!card || !name) return;
    const pos = (card as Element).getAttribute('data-drop') as DropPosition | null;
    const at = cardPath(card as Element);
    const resolved = pos ? resolveDrop(state, at, pos) : resolveDrop(state, at, 'after');
    if (!resolved) return;
    const node: BlockNode = name.startsWith('primitive:')
      ? primitiveNode(name)
      : { type: 'macro', macro: name };
    try {
      state = insertAtPath(state, resolved.parentPath, resolved.index, node);
    } catch {
      return;
    }
    void refresh();
  });

  const saveBtn = doc.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save page';
  saveBtn.addEventListener('click', () => {
    void opts.savePage(state);
  });
  shell.prepend(saveBtn);

  await refresh();
}
