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

// Editor-side note (spec.md §9 unification): the legacy node types
// (image, gallery, carousel, diptych, triptych) remain as a UI
// abstraction in the editor — each provides a richer toolbar /
// cropper / attribute panel — but the wire format on disk is
// uniformly `::figure{...}`. Tests below cover both directions:
// legacy node → ::figure markdown, and ::figure markdown → the
// best-fit editor node type.

test('proseToMarkdown: heading + legacy image node emits ::figure', () => {
  const doc: ProseDoc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'A heading' }] },
      { type: 'image', attrs: { id: 'abcdef', alt: 'a picture' } }
    ]
  };
  const md = proseToMarkdown(doc);
  assert.match(md, /## A heading/);
  assert.match(md, /::figure\{ids="abcdef" alts="a picture"\}/);
});

test('markdownToProse: ::figure with single id parses to image (legacy editor UI)', () => {
  const md = `Para with **bold** and *em*.\n\n## A heading\n\n::figure{ids="abcdef" alts="picture"}\n`;
  const doc = markdownToProse(md);
  const img = doc.content[2]!;
  assert.equal(img.type, 'image');
  assert.equal(img.attrs?.id, 'abcdef');
  assert.equal(img.attrs?.alt, 'picture');
});

test('proseToMarkdown: image node with caption + position emits ::figure with justify', () => {
  const doc: ProseDoc = {
    type: 'doc',
    content: [
      {
        type: 'image',
        attrs: {
          id: 'abcdef',
          alt: 'a picture',
          caption: 'Workbench at dusk',
          position: 'right'
        }
      }
    ]
  };
  // Canonical emit order: ids, matrix, justify, width, aspect, fit, alts,
  // captions, caption, timer.
  const md = proseToMarkdown(doc);
  assert.match(
    md,
    /::figure\{ids="abcdef" justify=right alts="a picture" caption="Workbench at dusk"\}/
  );
});

test('proseToMarkdown: image position=default produces no justify attr', () => {
  const doc: ProseDoc = {
    type: 'doc',
    content: [{ type: 'image', attrs: { id: 'abcdef', alt: 'x', position: 'default' } }]
  };
  assert.doesNotMatch(proseToMarkdown(doc), /justify=/);
});

test('proseToMarkdown: image with empty caption omits the caption attribute', () => {
  const doc: ProseDoc = {
    type: 'doc',
    content: [{ type: 'image', attrs: { id: 'abcdef', alt: 'x', caption: '' } }]
  };
  assert.doesNotMatch(proseToMarkdown(doc), /caption=/);
});

test('markdownToProse: ::figure with justify=full carries position into image node', () => {
  const md = '::figure{ids="abcdef" alts="picture" caption="A workbench" justify=full}\n';
  const doc = markdownToProse(md);
  const img = doc.content[0]!;
  assert.equal(img.type, 'image');
  assert.equal(img.attrs?.caption, 'A workbench');
  assert.equal(img.attrs?.position, 'full');
});

test('markdownToProse: bare ::figure (single id) → image node with default position', () => {
  const md = '::figure{ids="abcdef" alts="x"}\n';
  const doc = markdownToProse(md);
  const img = doc.content[0]!;
  assert.equal(img.type, 'image');
  assert.equal(img.attrs?.position, 'default');
});

// ---- legacy multi-image nodes → ::figure with appropriate matrix ----

test('proseToMarkdown: gallery node emits ::figure with matrix=<layout>', () => {
  const doc: ProseDoc = {
    type: 'doc',
    content: [
      {
        type: 'gallery',
        attrs: { ids: 'abc,def,012', layout: 'masonry', caption: 'Workbench shots' }
      }
    ]
  };
  assert.match(
    proseToMarkdown(doc),
    /::figure\{ids="abc,def,012" matrix=masonry caption="Workbench shots"\}/
  );
});

test('proseToMarkdown: gallery node with per-image alts carries through', () => {
  const doc: ProseDoc = {
    type: 'doc',
    content: [
      {
        type: 'gallery',
        attrs: { ids: 'aaaaaa,bbbbbb,cccccc', layout: 'justified', alts: 'workbench,sky,bird' }
      }
    ]
  };
  assert.match(proseToMarkdown(doc), /alts="workbench,sky,bird"/);
});

