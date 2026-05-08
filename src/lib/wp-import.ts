// WordPress import: walk a WpPost's HTML, ingest every <img> into the
// originals + sidecars trees, and emit one markdown file using the
// unified `::figure` directive (spec.md §9). Each WP <figure> block
// maps to a single ::figure with `matrix=` chosen by image count.
//
// REST client (listPosts / fetchPost) lives in lib/wp-rest.ts; the WpPost
// type lives in lib/wp-import-types.ts. Both are re-exported here for
// callers that import them via the top-level path.
//
// Why not rehype-remark for the prose: WP block content is a small
// vocabulary (p, figure, h2/h3, strong, em, a, br, ul/ol, blockquote,
// code). A focused walker is shorter than wiring rehype-remark with
// custom handlers AND keeps the directive-emission code in one place.

import { Readable } from 'node:stream';
import rehypeParse from 'rehype-parse';
import { unified } from 'unified';

import { ingestStream } from './originals.ts';
import { safeFetch } from './url-safety.ts';

export type { WpPost } from './wp-import-types.ts';
export { fetchPost, type ListResult, listPosts, type WpFetcher } from './wp-rest.ts';

import type { WpPost } from './wp-import-types.ts';

export interface ImportResult {
  /** Frontmatter + body, ready to write to content/posts/. */
  markdown: string;
  /** sha256 ids of every image ingested for this post (in source order). */
  imagesIngested: string[];
  /** Per-image fetch failures, by URL. Logged; the post still imports. */
  imageErrors: Array<{ url: string; error: string }>;
  /** The path `content/posts/<date>-<slug>.md` should be written to. */
  filename: string;
}

export interface ImportOpts {
  siteRoot: string;
  /** Override the image fetcher for tests. Default: SSRF-safe via
   * lib/url-safety.ts; image bytes streamed directly to ingestStream. */
  fetchImage?: (url: string) => Promise<Readable>;
  /** Cap on per-image bytes. Default 50 MB — original photos are
   * usually 5-15 MB; the cap stops a runaway from filling disk. */
  maxImageBytes?: number;
}

/** Import one post: walk its HTML, ingest every image, emit markdown. */
export async function importPost(post: WpPost, opts: ImportOpts): Promise<ImportResult> {
  const fetchImage = opts.fetchImage ?? defaultImageFetcher();
  const imagesIngested: string[] = [];
  const imageErrors: Array<{ url: string; error: string }> = [];

  // Parse the WP HTML once; we walk it twice — once to find images
  // and ingest them (collecting id-keyed substitutions), once to emit
  // markdown (with directives in place of the figure blocks).
  const tree = unified().use(rehypeParse, { fragment: true }).parse(post.content.rendered);

  const figures = collectFigures(tree);
  const idsByImg = new Map<unknown, string>(); // hast img node → ingested id

  for (const fig of figures) {
    for (const item of fig.items) {
      const masterUrl = item.masterUrl;
      if (!masterUrl) continue;
      try {
        const stream = await fetchImage(masterUrl);
        const result = await ingestStream({
          stream,
          siteRoot: opts.siteRoot,
          source: {
            kind: 'wordpress',
            url: masterUrl,
            originalName: filenameFromUrl(masterUrl),
            postUrl: post.link
          }
        });
        idsByImg.set(item.imgNode, result.id);
        imagesIngested.push(result.id);
      } catch (err) {
        imageErrors.push({ url: masterUrl, error: (err as Error).message });
      }
    }
  }

  // Replace each figure subtree with a marker node that the markdown
  // emitter renders as the directive line. Walking the tree (rather
  // than threading idsByImg through the emitter) keeps the emitter
  // ignorant of WP-specific block structure.
  for (const fig of figures) {
    const directive = directiveForFigure(fig, idsByImg);
    replaceWithRawMarkdown(tree, fig.figureNode, directive);
  }

  const body = emitMarkdown(tree as HastNode).trim();
  const frontmatter = renderFrontmatter(post);
  const markdown = `${frontmatter}\n\n${body}\n`;

  return {
    markdown,
    imagesIngested,
    imageErrors,
    filename: filenameFor(post)
  };
}

// ---- helpers ----------------------------------------------------------

function filenameFor(post: WpPost): string {
  const date = post.date.slice(0, 10); // YYYY-MM-DD
  const slug = post.slug || `post-${post.id}`;
  return `${date}-${slug}.md`;
}

