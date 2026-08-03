import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { installMockOpfs } from './opfs-mock.ts';

const { resetMockOpfs } = installMockOpfs();
beforeEach(() => resetMockOpfs());

const MARKDOWN = `## Heading

A paragraph.
`;

test('preview: renders a draft into the published page with no network call', async () => {
  const { renderPreviewDocument } = await import('../../src/admin/preview-page.ts');
  const origFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('preview must not fetch');
  }) as typeof fetch;
  try {
    const html = await renderPreviewDocument({
      slug: 'hello',
      title: 'Hello',
      markdown: MARKDOWN,
      snapshot: null
    });
    assert.match(html, /<h1>Hello/);
    assert.match(html, /<h2>Heading<\/h2>/);
    assert.match(html, /<p>A paragraph\.<\/p>/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('preview: omits the comment thread', async () => {
  const { renderPreviewDocument } = await import('../../src/admin/preview-page.ts');
  const html = await renderPreviewDocument({
    slug: 'hello',
    title: 'Hello',
    markdown: MARKDOWN,
    snapshot: null
  });
  assert.ok(!html.includes('rkr-comment-bubble'), 'no comment bubble');
  assert.ok(!html.includes('id="respond"'), 'no comment form');
});

test('preview: no site snapshot → default theme and the given title', async () => {
  const { renderPreviewDocument } = await import('../../src/admin/preview-page.ts');
  const html = await renderPreviewDocument({
    slug: 'hello',
    title: 'Hello',
    markdown: MARKDOWN,
    snapshot: null
  });
  assert.match(html, /\/admin\/static\/themes\/default\.css/);
  assert.ok(!html.includes('/themes/tufte.css'));
  assert.match(html, /<title>Hello — /);
});

test('preview: site snapshot supplies theme, build hash, and site title', async () => {
  const { renderPreviewDocument } = await import('../../src/admin/preview-page.ts');
  const html = await renderPreviewDocument({
    slug: 'hello',
    title: 'Hello',
    markdown: MARKDOWN,
    snapshot: { title: 'rkroll', tagline: 'tag', theme: 'tufte', hash: 'abcdef012345' }
  });
  assert.match(html, /\/admin\/static\/themes\/tufte\.css\?v=abcdef012345/);
  assert.match(html, /rkroll/);
});

/** The head + header of the admin shell the preview boots from, as
 * much of it as captureSiteSnapshot reads. */
function shellDocument(theme: string, hash: string): Document {
  const sheets = ['default', ...(theme === 'default' ? [] : [theme])].map((name) => ({
    getAttribute: () => `/admin/static/themes/${name}.css?v=${hash}`
  }));
  return {
    querySelector: (sel: string) =>
      sel === '.rkr-site-title a' ? { textContent: 'rkroll' } : null,
    querySelectorAll: () => sheets
  } as unknown as Document;
}

async function withDocument<T>(doc: Document, fn: () => Promise<T>): Promise<T> {
  const g = globalThis as { document?: Document };
  const orig = g.document;
  g.document = doc;
  try {
    return await fn();
  } finally {
    if (orig === undefined) delete g.document;
    else g.document = orig;
  }
}

test('preview: with no stored snapshot the live shell supplies theme, hash, and site title', async () => {
  const { renderPreviewDocument } = await import('../../src/admin/preview-page.ts');
  const html = await withDocument(shellDocument('tufte', 'deadbeef1234'), () =>
    renderPreviewDocument({ slug: 'hello', title: 'Hello', markdown: MARKDOWN, snapshot: null })
  );
  assert.match(html, /\/admin\/static\/themes\/tufte\.css\?v=deadbeef1234/);
  assert.ok(!html.includes('v=unknown'), 'no asset falls back to the unknown hash');
  assert.match(html, /rkroll/);
});

test('preview: the live shell beats a stale stored snapshot', async () => {
  const { renderPreviewDocument } = await import('../../src/admin/preview-page.ts');
  const html = await withDocument(shellDocument('default', 'newhash00000'), () =>
    renderPreviewDocument({
      slug: 'hello',
      title: 'Hello',
      markdown: MARKDOWN,
      snapshot: { title: 'rkroll', tagline: 'tag', theme: 'tufte', hash: 'oldhash00000' }
    })
  );
  assert.ok(!html.includes('oldhash00000'), 'stale hash not used');
  assert.ok(!html.includes('/themes/tufte.css'), 'stale theme not used');
  assert.match(html, /\/admin\/static\/base\.css\?v=newhash00000/);
  // Nothing in the shell's header carries the tagline when the site has
  // none rendered, so the stored value still fills it in.
  assert.match(html, /tag/);
});

test('preview: no public-page scripts are referenced', async () => {
  const { renderPreviewDocument } = await import('../../src/admin/preview-page.ts');
  const html = await renderPreviewDocument({
    slug: 'hello',
    title: 'Hello',
    markdown: MARKDOWN,
    snapshot: null
  });
  assert.ok(!html.includes('<script'), 'static preview loads no scripts');
});

test('preview: findMarkdown prefers the active draft when two metas claim one slug', async () => {
  const { findMarkdown } = await import('../../src/admin/preview-page.ts');
  const { writeJson } = await import('../../src/admin/opfs.ts');
  const { writeRoot } = await import('../../src/admin/opfs-schema.ts');

  const doc = (markdown: string) => ({
    type: 'doc' as const,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: markdown }] }]
  });

  // A stale pinned copy of the post...
  await writeJson('meta/stale-draft.json', {
    schemaVersion: 1,
    draftId: 'stale-draft',
    slug: 'hello',
    title: 'Stale title',
    lastAccessedAt: new Date().toISOString()
  });
  await writeJson('drafts/stale-draft.json', doc('stale body'));

  // ...and the in-progress local draft editing the same slug, which
  // the editor is actively pointed at.
  await writeJson('meta/active-draft.json', {
    schemaVersion: 1,
    draftId: 'active-draft',
    slug: 'hello',
    title: 'Active title',
    lastAccessedAt: new Date().toISOString()
  });
  await writeJson('drafts/active-draft.json', doc('active body'));

  await writeRoot({ schemaVersion: 1, deviceId: 'dev', currentDraftId: 'active-draft' });

  const found = await findMarkdown('hello');
  assert.equal(found?.title, 'Active title');
  assert.match(found?.markdown ?? '', /active body/);
});

