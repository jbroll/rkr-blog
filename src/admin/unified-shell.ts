// Unified editor shell: one server-rendered page, two modes.
//
// The edit route renders the public block HTML with invisible
// `<!--rkr:path=i,j-->` markers (unified-hydrate.ts zips them back to
// tree paths), toggles View/Edit on the same DOM, and docks the palette
// on the right. View mode leaves the page as readers see it: palette
// hidden, nothing contenteditable, no config buttons.
//
// Structural changes go through `applyTree`, which asks the server for
// a fresh marked render and swaps it in, so DOM paths always match the
// tree. Text blur edits the tree in place without re-rendering.
//
// Browser-safe: no node:* imports (bundled into the admin entry).

import type { BlockNode, BlockTree, Slots } from '../lib/blocks.ts';
import type { PaletteMacro } from './blocks-editor.ts';
import { getAtPath, type Path, setSlotAtPath, updateSlotsAtPath } from './blocks-page-editor.ts';
import { domToMarkdown } from './dom-markdown.ts';
import { openFigureDialog, readFigureFields } from './figure-dialog-tree.ts';
import { openMacroDialog, readMacroFields } from './macro-dialog-tree.ts';
import { type HydratedUnit, hydrate } from './unified-hydrate.ts';
import { mountPaletteInsert } from './unified-insert.ts';
import { createSavePipeline } from './unified-save.ts';

type Mode = 'view' | 'edit';

export interface UnifiedShellDeps {
  /** Canonical tree embedded by the edit route (`#rkr-tree`). */
  tree: BlockTree;
  /** Palette entries from `GET /admin/blocks/macros`. */
  macros: PaletteMacro[];
  /** Persist the whole tree (`POST /admin/blocks/:slug`). */
  onSave(tree: BlockTree): Promise<void>;
  /** Marked edit-page body for `tree` (`POST /admin/blocks/_render`). */
  render(tree: BlockTree): Promise<string>;
}

interface ApplyOpts {
  /** Path (in the new tree) to select once the render lands. */
  select?: Path;
}

export interface UnifiedShell {
  setMode(mode: Mode): void;
  readonly selectedPath: Path | null;
  applyTree(next: BlockTree, opts?: ApplyOpts): Promise<void>;
}

/** Leaves whose extra parameters open a config dialog (figures,
 * macros). Text edits in place instead; containers need no dialog. */
const CONFIG_TYPES: ReadonlySet<string> = new Set(['figure', 'macro', 'button']);

const RENDER_FAILED = "Couldn't refresh the page. Select Save page to retry.";

function mustFind(scope: Element, selector: string): Element {
  const el = scope.querySelector(selector);
  if (!el) throw new Error(`unified shell: missing mount point ${selector}`);
  return el;
}

/** Current markdown source of a text leaf (mirrors the renderer rule). */
function textSource(node: BlockNode | null): string | null {
  if (node?.type !== 'text') return null;
  const markdown = node.markdown ?? (node as { slots?: { markdown?: unknown } }).slots?.markdown;
  return typeof markdown === 'string' ? markdown : '';
}

function nodeLabel(node: BlockNode): string {
  return node.type === 'macro' ? `macro ${node.macro}` : node.type;
}

/** Merge touched macro fields over the instance slots; an empty value
 * clears the override so the default flows through again. */
