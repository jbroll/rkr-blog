// Render JSON block trees to HTML. Containers become divs (flexbox is
// a theme concern); text leaves render their markdown DSL through the
// existing post pipeline; figure/video leaves delegate to the widget
// registry; macro instances expand against a RenderMacroLib.

import { remark } from 'remark';
import remarkDirective from 'remark-directive';
import { type BlockNode, type BlockTree, detectCycle, resolveSlots, type Slots } from './blocks.ts';
import { escapeAttr, escapeText, type RenderCtx, renderPostHtml } from './content.ts';
import { safeLinkUrl } from './safe-url.ts';
import type { DirectiveNode } from './widgets.ts';

/** Minimal macro source for the renderer. Task 3 provides the
 * file-backed implementation; the renderer only needs lookup. */
export interface RenderMacroLib {
  get(name: string): { defaults: Slots; tree: BlockNode } | undefined;
}

function textOf(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/** Direct macro-instance names inside a tree (one level). */
function directRefs(node: BlockNode): string[] {
  if (node.type === 'macro') return [node.macro];
  const kids =
    (node as { children?: BlockNode[] }).children ??
    (node as { blocks?: BlockNode[] }).blocks ??
    [];
  return kids.flatMap(directRefs);
}

/** Build an adjacency map by walking macro trees from `root`. */
function adjacencyFrom(lib: RenderMacroLib, root: string): Record<string, string[]> {
  const adj: Record<string, string[]> = {};
  const queue = [root];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const name = queue.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const def = lib.get(name);
    const refs = def ? directRefs(def.tree) : [];
    adj[name] = refs;
    for (const r of refs) if (!seen.has(r)) queue.push(r);
  }
  return adj;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g;

/** Replace `{{name}}` in every string of a macro tree with the resolved
 * slot value. A name with no string or number value renders empty. */
function fillPlaceholders<T>(value: T, slots: Slots): T {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER, (_whole, name: string) => {
      const v = slots[name];
      return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => fillPlaceholders(v, slots)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, fillPlaceholders(v, slots)])
    ) as T;
  }
  return value;
}

function leafDirective(name: string, attrs: Record<string, string>): DirectiveNode {
  const attributes: Record<string, string | null | undefined> = { ...attrs };
  return { type: 'leafDirective', name, attributes, children: [] };
}

function strSlots(slots: Slots | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(slots ?? {})) {
    if (v === undefined || v === null) continue;
    out[k] = Array.isArray(v) ? v.join(',') : String(v);
  }
  return out;
}

const EMBED_ALLOW = ['youtube.com', 'youtu.be', 'vimeo.com', 'docs.google.com', 'maps.google.com'];

/** Optional render decorations, shared by `renderNode` and
 * `renderBlockTree`. `mark` returns an invisible prefix (the editor uses
 * an HTML comment carrying the node's tree path) that is prepended to
 * every non-empty node so the browser can zip the DOM back to tree
 * paths. Absent `mark`, output is byte-identical to the public render. */
interface RenderNodeOpts {
  mark?: (path: number[]) => string;
}

/** Render one node, then (when marking) prepend its path marker.
 * When marking, every node renders something (blank text renders an
 * edit placeholder), so every node gets a marker and the client's
 * render-order flattening (unified-hydrate.ts) skips nothing. */
async function renderNode(
  node: BlockNode,
  ctx: RenderCtx,
  lib: RenderMacroLib,
  stack: string[],
  path: number[],
  opts?: RenderNodeOpts
): Promise<string> {
  const html = await renderNodeHtml(node, ctx, lib, stack, path, opts);
  if (!html || !opts?.mark) return html;
  return `${opts.mark(path)}${html}`;
}