test('proseToMarkdown: gallery layout=justified emits matrix=justified', () => {
  const doc: ProseDoc = {
    type: 'doc',
    content: [{ type: 'gallery', attrs: { ids: 'a,b,c', layout: 'justified' } }]
  };
  assert.match(proseToMarkdown(doc), /matrix=justified/);
});

test('proseToMarkdown: gallery layout=matrix drops layout (legacy "matrix" had no shape)', () => {
  const doc: ProseDoc = {
    type: 'doc',
    content: [{ type: 'gallery', attrs: { ids: 'a,b,c', layout: 'matrix' } }]
  };
  // The legacy gallery's matrix layout doesn't map cleanly to the
  // unified directive's NxM grid (no rows/cols specified). Drop the
  // layout attr; author can add an explicit matrix=NxM later.
  assert.doesNotMatch(proseToMarkdown(doc), /matrix=/);
});

test('proseToMarkdown: empty alts on gallery is omitted', () => {
  for (const alts of ['', ',,']) {
    const doc: ProseDoc = {
      type: 'doc',
      content: [{ type: 'gallery', attrs: { ids: 'aaaaaa,bbbbbb', layout: 'justified', alts } }]
    };
    assert.doesNotMatch(proseToMarkdown(doc), /alts=/);
  }
});

test('proseToMarkdown: carousel node emits ::figure with matrix=1x1 + timer', () => {
  const off: ProseDoc = {
    type: 'doc',
    content: [{ type: 'carousel', attrs: { ids: 'a,b', autoplay: 0 } }]
  };
  const offMd = proseToMarkdown(off);
  assert.match(offMd, /matrix=1x1/);
  assert.doesNotMatch(offMd, /timer=/);

  const on: ProseDoc = {
    type: 'doc',
    content: [{ type: 'carousel', attrs: { ids: 'a,b', autoplay: 5 } }]
  };
  assert.match(proseToMarkdown(on), /::figure\{ids="a,b" matrix=1x1 timer=5\}/);
});

test('proseToMarkdown: diptych + triptych nodes emit ::figure with right matrix', () => {
  const di: ProseDoc = {
    type: 'doc',
    content: [{ type: 'diptych', attrs: { ids: 'a,b', caption: 'Before / after' } }]
  };
  assert.match(proseToMarkdown(di), /::figure\{ids="a,b" matrix=1x2 caption="Before \/ after"\}/);

  const tri: ProseDoc = {
    type: 'doc',
    content: [{ type: 'triptych', attrs: { ids: 'a,b,c' } }]
  };
  assert.match(proseToMarkdown(tri), /::figure\{ids="a,b,c" matrix=1x3\}/);
});

test('proseToMarkdown: multi-image node with empty ids drops the node silently', () => {
  const doc: ProseDoc = {
    type: 'doc',
    content: [{ type: 'gallery', attrs: { ids: '', layout: 'justified' } }]
  };
  assert.doesNotMatch(proseToMarkdown(doc), /::figure/);
});

test('proseToMarkdown: ids array (vs comma string) joins on emit', () => {
  const doc: ProseDoc = {
    type: 'doc',
    content: [{ type: 'gallery', attrs: { ids: ['a', 'b', 'c'], layout: 'justified' } }]
  };
  assert.match(proseToMarkdown(doc), /ids="a,b,c"/);
});

test('markdownToProse: ::figure matrix=masonry → gallery node with layout=masonry', () => {
  const md = '::figure{ids="abc,def" matrix=masonry caption="Two shots"}\n';
  const doc = markdownToProse(md);
  const g = doc.content[0]!;
  assert.equal(g.type, 'gallery');
  assert.equal(g.attrs?.ids, 'abc,def');
  assert.equal(g.attrs?.layout, 'masonry');
  assert.equal(g.attrs?.caption, 'Two shots');
});

test('markdownToProse: ::figure matrix=1x1 with multi ids → carousel node', () => {
  const md = '::figure{ids="a,b" matrix=1x1 timer=5}\n';
  const doc = markdownToProse(md);
  const c = doc.content[0]!;
  assert.equal(c.type, 'carousel');
  assert.equal(c.attrs?.autoplay, 5);
});

test('markdownToProse: ::figure matrix=1x2/1x3 → diptych/triptych nodes', () => {
  const md = '::figure{ids="a,b" matrix=1x2}\n\n::figure{ids="a,b,c" matrix=1x3}\n';
  const doc = markdownToProse(md);
  assert.equal(doc.content[0]?.type, 'diptych');
  assert.equal(doc.content[1]?.type, 'triptych');
});

