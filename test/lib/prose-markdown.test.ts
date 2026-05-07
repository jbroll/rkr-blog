import assert from 'node:assert/strict';
import { test } from 'node:test';

import { markdownToProse, type ProseDoc, proseToMarkdown } from '../../src/lib/prose-markdown.ts';

function paragraph(...texts: string[]): {
  type: string;
  content: { type: string; text: string }[];
} {
  return {
    type: 'paragraph',
    content: texts.map((t) => ({ type: 'text', text: t }))
  };
}

test('proseToMarkdown: code mark serializes to inline backticks', () => {
  const doc: ProseDoc = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'use ' },
          { type: 'text', text: 'foo()', marks: [{ type: 'code' }] }
        ]
      }
    ]
  };
  assert.match(proseToMarkdown(doc), /use `foo\(\)`/);
});

test('proseToMarkdown: paragraph with bold/italic/link/code marks', () => {
  const doc: ProseDoc = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' and ' },
          { type: 'text', text: 'italic', marks: [{ type: 'italic' }] },
          { type: 'text', text: ' and ' },
          {
            type: 'text',
            text: 'link',
            marks: [{ type: 'link', attrs: { href: 'https://example.com' } }]
          },
          { type: 'text', text: ' end.' }
        ]
      }
    ]
  };
  const md = proseToMarkdown(doc);
  assert.match(md, /Hello \*\*bold\*\* and \*italic\* and \[link\]\(https:\/\/example.com\) end\./);
});

