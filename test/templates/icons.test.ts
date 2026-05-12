// icons.ts is a static lookup table — no user input ever flows into
// the returned strings. These tests pin that contract so a future
// refactor that interpolates anything dynamic gets caught here
// before it shows up as an XSS vector at a callsite.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type IconName, icon } from '../../src/templates/icons.ts';

const NAMES: IconName[] = ['link', 'imagePlus', 'copy', 'settings', 'pencil', 'plus'];

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
