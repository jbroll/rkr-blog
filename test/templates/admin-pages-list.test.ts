import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { relativeDate } from '../../src/templates/admin-pages-list.ts';

const NOW = Date.parse('2026-10-25T12:00:00Z');

describe('relativeDate', () => {
  it('uses plain units', () => {
    assert.equal(relativeDate('2026-10-25T11:59:40Z', NOW), 'just now');
    assert.equal(relativeDate('2026-10-25T11:15:00Z', NOW), '45 minutes ago');
    assert.equal(relativeDate('2026-10-25T09:00:00Z', NOW), '3 hours ago');
    assert.equal(relativeDate('2026-10-24T09:00:00Z', NOW), 'yesterday');
    assert.equal(relativeDate('2026-10-20T12:00:00Z', NOW), '5 days ago');
    assert.equal(relativeDate('2026-09-27T12:00:00Z', NOW), '4 weeks ago');
  });

  it('falls back to a date for old or unparseable values', () => {
    assert.equal(relativeDate('2025-03-04T12:00:00Z', NOW), 'Mar 4, 2025');
    assert.equal(relativeDate('garbage', NOW), '');
  });
});
