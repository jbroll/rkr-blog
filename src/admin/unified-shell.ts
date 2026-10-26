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
import { getAtPath, type Path, setSlotAtPath } from './blocks-page-editor.ts';
import { domToMarkdown } from './dom-markdown.ts';
import type { MediaDialogDeps } from './figure-dialog-tree.ts';
import { openPageSettings, readPageFields } from './page-settings.ts';
import { mountBlockActions } from './unified-block-actions.ts';
import { createConfigurator } from './unified-configure.ts';
import type { DraftStore } from './unified-draft.ts';
import { type HydratedUnit, hydrate } from './unified-hydrate.ts';
import { mountPaletteInsert } from './unified-insert.ts';
import { createSavePipeline, type SavePipelineDeps } from './unified-save.ts';

type Mode = 'view' | 'edit';

export interface UnifiedShellDeps {
  /** Canonical tree embedded by the edit route (`#rkr-tree`). */
  tree: BlockTree;
  /** Palette entries from `GET /admin/blocks/macros`. */
  macros: PaletteMacro[];
  /** Persist the whole tree (`POST /admin/blocks/:slug`); see SavePipelineDeps. */
  onSave: SavePipelineDeps['onSave'];
  /** Stored version the page was rendered from (`data-version`). */
  version?: string;
  /** Durable unsaved tree; a differing draft is restored on mount. */
  drafts?: DraftStore;
  /** Source of `online` and `pagehide`; defaults to `window`. */
  win?: EventTarget;
  /** Marked edit-page body for `tree` (`POST /admin/blocks/_render`). */
  render(tree: BlockTree): Promise<string>;
  /** Pickers and the image editor for media dialogs. Without it, media
   * dialogs can rearrange and caption but not add. */
  media?: MediaDialogDeps;
}

interface ApplyOpts {
  /** Path (in the new tree) to select once the render lands. */
  select?: Path;
  /** Re-render without saving: the tree is unchanged but what the page
   * shows is not (applied image edits). */
  renderOnly?: boolean;
}

export interface UnifiedShell {
  setMode(mode: Mode): void;
  readonly selectedPath: Path | null;
  applyTree(next: BlockTree, opts?: ApplyOpts): Promise<void>;
}

const RENDER_FAILED = "Couldn't refresh the page. Select Retry to try again.";
const OFFLINE_STRUCTURE = 'Reconnect to add or move blocks';
const OFFLINE_DIALOG = "You're offline. Keep this open and save when you reconnect.";

