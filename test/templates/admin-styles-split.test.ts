import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { renderAdminPage } from '../../src/templates/admin.ts';
import { ADMIN_CSS_CORE } from '../../src/templates/admin-styles-core.ts';
import { ADMIN_CSS_DIALOGS } from '../../src/templates/admin-styles-dialogs.ts';

// admin-styles.ts (~639 lines) exceeded the 500-line production-source
// cap, so it was split into admin-styles-core.ts +
// admin-styles-dialogs.ts. The split is a pure refactor: the emitted
// CSS must be character-identical to the pre-split string. This
// fixture is a verbatim copy of the original ADMIN_CSS contents; if a
// future edit changes the rules, update the fixture in the same commit.
//
// The first line of the fixture is a DO-NOT-EDIT banner (test-infra
// metadata). Strip it before asserting byte-identity of the CSS itself.
const DO_NOT_EDIT_PREFIX = '/* DO NOT EDIT';
const fixtureRaw = readFileSync(
  fileURLToPath(new URL('./admin-styles.fixture.css', import.meta.url)),
  'utf8'
);
const ORIGINAL_CSS = fixtureRaw.startsWith(DO_NOT_EDIT_PREFIX)
  ? fixtureRaw.slice(fixtureRaw.indexOf('\n') + 1)
  : fixtureRaw;

test('admin CSS split: core + "\\n" + dialogs is byte-identical to the pre-split string', () => {
  assert.equal(`${ADMIN_CSS_CORE}\n${ADMIN_CSS_DIALOGS}`, ORIGINAL_CSS);
});

test('renderAdminPage embeds the full admin CSS verbatim inside the inline <style>', () => {
  const html = renderAdminPage({
    site: { title: 'rkroll' },
    bundleUrl: '/static/admin/main.js',
    cspNonce: 'test-nonce'
  });
  // The page still ships the CSS inline (not as a linked asset), so
  // caching is unchanged. The inline <style> now carries the
  // per-response CSP nonce (Task 19); the exact original CSS text must
  // still be present verbatim between the <style> tags.
  assert.ok(html.includes(`<style nonce="test-nonce">\n${ORIGINAL_CSS}\n</style>`));
});
