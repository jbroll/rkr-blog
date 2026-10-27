// Block configuration dialogs for the unified shell: picks the dialog for
// a node type and turns its result into a tree update.
//
// Browser-safe: no node:* imports (bundled into the admin entry).

import type { BlockNode, BlockTree, Slots } from '../lib/blocks.ts';
import { openAccordionDialog, readAccordionFields } from './accordion-dialog-tree.ts';
import { getAtPath, type Path, updateSlotsAtPath } from './block-tree-ops.ts';
import type { PaletteMacro } from './blocks-editor.ts';
import { openButtonDialog, readButtonFields } from './button-dialog-tree.ts';
import { openEmbedDialog, readEmbedFields } from './embed-dialog-tree.ts';
import { type MediaDialogDeps, openMediaDialog } from './figure-dialog-tree.ts';
import { applyGridSlots, openGridDialog, readGridFields } from './grid-dialog-tree.ts';
import { openMacroDialog, readMacroFields } from './macro-dialog-tree.ts';
import { openMarqueeDialog, readMarqueeFields } from './marquee-dialog-tree.ts';
import { openProgressDialog, readProgressFields } from './progress-dialog-tree.ts';

export interface ConfigureDeps {
  root: Element;
  macros: PaletteMacro[];
  media?: MediaDialogDeps;
  /** Section theme names for the grid dialog; the built-ins when absent. */
  themes?: string[];
  getTree(): BlockTree;
  applyTree(next: BlockTree, opts: { select?: Path; renderOnly?: boolean }): Promise<void>;
  flushText(): void;
  /** Message when dialog commits cannot render right now, else null. */
  refuse(): string | null;
}

/** A media block inserted but not yet saved: the dialog decides
 * whether it stays (something was picked) or goes. */
interface FreshMedia {
  done(kept: boolean): void;
}

export interface Configurator {
  configure(path: Path): void;
  openMediaConfig(path: Path, fresh?: FreshMedia): void;
  canConfigure(node: BlockNode): boolean;
}

/** Types `configure` opens a dialog for. */
const CONFIGURABLE: ReadonlySet<string> = new Set([
  'figure',
  'video',
  'macro',
  'button',
  'grid',
  'marquee',
  'accordion',
  'progress',
  'embed'
]);

type SmallType = 'marquee' | 'accordion' | 'progress' | 'embed';
const isSmall = (type: string): type is SmallType =>
  type === 'marquee' || type === 'accordion' || type === 'progress' || type === 'embed';

const NO_MEDIA: MediaDialogDeps = {
  pick: async () => [],
  thumbUrl: (kind, id) => (kind === 'image' ? `/admin/preview/${id}` : null)
};

/** Merge touched macro fields over the instance slots; an empty value
 * or empty list clears the override so the default flows through again. */
function mergeMacroFields(slots: Slots, touched: Record<string, unknown>): Slots {
  const merged = { ...slots };
  for (const [key, value] of Object.entries(touched)) {
    if (Array.isArray(value) && value.length > 0) merged[key] = value;
    else if (typeof value !== 'string' || value === '') delete merged[key];
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

  const openMediaConfig = (path: Path, fresh?: FreshMedia): void => {
    const node = getAtPath(deps.getTree(), path);
    if (node?.type !== 'figure' && node?.type !== 'video') return;
    openMediaDialog(root, {
      kind: node.type,
      slots: (node as { slots?: Slots }).slots ?? {},
      fresh: Boolean(fresh),
      media,
      refuse,
      onCommit: (slots) => {
        fresh?.done(Boolean(slots.ids));
        if (fresh && !slots.ids) return;
        commitSlots(path, (current) => ({ ...current, ...slots }));
      },
      onCancel: (edited) => {
        if (fresh) {
          fresh.done(false);
          return;
        }
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
        commitSlots(path, (current) => {
          const { size: _size, arrow: _arrow, ...rest } = current;
          return { ...rest, ...slots };
        });
      }
    });
  };

  const openGridConfig = (path: Path): void => {
    const node = getAtPath(deps.getTree(), path);
    if (node?.type !== 'grid') return;
    openGridDialog(root, {
      initial: readGridFields(node.slots),
      canBand: path.length === 1,
      themes: deps.themes,
      media,
      refuse,
      onCommit: (slots) => {
        commitSlots(path, (current) => applyGridSlots(current, slots));
      }
    });
  };

  const openSmallConfig = (path: Path, type: SmallType): void => {
    const node = getAtPath(deps.getTree(), path);
    if (node?.type !== type) return;
    const onCommit = (slots: Slots): void => {
      commitSlots(path, () => slots);
    };
    const opts = { refuse, onCommit };
    if (type === 'marquee') openMarqueeDialog(root, { ...opts, initial: readMarqueeFields(node) });
    else if (type === 'progress') {
      openProgressDialog(root, { ...opts, initial: readProgressFields(node) });
    } else if (type === 'embed') openEmbedDialog(root, { ...opts, initial: readEmbedFields(node) });
    else openAccordionDialog(root, { ...opts, initial: readAccordionFields(node) });
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
      else if (type === 'grid') openGridConfig(path);
      else if (type && isSmall(type)) openSmallConfig(path, type);
    }
  };
}
