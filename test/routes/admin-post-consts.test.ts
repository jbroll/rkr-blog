import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isValidSlug } from '../../src/routes/admin-post-consts.ts';

// ---------------------------------------------------------------------------
// Normal kebab-case slugs (existing behaviour)
// ---------------------------------------------------------------------------

test('isValidSlug: accepts simple kebab-case slugs', () => {
  assert.ok(isValidSlug('hello'));
  assert.ok(isValidSlug('hello-world'));
  assert.ok(isValidSlug('my-post-2026'));
  assert.ok(isValidSlug('a'));
  assert.ok(isValidSlug('abc123'));
});

test('isValidSlug: rejects empty string', () => {
  assert.equal(isValidSlug(''), false);
});

test('isValidSlug: rejects non-string values', () => {
  assert.equal(isValidSlug(null), false);
  assert.equal(isValidSlug(undefined), false);
  assert.equal(isValidSlug(42), false);
});

test('isValidSlug: rejects slugs exceeding 100 chars', () => {
  assert.equal(isValidSlug('a'.repeat(101)), false);
  assert.ok(isValidSlug('a'.repeat(100)));
});

test('isValidSlug: rejects slugs with invalid chars', () => {
  assert.equal(isValidSlug('hello world'), false);
  assert.equal(isValidSlug('hello/world'), false);
  assert.equal(isValidSlug('hello.world'), false);
  assert.equal(isValidSlug('-leading-dash'), false);
});

// ---------------------------------------------------------------------------
// System (_-prefixed) slugs — new behaviour
// ---------------------------------------------------------------------------

test('isValidSlug: accepts _-prefixed system slugs', () => {
  assert.ok(isValidSlug('_site-banner'));
  assert.ok(isValidSlug('_system'));
  assert.ok(isValidSlug('_meta-config'));
  assert.ok(isValidSlug('_a'));
});

test('isValidSlug: rejects bare underscore', () => {
  assert.equal(isValidSlug('_'), false);
});

test('isValidSlug: rejects __ (double underscore prefix)', () => {
  assert.equal(isValidSlug('__double'), false);
});

test('isValidSlug: rejects _ followed by digit', () => {
  // Pattern requires _[a-z] after underscore.
  assert.equal(isValidSlug('_1bad'), false);
});

test('isValidSlug: rejects underscores in middle', () => {
  assert.equal(isValidSlug('hello_world'), false);
});
