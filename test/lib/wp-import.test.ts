// Coverage for the WP import pipeline. Drives importPost() against a
// synthetic post object and a stub image fetcher so the test doesn't
// depend on roll-along.rkroll.com being reachable.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';
import { parsePost } from '../../src/lib/content.ts';
import { importPost } from '../../src/lib/wp-import.ts';
import type { WpPost } from '../../src/lib/wp-import-types.ts';
import { fetchPost, listPosts } from '../../src/lib/wp-rest.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-wp-import-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'data', 'content/posts']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function makeJpegSized(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 50, g: 100, b: 200 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

/** Stub fetcher: returns a fresh JPEG buffer per URL so different URLs
 * map to different sha256 ids. The url's path becomes the seed so
 * deterministic-per-url. */
function stubFetcher(): (url: string) => Promise<Readable> {
  const buffers = new Map<string, Buffer>();
  return async (url: string) => {
    let buf = buffers.get(url);
    if (!buf) {
      // Cheap way to vary content per URL: encode the URL length in
      // the image dimensions so two URLs produce different sha256.
      const w = 100 + (url.length % 20);
      const h = 80 + (url.length % 17);
      buf = await makeJpegSized(w, h);
      buffers.set(url, buf);
    }
    return Readable.from([buf]);
  };
}

const POST_HTML_GALLERY = `
<p>Opening paragraph with <strong>bold</strong> and <em>italic</em> and a <a href="https://example.com">link</a>.</p>
<figure class="wp-block-gallery has-nested-images columns-default">
  <figure class="wp-block-image"><img data-src="https://example.com/wp-content/uploads/a-1024x768.jpg" alt="alpha"/></figure>
  <figure class="wp-block-image"><img data-src="https://example.com/wp-content/uploads/b-1024x768.jpg" alt="bravo"/></figure>
  <figure class="wp-block-image"><img data-src="https://example.com/wp-content/uploads/c-1024x768.jpg" alt=""/></figure>
  <figure class="wp-block-image"><img data-src="https://example.com/wp-content/uploads/d-1024x768.jpg" alt=""/></figure>
</figure>
<p>Closing paragraph.</p>
`;

const POST_HTML_SINGLE = `
<p>One image follows.</p>
<figure class="wp-block-image"><img data-src="https://example.com/wp-content/uploads/x-800x600.jpg" alt="solo"/><figcaption>The caption</figcaption></figure>
`;

const POST_HTML_DIPTYCH = `
<figure class="wp-block-gallery">
  <figure class="wp-block-image"><img data-src="https://example.com/wp-content/uploads/a.jpg" alt=""/></figure>
  <figure class="wp-block-image"><img data-src="https://example.com/wp-content/uploads/b.jpg" alt=""/></figure>
</figure>
`;

const POST_HTML_TRIPTYCH = `
<figure class="wp-block-gallery">
  <figure class="wp-block-image"><img data-src="https://example.com/wp-content/uploads/a.jpg"/></figure>
  <figure class="wp-block-image"><img data-src="https://example.com/wp-content/uploads/b.jpg"/></figure>
  <figure class="wp-block-image"><img data-src="https://example.com/wp-content/uploads/c.jpg"/></figure>
</figure>
`;

const POST_HTML_LEGACY = `
<p>Older theme variant: figure with no wp-block-image class.</p>
<figure class="aligncenter size-large wp-lightbox-container">
  <img src="https://example.com/wp-content/uploads/legacy.jpg" alt="legacy"/>
  <figcaption>Older WP block</figcaption>
</figure>
`;

function makePost(content: string, slug = 'test-post'): WpPost {
  return {
    id: 1,
    date: '2026-05-07T12:00:00',
    modified: '2026-05-07T12:00:00',
    slug,
    status: 'publish',
    title: { rendered: 'Test Post' },
    content: { rendered: content },
    excerpt: { rendered: '' },
    link: 'https://example.com/test-post/'
  };
}

