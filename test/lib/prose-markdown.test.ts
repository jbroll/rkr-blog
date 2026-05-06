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
