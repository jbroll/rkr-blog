import assert from 'node:assert/strict';
import { test } from 'node:test';

import importWpCmd from '../../src/cli/import-wp.ts';

test('import-wp about: requires --to', async () => {
  await assert.rejects(
    () => importWpCmd(['about', 'https://wp.example']),
    /--to <target-url> is required/
  );
});

test('import-wp about: requires a bearer token', async () => {
  const saved = process.env.ADMIN_TOKEN;
  delete process.env.ADMIN_TOKEN;
  try {
    await assert.rejects(
      () => importWpCmd(['about', 'https://wp.example', '--to', 'https://t.example']),
      /bearer token required/
    );
  } finally {
    if (saved !== undefined) process.env.ADMIN_TOKEN = saved;
  }
});

test('import-wp about: missing base url → usage error', async () => {
  await assert.rejects(() => importWpCmd(['about']), /usage: site-admin import-wp about/);
});
