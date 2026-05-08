// Unit tests for the migrate-figures rewriter. Pure-string transforms;
// no FS or network. Verifies the legacy → ::figure mapping per
// spec.md §9 migration plan + the no-op behaviour on already-migrated
// or unrelated content.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rewriteMarkdown } from '../../src/cli/migrate-figures.ts';

test('migrate-figures: ::image{#ID alt=… caption=…} → ::figure (no matrix)', () => {
  const src = '::image{#abcdef0123456789 alt="cap" caption="hello world"}\n';
  const { newText, counts } = rewriteMarkdown(src);
  assert.equal(counts.image, 1);
  assert.match(newText, /::figure\{ids="abcdef0123456789" alts="cap" caption="hello world"\}/);
  assert.doesNotMatch(newText, /matrix=/); // single id → default 1x1
  assert.doesNotMatch(newText, /justify=/); // default position omitted
});

test('migrate-figures: ::image position=full → justify=full', () => {
  const src = '::image{#abc123 alt="x" position=full}\n';
  const { newText } = rewriteMarkdown(src);
  assert.match(newText, /::figure\{ids="abc123" alts="x" justify=full\}/);
});

test('migrate-figures: ::image position=inline → justify=inline', () => {
  const src = '::image{#abc123 position=inline}\n';
  const { newText } = rewriteMarkdown(src);
  assert.match(newText, /::figure\{ids="abc123" justify=inline\}/);
});

test('migrate-figures: ::image position=default produces no justify attr', () => {
  const src = '::image{#abc123 alt="x" position=default}\n';
  const { newText } = rewriteMarkdown(src);
  assert.match(newText, /::figure\{ids="abc123" alts="x"\}/);
  assert.doesNotMatch(newText, /justify=/);
});

test('migrate-figures: ::diptych → matrix=1x2', () => {
  const src = '::diptych{ids="a,b" alts="left,right" caption="duo"}\n';
  const { newText, counts } = rewriteMarkdown(src);
  assert.equal(counts.diptych, 1);
  assert.match(newText, /::figure\{ids="a,b" matrix=1x2 alts="left,right" caption="duo"\}/);
});

test('migrate-figures: ::triptych → matrix=1x3', () => {
  const src = '::triptych{ids="a,b,c"}\n';
  const { newText, counts } = rewriteMarkdown(src);
  assert.equal(counts.triptych, 1);
  assert.match(newText, /::figure\{ids="a,b,c" matrix=1x3\}/);
});

test('migrate-figures: ::gallery layout=justified → matrix=justified (default)', () => {
  const src = '::gallery{ids="a,b,c,d" layout=justified caption="row"}\n';
  const { newText, counts } = rewriteMarkdown(src);
  assert.equal(counts.gallery, 1);
  assert.match(newText, /::figure\{ids="a,b,c,d" matrix=justified caption="row"\}/);
});

test('migrate-figures: ::gallery layout=masonry → matrix=masonry', () => {
  const src = '::gallery{ids="a,b,c" layout=masonry}\n';
  const { newText } = rewriteMarkdown(src);
  assert.match(newText, /::figure\{ids="a,b,c" matrix=masonry\}/);
});

test('migrate-figures: ::gallery without layout defaults to matrix=justified', () => {
  // Legacy default for gallery was layout=justified.
  const src = '::gallery{ids="a,b,c"}\n';
  const { newText } = rewriteMarkdown(src);
  assert.match(newText, /::figure\{ids="a,b,c" matrix=justified\}/);
});

test('migrate-figures: ::gallery layout=matrix drops the layout (author fixes manually)', () => {
  // Legacy "matrix" layout (uniform square cells) maps to no
  // matrix attribute — the unified directive needs an explicit
  // NxM. Author can edit. Captured in commit message.
  const src = '::gallery{ids="a,b,c,d" layout=matrix}\n';
  const { newText } = rewriteMarkdown(src);
  assert.match(newText, /::figure\{ids="a,b,c,d"\}/);
  assert.doesNotMatch(newText, /matrix=/);
});

test('migrate-figures: ::carousel → matrix=1x1 + timer if autoplay', () => {
  const src = '::carousel{ids="a,b,c,d,e" autoplay=5}\n';
  const { newText, counts } = rewriteMarkdown(src);
  assert.equal(counts.carousel, 1);
  assert.match(newText, /::figure\{ids="a,b,c,d,e" matrix=1x1 timer=5\}/);
});