test('importPost: gallery of 4 → ::figure matrix=justified with 4 ids', async (t) => {
  const root = freshSiteRoot(t);
  const result = await importPost(makePost(POST_HTML_GALLERY), {
    siteRoot: root,
    fetchImage: stubFetcher()
  });
  assert.equal(result.imagesIngested.length, 4);
  assert.equal(result.imageErrors.length, 0);
  assert.match(result.markdown, /^---\n/);
  // 4+ images map to matrix=justified per the importer's mapping.
  assert.match(result.markdown, /::figure\{ids="[0-9a-f,]+" matrix=justified/);
  // Prose around the directive is preserved.
  assert.match(result.markdown, /Opening paragraph with \*\*bold\*\* and \*italic\*/);
  assert.match(result.markdown, /Closing paragraph\./);
  // The directive's id list contains the 4 ids in source order.
  const m = /ids="([0-9a-f,]+)"/.exec(result.markdown);
  assert.ok(m);
  const ids = (m as RegExpMatchArray)[1]?.split(',') ?? [];
  assert.deepEqual(ids, result.imagesIngested);
});

test('importPost: standalone figure → ::figure (1 id, default 1x1)', async (t) => {
  const root = freshSiteRoot(t);
  const result = await importPost(makePost(POST_HTML_SINGLE), {
    siteRoot: root,
    fetchImage: stubFetcher()
  });
  assert.equal(result.imagesIngested.length, 1);
  // Single id → no matrix attribute (defaults to 1x1). Single alt
  // still goes through `alts=` since the unified directive uses a
  // parallel-array model.
  assert.match(result.markdown, /::figure\{ids="[0-9a-f]{64}" alts="solo" caption="The caption"\}/);
});

test('importPost: 2-image figure → ::figure matrix=1x2', async (t) => {
  const root = freshSiteRoot(t);
  const result = await importPost(makePost(POST_HTML_DIPTYCH), {
    siteRoot: root,
    fetchImage: stubFetcher()
  });
  assert.equal(result.imagesIngested.length, 2);
  assert.match(result.markdown, /::figure\{ids="[0-9a-f]{64},[0-9a-f]{64}" matrix=1x2/);
});

test('importPost: 3-image figure → ::figure matrix=1x3', async (t) => {
  const root = freshSiteRoot(t);
  const result = await importPost(makePost(POST_HTML_TRIPTYCH), {
    siteRoot: root,
    fetchImage: stubFetcher()
  });
  assert.equal(result.imagesIngested.length, 3);
  assert.match(
    result.markdown,
    /::figure\{ids="[0-9a-f]{64},[0-9a-f]{64},[0-9a-f]{64}" matrix=1x3/
  );
});

test('importPost: legacy theme figure (no wp-block-image class) still ingests', async (t) => {
  // Older WP themes use class="aligncenter size-large
  // wp-lightbox-container" without the `wp-block-image` token. We
  // accept any <figure> containing an <img>.
  const root = freshSiteRoot(t);
  const result = await importPost(makePost(POST_HTML_LEGACY), {
    siteRoot: root,
    fetchImage: stubFetcher()
  });
  assert.equal(result.imagesIngested.length, 1);
  assert.match(
    result.markdown,
    /::figure\{ids="[0-9a-f]{64}" alts="legacy" caption="Older WP block"/
  );
  assert.doesNotMatch(result.markdown, /dropped non-WP figure/);
});

// Regression: WP serves a srcset with a `-rotated.jpeg` entry for
// images whose EXIF orientation has been baked into a separate file.
// The unrotated master + the `-WxH` thumbnails are derived from the
// raw landscape pixels; the `-rotated.jpeg` is the portrait result of
// applying the EXIF rotation. Picking the un-suffixed master fetches
// the unrotated landscape — so the post renders the photo sideways.
// rehype-parse exposes the `srcset` HTML attribute as `props.srcSet`
// (camelCase, matching React's DOM binding), but wp-import was
// reading `props.srcset` — empty → the picker fell through to the
// `src` attribute and stripped its `-WxH` suffix to land on the
// unrotated master. Read `srcSet` so the largest srcset entry wins,
// which in this scenario is the rotated portrait variant.
// Stripping the `-WxH` suffix off a srcset entry to "upgrade" to the
// un-suffixed master defeats WP's orientation handling: WP rotates the
// thumbnails before saving them, but strips EXIF Orientation from the
// master during compress, so the stripped URL is the one sideways file
// in the bundle. A srcset with only `-WxH` entries (no -rotated
// variant) must therefore land on the largest thumbnail verbatim.
test('importPost: uses the largest srcset entry verbatim (no -WxH strip)', async (t) => {
  const root = freshSiteRoot(t);
  const seenUrls: string[] = [];
  const wrappedFetcher = async (url: string): Promise<Readable> => {
    seenUrls.push(url);
    return stubFetcher()(url);
  };
  const html = `
<figure class="wp-block-image">
  <img src="https://example.com/wp-content/uploads/foo-150x150.jpeg"
       srcset="https://example.com/wp-content/uploads/foo-300x400.jpeg 300w,
               https://example.com/wp-content/uploads/foo-768x1024.jpeg 768w,
               https://example.com/wp-content/uploads/foo-1536x2048.jpeg 1536w"
       alt="portrait"/>
</figure>`;
  await importPost(makePost(html), { siteRoot: root, fetchImage: wrappedFetcher });
  assert.deepEqual(seenUrls, ['https://example.com/wp-content/uploads/foo-1536x2048.jpeg']);
});

test('importPost: prefers the rotated srcset entry over the unrotated master', async (t) => {
  const root = freshSiteRoot(t);
  const seenUrls: string[] = [];
  const fetcher = stubFetcher();
  const wrappedFetcher = async (url: string): Promise<Readable> => {
    seenUrls.push(url);
    return fetcher(url);
  };
  // Single <figure> with the WP-style srcset that includes a
  // `-rotated.jpeg` entry at the largest width. The `src` attribute
  // points at a sized thumbnail to match what WP actually serves.
  const html = `
<figure class="wp-block-image">
  <img src="https://example.com/wp-content/uploads/foo-768x1024.jpeg"
       srcset="https://example.com/wp-content/uploads/foo-768x1024.jpeg 768w,
               https://example.com/wp-content/uploads/foo-1536x2048.jpeg 1536w,
               https://example.com/wp-content/uploads/foo-rotated.jpeg 1701w"
       alt="rotated portrait"/>
</figure>`;
  await importPost(makePost(html), {
    siteRoot: root,
    fetchImage: wrappedFetcher
  });
  assert.deepEqual(seenUrls, ['https://example.com/wp-content/uploads/foo-rotated.jpeg']);
});

test('importPost: master URL is fetched (WP -WxH suffix stripped)', async (t) => {
  // The figure has data-src=...-1024x768.jpg; pickMasterUrl should
  // strip the suffix and fetch the un-suffixed master.
  const root = freshSiteRoot(t);
  const seenUrls: string[] = [];
  const fetcher = stubFetcher();
  const wrappedFetcher = async (url: string): Promise<Readable> => {
    seenUrls.push(url);
    return fetcher(url);
  };
  await importPost(makePost(POST_HTML_GALLERY), {
    siteRoot: root,
    fetchImage: wrappedFetcher
  });
  // No URL should still carry the -WxH suffix.
  for (const url of seenUrls) {
    assert.doesNotMatch(
      url,
      /-\d+x\d+\.[a-z]+$/,
      `${url} should be the master, not a sized variant`
    );
  }
});

test('importPost: imported markdown round-trips through parsePost', async (t) => {
  const root = freshSiteRoot(t);
  const result = await importPost(makePost(POST_HTML_GALLERY), {
    siteRoot: root,
    fetchImage: stubFetcher()
  });
  const parsed = parsePost(result.markdown);
  assert.equal(parsed.frontmatter.slug, 'test-post');
  assert.equal(parsed.frontmatter.status, 'draft');
  assert.equal(parsed.frontmatter.source_kind, 'wordpress');
  // The ::figure directive should be in the AST as a leafDirective.
  const directives = parsed.ast.children.filter((n) => n.type === 'leafDirective');
  assert.equal(directives.length, 1);
  assert.equal((directives[0] as unknown as { name: string }).name, 'figure');
});

test('importPost: image fetch failures are reported, post still imports', async (t) => {
  const root = freshSiteRoot(t);
  const failingFetcher = async (_url: string): Promise<Readable> => {
    throw new Error('simulated network failure');
  };
  const result = await importPost(makePost(POST_HTML_SINGLE), {
    siteRoot: root,
    fetchImage: failingFetcher
  });
  assert.equal(result.imagesIngested.length, 0);
  assert.equal(result.imageErrors.length, 1);
  assert.match(result.imageErrors[0]?.error ?? '', /simulated network failure/);
  // Markdown still emitted; the failed figure becomes a placeholder
  // comment so the operator sees the gap.
  assert.match(result.markdown, /import: figure had no resolvable images/);
});

// ---- inline HTML rendering paths --------------------------------------

test('importPost: renders <pre>, <div>, <section>, stray <figure>, unknown block', async (t) => {
  const root = freshSiteRoot(t);
  const html = `
<pre><code>fenced code</code></pre>
<div><p>div-wrapped paragraph</p></div>
<section><p>section-wrapped paragraph</p></section>
<figure class="text-only-figure">just a caption, no image</figure>
<aside>aside text</aside>
`;
  const result = await importPost(makePost(html, 'block-html'), {
    siteRoot: root,
    fetchImage: stubFetcher()
  });
  // Fenced code block.
  assert.match(result.markdown, /```\nfenced code\n```/);
  // Generic wrappers recurse so inner paragraphs survive.
  assert.match(result.markdown, /div-wrapped paragraph/);
  assert.match(result.markdown, /section-wrapped paragraph/);
  // Stray figure (no wp-block-image class chain) → comment placeholder.
  assert.match(result.markdown, /<!-- import: dropped non-WP figure -->/);
  // Unknown block tag (<aside>) → falls through to inline rendering.
  assert.match(result.markdown, /aside text/);
});

test('importPost: renders <h1>-<h6>, <hr>, top-level <br>, <blockquote>', async (t) => {
  const root = freshSiteRoot(t);
  const html = `
<h1>One</h1>
<h2>Two</h2>
<h3>Three</h3>
<h4>Four</h4>
<h5>Five</h5>
<h6>Six</h6>
<hr/>
<br/>
<blockquote>
  <p>quoted line one</p>
  <p>quoted line two</p>
</blockquote>
`;
  const result = await importPost(makePost(html, 'block-vocab'), {
    siteRoot: root,
    fetchImage: stubFetcher()
  });
  // Heading levels map to # repetitions.
  assert.match(result.markdown, /^# One$/m);
  assert.match(result.markdown, /^## Two$/m);
  assert.match(result.markdown, /^### Three$/m);
  assert.match(result.markdown, /^#### Four$/m);
  assert.match(result.markdown, /^##### Five$/m);
  assert.match(result.markdown, /^###### Six$/m);
  // <hr/> → markdown rule.
  assert.match(result.markdown, /^---$/m);
  // <blockquote> wraps inner blocks with `> ` prefix.
  assert.match(result.markdown, /^> quoted line one$/m);
  assert.match(result.markdown, /^> quoted line two$/m);
});

test('importPost: renders <ol>/<ul>, <code>, <br>, <span> in body markdown', async (t) => {
  const root = freshSiteRoot(t);
  const html = `
<p>Para with <code>inline()</code> and a <br/>break and <span>span text</span> and <foo>unknown tag</foo>.</p>
<ol><li>first</li><li>second</li></ol>
<ul><li>alpha</li><li>bravo</li></ul>
`;
  const result = await importPost(makePost(html, 'inline-html'), {
    siteRoot: root,
    fetchImage: stubFetcher()
  });
  // Backtick code, hard-break (two spaces + newline), span unwraps to text,
  // unknown tag's text content survives.
  assert.match(result.markdown, /`inline\(\)`/);
  assert.match(result.markdown, / {2}\n/); // <br> emits trailing two-space + newline
  assert.match(result.markdown, /span text/);
  assert.match(result.markdown, /unknown tag/);
  // Ordered list: numbered prefix; unordered list: dash prefix.
  assert.match(result.markdown, /1\. first/);
  assert.match(result.markdown, /2\. second/);
  assert.match(result.markdown, /- alpha/);
  assert.match(result.markdown, /- bravo/);
});

// ---- listPosts / fetchPost via injected fetcher -----------------------

async function startWpListFixture(
  t: TestContext,
  posts: WpPost[]
): Promise<{ baseUrl: string; calls: string[] }> {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url ?? '');
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/wp-json/wp/v2/posts') {
      const slug = url.searchParams.get('slug');
      if (slug) {
        const found = posts.filter((p) => p.slug === slug);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(found));
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'X-WP-Total': String(posts.length),
        'X-WP-TotalPages': '1'
      });
      res.end(JSON.stringify(posts));
      return;
    }
    const numMatch = /^\/wp-json\/wp\/v2\/posts\/(\d+)$/.exec(url.pathname);
    if (numMatch) {
      const id = Number(numMatch[1]);
      const post = posts.find((p) => p.id === id);
      if (!post) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(post));
      return;
    }
    res.writeHead(404);
    res.end('unknown');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

test('listPosts: returns posts + reads X-WP-Total/X-WP-TotalPages headers', async (t) => {
  const { baseUrl } = await startWpListFixture(t, [
    makePost('<p>a</p>', 'a'),
    makePost('<p>b</p>', 'b')
  ]);
  const result = await listPosts(baseUrl, { perPage: 50, page: 1 }, fetch);
  assert.equal(result.posts.length, 2);
  assert.equal(result.total, 2);
  assert.equal(result.totalPages, 1);
});

test('listPosts: clamps perPage and uses defaults', async (t) => {
  const { baseUrl, calls } = await startWpListFixture(t, []);
  // perPage 9999 → capped at 100; page omitted → defaults to 1.
  await listPosts(baseUrl, { perPage: 9999 }, fetch);
  const reqUrl = calls[0] ?? '';
  assert.match(reqUrl, /per_page=100/);
  assert.match(reqUrl, /page=1/);
  assert.match(reqUrl, /status=publish/);
});

test('listPosts: 5xx → throws with status + URL', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(503);
    res.end('upstream wedged');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await assert.rejects(() => listPosts(baseUrl, {}, fetch), /WP listPosts: 503/);
});

test('fetchPost: numeric id resolves via /posts/<id>', async (t) => {
  const post = makePost('<p>numeric</p>', 'numeric-post');
  const { baseUrl } = await startWpListFixture(t, [post]);
  const got = await fetchPost(baseUrl, post.id, fetch);
  assert.equal(got.slug, 'numeric-post');
});

test('fetchPost: numeric-string id is treated as id (not slug)', async (t) => {
  const post = makePost('<p>str-num</p>', 'str-numeric');
  const { baseUrl, calls } = await startWpListFixture(t, [post]);
  const got = await fetchPost(baseUrl, '1', fetch);
  assert.equal(got.slug, 'str-numeric');
  assert.match(calls[0] ?? '', /\/posts\/1$/);
});

test('fetchPost: slug path returns first match', async (t) => {
  const post = makePost('<p>slug-x</p>', 'slug-x');
  const { baseUrl } = await startWpListFixture(t, [post]);
  const got = await fetchPost(baseUrl, 'slug-x', fetch);
  assert.equal(got.id, post.id);
});

test('fetchPost: numeric id 5xx → throws', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(503);
    res.end('upstream');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await assert.rejects(() => fetchPost(baseUrl, 99, fetch), /WP fetchPost: 503/);
});

test('fetchPost: slug 5xx → throws', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(502);
    res.end('upstream');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await assert.rejects(() => fetchPost(baseUrl, 'no-such', fetch), /WP fetchPost: 502/);
});

test('fetchPost: slug returns empty array → throws "no post"', async (t) => {
  const { baseUrl } = await startWpListFixture(t, []);
  await assert.rejects(() => fetchPost(baseUrl, 'missing', fetch), /no post with slug "missing"/);
});

test('listPosts: trailing slash on base URL is normalised', async (t) => {
  const { baseUrl, calls } = await startWpListFixture(t, []);
  await listPosts(`${baseUrl}/`, {}, fetch);
  // The server only sees the path; we verify by checking it didn't 404.
  assert.match(calls[0] ?? '', /^\/wp-json\/wp\/v2\/posts\?/);
});

test('importPost: dedupes byte-identical images across figures', async (t) => {
  const root = freshSiteRoot(t);
  // Use a fetcher that returns the SAME bytes for every URL.
  const sameBytes = await makeJpegSized(50, 50);
  const fetcher = async (_url: string): Promise<Readable> => Readable.from([sameBytes]);
  const result = await importPost(makePost(POST_HTML_GALLERY), {
    siteRoot: root,
    fetchImage: fetcher
  });
  // 4 figures, but all with identical bytes → ingestStream dedupes
  // → exactly 1 unique id, but the imagesIngested array still has
  // 4 entries (one per figure, all the same id).
  assert.equal(result.imagesIngested.length, 4);
  assert.equal(new Set(result.imagesIngested).size, 1);
  // Sidecar and original directories have exactly 1 entry.
  const sidecarFiles = fs.readdirSync(path.join(root, 'sidecars'));
  assert.equal(sidecarFiles.length, 1);
});