/** JSON with sorted keys, so equal trees compare equal whatever built them. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v
  );
}

const offline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

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
  let generation = 0;
  let latest: Promise<void> = Promise.resolve();

  let actions: { refresh(): void } | undefined;

  const select = (path: Path | null): void => {
    selected = path ? [...path] : null;
    actions?.refresh();
  };

  const save = createSavePipeline({
    onSave: deps.onSave,
    getTree: () => tree,
    resave: () => applyTree(tree),
    shellEl,
    toolbar,
    version: deps.version,
    drafts: deps.drafts,
    dialogRoot: root,
    win: deps.win
  });
  // Dialog commits re-render, which needs the server.
  const refuseOffline = (): string | null => (offline() ? OFFLINE_DIALOG : null);

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
    // Selecting a button block must not follow its link.
    if (mode === 'edit' && (ev.target as Element | null)?.closest?.('a')) ev.preventDefault();
    const unit = unitAt(ev.target);
    if (unit) select(unit.path);
  });

  const reindex = (): void => {
    units = hydrate(shown, body);
    unitOf = new Map(units.flatMap((u) => u.elements.map((el) => [el, u] as const)));
  };

  const openSettings = (): void => {
    flushText();
    const slug = (root as HTMLElement).dataset?.slug ?? '';
    openPageSettings(root, {
      slug,
      fields: readPageFields(tree.fields, slug),
      refuse: () => (shown !== tree ? refuseOffline() : null),
      onCommit: (fields) => {
        const next = {
          ...tree,
          fields: { ...tree.fields, ...fields, excerpt: fields.excerpt ?? '' }
        };
        const titleEl = toolbar.querySelector('.rkr-unified-title');
        if (titleEl) titleEl.textContent = fields.title;
        // The body does not show the fields, so it stays valid for `next`.
        if (shown !== tree) {
          void applyTree(next);
          return;
        }
        tree = next;
        shown = next;
        save.markEditing();
        void save.requestSave(next);
      }
    });
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
    if (next === 'edit') doc.documentElement.setAttribute('data-rkr-editing', '');
    else doc.documentElement.removeAttribute('data-rkr-editing');
    for (const unit of units) {
      if (unit.node.type !== 'text') continue;
      for (const el of unit.elements) {
        if (next === 'edit') el.setAttribute('contenteditable', 'true');
        else el.removeAttribute('contenteditable');
      }
    }
    actions?.refresh();
  };

  const swap = (html: string, rendered: BlockTree, opts: ApplyOpts): void => {
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
    // Structure needs the server render; text blurs never come through here.
    if (shown !== next && offline()) {
      save.notice(OFFLINE_STRUCTURE);
      return;
    }
    const mine = ++generation;
    tree = next;
    // Set now, not at swap: a palette click before the render lands
    // must target the new tree.
    if (opts.select) select(opts.select);
    if (!opts.renderOnly) {
      save.markEditing();
      // Durable before the render, which may fail or never return.
      save.draft(next);
    }
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
    if (!opts.renderOnly) await save.requestSave(next);
  };

  const applyTree = (next: BlockTree, opts: ApplyOpts = {}): Promise<void> => {
    latest = applyLatest(next, opts);
    return latest;
  };

  reindex();

  // A toolbar or palette button may not take focus (Safari, Firefox on
  // macOS), so the focused leaf would only blur once the body goes inert.
  const flushText = (): void => {
    commitText(doc.activeElement);
  };

  const { configure, openMediaConfig, canConfigure } = createConfigurator({
    root,
    macros: deps.macros,
    media: deps.media,
    getTree: () => tree,
    applyTree,
    flushText,
    refuse: refuseOffline
  });

  const insert = mountPaletteInsert({
    dock,
    body,
    macros: deps.macros,
    getTree: () => tree,
    getSelected: () => selected,
    flushText,
    commitInsert: (next, path, inserted) => {
      if (offline()) {
        save.notice(OFFLINE_STRUCTURE);
        return;
      }
      void applyTree(next, { select: path });
      const node = getAtPath(next, path);
      const ids = (node as { slots?: Slots } | null)?.slots?.ids;
      if (inserted && (node?.type === 'figure' || node?.type === 'video') && !ids) {
        openMediaConfig(path, true);
      }
    },
    showNudge: (text) => {
      save.notice(text);
    }
  });

  actions = mountBlockActions({
    body,
    getTree: () => tree,
    getSelected: () => selected,
    select,
    applyTree,
    configure,
    canConfigure,
    flushText,
    isEditing: () => mode === 'edit',
    drag: { start: (path) => insert.beginMove(path), end: () => insert.endMove() }
  });

  for (const button of toolbar.querySelectorAll('[data-mode]')) {
    button.addEventListener('click', () => {
      const next = (button as HTMLElement).dataset.mode;
      if (next === 'view' || next === 'edit') setMode(next);
    });
  }

  toolbar.querySelector('.rkr-unified-settings')?.addEventListener('click', openSettings);

  setMode('view');

  // A draft equal to the page is a save whose clear never ran; any other
  // draft is unsynced work, saved against the version it was edited from.
  const restoreDraft = async (store: DraftStore): Promise<void> => {
    const draft = await store.load().catch(() => null);
    if (!draft || tree !== deps.tree) return;
    if (stableJson(draft.tree) === stableJson(tree)) {
      await store.clear().catch(() => {});
      return;
    }
    if (draft.baseVersion) save.rebase(draft.baseVersion, draft.savedAt);
    await applyTree(draft.tree);
    if (save.state() === 'clean') save.notice('Restored unsaved changes');
  };
  if (deps.drafts) void restoreDraft(deps.drafts);

  // Last chance for a focused, unblurred edit; IndexedDB writes started
  // here usually complete.
  (deps.win ?? (typeof window !== 'undefined' ? window : undefined))?.addEventListener(
    'pagehide',
    () => {
      flushText();
      if (save.state() !== 'clean') save.draft(tree);
    }
  );

  doc.addEventListener('keydown', (raw: Event) => {
    const ev = raw as KeyboardEvent;
    if (!(ev.ctrlKey || ev.metaKey) || ev.altKey || ev.shiftKey) return;
    if ((ev.target as Element | null)?.closest?.('[data-rkr-dialog]')) return;
    const key = ev.key.toLowerCase();
    if (key === 'e') {
      ev.preventDefault();
      flushText();
      setMode(mode === 'edit' ? 'view' : 'edit');
    } else if (key === 's') {
      ev.preventDefault();
      flushText();
      save.saveNow();
    }
  });

  return {
    setMode,
    applyTree,
    get selectedPath() {
      return selected;
    }
  };
}
