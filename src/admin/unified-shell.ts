// Unified editor shell: one server-rendered page, two modes.
//
// The edit route renders the public block HTML with invisible
// `<!--rkr:path=i,j-->` markers in front of every node. This module
// hydrates those markers back to tree paths (no second renderer, no
// iframe), toggles View/Edit on the same DOM, and docks the palette on
// the right. View mode leaves the page exactly as readers see it:
// palette hidden, nothing contenteditable, no config buttons.
//
// The marker order is the server's render order (`renderBlockTree`
// with the `mark` option): containers are nodes themselves, macro
// instances are a single unit, and an empty text leaf renders nothing
// and therefore emits no marker. Hydration zips the markers to that
// same flattened order, so paths never depend on the DOM shape.
//
// Browser-safe: no node:* imports (bundled into the admin entry).

import type { BlockNode, BlockTree, Slots } from '../lib/blocks.ts';
import type { PaletteMacro } from './blocks-editor.ts';
import { getAtPath, type Path, setSlotAtPath, updateSlotsAtPath } from './blocks-page-editor.ts';
import { domToMarkdown } from './dom-markdown.ts';
import { openFigureDialog, readFigureFields } from './figure-dialog-tree.ts';
import { openMacroDialog, readMacroFields } from './macro-dialog-tree.ts';
import { mountPaletteInsert, reloadPage } from './unified-insert.ts';
import { createSavePipeline } from './unified-save.ts';

type Mode = 'view' | 'edit';

export interface UnifiedShellDeps {
  /** Canonical tree embedded by the edit route (`#rkr-tree`). */
  tree: BlockTree;
  /** Palette entries from `GET /admin/blocks/macros`. */
  macros: PaletteMacro[];
  /** Persist the whole tree (`POST /admin/blocks/:slug`). */
  onSave(tree: BlockTree): Promise<void>;
}

export interface UnifiedShell {
  setMode(mode: Mode): void;
  readonly selectedPath: Path | null;
}

/** Leaves whose extra parameters open a config dialog (figures,
 * macros). Text edits in place instead; containers need no dialog. */
const CONFIG_TYPES: ReadonlySet<string> = new Set(['figure', 'macro', 'button']);

const MARKER = /^rkr:path=([0-9,]+)$/;

interface HydratedUnit {
  path: Path;
  node: BlockNode;
  /** Elements rendered by this node. A text leaf can render several
   * block elements (one per markdown block); containers render one. */
  elements: Element[];
}

function kidsOf(node: BlockNode): BlockNode[] {
  if (node.type === 'macro') return [];
  const n = node as { children?: BlockNode[]; blocks?: BlockNode[] };
  return n.children ?? n.blocks ?? [];
}

/** Mirrors the renderer's empty-text rule: `!markdown` renders '' and
 * so emits no marker. */
function isBlankText(node: BlockNode): boolean {
  if (node.type !== 'text') return false;
  const markdown =
    node.markdown ?? (typeof node.slots?.markdown === 'string' ? node.slots.markdown : '');
  return !markdown;
}

/** Tree nodes in the server's render order. */
function serverOrder(tree: BlockTree): { path: Path; node: BlockNode }[] {
  const out: { path: Path; node: BlockNode }[] = [];
  const walk = (nodes: BlockNode[], base: Path): void => {
    nodes.forEach((node, i) => {
      const path = [...base, i];
      if (isBlankText(node)) return;
      out.push({ path, node });
      if (node.type !== 'macro') walk(kidsOf(node), path);
    });
  };
  walk(tree.body, []);
  return out;
}

function parseMarker(value: string | null): Path | null {
  const match = MARKER.exec((value ?? '').trim());
  if (!match) return null;
  const path = (match[1] as string).split(',').map(Number);
  return path.some((i) => !Number.isInteger(i)) ? null : path;
}

function samePath(a: Path, b: Path): boolean {
  return a.length === b.length && a.every((v, i) => b[i] === v);
}

/** Every path marker under `scope`, in document order. */
function collectMarkers(scope: Element): Node[] {
  const out: Node[] = [];
  const walk = (parent: Node): void => {
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 8 && parseMarker(child.nodeValue)) out.push(child);
      else if (child.nodeType === 1) walk(child);
    }
  };
  walk(scope);
  return out;
}

/** Sibling elements emitted by the node whose marker is `marker`.
 * Sibling markers delimit units, so a container reports only its own
 * element while a multi-paragraph text leaf reports every paragraph. */