test('proseToMarkdown: heading and image directive', () => {
  const doc: ProseDoc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'A heading' }] },
      { type: 'image', attrs: { id: 'abc123', alt: 'a picture' } }
    ]
  };
  const md = proseToMarkdown(doc);
  assert.match(md, /## A heading/);
  assert.match(md, /::image\{#abc123 alt="a picture"\}/);
});

test('markdownToProse: paragraph + heading + image directive', () => {
  const md = `Para with **bold** and *em*.\n\n## A heading\n\n::image{#abc123 alt="picture"}\n`;
  const doc = markdownToProse(md);
  assert.equal(doc.type, 'doc');

  const p = doc.content[0]!;
  assert.equal(p.type, 'paragraph');
  // The paragraph contains: "Para with ", strong(bold), " and ", em(em), "."
  const texts = (p.content ?? []).map((n) => ({
    text: n.text,
    marks: n.marks?.map((m) => m.type) ?? []
  }));
  assert.ok(texts.some((t) => t.text === 'bold' && t.marks.includes('bold')));
  assert.ok(texts.some((t) => t.text === 'em' && t.marks.includes('italic')));

  const h = doc.content[1]!;
  assert.equal(h.type, 'heading');
  assert.equal(h.attrs?.level, 2);

  const img = doc.content[2]!;
  assert.equal(img.type, 'image');
  assert.equal(img.attrs?.id, 'abc123');
  assert.equal(img.attrs?.alt, 'picture');
});

test('proseToMarkdown: image with caption and position emits all three attrs', () => {
  const doc: ProseDoc = {
    type: 'doc',
    content: [
      {
        type: 'image',
        attrs: {
          id: 'abc123',
          alt: 'a picture',
          caption: 'Workbench at dusk',
          position: 'right'
        }
      }
    ]
  };
  const md = proseToMarkdown(doc);
  assert.match(md, /::image\{#abc123 alt="a picture" caption="Workbench at dusk" position=right\}/);
});

test('proseToMarkdown: image with default position omits the position attribute', () => {
  const doc: ProseDoc = {
    type: 'doc',
    content: [{ type: 'image', attrs: { id: 'abc123', alt: 'x', position: 'default' } }]
  };
  const md = proseToMarkdown(doc);
  assert.equal(md.includes('position='), false);
});

test('proseToMarkdown: image with empty caption omits the caption attribute', () => {
  const doc: ProseDoc = {
    type: 'doc',
    content: [{ type: 'image', attrs: { id: 'abc123', alt: 'x', caption: '' } }]
  };
  const md = proseToMarkdown(doc);
  assert.equal(md.includes('caption='), false);
});

test('markdownToProse: image directive carries caption and position into prose attrs', () => {
  const md = '::image{#abc123 alt="picture" caption="A workbench" position=full}\n';
  const doc = markdownToProse(md);
  const img = doc.content[0]!;
  assert.equal(img.type, 'image');
  assert.equal(img.attrs?.caption, 'A workbench');
  assert.equal(img.attrs?.position, 'full');
});

test('markdownToProse: image without caption/position fills defaults', () => {
  // Bare ::image{#id alt=…} should still produce a node with caption='' and position='default'
  // so the editor's attribute panel always has values to bind.
  const md = '::image{#abc123 alt="x"}\n';
  const doc = markdownToProse(md);
  const img = doc.content[0]!;
  assert.equal(img.attrs?.caption, '');
  assert.equal(img.attrs?.position, 'default');
});

// ---- multi-image directives (gallery / carousel / diptych / triptych) ----

test('proseToMarkdown: gallery directive emits ids + layout + caption', () => {
  const doc: ProseDoc = {
    type: 'doc',
    content: [
      {
        type: 'gallery',
        attrs: { ids: 'abc,def,012', layout: 'masonry', caption: 'Workbench shots' }
      }
    ]
  };
  const md = proseToMarkdown(doc);
  assert.match(md, /::gallery\{ids="abc,def,012" layout=masonry caption="Workbench shots"\}/);
});

test('proseToMarkdown: gallery with default layout (justified) omits the layout attr', () => {
  const doc: ProseDoc = {
    type: 'doc',
    content: [{ type: 'gallery', attrs: { ids: 'a,b', layout: 'justified' } }]
  };
  const md = proseToMarkdown(doc);
  assert.equal(md.includes('layout='), false);
});

test('proseToMarkdown: carousel emits autoplay only when > 0', () => {
  const off: ProseDoc = {
    type: 'doc',
    content: [{ type: 'carousel', attrs: { ids: 'a,b', autoplay: 0 } }]
  };
  assert.equal(proseToMarkdown(off).includes('autoplay='), false);

  const on: ProseDoc = {
    type: 'doc',
    content: [{ type: 'carousel', attrs: { ids: 'a,b', autoplay: 5 } }]
  };
  assert.match(proseToMarkdown(on), /::carousel\{ids="a,b" autoplay=5\}/);
});

test('proseToMarkdown: diptych and triptych emit only ids + caption', () => {
  const di: ProseDoc = {
    type: 'doc',
    content: [{ type: 'diptych', attrs: { ids: 'a,b', caption: 'Before / after' } }]
  };
  assert.match(proseToMarkdown(di), /::diptych\{ids="a,b" caption="Before \/ after"\}/);

  const tri: ProseDoc = {
    type: 'doc',
    content: [{ type: 'triptych', attrs: { ids: 'a,b,c' } }]
  };
  assert.match(proseToMarkdown(tri), /::triptych\{ids="a,b,c"\}/);
});

test('proseToMarkdown: multi-image with empty ids drops the node silently', () => {
  const doc: ProseDoc = { type: 'doc', content: [{ type: 'gallery', attrs: { ids: '' } }] };
  assert.equal(proseToMarkdown(doc).includes('::gallery'), false);
});

test('proseToMarkdown: ids can be supplied as an array (joined to comma string)', () => {
  // Editor may store ids as a JSON array in some flows; accept it.
  const doc: ProseDoc = {
    type: 'doc',
    content: [{ type: 'gallery', attrs: { ids: ['a', 'b', 'c'] } }]
  };
  assert.match(proseToMarkdown(doc), /ids="a,b,c"/);
});

test('markdownToProse: gallery directive becomes a gallery prose node with all attrs', () => {
  const md = '::gallery{ids="abc,def" layout=masonry caption="Two shots"}\n';
  const doc = markdownToProse(md);
  const g = doc.content[0]!;
  assert.equal(g.type, 'gallery');
  assert.equal(g.attrs?.ids, 'abc,def');
  assert.equal(g.attrs?.layout, 'masonry');
  assert.equal(g.attrs?.caption, 'Two shots');
});

test('markdownToProse: gallery without layout fills layout="justified" default', () => {
  const md = '::gallery{ids="abc,def"}\n';
  const doc = markdownToProse(md);
  assert.equal(doc.content[0]?.attrs?.layout, 'justified');
});

test('markdownToProse: carousel autoplay parses to a number', () => {
  const md = '::carousel{ids="a,b" autoplay=5}\n';
  const doc = markdownToProse(md);
  assert.equal(doc.content[0]?.attrs?.autoplay, 5);
});

test('markdownToProse: diptych and triptych become typed prose nodes', () => {
  const md = '::diptych{ids="a,b"}\n\n::triptych{ids="a,b,c"}\n';
  const doc = markdownToProse(md);
  assert.equal(doc.content[0]?.type, 'diptych');
  assert.equal(doc.content[1]?.type, 'triptych');
});

// ---- round-trip identity (markdown → prose → markdown) ------------------
// These guard against drift between the two converters: when one side
// learns a new attribute the other will silently lose it.

test('round-trip identity: image directive with caption + position', () => {
  const md = '::image{#abc123 alt="x" caption="A caption" position=full}\n';
  const back = proseToMarkdown(markdownToProse(md));
  assert.equal(back.trim(), md.trim());
});

test('round-trip identity: gallery directive with non-default layout + caption', () => {
  const md = '::gallery{ids="abc,def" layout=masonry caption="Two shots"}\n';
  const back = proseToMarkdown(markdownToProse(md));
  assert.equal(back.trim(), md.trim());
});

test('round-trip identity: carousel directive with autoplay + caption', () => {
  const md = '::carousel{ids="a,b,c" autoplay=5 caption="Slideshow"}\n';
  const back = proseToMarkdown(markdownToProse(md));
  assert.equal(back.trim(), md.trim());
});

test('round-trip identity: diptych and triptych preserve ids + caption', () => {
  const di = '::diptych{ids="a,b" caption="Pair"}\n';
  assert.equal(proseToMarkdown(markdownToProse(di)).trim(), di.trim());

  const tri = '::triptych{ids="a,b,c"}\n';
  assert.equal(proseToMarkdown(markdownToProse(tri)).trim(), tri.trim());
});

test('proseToMarkdown: drops image directives whose id is not 6-64 hex', () => {
  // Defends against a forged ProseMirror JSON body submitted via
  // POST /admin/posts that smuggles directive syntax through the id
  // attribute (e.g. `id="abc} ::shell{cmd=…`). The editor never
  // authors non-hex ids, but emit-side validation matches the same
  // shape check the multi-image emit and the public-side renderer use.
  const cases: ProseDoc[] = [
    { type: 'doc', content: [{ type: 'image', attrs: { id: 'too-short', alt: '' } }] },
    { type: 'doc', content: [{ type: 'image', attrs: { id: 'NOT_HEX!@#', alt: '' } }] },
    { type: 'doc', content: [{ type: 'image', attrs: { id: 'ABC123', alt: '' } }] }, // uppercase hex isn't accepted
    { type: 'doc', content: [{ type: 'image', attrs: { id: '} ::shell{', alt: '' } }] }
  ];
  for (const doc of cases) {
    const md = proseToMarkdown(doc);
    assert.equal(md.includes('::image'), false, `should drop ${JSON.stringify(doc.content[0])}`);
  }
});

test('proseToMarkdown: invalid image position values are silently dropped', () => {
  // The widget on the public side coerces unknown positions back to
  // 'default' (src/widgets/image.ts extractPosition). Without validation
  // here, a stale/forged prose doc could round-trip `position=foo` into
  // markdown and break round-trip identity vs the rendered HTML.
  const doc: ProseDoc = {
    type: 'doc',
    content: [{ type: 'image', attrs: { id: 'abc', alt: '', position: 'something-bogus' } }]
  };
  const md = proseToMarkdown(doc);
  assert.equal(md.includes('position='), false);
});

test('proseToMarkdown: carousel autoplay is capped at 60 to match the public renderer', () => {
  // src/widgets/carousel.ts caps autoplay at 60. Without clamping here,
  // the editor could store autoplay=999, emit it verbatim, and the
  // public side would silently render data-autoplay=60 — breaking
  // round-trip identity (markdown→prose→markdown wouldn't be stable).
  const doc: ProseDoc = {
    type: 'doc',
    content: [{ type: 'carousel', attrs: { ids: 'a,b', autoplay: 999 } }]
  };
  const md = proseToMarkdown(doc);
  assert.match(md, /autoplay=60/);
  assert.equal(md.includes('autoplay=999'), false);
});

test('round-trip: prose → markdown → prose preserves structure on a representative doc', () => {
  const original: ProseDoc = {
    type: 'doc',
    content: [
      paragraph('Just a plain paragraph.'),
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Section' }] },
      paragraph('After the heading.'),
      { type: 'image', attrs: { id: 'deadbeef', alt: 'caption' } }
    ]
  };
  const md = proseToMarkdown(original);
  const reparsed = markdownToProse(md);

  assert.equal(reparsed.content.length, 4);
  assert.equal(reparsed.content[0]?.type, 'paragraph');
  assert.equal(reparsed.content[1]?.type, 'heading');
  assert.equal(reparsed.content[1]?.attrs?.level, 2);
  assert.equal(reparsed.content[3]?.type, 'image');
  assert.equal(reparsed.content[3]?.attrs?.id, 'deadbeef');
  assert.equal(reparsed.content[3]?.attrs?.alt, 'caption');
});

test('proseToMarkdown: blockquote, code block, lists, hard break, horizontal rule', () => {
  const doc: ProseDoc = {
    type: 'doc',
    content: [
      {
        type: 'blockquote',
        content: [paragraph('a quote line')]
      },
      {
        type: 'codeBlock',
        attrs: { language: 'js' },
        content: [{ type: 'text', text: 'const x = 1;' }]
      },
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [paragraph('one')] },
          { type: 'listItem', content: [paragraph('two')] }
        ]
      },
      { type: 'horizontalRule' },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'first' },
          { type: 'hardBreak' },
          { type: 'text', text: 'second' }
        ]
      }
    ]
  };
  const md = proseToMarkdown(doc);
  assert.match(md, /^> a quote line/m);
  assert.match(md, /```js\nconst x = 1;\n```/);
  assert.match(md, /- one\n- two/);
  assert.match(md, /^---$/m);
  assert.match(md, /first {2}\nsecond/);
});