async function renderNodeHtml(
  node: BlockNode,
  ctx: RenderCtx,
  lib: RenderMacroLib,
  stack: string[],
  path: number[],
  opts?: RenderNodeOpts
): Promise<string> {
  // Render a container's children with their index appended to the path.
  const renderKids = (kids: BlockNode[]): Promise<string[]> =>
    Promise.all(kids.map((k, i) => renderNode(k, ctx, lib, stack, [...path, i], opts)));

  switch (node.type) {
    case 'section': {
      const slots = node.slots ?? {};
      const theme = /^[a-z-]+$/.test(textOf(slots.theme, 'light'))
        ? textOf(slots.theme, 'light')
        : 'light';
      const edge = textOf(slots.edge, 'straight');
      const kids = node.children ?? [];
      const inner = (await renderKids(kids)).join('');
      const wave =
        edge === 'wave' ? '\n<div class="rkr-section-wave" aria-hidden="true"></div>' : '';
      return `<section class="rkr-section rkr-theme-${escapeAttr(theme)}">\n<div class="rkr-section-inner">\n${inner}</div>${wave}\n</section>\n`;
    }
    case 'row': {
      const kids = node.children ?? [];
      const inner = (await renderKids(kids)).join('');
      return `<div class="rkr-row">\n${inner}</div>\n`;
    }
    case 'col':
    case 'flow': {
      const cls = node.type === 'col' ? 'rkr-col' : 'rkr-flow';
      const kids = node.children ?? node.blocks ?? [];
      const inner = (await renderKids(kids)).join('');
      return `<div class="${cls}">\n${inner}</div>\n`;
    }
    case 'text': {
      const md = node.markdown ?? textOf(node.slots?.markdown);
      // Blank text is invisible to readers; the editor needs an element to type into.
      if (!md) return opts?.mark ? '<p class="rkr-unified-blank" data-rkr-blank></p>\n' : '';
      const ast = remark().use(remarkDirective).parse(md);
      return renderPostHtml(ast as Parameters<typeof renderPostHtml>[0], ctx);
    }
    case 'figure':
    case 'video': {
      return ctx.widgets.dispatch(node.type, leafDirective(node.type, strSlots(node.slots)), ctx);
    }
    case 'button': {
      const label = textOf(node.slots?.label);
      const href = safeLinkUrl(textOf(node.slots?.href, '#'));
      const variant =
        textOf(node.slots?.variant, 'primary') === 'secondary' ? 'secondary' : 'primary';
      return `<a class="rkr-btn is-${variant}" href="${escapeAttr(href)}">${escapeText(label)}</a>\n`;
    }
    case 'marquee': {
      return `<div class="rkr-marquee"><span>${escapeText(textOf(node.slots?.text))}</span></div>\n`;
    }
    case 'accordion': {
      const items = Array.isArray(node.slots?.items) ? node.slots.items : [];
      const out = items
        .map((it) => {
          const rec = (it ?? {}) as Record<string, unknown>;
          return `<details><summary>${escapeText(textOf(rec.title))}</summary>\n${escapeText(textOf(rec.body))}\n</details>`;
        })
        .join('\n');
      return `<div class="rkr-accordion">\n${out}\n</div>\n`;
    }
    case 'progress': {
      const goal = Number(node.slots?.goal ?? 0);
      const raised = Number(node.slots?.raised ?? 0);
      const pct = goal > 0 ? Math.min(100, Math.round((raised / goal) * 100)) : 0;
      return `<div class="rkr-progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div class="rkr-progress-bar" style="width: ${pct}%"></div></div>\n`;
    }
    case 'embed': {
      const url = textOf(node.slots?.url);
      let host = '';
      try {
        host = new URL(url).hostname;
      } catch {
        return `<!-- embed: invalid url -->`;
      }
      if (!EMBED_ALLOW.some((h) => host === h || host.endsWith(`.${h}`))) {
        return `<a href="${escapeAttr(safeLinkUrl(url))}">${escapeText(url)}</a>\n`;
      }
      return `<iframe class="rkr-embed" src="${escapeAttr(url)}" loading="lazy" sandbox="allow-scripts allow-same-origin"></iframe>\n`;
    }
    case 'macro': {
      if (stack.includes(node.macro)) return `<!-- macro cycle: ${escapeText(node.macro)} -->`;
      const def = lib.get(node.macro);
      if (!def) return `<!-- unknown macro: ${escapeText(node.macro)} -->`;
      if (detectCycle(adjacencyFrom(lib, node.macro), node.macro)) {
        return `<!-- macro cycle: ${escapeText(node.macro)} -->`;
      }
      const overrides = node.slots ?? {};
      const merged = resolveSlots({ defaults: def.defaults }, overrides).slots;
      const filled = fillPlaceholders(def.tree, merged);
      // Tree slots (theme, edge) plus explicit overrides; defaults feed placeholders only.
      const tree = {
        ...filled,
        slots: { ...(filled.slots ?? {}), ...overrides }
      } as BlockNode;
      // The instance is one editable unit: mark the instance path once,
      // render the expansion internals unmarked.
      return renderNodeHtml(tree, ctx, lib, [...stack, node.macro], path);
    }
    default: {
      // Page trees are validated on save and macros on load; this guards
      // anything that slipped past, without taking the page down.
      // biome-ignore lint/suspicious/noConsole: no request logger reaches the renderer
      console.warn(`renderBlockTree: unknown block type ${(node as { type: unknown }).type}`);
      return '';
    }
  }
}

/** Raw figure `ids` strings in a tree, following macro references one
 * level deep per name (cycle-guarded). Callers feed these to the
 * image-map prepass, which splits comma lists itself. */
export function collectBlockFigureIds(
  tree: BlockTree,
  getMacroTree?: (name: string) => BlockNode | undefined
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (node: BlockNode): void => {
    if (node.type === 'figure' && typeof node.slots?.ids === 'string' && node.slots.ids) {
      out.push(node.slots.ids);
      return;
    }
    if (node.type === 'macro') {
      if (!getMacroTree || seen.has(node.macro)) return;
      seen.add(node.macro);
      const def = getMacroTree(node.macro);
      if (def) walk(def);
      return;
    }
    const n = node as { children?: BlockNode[]; blocks?: BlockNode[] };
    for (const k of n.children ?? n.blocks ?? []) walk(k);
  };
  for (const n of tree.body) walk(n);
  return out;
}

/** Render a whole page tree. Unknown macros and cycles become HTML
 * comments so authoring errors are visible without breaking the page.
 * Passing `opts.mark` prefixes each rendered node with the marker it
 * returns (used by the unified editor to address nodes); without it the
 * output is the public page, byte-for-byte. */
export async function renderBlockTree(
  tree: BlockTree,
  ctx: RenderCtx,
  lib: RenderMacroLib,
  opts?: RenderNodeOpts
): Promise<string> {
  const out = await Promise.all(tree.body.map((n, i) => renderNode(n, ctx, lib, [], [i], opts)));
  return out.join('');
}
