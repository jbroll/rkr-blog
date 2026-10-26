// Block selection chrome for the unified editor: the outline on the
// selected block, its toolbar (move, duplicate, configure, delete, drag
// handle) and the matching keyboard shortcuts.
//
// The shell owns the tree and selection; every action reads the tree
// after `flushText` (so typing in progress is committed first), builds
// the next tree with the pure ops in blocks-page-editor.ts, and hands it
// to `applyTree`, which re-renders and re-hydrates the page.
//
// Browser-safe: no node:* imports.

import type { BlockNode, BlockTree } from '../lib/blocks.ts';
import { gridLabel } from '../lib/grid.ts';
import { moveBlock } from './block-move.ts';
import { childrenOf, getAtPath, insertAtPath, type Path, removeAtPath } from './block-tree-ops.ts';

export interface BlockActionsEnv {
  body: Element;
  getTree(): BlockTree;
  getSelected(): Path | null;
  select(path: Path | null): void;
  applyTree(next: BlockTree, opts?: { select?: Path }): Promise<void>;
  configure(path: Path): void;
  /** Whether `configure` can open something for this node. */
  canConfigure(node: BlockNode): boolean;
  /** Commit the focused text block before an action reads the tree. */
  flushText?(): void;
  /** Toolbar and shortcuts only act in edit mode. Defaults to true. */
  isEditing?(): boolean;
  /** A note shown in the toolbar for the selected block, or null. */
  noteFor?(path: Path): string | null;
  /** Drag-handle hooks; the drop itself is handled by the insert module. */
  drag?: { start(path: Path): void; end(): void };
}

const TYPE_LABELS: Record<string, string> = {
  text: 'Text',
  figure: 'Image',
  button: 'Button'
};

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function typeLabel(node: BlockNode): string {
  if (node.type === 'macro') return capitalize(node.macro);
  if (node.type === 'grid') return gridLabel(node.slots);
  return TYPE_LABELS[node.type] ?? capitalize(node.type);
}

const GHOST_WIDTH = 320;
const GHOST_HEIGHT = 240;

/** A shrunken copy of the dragged block to use as the drag image. The
 * browser snapshots it during dragstart, so the caller removes it on
 * the next tick. */
function dragGhost(doc: Document, source: Element | null): HTMLElement | null {
  const rect = source?.getBoundingClientRect?.();
  if (!source?.cloneNode || !rect?.width) return null;
  const ghost = source.cloneNode(true) as HTMLElement;
  for (const el of [ghost, ...ghost.querySelectorAll('[data-rkr-path],[data-rkr-selected]')]) {
    el.removeAttribute('data-rkr-path');
    el.removeAttribute('data-rkr-selected');
    el.removeAttribute('contenteditable');
  }
  ghost.classList?.add('rkr-drag-ghost');
  ghost.setAttribute(
    'style',
    `position:fixed;top:-10000px;left:0;width:${Math.min(GHOST_WIDTH, rect.width)}px;max-height:${GHOST_HEIGHT}px;overflow:hidden;pointer-events:none`
  );
  (doc.body ?? doc.documentElement).append(ghost);
  return ghost;
}

function listAt(tree: BlockTree, parent: Path): BlockNode[] | null {
  if (parent.length === 0) return tree.body;
  const node = getAtPath(tree, parent);
  return node ? childrenOf(node) : null;
}

/** Every path in render order, parents before their children. */
function flatten(tree: BlockTree): Path[] {
  const out: Path[] = [];
  const walk = (nodes: BlockNode[], base: Path): void => {
    nodes.forEach((node, i) => {
      out.push([...base, i]);
      walk(childrenOf(node), [...base, i]);
    });
  };
  walk(tree.body, []);
  return out;
}

const pathKey = (path: Path): string => path.join(',');

function pathOf(el: Element | null | undefined): Path | null {
  const raw = el?.closest?.('[data-rkr-path]')?.getAttribute('data-rkr-path');
  if (raw === null || raw === undefined || raw === '') return null;
  return raw.split(',').map(Number);
}

const TOOLBAR_HEIGHT = 34;
const OUTLINE_GAP = 4;

