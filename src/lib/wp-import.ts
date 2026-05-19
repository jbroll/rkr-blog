// WordPress import: walk a WpPost's HTML, ingest every <img> into the
// originals + sidecars trees, and emit one markdown file using the
// unified `::figure` directive (spec.md §9). Each WP <figure> block
// maps to a single ::figure with `matrix=` chosen by image count.
//
// REST client (listPosts / fetchPost) lives in lib/wp-rest.ts; the WpPost
// type lives in lib/wp-import-types.ts. Callers import directly from
// the right module — no convenience re-exports here.
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
import { collectText, emitMarkdown, findFirst } from './wp-import-emit.ts';
import type { HastNode, WpPost } from './wp-import-types.ts';

export interface ImportResult {
  /** Frontmatter + body, ready to write to content/posts/. */
  markdown: string;
  /** sha256 ids of every image ingested for this post (in source order),
   * including the banner image if one was provided. */
  imagesIngested: string[];
  /** Per-image fetch failures, by URL. Logged; the post still imports. */
  imageErrors: Array<{ url: string; error: string }>;
  /** The path `content/posts/<date>-<slug>.md` should be written to. */
  filename: string;
  /** Ingested id of the banner / featured image, if `opts.bannerUrl` was set. */
  bannerImageId?: string;
}

export interface ImportOpts {
  siteRoot: string;
  /** Override the image fetcher for tests. Default: SSRF-safe via
   * lib/url-safety.ts; image bytes streamed directly to ingestStream. */
  fetchImage?: (url: string) => Promise<Readable>;
  /** Cap on per-image bytes. Default 50 MB — original photos are
   * usually 5-15 MB; the cap stops a runaway from filling disk. */
  maxImageBytes?: number;
  /** URL of the post's banner / featured image. Ingested separately
   * from the body figures; its id lands in frontmatter as `banner:`. */
  bannerUrl?: string;
  /** Override tag-name resolver for tests. Given the WP tag IDs from
   * the post, returns an array of name strings. Default: fetches
   * /wp/v2/tags?include=<ids> from the post's origin. */
  fetchTagNames?: (tagIds: number[], postLink: string) => Promise<string[]>;
}

