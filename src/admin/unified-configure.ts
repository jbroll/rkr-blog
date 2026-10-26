// Block configuration dialogs for the unified shell: picks the dialog for
// a node type and turns its result into a tree update.
//
// Browser-safe: no node:* imports (bundled into the admin entry).

import type { BlockNode, BlockTree, Slots } from '../lib/blocks.ts';
import type { PaletteMacro } from './blocks-editor.ts';
import { getAtPath, type Path, updateSlotsAtPath } from './blocks-page-editor.ts';
import { openButtonDialog, readButtonFields } from './button-dialog-tree.ts';
import { type MediaDialogDeps, openMediaDialog } from './figure-dialog-tree.ts';
import { openMacroDialog, readMacroFields } from './macro-dialog-tree.ts';

export interface ConfigureDeps {
  root: Element;
  macros: PaletteMacro[];
  media?: MediaDialogDeps;
  getTree(): BlockTree;
  applyTree(next: BlockTree, opts: { select?: Path; renderOnly?: boolean }): Promise<void>;
  flushText(): void;
  /** Message when dialog commits cannot render right now, else null. */
  refuse(): string | null;
}

export interface Configurator {
  configure(path: Path): void;
  openMediaConfig(path: Path, fresh?: boolean): void;
  canConfigure(node: BlockNode): boolean;
}

/** Types `configure` opens a dialog for. */
const CONFIGURABLE: ReadonlySet<string> = new Set(['figure', 'video', 'macro', 'button']);

const NO_MEDIA: MediaDialogDeps = {
  pick: async () => [],
  thumbUrl: (kind, id) => (kind === 'image' ? `/admin/preview/${id}` : null)
};

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

export function createConfigurator(deps: ConfigureDeps): Configurator {
  const { root, flushText, refuse } = deps;
  const media = deps.media ?? NO_MEDIA;
  const macroInfo = new Map(deps.macros.map((m) => [m.name, m]));

  const commitSlots = (path: Path, update: (slots: Slots) => Slots): void => {
    flushText();
    const next = updateSlotsAtPath(deps.getTree(), path, update);
    void deps.applyTree(next, { select: path });
  };

  const openMediaConfig = (path: Path, fresh = false): void => {
    const node = getAtPath(deps.getTree(), path);
    if (node?.type !== 'figure' && node?.type !== 'video') return;
    openMediaDialog(root, {
      kind: node.type,
      slots: (node as { slots?: Slots }).slots ?? {},
      fresh,
      media,
      refuse,
      onCommit: (slots) => {
        commitSlots(path, (current) => ({ ...current, ...slots }));
      },
      onCancel: (edited) => {
        if (!edited) return;
        // Applied image edits changed the derivatives the page shows. A
        // pending text edit saves itself through flushText.
        flushText();
        void deps.applyTree({ ...deps.getTree() }, { select: path, renderOnly: true });
      }
    });
  };

  const openButtonConfig = (path: Path): void => {
    const node = getAtPath(deps.getTree(), path);
    if (node?.type !== 'button') return;
    openButtonDialog(root, {
      initial: readButtonFields(node),
      refuse,
      onCommit: (slots) => {
        commitSlots(path, (current) => ({ ...current, ...slots }));
      }
    });
  };

  const openMacroConfig = (path: Path): void => {
    const node = getAtPath(deps.getTree(), path);
    if (node?.type !== 'macro') return;
    const info = macroInfo.get(node.macro);
    openMacroDialog(root, {
      title: `Edit ${info?.label ?? node.macro}`,
      fields: readMacroFields(node, info?.defaults ?? {}, info?.fieldSchema),
      media,
      refuse,
      onCommit: (touched) => {
        commitSlots(path, (slots) => mergeMacroFields(slots, touched));
      },
      onCancel: () => {}
    });
  };

  return {
    openMediaConfig,
    canConfigure: (node) => CONFIGURABLE.has(node.type),
    configure(path) {
      const type = getAtPath(deps.getTree(), path)?.type;
      if (type === 'figure' || type === 'video') openMediaConfig(path);
      else if (type === 'macro') openMacroConfig(path);
      else if (type === 'button') openButtonConfig(path);
    }
  };
}