function elementsAfter(marker: Node): Element[] {
  const out: Element[] = [];
  for (let next = marker.nextSibling; next; next = next.nextSibling) {
    if (next.nodeType === 8 && parseMarker(next.nodeValue)) break;
    if (next.nodeType === 1) out.push(next as Element);
  }
  return out;
}

function hydrate(tree: BlockTree, body: Element): HydratedUnit[] {
  const ordered = serverOrder(tree);
  const units: HydratedUnit[] = [];
  collectMarkers(body).forEach((marker, i) => {
    const markerPath = parseMarker(marker.nodeValue);
    if (!markerPath) return;
    const zipped = ordered[i];
    const node =
      zipped && samePath(zipped.path, markerPath) ? zipped.node : getAtPath(tree, markerPath);
    if (!node) return;
    let elements = elementsAfter(marker);
    if (elements.length === 0) {
      // The node rendered no elements (an unresolvable figure, an
      // unknown macro): plant a selectable placeholder so it stays
      // editable instead of becoming an invisible gap. The marker still
      // delimits the unit, so a re-render zips identically.
      const doc = body.ownerDocument;
      const holder = doc.createElement('div');
      holder.className = 'rkr-unified-empty';
      holder.textContent = `Empty ${node.type === 'macro' ? `macro ${node.macro}` : node.type} — configure to add content`;
      marker.parentNode?.insertBefore(holder, marker.nextSibling);
      elements = [holder];
    }
    units.push({ path: markerPath, node, elements });
  });
  return units;
}

function mustFind(scope: Element, selector: string): Element {
  const el = scope.querySelector(selector);
  if (!el) throw new Error(`unified shell: missing mount point ${selector}`);
  return el;
}

/** Current markdown source of a text leaf (mirrors the renderer rule). */
function textSource(node: BlockNode): string | null {
  if (node.type !== 'text') return null;
  const markdown = node.markdown ?? (node as { slots?: { markdown?: unknown } }).slots?.markdown;
  return typeof markdown === 'string' ? markdown : '';
}

function nodeLabel(node: BlockNode): string {
  return node.type === 'macro' ? `macro ${node.macro}` : node.type;
}

/** Page-level depth gate, derived from the macro rule: containers may
 * not land at depth 3 or deeper — save the inner part as its own macro
 * instead. Leaves and macro instances are always allowed. */
