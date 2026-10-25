// Edit-surface render of a block tree: the public body (macro library,
// image/video maps, widget dispatch) plus `<!--rkr:path=i,j-->` markers
// the unified editor hydrates. Shared by the edit page and the
// re-render endpoint so both produce identical markup.

import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';

import figureWidget from '../widgets/figure.ts';
import videoWidget from '../widgets/video.ts';
import type { BlockTree } from './blocks.ts';
import { collectBlockFigureIds, renderBlockTree } from './blocks-render.ts';
import { buildImageMap } from './image-map-fs.ts';
import { loadMacroLibrary } from './macro-library.ts';
import { buildVideoMap } from './video-map-fs.ts';
import { type DirectiveNode, WidgetRegistry } from './widgets.ts';

/** Pinned form (no spaces) so the client parses it with one regex. */
const pathMarker = (p: number[]): string => `<!--rkr:path=${p.join(',')}-->`;

function editWidgets(): WidgetRegistry {
  const widgets = new WidgetRegistry();
  widgets.register(figureWidget);
  widgets.register(videoWidget);
  return widgets;
}

export async function renderEditBody(
  siteRoot: string,
  tree: BlockTree,
  log: FastifyBaseLogger
): Promise<string> {
  const lib = loadMacroLibrary(path.join(siteRoot, 'macros'));
  const macroLib = {
    get: (name: string) => {
      const def = lib.get(name);
      return def ? { defaults: def.defaults, tree: def.tree } : undefined;
    }
  };
  // Same image prepass as the public route (routes/public.ts), walking
  // macro expansions so a figure inside a macro resolves on both.
  const synthetic = collectBlockFigureIds(tree, (n) => lib.get(n)?.tree).map((ids) => ({
    type: 'leafDirective',
    name: 'figure',
    attributes: { ids },
    children: []
  }));
  const ctx = {
    images: await buildImageMap(siteRoot, synthetic as unknown as DirectiveNode[], { log }),
    videos: await buildVideoMap(siteRoot),
    widgets: editWidgets()
  };
  return renderBlockTree(tree, ctx, macroLib, { mark: pathMarker });
}
