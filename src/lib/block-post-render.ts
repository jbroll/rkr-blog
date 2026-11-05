// A stored JSON page rendered for GET /:slug: body, hero banner and
// subtitle, matching what the markdown path produced for the same post.

import path from 'node:path';

import { figureDirective, splitHero } from './block-teaser.ts';
import type { BlockTree } from './blocks.ts';
import { collectBlockFigureIds, renderBlockTree } from './blocks-render.ts';
import { buildImageMap } from './image-map-fs.ts';
import { loadMacroLibrary } from './macro-library.ts';
import type { Campaign } from './site-org-settings.ts';
import { resolveTagSources, type TagLookup } from './tag-source.ts';
import type { DirectiveNode, VideoMapView, WidgetRegistry } from './widgets.ts';

interface Logger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface BlockPostParts {
  bodyHtml: string;
  bannerHtml: string | null;
  subtitle?: string;
}

type BlockRenderDeps = {
  widgets: WidgetRegistry;
  videos: VideoMapView;
  log: Logger;
  campaign?: Campaign;
  lookup?: TagLookup;
  selfSlug?: string;
};

/** The render context and macro lookup a tree needs, with its tag sources
 * and figures resolved. `tree` is the resolved tree to render. */
export async function prepareBlockRender(
  siteRoot: string,
  source: BlockTree,
  deps: BlockRenderDeps
) {
  const tree = deps.lookup ? resolveTagSources(source, deps.lookup, deps.selfSlug) : source;
  const lib = loadMacroLibrary(path.join(siteRoot, 'macros'), deps.log);
  const macroLib = {
    get: (n: string) => {
      const d = lib.get(n);
      return d ? { defaults: d.defaults, tree: d.tree } : undefined;
    }
  };
  const synthetic = collectBlockFigureIds(tree, macroLib).map((ids) => ({
    type: 'leafDirective',
    name: 'figure',
    attributes: { ids },
    children: []
  }));
  const ctx = {
    images: await buildImageMap(siteRoot, synthetic as unknown as DirectiveNode[], {
      log: deps.log
    }),
    videos: deps.videos,
    widgets: deps.widgets
  };
  return { ctx, macroLib, tree };
}

export async function renderBlockPost(
  siteRoot: string,
  page: { tree: BlockTree; fields: Record<string, unknown> },
  deps: BlockRenderDeps
): Promise<BlockPostParts> {
  const { ctx, macroLib, tree } = await prepareBlockRender(siteRoot, page.tree, deps);
  const { hero, rest } = splitHero(tree);
  const bannerHtml = hero
    ? await deps.widgets.dispatch('figure', figureDirective(hero), ctx)
    : null;
  const bodyHtml = await renderBlockTree(rest, ctx, macroLib, { campaign: deps.campaign });
  const sub = page.fields.subtitle;
  return {
    bodyHtml,
    bannerHtml,
    ...(typeof sub === 'string' && sub.trim() ? { subtitle: sub } : {})
  };
}
