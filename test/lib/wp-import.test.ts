// Coverage for the WP import pipeline. Drives importPost() against a
// synthetic post object and a stub image fetcher so the test doesn't
// depend on roll-along.rkroll.com being reachable.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { parsePost } from '../../src/lib/content.ts';
import { importPost, type WpPost } from '../../src/lib/wp-import.ts';

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