function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    /* c8 ignore next -- pathname.split('/').pop() always returns a string */
    const base = u.pathname.split('/').pop() ?? 'image';
    return base;
  } catch {
    /* c8 ignore next -- defensive: importPost callers always pass parsed URLs */
    return 'image';
  }
}

/* c8 ignore start -- production-only wiring; tests inject opts.fetchImage */
function defaultImageFetcher(): (url: string) => Promise<Readable> {
  return async (url: string) => {
    const res = await safeFetch(url, { timeoutMs: 60_000 });
    if (!res.ok) throw new Error(`image fetch ${res.status} ${url}`);
    if (!res.body) throw new Error(`image fetch ${url}: empty body`);
    return Readable.fromWeb(res.body);
  };
}
/* c8 ignore stop */

/** Render YAML frontmatter for an imported post. Status defaults to
 * `draft` so the operator can review before publishing. */
function renderFrontmatter(post: WpPost): string {
  const titleEsc = post.title.rendered.replace(/"/g, '\\"');
  const lines = [
    '---',
    `title: "${titleEsc}"`,
    `slug: ${post.slug}`,
    `date: ${post.date}`,
    'status: draft',
    `source_url: ${post.link}`,
    `source_kind: wordpress`,
    '---'
  ];
  return lines.join('\n');
}

// ---- figure collection + directive emission ---------------------------

interface FigureImage {
  imgNode: unknown;
  /** Largest available URL we found (from data-src / src + data-srcset). */
  masterUrl: string | null;
  alt: string;
  caption: string | null;
}

interface CollectedFigure {
  figureNode: unknown;
  /** `image` for a single-image figure, `gallery` for nested-images. */
  kind: 'image' | 'gallery';
  items: FigureImage[];
  /** Caption on the OUTER figure (for galleries). */
  outerCaption: string | null;
}

type HastNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
};

function collectFigures(tree: unknown): CollectedFigure[] {
  const out: CollectedFigure[] = [];
  walk(tree as HastNode, null);
  return out;

  function walk(node: HastNode, parentFig: CollectedFigure | null): void {
    if (node.type !== 'element') {
      for (const c of node.children ?? []) walk(c, parentFig);
      return;
    }
    if (node.tagName === 'figure' && hasClass(node, 'wp-block-gallery')) {
      const fig: CollectedFigure = {
        figureNode: node,
        kind: 'gallery',
        items: [],
        outerCaption: extractFigcaption(node, /* outermost */ true)
      };
      out.push(fig);
      // Walk children to find nested images.
      for (const c of node.children ?? []) walk(c, fig);
      return;
    }
    // Any other <figure> that contains an <img> is treated as an
    // image figure. This covers `wp-block-image` (Gutenberg) AND
    // older theme variants like `aligncenter size-large
    // wp-lightbox-container` AND any custom theme that wraps a
    // standalone image in a figure.
    if (node.tagName === 'figure' && findFirst(node, (n) => n.tagName === 'img')) {
      if (parentFig) {
        // Image inside a gallery — append to the parent's items.
        const item = imageItemFromFigure(node);
        if (item) parentFig.items.push(item);
        return;
      }
      const item = imageItemFromFigure(node);
      if (item) {
        out.push({
          figureNode: node,
          kind: 'image',
          items: [item],
          outerCaption: null
        });
      }
      return;
    }
    for (const c of node.children ?? []) walk(c, parentFig);
  }
}

function imageItemFromFigure(figure: HastNode): FigureImage | null {
  const img = findFirst(figure, (n) => n.tagName === 'img');
  if (!img) return null;
  const props = img.properties ?? {};
  const dataSrc = String(props.dataSrc ?? '');
  const src = String(props.src ?? '');
  const dataSrcset = String(props.dataSrcset ?? '');
  const srcset = String(props.srcset ?? '');
  const masterUrl = pickMasterUrl(dataSrc, src, dataSrcset, srcset);
  const alt = String(props.alt ?? '');
  const caption = extractFigcaption(figure, false);
  return { imgNode: img, masterUrl, alt, caption };
}

/** Pick the highest-resolution URL we can find. WP serves `<file>.jpg`
 * (master) at the un-suffixed path; if any URL has a `-WxH.jpg`
 * suffix, strip it. Falls back to the largest srcset entry. */