// ---- round-trip identity (markdown → prose → markdown) ------------------
// Each editor node type → ::figure → parses back to the same editor
// node type. Legacy attribute layout is preserved across the round-trip.

test('round-trip: ::figure with single id + caption + justify', () => {
  // Canonical attribute order: justify before alts, caption before timer.
  const md = '::figure{ids="abcdef" justify=full alts="x" caption="A caption"}\n';
  assert.equal(proseToMarkdown(markdownToProse(md)).trim(), md.trim());
});

test('round-trip: ::figure matrix=masonry + caption + alts', () => {
  const md = '::figure{ids="abc,def" matrix=masonry alts="cat,dog" caption="Two shots"}\n';
  assert.equal(proseToMarkdown(markdownToProse(md)).trim(), md.trim());
});

test('round-trip: ::figure matrix=1x1 + timer + caption', () => {
  // Canonical order: caption before timer.
  const md = '::figure{ids="a,b,c" matrix=1x1 caption="Slideshow" timer=5}\n';
  assert.equal(proseToMarkdown(markdownToProse(md)).trim(), md.trim());
});

test('round-trip: ::figure matrix=1x2 / matrix=1x3 preserve ids + caption', () => {
  const di = '::figure{ids="a,b" matrix=1x2 caption="Pair"}\n';
  assert.equal(proseToMarkdown(markdownToProse(di)).trim(), di.trim());

  const tri = '::figure{ids="a,b,c" matrix=1x3}\n';
  assert.equal(proseToMarkdown(markdownToProse(tri)).trim(), tri.trim());
});

test('proseToMarkdown: drops legacy image nodes whose id is not 6-64 hex', () => {
  // Defends against a forged ProseMirror JSON body that smuggles
  // directive syntax through the id attribute. The editor never
  // authors non-hex ids; legacyImageToFigureAttrs validates on emit.
  const cases: ProseDoc[] = [
    { type: 'doc', content: [{ type: 'image', attrs: { id: 'too-short', alt: '' } }] },
    { type: 'doc', content: [{ type: 'image', attrs: { id: 'NOT_HEX!@#', alt: '' } }] },
    { type: 'doc', content: [{ type: 'image', attrs: { id: 'ABC123', alt: '' } }] }, // uppercase hex isn't accepted
    { type: 'doc', content: [{ type: 'image', attrs: { id: '} ::shell{', alt: '' } }] }
  ];
  for (const doc of cases) {
    assert.doesNotMatch(
      proseToMarkdown(doc),
      /::figure/,
      `should drop ${JSON.stringify(doc.content[0])}`
    );
  }
});

test('proseToMarkdown: invalid image position values silently dropped from justify', () => {
  // legacyImageToFigureAttrs only emits justify for full|left|right|inline.
  // A stale/forged position attr like 'something-bogus' is ignored.
  const doc: ProseDoc = {
    type: 'doc',
    content: [{ type: 'image', attrs: { id: 'abcdef', alt: '', position: 'something-bogus' } }]
  };
  assert.doesNotMatch(proseToMarkdown(doc), /justify=/);
});

