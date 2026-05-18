import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderAdminPage } from '../../src/templates/admin.ts';

const base = {
  site: { title: 'rkroll' },
  bundleUrl: '/static/admin/main.js',
  cspNonce: 'test-nonce'
} as const;

test('renderAdminPage: includes admin manifest link', () => {
  const html = renderAdminPage(base);
  assert.match(html, /\/static\/admin-manifest\.webmanifest/);
});

test('renderAdminPage: includes admin SW registration script', () => {
  const html = renderAdminPage(base);
  assert.match(html, /sw-admin-register\.js/);
});