/** Import one post: walk its HTML, ingest every image, emit markdown. */
export async function importPost(post: WpPost, opts: ImportOpts): Promise<ImportResult> {
  const fetchImage = opts.fetchImage ?? defaultImageFetcher();
  const resolveTagNames = opts.fetchTagNames ?? defaultTagFetcher();
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
          // passthrough: bytes from the source WordPress blog land on
          // disk byte-identical. The source already served compressed
          // images (often JPEG through WP's media pipeline);
          // re-encoding them to WebP at ingest would be a generation-2
          // lossy step on archive content. Skip the resize + EXIF
          // orientation bake so the import truly mirrors the source.
          passthrough: true,
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

  // Ingest the featured / banner image (separate from body figures).
  let bannerImageId: string | undefined;
  if (opts.bannerUrl) {
    try {
      const stream = await fetchImage(opts.bannerUrl);
      const result = await ingestStream({
        stream,
        siteRoot: opts.siteRoot,
        passthrough: true,
        source: {
          kind: 'wordpress',
          url: opts.bannerUrl,
          originalName: filenameFromUrl(opts.bannerUrl),
          postUrl: post.link
        }
      });
      bannerImageId = result.id;
      imagesIngested.push(result.id);
    } catch (err) {
      imageErrors.push({ url: opts.bannerUrl, error: (err as Error).message });
    }
  }

  // Resolve tag IDs → names. A fetch failure is non-fatal: the post
  // imports without tags rather than failing entirely.
  let tagNames: string[] = [];
  if (post.tags && post.tags.length > 0) {
    try {
      tagNames = await resolveTagNames(post.tags, post.link);
    } catch {
      /* c8 ignore next -- fetch failures are non-fatal */
    }
  }

  const body = emitMarkdown(tree as HastNode).trim();
  const frontmatter = renderFrontmatter(post, tagNames);
  // Banner image leads the body as a ::figure directive so the author
  // can edit its attributes (justify, aspect, etc.) directly in markdown.
  // Default: full-bleed with a 3:1 crop so it reads as a page banner.
  const bannerDirective = bannerImageId
    ? `::figure{ids="${bannerImageId}" justify=bleed aspect=3:1}\n\n`
    : '';
  const markdown = `${frontmatter}\n\n${bannerDirective}${body}\n`;

  return {
    markdown,
    imagesIngested,
    imageErrors,
    filename: filenameFor(post),
    bannerImageId
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

/** Default WP tag resolver: fetches /wp/v2/tags?include=<ids> from the
 * same origin as `postLink` and maps each result to its `name` string. */
function defaultTagFetcher(): (tagIds: number[], postLink: string) => Promise<string[]> {
  return async (tagIds: number[], postLink: string) => {
    const origin = new URL(postLink).origin;
    const url = `${origin}/wp-json/wp/v2/tags?include=${tagIds.join(',')}&per_page=100`;
    const res = await safeFetch(url, { timeoutMs: 15_000 });
    if (!res.ok) throw new Error(`wp tags fetch ${res.status}`);
    const data = (await res.json()) as Array<{ name: string }>;
    return data.map((t) => t.name);
  };
}
/* c8 ignore stop */

/** Decode the small set of HTML entities WP stores in `title.rendered`.
 * Handles numeric (decimal + hex) codepoints and the named entities most
 * likely to appear in prose. An out-of-range or malformed numeric entity
 * is left literal rather than throwing (a bad WP import must not 500). */
function decodeHtmlEntities(s: string): string {
  const fromCp = (literal: string, raw: string, radix: number): string => {
    const cp = parseInt(raw, radix);
    if (!Number.isInteger(cp) || cp < 0 || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff)
      return literal;
    return String.fromCodePoint(cp);
  };
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (m: string, n: string) => fromCp(m, n, 16))
    .replace(/&#(\d+);/g, (m: string, n: string) => fromCp(m, n, 10))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

function yamlQuote(s: string): string {
  return `"${s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]/g, ' ')}"`;
}

/** Render YAML frontmatter for an imported post. Status defaults to
 * `draft` so the operator can review before publishing. */
function renderFrontmatter(post: WpPost, tagNames: string[] = []): string {
  const titleEsc = decodeHtmlEntities(post.title.rendered)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  const lines = [
    '---',
    `title: "${titleEsc}"`,
    `slug: ${yamlQuote(post.slug)}`,
    `date: ${yamlQuote(post.date)}`,
    'status: draft',
    `source_url: ${yamlQuote(post.link)}`,
    `source_kind: wordpress`
  ];
  if (tagNames.length > 0) {
    lines.push('tags:');
    for (const name of tagNames) lines.push(`- ${yamlQuote(name)}`);
  }
  lines.push('---');
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
    // Jetpack tiled gallery: outer wrapper is a <div>, not a <figure>.
    // Walk its subtree collecting all <figure.tiled-gallery__item> imgs.
    if (node.tagName === 'div' && hasClass(node, 'wp-block-jetpack-tiled-gallery')) {
      const fig: CollectedFigure = {
        figureNode: node,
        kind: 'gallery',
        items: [],
        outerCaption: null
      };
      out.push(fig);
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
  // rehype-parse normalizes the standard `srcset` HTML attribute to the
  // camelCase `srcSet` property name (matching React's DOM bindings).
  // The data-* form (`data-srcset`) is preserved verbatim as
  // `dataSrcset`. Reading the wrong key silently dropped srcset entirely,
  // so the picker fell through to the un-suffixed master URL — for a
  // WP image with EXIF orientation baked into a `-rotated.jpeg` srcset
  // entry, that meant fetching the unrotated raw file and rendering it
  // sideways. Fall back to the lowercase form too in case a future
  // parser swap shifts the casing again.
  const srcset = String(props.srcSet ?? props.srcset ?? '');
  const masterUrl = pickMasterUrl(dataSrc, src, dataSrcset, srcset);
  const alt = String(props.alt ?? '');
  const caption = extractFigcaption(figure, false);
  return { imgNode: img, masterUrl, alt, caption };
}

/** Pick the URL to fetch for this <img>. WP's srcset is the source of
 * truth: every entry there is already orientation-correct (WP rotates
 * thumbnails before saving them, and emits a `-rotated.jpeg` variant
 * for the full-size case). The previous behaviour stripped the
 * `-WxH` suffix off the chosen entry to "upgrade" to the master file,
 * but that master is exactly the file WP stripped EXIF Orientation
 * from — so the upgrade turned a known-correct URL into the one
 * sideways file in the bundle.
 *
 * Take the URL WP gave us. Fall back to dataSrc / src only when there
 * is no srcset at all (older WP themes that only emit a bare `src`);
 * there the strip is the only way to get above thumbnail resolution,
 * and orientation isn't relevant because those themes pre-date the
 * orientation-aware media pipeline. */
function pickMasterUrl(
  dataSrc: string,
  src: string,
  dataSrcset: string,
  srcset: string
): string | null {
  const real = (u: string): boolean => Boolean(u) && !u.startsWith('data:');
  // Largest srcset entry wins. WP picks the variant — we don't.
  for (const ss of [dataSrcset, srcset]) {
    if (!ss) continue;
    let bestW = 0;
    let best: string | null = null;
    for (const part of ss.split(',')) {
      const m = part.trim().match(/^(\S+)\s+(\d+)w$/);
      if (m && Number(m[2]) > bestW) {
        bestW = Number(m[2]);
        best = m[1] as string;
      }
    }
    if (best) return best;
  }
  // No srcset → legacy theme. Promote a bare `src` thumbnail to its
  // un-suffixed master so we don't ingest at 300px.
  const flat = real(dataSrc) ? dataSrc : real(src) ? src : null;
  if (!flat) return null;
  return flat.replace(/-\d+x\d+(?=\.[A-Za-z]+$)/, '');
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
