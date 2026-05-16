// icons.ts is a static lookup table — no user input ever flows into
// the returned strings. These tests pin that contract so a future
// refactor that interpolates anything dynamic gets caught here
// before it shows up as an XSS vector at a callsite.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type IconName, icon, iconSpec } from '../../src/templates/icons.ts';

const NAMES: IconName[] = ['link', 'imagePlus', 'copy', 'settings', 'pencil', 'plus', 'save'];

test('icons: every name returns a non-empty <svg> with the Lucide attribute set', () => {
  for (const name of NAMES) {
    const svg = icon(name);
    assert.ok(svg.startsWith('<svg '), `${name} should start with <svg`);
    assert.ok(svg.endsWith('</svg>'), `${name} should end with </svg>`);
    assert.match(svg, /viewBox="0 0 24 24"/, `${name} should keep the Lucide 24×24 viewBox`);
    assert.match(svg, /stroke="currentColor"/, `${name} should inherit theme colour`);
    assert.match(svg, /aria-hidden="true"/, `${name} should not show up to AT`);
  }
});

test('icons: size param controls width/height without changing viewBox', () => {
  const small = icon('link', 16);
  assert.match(small, /width="16"/);
  assert.match(small, /height="16"/);
  assert.match(small, /viewBox="0 0 24 24"/);

  const big = icon('plus', 32);
  assert.match(big, /width="32"/);
  assert.match(big, /height="32"/);
});

test('icons: default size is 24', () => {
  const svg = icon('settings');
  assert.match(svg, /width="24" height="24"/);
});

test('icons: iconSpec returns a namespaced ProseMirror tuple for TipTap renderHTML', () => {
  for (const name of NAMES) {
    const spec = iconSpec(name);
    // tuple shape: [tag, attrs, ...children]. Tag must be namespaced
    // ("http://www.w3.org/2000/svg svg") so ProseMirror's
    // DOMSerializer creates the SVG element via createElementNS — a
    // bare "svg" tag would land in the HTML namespace and not render.
    assert.equal(spec[0], 'http://www.w3.org/2000/svg svg', `${name} tag namespace`);
    assert.equal(spec[1].viewBox, '0 0 24 24', `${name} viewBox`);
    assert.equal(spec[1].stroke, 'currentColor', `${name} stroke`);
    assert.ok(spec.length >= 3, `${name} has at least one child`);
    for (const child of spec.slice(2)) {
      const [childTag, childAttrs] = child as readonly [string, Record<string, string>];
      assert.ok(typeof childTag === 'string', `${name} child tag is a string`);
      assert.ok(childAttrs !== null && typeof childAttrs === 'object', `${name} child attrs`);
    }
  }
});

test('icons: iconSpec size param controls width/height', () => {
  const spec = iconSpec('plus', 16);
  assert.equal(spec[1].width, '16');
  assert.equal(spec[1].height, '16');
  const defaultSpec = iconSpec('plus');
  assert.equal(defaultSpec[1].width, '24');
  assert.equal(defaultSpec[1].height, '24');
});

test('icon("comment") renders a sized speech-bubble svg', () => {
  const html = icon('comment', 18);
  assert.match(html, /^<svg [^>]*width="18"[^>]*height="18"/);
  assert.ok(html.includes('M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'));
});