function pickMasterUrl(
  dataSrc: string,
  src: string,
  dataSrcset: string,
  srcset: string
): string | null {
  // Skip placeholder data: URLs.
  const real = (u: string): boolean => Boolean(u) && !u.startsWith('data:');
  // Largest srcset entry first.
  let best: string | null = null;
  for (const ss of [dataSrcset, srcset]) {
    if (!ss) continue;
    let bestW = 0;
    for (const part of ss.split(',')) {
      const m = part.trim().match(/^(\S+)\s+(\d+)w$/);
      if (m && Number(m[2]) > bestW) {
        bestW = Number(m[2]);
        best = m[1] as string;
      }
    }
    if (best) break;
  }
  if (!best && real(dataSrc)) best = dataSrc;
  if (!best && real(src)) best = src;
  if (!best) return null;
  // Strip WP's -WxH suffix to get the master.
  return best.replace(/-\d+x\d+(?=\.[A-Za-z]+$)/, '');
}

function directiveForFigure(fig: CollectedFigure, idsByImg: Map<unknown, string>): string {
  const ids: string[] = [];
  const alts: string[] = [];
  for (const item of fig.items) {
    const id = idsByImg.get(item.imgNode);
    if (id) {
      ids.push(id);
      alts.push(item.alt.replace(/,/g, ' '));
    }
  }
  if (ids.length === 0) return '<!-- import: figure had no resolvable images -->';

  const outerCaption = fig.outerCaption ?? fig.items[0]?.caption ?? null;
  const captionAttr = outerCaption ? ` caption="${escapeAttr(outerCaption)}"` : '';
  const altsAttr = alts.some((a) => a.length > 0) ? ` alts="${escapeAttr(alts.join(','))}"` : '';

  // Layout selection mirrors the legacy widget mapping so existing
  // visual expectations carry over:
  //   1 image  → no matrix (default 1x1)            ← legacy ::image
  //   2 images → matrix=1x2                          ← legacy ::diptych
  //   3 images → matrix=1x3                          ← legacy ::triptych
  //   4+       → matrix=justified                    ← legacy ::gallery{layout=justified}
  let matrixAttr: string;
  if (ids.length === 1) matrixAttr = '';
  else if (ids.length === 2) matrixAttr = ' matrix=1x2';
  else if (ids.length === 3) matrixAttr = ' matrix=1x3';
  else matrixAttr = ' matrix=justified';

  return `\n\n::figure{ids="${ids.join(',')}"${matrixAttr}${altsAttr}${captionAttr}}\n\n`;
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '\\"');
}

// ---- HAST tree utilities ----------------------------------------------

function hasClass(node: HastNode, cls: string): boolean {
  const props = node.properties ?? {};
  const className = props.className;
  if (Array.isArray(className)) return className.includes(cls);
  if (typeof className === 'string') return className.split(/\s+/).includes(cls);
  return false;
}

function findFirst(node: HastNode, pred: (n: HastNode) => boolean): HastNode | null {
  if (pred(node)) return node;
  for (const c of node.children ?? []) {
    const r = findFirst(c, pred);
    if (r) return r;
  }
  return null;
}

/** Decode + collapse a `<figcaption>`'s content to a plain string. */
function extractFigcaption(figure: HastNode, outermostOnly: boolean): string | null {
  // For galleries we want the OUTER figcaption (the gallery-level
  // caption), not the per-image ones. Walk only the immediate children.
  const candidates: HastNode[] = [];
  if (outermostOnly) {
    for (const c of figure.children ?? []) {
      if (c.type === 'element' && c.tagName === 'figcaption') candidates.push(c);
    }
  } else {
    const fc = findFirst(figure, (n) => n.tagName === 'figcaption');
    if (fc) candidates.push(fc);
  }
  if (candidates.length === 0) return null;
  return collectText(candidates[0] as HastNode).trim() || null;
}

function collectText(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  let out = '';
  for (const c of node.children ?? []) out += collectText(c);
  return out;
}

/** Replace a node in the tree with a single text node carrying raw
 * markdown. rehype-remark passes text through; the directive lines
 * end up in the output verbatim. */
