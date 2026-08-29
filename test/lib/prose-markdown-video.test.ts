// Round-trip for the ::video directive in the admin editor's prose
// converter (video spec Task 8). Mirrors the ::figure directive tests:
// the editor node carries the raw attribute strings (ids, trim, poster,
// caption) and the markdown is the wire format.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { markdownToProse, type ProseDoc, proseToMarkdown } from '../../src/lib/prose-markdown.ts';

test('round-trips a minimal ::video directive', () => {
  const md = '::video{ids="ab..."}\n';
  const doc = markdownToProse(md);
  assert.equal(doc.content[0]?.type, 'video');
  assert.equal(doc.content[0]?.attrs?.ids, 'ab...');
  assert.match(proseToMarkdown(doc), /::video\{ids="ab\.\.\."\}/);
});

test('round-trips the full ::video attribute set', () => {
  const md = '::video{ids="abcd" trim="2.0-45.5" poster="1.5" caption="demo reel"}\n';
  const doc = markdownToProse(md);
  const node = doc.content[0];
  assert.equal(node?.type, 'video');
  assert.equal(node?.attrs?.trim, '2.0-45.5');
  assert.equal(node?.attrs?.poster, '1.5');
  assert.equal(node?.attrs?.caption, 'demo reel');
  assert.equal(proseToMarkdown(doc).trim(), md.trim());
});

test('proseToMarkdown: video node with width/justify/controls/autoplay emits attrs', () => {
  const doc: ProseDoc = {
    type: 'doc',
    content: [
      {
        type: 'video',
        attrs: {
          ids: 'abcd',
          trim: '',
          poster: '',
          caption: '',
          width: '50%',
          justify: 'left',
          controls: false,
          autoplay: true
        }
      }
    ]
  };
  const md = proseToMarkdown(doc);
  assert.match(md, /::video\{ids="abcd" width=50% justify=left controls=false autoplay\}/);
});

test('proseToMarkdown: default video attrs are omitted from the directive', () => {
  const doc: ProseDoc = {
    type: 'doc',
    content: [
      {
        type: 'video',
        attrs: {
          ids: 'abcd',
          trim: '',
          poster: '',
          caption: '',
          width: '',
          justify: 'center',
          controls: true,
          autoplay: false
        }
      }
    ]
  };
  assert.match(proseToMarkdown(doc), /^::video\{ids="abcd"\}/);
});

test('proseToMarkdown: video node with empty ids drops the node silently', () => {
  const doc: ProseDoc = {
    type: 'doc',
    content: [{ type: 'video', attrs: { ids: '', trim: '', poster: '', caption: '' } }]
  };
  assert.doesNotMatch(proseToMarkdown(doc), /::video/);
});

test('round-trip (editor save): video caption survives hostile chars', () => {
  const text = 'cap with } a brace and " a dquote and \\ a backslash';
  const doc: ProseDoc = {
    type: 'doc',
    content: [{ type: 'video', attrs: { ids: 'abcd', trim: '', poster: '', caption: text } }]
  };
  const md = proseToMarkdown(doc);
  const back = markdownToProse(md);
  assert.equal(back.content[0]?.type, 'video', `directive dropped: ${JSON.stringify(md)}`);
  assert.equal(back.content[0]?.attrs?.caption, text, `caption corrupted: ${JSON.stringify(md)}`);
});

test('markdownToProse: video node parses booleans from directive attrs', () => {
  const md = '::video{ids="abcd" controls=false autoplay}\n';
  const node = markdownToProse(md).content[0];
  assert.equal(node?.type, 'video');
  assert.equal(node?.attrs?.controls, false);
  assert.equal(node?.attrs?.autoplay, true);
});
