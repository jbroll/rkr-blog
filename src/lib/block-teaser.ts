// Hero figure and teaser (hero + lede paragraph) from a stored JSON block
// tree. Mirrors the markdown rule in routes/public.ts: only a figure that
// opens the post is its hero; the lede is the first text leaf after it.
// No hero or no lede means no teaser. Only those two nodes are measured
// and rendered, so a broken image later in the page cannot take the
// index down.

import type { Paragraph, Root } from 'mdast';
import { remark } from 'remark';
import remarkDirective from 'remark-directive';
import type { BlockNode, BlockTree, LeafNode } from './blocks.ts';
import { type RenderCtx, renderPostHtml } from './content.ts';
import { readGridSlots } from './grid.ts';
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

/** The page hero and the tree without it. The hero is the body's first
 * node when that is a figure, or the first block of a leading one-column grid (where
 * a migrated post's body lives). */
export function splitHero(tree: BlockTree): { hero: LeafNode | null; rest: BlockTree } {
  const first = tree.body[0];
  if (first?.type === 'figure') {
    return { hero: first as LeafNode, rest: { ...tree, body: tree.body.slice(1) } };
  }
  const lead = first?.type === 'grid' ? readGridSlots(first.slots) : null;
  if (first?.type === 'grid' && lead && lead.cols === 1 && !lead.band) {
    const kids = first.children;
    if (kids[0]?.type === 'figure') {
      const rest: BlockTree = {
        ...tree,
        body: [{ ...first, children: kids.slice(1) }, ...tree.body.slice(1)]
      };
      return { hero: kids[0] as LeafNode, rest };
    }
  }
  return { hero: null, rest: tree };
}

/** Hero figure + lede markdown from a block tree. */
function blockTeaserSource(tree: BlockTree): { figure: LeafNode; lede: string } | null {
  const figure = splitHero(tree).hero;
  if (!figure) return null;
  const leaves = tree.body.flatMap(blockLeaves);
  const heroIdx = leaves.indexOf(figure);
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
export function figureDirective(node: LeafNode): DirectiveNode {
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