export function mountUnifiedShell(root: Element, deps: UnifiedShellDeps): UnifiedShell {
  const doc = root.ownerDocument;
  const shellEl = mustFind(root, '#rkr-unified-shell');
  const toolbar = mustFind(root, '#rkr-unified-toolbar');
  const dock = mustFind(root, '#rkr-unified-dock') as HTMLElement;
  const body = mustFind(root, '#rkr-blocks-page-body');

  let tree = deps.tree;
  let selected: Path | null = null;
  const tools: Element[] = [];

  const select = (path: Path): void => {
    selected = [...path];
  };

  // Indexed after hydration below (units must exist first).
  let unitByPath = new Map<string, HydratedUnit>();

  const save = createSavePipeline({
    onSave: deps.onSave,
    getTree: () => tree,
    shellEl,
    toolbar
  });

  /** Persist `next` as the shell's tree through the pipeline. */
  const saveTree = (next: BlockTree): Promise<void> => {
    tree = next;
    return save.requestSave(next);
  };

  // Blur on edited text serializes the leaf back to the markdown DSL.
  // focusout bubbles, so one delegated listener covers every leaf.
  body.addEventListener('focusout', (ev: Event) => {
    const target = (ev as unknown as { target: Element | null }).target;
    const card = target?.closest?.('[data-rkr-path]');
    if (!card) return;
    const key = String((card as Element).getAttribute('data-rkr-path'));
    const unit = unitByPath.get(key);
    if (!unit) return;
    const before = textSource(unit.node);
    if (before === null) return;
    const after = domToMarkdown(unit.elements);
    if (after === before) return;
    select(unit.path);
    const next = setSlotAtPath(tree, unit.path, 'markdown', after);
    save.markEditing();
    void saveTree(next);
  });

  body.addEventListener('input', () => {
    save.markEditing();
  });

  // Now that hydration produced the live units, index them for blur lookup.
  const units = hydrate(tree, body);
  // Now that hydration produced the live units, index them for blur lookup.
  unitByPath = new Map(units.map((u) => [u.path.join(','), u]));
  for (const unit of units) {
    for (const el of unit.elements) {
      el.setAttribute('data-rkr-path', unit.path.join(','));
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        select(unit.path);
      });
    }
  }

  // Palette mounts once; modes only hide/show the dock. Placement lives
  // in unified-insert; the shell applies the tree, saves, and reloads so
  // the DOM stays the server render (Task 7 owns live refresh).
  mountPaletteInsert({
    dock,
    body,
    macros: deps.macros,
    getTree: () => tree,
    getSelected: () => selected,
    commitInsert: (next) => {
      tree = next;
      save.markEditing();
      void save.requestSave(next).then(
        () => reloadPage(),
        () => {}
      );
    },
    showNudge: (text) => {
      save.notice(text);
    }
  });

  /** Commit dialog slots for the figure at `path`: apply every key,
   * then save the whole tree exactly once. Other slot keys pass
   * through untouched. */
  const commitFigureSlots = (path: Path, slots: Slots): void => {
    let next = tree;
    for (const [key, value] of Object.entries(slots)) {
      if (typeof value === 'string') next = setSlotAtPath(next, path, key, value);
    }
    save.markEditing();
    void saveTree(next).then(
      () => reloadPage(),
      () => {}
    );
  };

  const macroDefaults = new Map(deps.macros.map((m) => [m.name, m.defaults ?? {}]));

  const openFigureConfig = (path: Path): void => {
    const node = getAtPath(tree, path);
    if (!node || node.type !== 'figure') return;
    select(path);
    console.log('[unified] openFigureConfig', path);
    openFigureDialog(root, {
      initial: readFigureFields(node),
      onCommit: (slots) => { console.log('[unified] figure commit', slots); commitFigureSlots(path, slots); },
      onCancel: () => {}
    });
  };

  /** Merge touched macro fields over the instance slots (empty clears
   * back to the default), then save once and reload so the DOM stays
   * the server render. Untouched overrides are never dropped. */
  const openMacroConfig = (path: Path): void => {
    const node = getAtPath(tree, path);
    if (!node || node.type !== 'macro') return;
    select(path);
    const defs = macroDefaults.get(node.macro) ?? {};
    openMacroDialog(root, {
      fields: readMacroFields(node, defs),
      onCommit: (touched) => {
        const next = updateSlotsAtPath(tree, path, (slots) => {
          const merged = { ...slots };
          for (const [key, value] of Object.entries(touched)) {
            if (typeof value !== 'string' || value === '') delete merged[key];
            else merged[key] = value;
          }
          return merged;
        });
        save.markEditing();
        void saveTree(next).then(
          () => reloadPage(),
          () => {}
        );
      },
      onCancel: () => {}
    });
  };

  const clearTools = (): void => {
    for (const holder of tools.splice(0)) holder.remove();
  };

  const addTools = (): void => {
    for (const unit of units) {
      if (!CONFIG_TYPES.has(unit.node.type)) continue;
      const anchor = unit.elements[unit.elements.length - 1];
      if (!anchor?.parentNode) continue;
      const holder = doc.createElement('div');
      holder.className = 'rkr-unified-node-tools';
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'rkr-unified-config';
      button.textContent = 'Configure';
      button.setAttribute('aria-label', `Configure ${nodeLabel(unit.node)}`);
      button.setAttribute('data-config-path', unit.path.join(','));
      button.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (unit.node.type === 'figure') openFigureConfig(unit.path);
        else if (unit.node.type === 'macro') openMacroConfig(unit.path);
        else select(unit.path);
      });
      holder.append(button);
      // Sibling, not child: a figure's caption/gallery markup stays
      // exactly what the public page renders.
      anchor.after(holder);
      tools.push(holder);
    }
  };

  const setMode = (next: Mode): void => {
    shellEl.setAttribute('data-mode', next);
    shellEl.classList.toggle('is-view', next === 'view');
    shellEl.classList.toggle('is-edit', next === 'edit');
    for (const button of toolbar.querySelectorAll('[data-mode]')) {
      const active = (button as HTMLElement).dataset.mode === next;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.classList.toggle('is-active', active);
    }
    dock.hidden = next === 'view';
    for (const unit of units) {
      if (unit.node.type !== 'text') continue;
      for (const el of unit.elements) {
        if (next === 'edit') el.setAttribute('contenteditable', 'true');
        else el.removeAttribute('contenteditable');
      }
    }
    clearTools();
    if (next === 'edit') addTools();
  };

  for (const button of toolbar.querySelectorAll('[data-mode]')) {
    button.addEventListener('click', () => {
      const next = (button as HTMLElement).dataset.mode;
      if (next === 'view' || next === 'edit') setMode(next);
    });
  }

  setMode('view');

  return {
    setMode,
    get selectedPath() {
      return selected;
    }
  };
}