test('preview: findMarkdown falls back to a scan when the active draft is on another slug', async () => {
  const { findMarkdown } = await import('../../src/admin/preview-page.ts');
  const { writeJson } = await import('../../src/admin/opfs.ts');
  const { writeRoot } = await import('../../src/admin/opfs-schema.ts');

  const doc = (markdown: string) => ({
    type: 'doc' as const,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: markdown }] }]
  });

  await writeJson('meta/other-slug-draft.json', {
    schemaVersion: 1,
    draftId: 'other-slug-draft',
    slug: 'goodbye',
    title: 'Unrelated',
    lastAccessedAt: new Date().toISOString()
  });
  await writeJson('drafts/other-slug-draft.json', doc('unrelated body'));

  await writeJson('meta/pinned-hello.json', {
    schemaVersion: 1,
    draftId: 'pinned-hello',
    slug: 'hello',
    title: 'Pinned title',
    lastAccessedAt: new Date().toISOString()
  });
  await writeJson('drafts/pinned-hello.json', doc('pinned body'));

  await writeRoot({ schemaVersion: 1, deviceId: 'dev', currentDraftId: 'other-slug-draft' });

  const found = await findMarkdown('hello');
  assert.equal(found?.title, 'Pinned title');
});

test('preview: findMarkdown falls back to the slug when the draft has an empty title', async () => {
  const { findMarkdown } = await import('../../src/admin/preview-page.ts');
  const { writeJson } = await import('../../src/admin/opfs.ts');

  await writeJson('meta/untitled-draft.json', {
    schemaVersion: 1,
    draftId: 'untitled-draft',
    slug: 'hello',
    title: '',
    lastAccessedAt: new Date().toISOString()
  });
  await writeJson('drafts/untitled-draft.json', {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }]
  });

  const found = await findMarkdown('hello');
  assert.equal(found?.title, 'hello');
});

test('preview: findMarkdown ignores _-prefixed meta-of-meta files', async () => {
  const { findMarkdown } = await import('../../src/admin/preview-page.ts');
  const { writeJson } = await import('../../src/admin/opfs.ts');

  await writeJson('meta/_site.json', { title: 'rkroll', theme: 'default', hash: 'abc' });

  const found = await findMarkdown('hello');
  assert.equal(found, null);
});