test('markdownToProse skips frontmatter and yields only the body', () => {
  const md = `---\ntitle: T\nslug: s\n---\n\nbody paragraph\n`;
  const doc = markdownToProse(md);
  assert.equal(doc.content.length, 1);
  assert.equal(doc.content[0]?.type, 'paragraph');
});

test('proseToMarkdown drops image nodes with no id', () => {
  const doc: ProseDoc = {
    type: 'doc',
    content: [paragraph('keep'), { type: 'image', attrs: { id: '', alt: 'no id' } }]
  };
  const md = proseToMarkdown(doc);
  assert.match(md, /keep/);
  assert.equal(md.includes('::image'), false);
});

test('markdownToProse: blockquote / code block / link / inline code / hard break / list', () => {
  const md = [
    '> a quote line',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    'a [link](https://example.com) and `code`.',
    '',
    'first  ',
    'second',
    '',
    '- one',
    '- two',
    ''
  ].join('\n');
  const doc = markdownToProse(md);
  const types = doc.content.map((n) => n.type);
  assert.ok(types.includes('blockquote'));
  assert.ok(types.includes('codeBlock'));
  assert.ok(types.includes('bulletList'));

  const linked = doc.content.find(
    (n) => n.type === 'paragraph' && n.content?.some((c) => c.marks?.some((m) => m.type === 'link'))
  );
  assert.ok(linked, 'expected a paragraph containing a link');
  const linkText = linked?.content?.find((c) => c.marks?.some((m) => m.type === 'link'));
  assert.equal(linkText?.text, 'link');
  assert.equal(
    (linkText?.marks?.find((m) => m.type === 'link')?.attrs as { href: string } | undefined)?.href,
    'https://example.com'
  );

  const codeMarked = linked?.content?.find((c) => c.marks?.some((m) => m.type === 'code'));
  assert.equal(codeMarked?.text, 'code');

  const hbPara = doc.content.find((n) => n.content?.some((c) => c.type === 'hardBreak'));
  assert.ok(hbPara, 'expected a paragraph with a hardBreak');
});