function replaceWithRawMarkdown(tree: unknown, target: unknown, raw: string): void {
  // Walk to find the target's parent.
  walk(tree as HastNode);
  function walk(node: HastNode): boolean {
    const children = node.children;
    if (!children) return false;
    for (let i = 0; i < children.length; i++) {
      if (children[i] === target) {
        children[i] = { type: 'text', value: raw } as HastNode;
        return true;
      }
      if (walk(children[i] as HastNode)) return true;
    }
    return false;
  }
}

// ---- HAST → markdown emitter ------------------------------------------
// Block-level vocabulary covered: p, h1-h6, ul, ol, blockquote, hr,
// pre/code, br. Inline: a, strong, b, em, i, code, br. Anything else
// recurses through children. Raw text nodes (used to inject our
// directive lines) pass through verbatim.

function emitMarkdown(root: HastNode): string {
  return emitBlocks(root.children ?? []);
}

function emitBlocks(nodes: HastNode[]): string {
  const parts: string[] = [];
  for (const n of nodes) {
    const block = renderBlock(n);
    if (block) parts.push(block);
  }
  return parts.join('\n\n');
}

function renderBlock(node: HastNode): string {
  if (node.type === 'text') {
    // Top-level text — usually whitespace between blocks. Treat any
    // non-whitespace content as a paragraph.
    const v = (node.value ?? '').trim();
    return v;
  }
  if (node.type !== 'element') return '';
  const tag = node.tagName ?? '';
  const kids = node.children ?? [];
  switch (tag) {
    case 'p':
      return renderInline(kids).trim();
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const level = Number(tag.slice(1));
      return `${'#'.repeat(level)} ${renderInline(kids).trim()}`;
    }
    case 'hr':
      return '---';
    case 'br':
      return '';
    case 'blockquote':
      return emitBlocks(kids)
        .split('\n')
        .map((l) => (l.length > 0 ? `> ${l}` : '>'))
        .join('\n');
    case 'ul':
      return renderList(kids, /* ordered */ false);
    case 'ol':
      return renderList(kids, /* ordered */ true);
    case 'pre': {
      // <pre><code>...</code></pre> → fenced code block.
      const code = findFirst(node, (n) => n.tagName === 'code');
      const text = code ? collectText(code) : collectText(node);
      return `\`\`\`\n${text.replace(/\n+$/, '')}\n\`\`\``;
    }
    case 'figure':
      // Should already have been replaced with a directive marker by
      // collectFigures + replaceWithRawMarkdown. If a stray figure
      // survives (non-WP-block class), drop it with a comment.
      return '<!-- import: dropped non-WP figure -->';
    case 'div':
    case 'section':
    case 'article':
    case 'main':
      // Generic wrappers — recurse.
      return emitBlocks(kids);
    default:
      // Unknown block: try as inline; if there's nothing inside, drop.
      return renderInline(kids).trim();
  }
}

function renderList(items: HastNode[], ordered: boolean): string {
  const lines: string[] = [];
  let i = 1;
  for (const item of items) {
    if (item.type !== 'element' || item.tagName !== 'li') continue;
    const marker = ordered ? `${i}.` : '-';
    const inner = emitBlocks(item.children ?? []) || renderInline(item.children ?? []).trim();
    const indented = inner
      .split('\n')
      .map((l, idx) => (idx === 0 ? `${marker} ${l}` : `   ${l}`))
      .join('\n');
    lines.push(indented);
    i++;
  }
  return lines.join('\n');
}

function renderInline(nodes: HastNode[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') {
      out += n.value ?? '';
      continue;
    }
    if (n.type !== 'element') continue;
    const tag = n.tagName ?? '';
    const kids = n.children ?? [];
    switch (tag) {
      case 'strong':
      case 'b':
        out += `**${renderInline(kids)}**`;
        break;
      case 'em':
      case 'i':
        out += `*${renderInline(kids)}*`;
        break;
      case 'code':
        out += `\`${collectText(n)}\``;
        break;
      case 'br':
        out += '  \n';
        break;
      case 'a': {
        const href = String(n.properties?.href ?? '');
        const text = renderInline(kids);
        out += href ? `[${text}](${href})` : text;
        break;
      }
      case 'span':
      case 'small':
      case 'big':
        out += renderInline(kids);
        break;
      default:
        // Drop unknown inline tags but keep their text content.
        out += renderInline(kids);
    }
  }
  return out;
}