test('migrate-figures: ::carousel autoplay=999 caps at 60', () => {
  const src = '::carousel{ids="a,b" autoplay=999}\n';
  const { newText } = rewriteMarkdown(src);
  assert.match(newText, /timer=60/);
});

test('migrate-figures: idempotent — already-migrated ::figure is left alone', () => {
  const src = '::figure{ids="a,b,c" matrix=1x3 caption="already migrated"}\n';
  const { newText, counts } = rewriteMarkdown(src);
  assert.equal(
    counts.image + counts.diptych + counts.triptych + counts.gallery + counts.carousel,
    0
  );
  assert.equal(newText, src); // byte-identical
});

test('migrate-figures: prose around directives is preserved', () => {
  const src = `# A post

Opening paragraph.

::image{#abcdef0123456789 alt="hi"}

Middle paragraph.

::diptych{ids="aaa,bbb"}

Closing paragraph.
`;
  const { newText, counts } = rewriteMarkdown(src);
  assert.equal(counts.image, 1);
  assert.equal(counts.diptych, 1);
  assert.match(newText, /^# A post/);
  assert.match(newText, /Opening paragraph\./);
  assert.match(newText, /Middle paragraph\./);
  assert.match(newText, /Closing paragraph\./);
  assert.match(newText, /::figure\{ids="abcdef0123456789" alts="hi"\}/);
  assert.match(newText, /::figure\{ids="aaa,bbb" matrix=1x2\}/);
});

test('migrate-figures: multiple directives in one file all rewrite', () => {
  // Realistic ids (6-64 hex). The shorthand `#ID` form requires a hex
  // run of that length; shorter ids in the test wouldn't match the
  // regex (and wouldn't pass the public widget's id-shape guard either).
  const src =
    [
      '::image{#aaaaaa1 alt="1"}',
      '::diptych{ids="bbbbbb2,cccccc3"}',
      '::gallery{ids="dddddd4,eeeeee5,ffffff6" layout=masonry}',
      '::carousel{ids="ggggggg,hhhhhhh"}'
    ].join('\n') + '\n';
  const { newText, counts } = rewriteMarkdown(src);
  assert.equal(counts.image, 1);
  assert.equal(counts.diptych, 1);
  assert.equal(counts.gallery, 1);
  assert.equal(counts.carousel, 1);
  assert.match(newText, /::figure\{ids="aaaaaa1" alts="1"\}/);
  assert.match(newText, /::figure\{ids="bbbbbb2,cccccc3" matrix=1x2\}/);
  assert.match(newText, /::figure\{ids="dddddd4,eeeeee5,ffffff6" matrix=masonry\}/);
  assert.match(newText, /::figure\{ids="ggggggg,hhhhhhh" matrix=1x1\}/);
});

test('migrate-figures: ::image with multi-word quoted attrs migrates cleanly', () => {
  const src = '::image{#abcdef0123456789 alt="some longer alt text" caption="with spaces"}\n';
  const { newText } = rewriteMarkdown(src);
  assert.match(newText, /alts="some longer alt text"/);
  assert.match(newText, /caption="with spaces"/);
});

test('migrate-figures: backslash-escaped inner quotes are left untouched (documented limitation)', () => {
  // The regex parser doesn't handle `\"` inside attribute values.
  // The directive stays intact rather than being garbled; the
  // operator migrates it manually after running --write.
  const src = '::image{#abcdef0123456789 caption="he said \\"hi\\""}\n';
  const { newText, counts } = rewriteMarkdown(src);
  assert.equal(counts.image, 0);
  assert.equal(newText, src);
});

test('migrate-figures: malformed directive (no id) is left alone', () => {
  // No `#ID` shorthand and no `id="..."` attribute → can't migrate.
  const src = '::image{alt="orphan"}\n';
  const { newText, counts } = rewriteMarkdown(src);
  assert.equal(counts.image, 0);
  assert.equal(newText, src);
});

test('migrate-figures: ::diptych without ids is left alone', () => {
  const src = '::diptych{caption="orphan"}\n';
  const { newText, counts } = rewriteMarkdown(src);
  assert.equal(counts.diptych, 0);
  assert.equal(newText, src);
});