export function mountBlockActions(env: BlockActionsEnv): { refresh(): void; dispose(): void } {
  const { body } = env;
  const doc = body.ownerDocument;
  const host = (body.parentNode ?? body) as Element;

  const bar = doc.createElement('div');
  bar.className = 'rkr-block-toolbar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Block actions');
  bar.hidden = true;
  const label = doc.createElement('span');
  label.className = 'rkr-block-type';
  bar.append(label);

  // One box around every element the block rendered; per-element CSS
  // outlines would box a heading and its paragraph separately.
  const outline = doc.createElement('div');
  outline.className = 'rkr-block-outline';
  outline.setAttribute('aria-hidden', 'true');
  outline.hidden = true;
  host.append(outline);

  const isBusy = (): boolean => body.hasAttribute('inert');
  const editing = (): boolean => env.isEditing?.() ?? true;

  /** Run `fn` with a fresh tree and the selected path, after committing
   * any text in progress. */
  const act = (fn: (tree: BlockTree, path: Path) => void): void => {
    if (isBusy() || !editing()) return;
    const before = env.getSelected();
    if (!before) return;
    env.flushText?.();
    const tree = env.getTree();
    if (getAtPath(tree, before)) fn(tree, before);
  };

  const move = (delta: -1 | 1): void =>
    act((tree, path) => {
      const parent = path.slice(0, -1);
      const to = (path[path.length - 1] as number) + delta;
      const size = listAt(tree, parent)?.length ?? 0;
      if (to < 0 || to >= size) return;
      const next = moveBlock(tree, path, parent, delta < 0 ? to : to + 1);
      void env.applyTree(next, { select: [...parent, to] });
    });

  const duplicate = (): void =>
    act((tree, path) => {
      const node = getAtPath(tree, path) as BlockNode;
      const parent = path.slice(0, -1);
      const at = (path[path.length - 1] as number) + 1;
      const next = insertAtPath(tree, parent, at, node);
      void env.applyTree(next, { select: [...parent, at] });
    });

  const remove = (): void =>
    act((tree, path) => {
      const parent = path.slice(0, -1);
      const idx = path[path.length - 1] as number;
      const size = listAt(tree, parent)?.length ?? 0;
      let target: Path | null = null;
      if (idx < size - 1) target = path;
      else if (idx > 0) target = [...parent, idx - 1];
      const next = removeAtPath(tree, path);
      env.select(target);
      void env.applyTree(next, target ? { select: target } : undefined);
    });

  const configure = (): void =>
    act((tree, path) => {
      const node = getAtPath(tree, path);
      if (node && env.canConfigure(node)) env.configure(path);
    });

  const button = (action: string, aria: string, text: string, onClick: () => void) => {
    const el = doc.createElement('button');
    el.type = 'button';
    el.className = `rkr-block-action rkr-block-${action}`;
    el.setAttribute('data-action', action);
    el.setAttribute('aria-label', aria);
    el.textContent = text;
    el.addEventListener('click', (ev: Event) => {
      ev.stopPropagation();
      onClick();
    });
    bar.append(el);
    return el;
  };

  const handle = button('drag', 'Drag to move', 'Drag', () => {});
  (handle as HTMLElement).draggable = true;
  handle.addEventListener('dragstart', (ev: Event) => {
    const path = env.getSelected();
    if (!path || isBusy()) {
      ev.preventDefault();
      return;
    }
    env.flushText?.();
    const dt = (
      ev as unknown as {
        dataTransfer?: {
          setData(t: string, v: string): void;
          setDragImage?(el: Element, x: number, y: number): void;
          effectAllowed: string;
        };
      }
    ).dataTransfer;
    try {
      dt?.setData('text/plain', 'rkr-move');
      if (dt) dt.effectAllowed = 'move';
    } catch {
      // Locked-down browsers and test fakes may refuse; the drag state
      // lives in the insert module.
    }
    if (dt?.setDragImage) {
      const ghost = dragGhost(doc, body.querySelector(`[data-rkr-path="${pathKey(path)}"]`));
      if (ghost) {
        dt.setDragImage(ghost, 16, 16);
        setTimeout(() => ghost.remove(), 0);
      }
    }
    env.drag?.start(path);
  });
  handle.addEventListener('dragend', () => {
    env.drag?.end();
  });
  const up = button('move-up', 'Move up', 'Up', () => move(-1));
  const down = button('move-down', 'Move down', 'Down', () => move(1));
  button('duplicate', 'Duplicate', 'Duplicate', duplicate);
  const config = button('configure', 'Configure', 'Configure', configure);
  button('delete', 'Delete', 'Delete', remove);
  const note = doc.createElement('span');
  note.className = 'rkr-block-note';
  note.hidden = true;
  bar.append(note);
  host.append(bar);

  const setDisabled = (el: Element, off: boolean): void => {
    if (off) el.setAttribute('disabled', '');
    else el.removeAttribute('disabled');
  };

  const position = (): void => {
    const path = env.getSelected();
    const rects = path
      ? [...body.querySelectorAll(`[data-rkr-path="${pathKey(path)}"]`)]
          .map((el) => el.getBoundingClientRect?.())
          .filter((r) => !!r)
      : [];
    const first = rects[0];
    if (!first) return;
    const box = {
      top: Math.min(...rects.map((r) => r.top)),
      left: Math.min(...rects.map((r) => r.left)),
      right: Math.max(...rects.map((r) => r.right)),
      bottom: Math.max(...rects.map((r) => r.bottom))
    };
    outline.setAttribute(
      'style',
      `top:${box.top - OUTLINE_GAP}px;left:${box.left - OUTLINE_GAP}px;width:${box.right - box.left + 2 * OUTLINE_GAP}px;height:${box.bottom - box.top + 2 * OUTLINE_GAP}px`
    );
    const width = (bar as HTMLElement).offsetWidth || 0;
    const viewport = doc.defaultView?.innerWidth ?? Number.POSITIVE_INFINITY;
    const left = Math.max(4, Math.min(box.left, viewport - width - 4));
    const stuck =
      doc.getElementById?.('rkr-unified-toolbar')?.getBoundingClientRect?.().bottom ?? 0;
    bar.setAttribute(
      'style',
      `top:${Math.max(4, stuck + 4, box.top - TOOLBAR_HEIGHT)}px;left:${left}px`
    );
  };

  const refresh = (): void => {
    for (const el of body.querySelectorAll('[data-rkr-selected]')) {
      el.removeAttribute('data-rkr-selected');
    }
    const path = env.getSelected();
    const tree = env.getTree();
    const node = path ? getAtPath(tree, path) : null;
    const els = path ? [...body.querySelectorAll(`[data-rkr-path="${pathKey(path)}"]`)] : [];
    if (!path || !node || !editing() || els.length === 0) {
      bar.hidden = true;
      outline.hidden = true;
      return;
    }
    for (const el of els) el.setAttribute('data-rkr-selected', '');
    label.textContent = typeLabel(node);
    const idx = path[path.length - 1] as number;
    const size = listAt(tree, path.slice(0, -1))?.length ?? 0;
    setDisabled(up, idx === 0);
    setDisabled(down, idx >= size - 1);
    config.hidden = !env.canConfigure(node);
    const text = env.noteFor?.(path) ?? null;
    note.textContent = text ?? '';
    note.hidden = !text;
    bar.hidden = false;
    outline.hidden = false;
    position();
  };

  const neighbour = (delta: -1 | 1): void => {
    const path = env.getSelected();
    if (!path) return;
    const all = flatten(env.getTree());
    const at = all.findIndex((p) => pathKey(p) === pathKey(path));
    const to = all[at + delta];
    if (at < 0 || !to) return;
    env.select(to);
    refresh();
    body.querySelector(`[data-rkr-path="${pathKey(to)}"]`)?.scrollIntoView?.({ block: 'nearest' });
  };

  const onKeydown = (raw: Event): void => {
    const ev = raw as KeyboardEvent;
    if (ev.defaultPrevented || !editing()) return;
    const target = ev.target as Element | null;
    if (target?.closest?.('[data-rkr-dialog]')) return;
    if (target?.closest?.('[contenteditable="true"]')) {
      if (ev.key !== 'Escape') return;
      const path = pathOf(target);
      (target as HTMLElement).blur?.();
      if (path) env.select(path);
      refresh();
      ev.preventDefault();
      return;
    }
    for (const tag of ['input', 'textarea', 'select', 'dialog']) {
      if (target?.closest?.(tag)) return;
    }
    if (isBusy() || !env.getSelected()) return;
    const mod = ev.ctrlKey || ev.metaKey;
    const plain = !mod && !ev.altKey && !ev.shiftKey;
    let handled = true;
    if (ev.altKey && !mod && ev.key === 'ArrowUp') move(-1);
    else if (ev.altKey && !mod && ev.key === 'ArrowDown') move(1);
    else if (mod && !ev.altKey && ev.key.toLowerCase() === 'd') duplicate();
    else if (plain && (ev.key === 'Delete' || ev.key === 'Backspace')) remove();
    else if (plain && ev.key === 'Escape') {
      env.select(null);
      refresh();
    } else if (plain && ev.key === 'Enter' && !target?.closest?.('button')) configure();
    else if (plain && ev.key === 'ArrowUp') neighbour(-1);
    else if (plain && ev.key === 'ArrowDown') neighbour(1);
    else handled = false;
    if (handled) ev.preventDefault();
  };
  doc.addEventListener('keydown', onKeydown);

  const view = doc.defaultView;
  view?.addEventListener('scroll', position, true);
  view?.addEventListener('resize', position);
  body.addEventListener('input', position);
  const resizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(position);
  resizes?.observe(body);

  return {
    refresh,
    dispose: () => {
      doc.removeEventListener('keydown', onKeydown);
      view?.removeEventListener('scroll', position, true);
      view?.removeEventListener('resize', position);
      body.removeEventListener('input', position);
      resizes?.disconnect();
      bar.remove();
      outline.remove();
    }
  };
}