test('markdownToProse: ordered list maps to orderedList', () => {
  const doc = markdownToProse('1. a\n2. b\n');
  assert.equal(doc.content[0]?.type, 'orderedList');
});

test('markdownToProse: thematic break → horizontalRule', () => {
  const doc = markdownToProse('one\n\n---\n\ntwo\n');
  assert.ok(doc.content.some((n) => n.type === 'horizontalRule'));
});

test('proseToMarkdown: ordered list emits with "1." marker', () => {
  const doc: ProseDoc = {
    type: 'doc',
    content: [
      {
        type: 'orderedList',
        content: [
          { type: 'listItem', content: [paragraph('one')] },
          { type: 'listItem', content: [paragraph('two')] }
        ]
      }
    ]
  };
  assert.match(proseToMarkdown(doc), /1\. one\n1\. two/);
});

test('proseToMarkdown: heading level is clamped to 1-6', () => {
  const high: ProseDoc = {
    type: 'doc',
    content: [{ type: 'heading', attrs: { level: 99 }, content: [{ type: 'text', text: 'h' }] }]
  };
  assert.match(proseToMarkdown(high), /^###### h/);

  const low: ProseDoc = {
    type: 'doc',
    content: [{ type: 'heading', attrs: { level: -3 }, content: [{ type: 'text', text: 'h' }] }]
  };
  assert.match(proseToMarkdown(low), /^# h/);

  const garbage: ProseDoc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 'not-a-number' }, content: [{ type: 'text', text: 'h' }] }
    ]
  };
  assert.match(proseToMarkdown(garbage), /^# h/);
});

test('proseToMarkdown: unknown node types are dropped (silent)', () => {
  const doc: ProseDoc = {
    type: 'doc',
    content: [paragraph('keep'), { type: 'mystery-node' }, paragraph('also keep')]
  };
  const md = proseToMarkdown(doc);
  assert.match(md, /keep[\s\S]*also keep/);
  assert.equal(md.includes('mystery'), false);
});

test('proseToMarkdown: unknown marks fall through to plain text', () => {
  const doc: ProseDoc = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'plain', marks: [{ type: 'unknown-mark' }] }]
      }
    ]
  };
  assert.match(proseToMarkdown(doc), /plain/);
});
