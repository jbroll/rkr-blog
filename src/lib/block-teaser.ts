// Teaser (hero figure + lede paragraph) from a stored JSON block tree.
// Mirrors the markdown teaser in routes/public.ts: the first figure in
// document order, then the first text leaf after it; no figure or no
// lede means no teaser. Only those two nodes are measured and rendered,
// so a broken image later in the page cannot take the index down.

import type { Paragraph, Root } from 'mdast';
import { remark } from 'remark';
import remarkDirective from 'remark-directive';
import type { BlockNode, BlockTree, LeafNode } from './blocks.ts';
import { type RenderCtx, renderPostHtml } from './content.ts';
import { buildImageMap } from './image-map-fs.ts';
import { truncateParagraph } from './teaser-truncate.ts';
import { buildVideoMap } from './video-map-fs.ts';
import type { DirectiveNode, WidgetRegistry } from './widgets.ts';

export interface TeaserParts {
  bannerHtml: string;
  excerptHtml: string;
}

/** Structural logger so this module stays independent of Fastify. */
interface BakeLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** Flatten a block tree to its leaves in document order. Macros stay
 * unexpanded: a figure hidden inside a macro is not a page hero. */
function blockLeaves(node: BlockNode): BlockNode[] {
  if (node.type === 'macro') return [];
  const kids =
    (node as { children?: BlockNode[]; blocks?: BlockNode[] }).children ??
    (node as { children?: BlockNode[]; blocks?: BlockNode[] }).blocks;
  if (kids) return kids.flatMap(blockLeaves);
  return [node];
}

/** Hero figure + lede markdown from a block tree. */
function blockTeaserSource(tree: BlockTree): { figure: LeafNode; lede: string } | null {
  const leaves = tree.body.flatMap(blockLeaves);
  const heroIdx = leaves.findIndex((n) => n.type === 'figure');
  if (heroIdx === -1) return null;
  const figure = leaves[heroIdx] as LeafNode;
  for (const node of leaves.slice(heroIdx + 1)) {
    if (node.type !== 'text') continue;
    const lede =
      node.markdown ?? (typeof node.slots?.markdown === 'string' ? node.slots.markdown : '');
    if (lede.trim()) return { figure, lede };
  }
  return null;
}

/** A figure block's slots as the directive the widget dispatcher reads,
 * matching `renderBlockTree` and the `GET /:slug` synthetic prepass. */
function figureDirective(node: LeafNode): DirectiveNode {
  const attributes: Record<string, string | null | undefined> = {};
  for (const [k, v] of Object.entries(node.slots ?? {})) {
    if (v === undefined || v === null) continue;
    attributes[k] = Array.isArray(v) ? v.join(',') : String(v);
  }
  return { type: 'leafDirective', name: 'figure', attributes, children: [] };
}

export async function extractBlockTeaser(
  siteRoot: string,
  tree: BlockTree,
  widgets: WidgetRegistry,
  maxWords: number,
  log?: BakeLogger
): Promise<TeaserParts | null> {
  const source = blockTeaserSource(tree);
  if (!source) return null;
  const ledeAst = remark().use(remarkDirective).parse(source.lede) as Root;
  const lede = ledeAst.children.find((n): n is Paragraph => n.type === 'paragraph');
  if (!lede) return null;

  const hero = figureDirective(source.figure);
  const ctx: RenderCtx = {
    images: await buildImageMap(siteRoot, [hero, ledeAst], { log }),
    videos: await buildVideoMap(siteRoot),
    widgets
  };
  const bannerHtml = await widgets.dispatch('figure', hero, ctx);
  const excerptHtml = await renderPostHtml(
    { type: 'root', children: [truncateParagraph(lede, maxWords)] },
    ctx
  );
  return { bannerHtml, excerptHtml };
}