function mergeMacroFields(slots: Slots, touched: Record<string, unknown>): Slots {
  const merged = { ...slots };
  for (const [key, value] of Object.entries(touched)) {
    if (typeof value !== 'string' || value === '') delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

export function mountUnifiedShell(root: Element, deps: UnifiedShellDeps): UnifiedShell {
  const doc = root.ownerDocument;
  const shellEl = mustFind(root, '#rkr-unified-shell');
  const toolbar = mustFind(root, '#rkr-unified-toolbar');
  const dock = mustFind(root, '#rkr-unified-dock') as HTMLElement;
  const body = mustFind(root, '#rkr-blocks-page-body');

  let tree = deps.tree;
  // The tree the body DOM was rendered from. It differs from `tree`
  // while a render is pending or after one failed; the body is inert
  // then, because its paths no longer address `tree`.
  let shown = deps.tree;
  let mode: Mode = 'view';
  let selected: Path | null = null;
  let units: HydratedUnit[] = [];
  let unitOf = new Map<Element, HydratedUnit>();
  const tools: Element[] = [];
  let generation = 0;
  let latest: Promise<void> = Promise.resolve();

  const select = (path: Path): void => {
    selected = [...path];
  };

  const save = createSavePipeline({
    onSave: deps.onSave,
    getTree: () => tree,
    resave: () => applyTree(tree),
    shellEl,
    toolbar
  });

  const unitAt = (target: unknown): HydratedUnit | null => {
    const card = (target as Element | null)?.closest?.('[data-rkr-path]');
    return card ? (unitOf.get(card) ?? null) : null;
  };

  /** Serialize the text leaf containing `target` back to the markdown
   * DSL. Skipped while the DOM is stale: its paths don't address `tree`. */
  const commitText = (target: unknown): void => {
    if (shown !== tree) return;
    const unit = unitAt(target);
    if (!unit) return;
    const before = textSource(getAtPath(tree, unit.path));
    if (before === null) return;
    const after = domToMarkdown(unit.elements);
    if (after === before) return;
    select(unit.path);
    if (after) {
      // View mode hides blank placeholders; this one has content now.
      for (const el of unit.elements) {
        el.removeAttribute('data-rkr-blank');
        el.classList.remove('rkr-unified-blank');
      }
    }
    tree = setSlotAtPath(tree, unit.path, 'markdown', after);
    shown = tree;
    save.markEditing();
    void save.requestSave(tree);
  };

  // focusout bubbles, so one delegated listener covers every leaf.
  body.addEventListener('focusout', (ev: Event) => {
    commitText(ev.target);
  });

  body.addEventListener('input', () => {
    save.markEditing();
  });

  body.addEventListener('click', (ev: Event) => {
    const unit = unitAt(ev.target);
    if (unit) select(unit.path);
  });

  const reindex = (): void => {
    units = hydrate(shown, body);
    unitOf = new Map(units.flatMap((u) => u.elements.map((el) => [el, u] as const)));
  };

  const openFigureConfig = (path: Path): void => {
    const node = getAtPath(tree, path);
    if (node?.type !== 'figure') return;
    openFigureDialog(root, {
      initial: readFigureFields(node),
      onCommit: (slots) => {
        let next = tree;
        for (const [key, value] of Object.entries(slots)) {
          if (typeof value === 'string') next = setSlotAtPath(next, path, key, value);
        }
        void applyTree(next, { select: path });
      },
      onCancel: () => {}
    });
  };

  const macroDefaults = new Map(deps.macros.map((m) => [m.name, m.defaults ?? {}]));

  const openMacroConfig = (path: Path): void => {
    const node = getAtPath(tree, path);
    if (node?.type !== 'macro') return;
    openMacroDialog(root, {
      fields: readMacroFields(node, macroDefaults.get(node.macro) ?? {}),
      onCommit: (touched) => {
        const next = updateSlotsAtPath(tree, path, (slots) => mergeMacroFields(slots, touched));
        void applyTree(next, { select: path });
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
        select(unit.path);
        if (unit.node.type === 'figure') openFigureConfig(unit.path);
        else if (unit.node.type === 'macro') openMacroConfig(unit.path);
      });
      holder.append(button);
      // Sibling, not child: a figure's caption/gallery markup stays
      // exactly what the public page renders.
      anchor.after(holder);
      tools.push(holder);
    }
  };

  const setMode = (next: Mode): void => {
    mode = next;
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

  const swap = (html: string, rendered: BlockTree, opts: ApplyOpts): void => {
    clearTools();
    body.innerHTML = html;
    shown = rendered;
    reindex();
    if (selected && !getAtPath(tree, selected)) selected = null;
    body.removeAttribute('inert');
    setMode(mode);
    if (opts.select && mode === 'edit') {
      const key = opts.select.join(',');
      const unit = units.find((u) => u.path.join(',') === key);
      if (unit?.node.type === 'text') (unit.elements[0] as HTMLElement | undefined)?.focus();
    }
  };

  /** Render `next`, swap it in, re-hydrate, re-apply the mode, restore
   * selection, then save. Only the newest call swaps and saves; older
   * calls resolve when it settles. A failed render keeps `next` as the
   * tree, leaves the DOM untouched, and reports in the save indicator. */
  const applyLatest = async (next: BlockTree, opts: ApplyOpts): Promise<void> => {
    const mine = ++generation;
    tree = next;
    // Set now, not at swap: a palette click before the render lands
    // must target the new tree.
    if (opts.select) select(opts.select);
    save.markEditing();
    body.setAttribute('inert', '');
    let html: string;
    try {
      html = shown === next ? '' : await deps.render(next);
    } catch {
      if (mine === generation) save.fail(RENDER_FAILED);
      return mine === generation ? undefined : latest;
    }
    if (mine !== generation) return latest;
    if (shown === next) body.removeAttribute('inert');
    else swap(html, next, opts);
    await save.requestSave(next);
  };

  const applyTree = (next: BlockTree, opts: ApplyOpts = {}): Promise<void> => {
    latest = applyLatest(next, opts);
    return latest;
  };

  reindex();

  mountPaletteInsert({
    dock,
    body,
    macros: deps.macros,
    getTree: () => tree,
    getSelected: () => selected,
    // A palette button may not take focus (Safari, Firefox on macOS),
    // so the focused leaf would only blur once the body goes inert.
    flushText: () => {
      commitText(doc.activeElement);
    },
    commitInsert: (next, path) => {
      void applyTree(next, { select: path });
    },
    showNudge: (text) => {
      save.notice(text);
    }
  });

  for (const button of toolbar.querySelectorAll('[data-mode]')) {
    button.addEventListener('click', () => {
      const next = (button as HTMLElement).dataset.mode;
      if (next === 'view' || next === 'edit') setMode(next);
    });
  }

  setMode('view');

  return {
    setMode,
    applyTree,
    get selectedPath() {
      return selected;
    }
  };
}
