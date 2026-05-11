import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderAdminSettingsPage } from '../../src/templates/admin-settings.ts';

test('renderAdminSettingsPage: form pre-fills persisted values', () => {
  const html = renderAdminSettingsPage({
    site: { title: 'rkroll' },
    persisted: { title: 'My Blog', tagline: 'A subtitle', theme: 'papermod' },
    themes: ['default', 'papermod', 'terminal']
  });
  // Title + tagline are <input value="…">.
  assert.match(html, /<input id="rkr-settings-title"[^>]*value="My Blog"/);
  assert.match(html, /<input id="rkr-settings-tagline"[^>]*value="A subtitle"/);
  // The selected theme carries the `selected` attribute; the others
  // don't.
  assert.match(html, /<option value="papermod" selected>papermod<\/option>/);
  assert.match(html, /<option value="default">default<\/option>/);
  assert.match(html, /<option value="terminal">terminal<\/option>/);
  // Posted form points at the same path so a refresh after submit
  // re-renders the page rather than re-posting.
  assert.match(html, /action="\/admin\/settings"/);
  assert.match(html, /method="post"/);
});

test('renderAdminSettingsPage: placeholder shows the env-derived default', () => {
  // No persisted title — the active siteConfig's title becomes the
  // placeholder, so the operator can see what they're falling back
  // to before they decide to override.
  const html = renderAdminSettingsPage({
    site: { title: 'rkroll' },
    persisted: {},
    themes: ['default']
  });
  assert.match(html, /<input id="rkr-settings-title"[^>]*value=""/);
  assert.match(html, /placeholder="rkroll"/);
});

test('renderAdminSettingsPage: title + tagline escape HTML', () => {
  const html = renderAdminSettingsPage({
    site: { title: 'rkroll' },
    persisted: { title: '<script>x</script>', tagline: '" autofocus="' },
    themes: ['default']
  });
  assert.ok(!html.includes('<script>x</script>'), 'title must be escaped');
  // The quote in the tagline must be entity-escaped so it doesn't
  // break out of the value="…" attribute and inject autofocus.
  assert.doesNotMatch(html, /autofocus="/);
});

test('renderAdminSettingsPage: flash message renders with the right kind class', () => {
  const ok = renderAdminSettingsPage({
    site: { title: 'rkroll' },
    persisted: {},
    themes: ['default'],
    flash: { kind: 'ok', text: 'Settings saved.' }
  });
  assert.match(ok, /class="rkr-admin-settings-flash is-ok"[^>]*>Settings saved\./);

  const err = renderAdminSettingsPage({
    site: { title: 'rkroll' },
    persisted: {},
    themes: ['default'],
    flash: { kind: 'error', text: 'title too long' }
  });
  assert.match(err, /class="rkr-admin-settings-flash is-error"[^>]*>title too long/);
});