test('proseToMarkdown: carousel autoplay capped at 60 on emit (timer)', () => {
  const doc: ProseDoc = {
    type: 'doc',
    content: [{ type: 'carousel', attrs: { ids: 'a,b', autoplay: 999 } }]
  };
  const md = proseToMarkdown(doc);
  assert.match(md, /timer=60/);
  assert.doesNotMatch(md, /timer=999/);
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
  // `* * *` rather than `---` so a leading horizontal rule can't be
  // mistaken for a frontmatter delimiter when this markdown is POSTed.
  assert.match(md, /^\* \* \*$/m);
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

// ---- ::figure (unified directive, spec.md §9) -------------------------

test('proseToMarkdown: figure node with custom layout attrs emits figure-shape directly', () => {
  // The generic FigureNode is used by the editor for figures whose
  // attribute set doesn't fit a legacy node (anything with width=,
  // aspect=, fit=, or NxM with N>1 rows). Verify the emit path stays
  // verbatim for these.
  const doc: ProseDoc = {
    type: 'doc',
    content: [
      {
        type: 'figure',
        attrs: {
          ids: 'abcdef0123456789',
          alts: '',
          captions: '',
          caption: '',
          matrix: '2x2',
          justify: 'center',
          width: '60%',
          aspect: '16:9',
          fit: 'cover',
          timer: 0
        }
      }
    ]
  };
  const md = proseToMarkdown(doc);
  assert.match(md, /::figure\{ids="abcdef0123456789" matrix=2x2 width=60% aspect=16:9\}/);
});

test('proseToMarkdown: figure with full attribute set round-trips', () => {
  const md = `::figure{ids="aaa,bbb,ccc,ddd" matrix=2x2 justify=full aspect=16:9 fit=contain alts="a,b,c,d" captions="cap a|cap b|cap c|cap d" caption="whole figure" timer=10}\n`;
  const doc = markdownToProse(md);
  assert.equal(doc.content.length, 1);
  const node = doc.content[0];
  if (!node) throw new Error('no node');
  assert.equal(node.type, 'figure');
  assert.deepEqual(node.attrs, {
    ids: 'aaa,bbb,ccc,ddd',
    alts: 'a,b,c,d',
    captions: 'cap a|cap b|cap c|cap d',
    caption: 'whole figure',
    matrix: '2x2',
    justify: 'full',
    width: '',
    aspect: '16:9',
    fit: 'contain',
    timer: 10
  });
  // Round-trip back to markdown — every emitted attribute should reappear.
  const md2 = proseToMarkdown(doc);
  for (const piece of [
    'ids="aaa,bbb,ccc,ddd"',
    'matrix=2x2',
    'justify=full',
    'aspect=16:9',
    'fit=contain',
    'alts="a,b,c,d"',
    'captions="cap a|cap b|cap c|cap d"',
    'caption="whole figure"',
    'timer=10'
  ]) {
    assert.ok(md2.includes(piece), `expected ${piece} in ${md2}`);
  }
});

test('proseToMarkdown: figure default fit/justify omitted from output', () => {
  const doc: ProseDoc = {
    type: 'doc',
    content: [
      {
        type: 'figure',
        attrs: {
          ids: 'abc,def',
          matrix: '1x2',
          justify: 'center',
          fit: 'cover',
          alts: '',
          captions: '',
          caption: '',
          width: '',
          aspect: '',
          timer: 0
        }
      }
    ]
  };
  const md = proseToMarkdown(doc);
  // matrix=1x2 emitted; justify=center / fit=cover defaults dropped.
  assert.match(md, /::figure\{ids="abc,def" matrix=1x2\}/);
  assert.doesNotMatch(md, /justify=center/);
  assert.doesNotMatch(md, /fit=cover/);
});

test('proseToMarkdown: figure malformed width/aspect dropped on emit', () => {
  // The widget is forgiving on render, but the editor's serializer
  // shouldn't emit malformed attribute values that the spec rejects.
  const doc: ProseDoc = {
    type: 'doc',
    content: [
      {
        type: 'figure',
        attrs: {
          ids: 'abc',
          width: '100', // missing unit
          aspect: 'not-an-aspect',
          alts: '',
          captions: '',
          caption: '',
          matrix: '',
          justify: 'center',
          fit: 'cover',
          timer: 0
        }
      }
    ]
  };
  const md = proseToMarkdown(doc);
  assert.doesNotMatch(md, /width=/);
  assert.doesNotMatch(md, /aspect=/);
});

test('proseToMarkdown: figure timer caps at 60 on emit', () => {
  const doc: ProseDoc = {
    type: 'doc',
    content: [
      {
        type: 'figure',
        attrs: {
          ids: 'a,b,c,d,e',
          matrix: '1x2',
          timer: 999,
          alts: '',
          captions: '',
          caption: '',
          justify: 'center',
          fit: 'cover',
          width: '',
          aspect: ''
        }
      }
    ]
  };
  assert.match(proseToMarkdown(doc), /timer=60/);
});

test('markdownToProse: ::figure with width= → generic figure node (legacy nodes lack the field)', () => {
  // Single id but with a width attribute that no legacy node carries
  // → must land on the generic figure node, not the legacy image node.
  const md = `::figure{ids="abc" width=60%}\n`;
  const doc = markdownToProse(md);
  const node = doc.content[0];
  if (!node) throw new Error('no node');
  assert.equal(node.type, 'figure');
  assert.deepEqual(node.attrs, {
    ids: 'abc',
    alts: '',
    captions: '',
    caption: '',
    matrix: '',
    justify: 'center',
    width: '60%',
    aspect: '',
    fit: 'cover',
    timer: 0
  });
});
