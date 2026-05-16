import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderAdminSettingsPage } from '../../src/templates/admin-settings.ts';

test('renderAdminSettingsPage: form pre-fills persisted values', () => {
  const html = renderAdminSettingsPage({
    site: { title: 'rkroll' },
    persisted: { title: 'My Blog', tagline: 'A subtitle', theme: 'papermod' },
    themes: ['default', 'papermod', 'terminal'],
    gdriveConnected: false, onedriveConnected: false, gitHash: 'unknown', hasBanner: false
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
    themes: ['default'],
    gdriveConnected: false, onedriveConnected: false, gitHash: 'unknown', hasBanner: false
  });
  assert.match(html, /<input id="rkr-settings-title"[^>]*value=""/);
  assert.match(html, /placeholder="rkroll"/);
});

test('renderAdminSettingsPage: title + tagline escape HTML', () => {
  const html = renderAdminSettingsPage({
    site: { title: 'rkroll' },
    persisted: { title: '<script>x</script>', tagline: '" autofocus="' },
    themes: ['default'],
    gdriveConnected: false, onedriveConnected: false, gitHash: 'unknown', hasBanner: false
  });
  assert.ok(!html.includes('<script>x</script>'), 'title must be escaped');
  // The quote in the tagline must be entity-escaped so it doesn't
  // break out of the value="…" attribute and inject autofocus.
  assert.doesNotMatch(html, /autofocus="/);
});

test('renderAdminSettingsPage: error flash renders inline; ok flash does not', () => {
  // Success is handled client-side (toast); no inline element needed.
  const ok = renderAdminSettingsPage({
    site: { title: 'rkroll' },
    persisted: {},
    themes: ['default'],
    gdriveConnected: false, onedriveConnected: false, gitHash: 'unknown', hasBanner: false,
    flash: { kind: 'ok', text: 'Settings saved.' }
  });
  assert.doesNotMatch(ok, /rkr-admin-settings-flash/);

  const err = renderAdminSettingsPage({
    site: { title: 'rkroll' },
    persisted: {},
    themes: ['default'],
    gdriveConnected: false, onedriveConnected: false, gitHash: 'unknown', hasBanner: false,
    flash: { kind: 'error', text: 'title too long' }
  });
  assert.match(err, /class="rkr-admin-settings-flash is-error"[^>]*>title too long/);
});

test('renderAdminSettingsPage: save button is in the heading row with a disk icon', () => {
  const html = renderAdminSettingsPage({
    site: { title: 'rkroll' },
    persisted: {},
    themes: ['default'],
    gdriveConnected: false, onedriveConnected: false, gitHash: 'unknown', hasBanner: false
  });
  // Heading and button share a flex row.
  assert.match(html, /rkr-admin-settings-heading-row/);
  // Button has the save icon (Lucide save path signature).
  assert.match(html, /rkr-admin-settings-submit[^>]*>[\s\S]*M19 21H5/);
  // Submit button is still a type="submit" inside the form.
  assert.match(html, /type="submit"/);
});

test('renderAdminSettingsPage: build chip shows the short git hash with full sha in title', () => {
  const html = renderAdminSettingsPage({
    site: { title: 'rkroll' },
    persisted: {},
    themes: ['default'],
    gdriveConnected: false, onedriveConnected: false, gitHash: 'abc123def456789ffeed0011223344556677889a', hasBanner: false
  });
  // Short form (12 chars) is the visible text; full sha is in the
  // title attr so a hover reveals the exact commit.
  assert.match(html, /<p class="rkr-admin-settings-build">/);
  assert.match(html, /title="abc123def456789ffeed0011223344556677889a"/);
  assert.match(html, /<code[^>]*>abc123def456<\/code>/);
});

test('renderAdminSettingsPage: build chip shows "unknown" verbatim', () => {
  const html = renderAdminSettingsPage({
    site: { title: 'rkroll' },
    persisted: {},
    themes: ['default'],
    gdriveConnected: false, onedriveConnected: false, gitHash: 'unknown', hasBanner: false
  });
  assert.match(html, /<code[^>]*>unknown<\/code>/);
});

test('renderAdminSettingsPage: ingestResize fields show persisted values', () => {
  const html = renderAdminSettingsPage({
    site: { title: 'rkroll' },
    persisted: { ingestResize: { maxDim: 2400, scalePct: 80, webpQuality: 70 } },
    themes: ['default'],
    gdriveConnected: false, onedriveConnected: false, gitHash: 'unknown', hasBanner: false
  });
  assert.match(html, /value="2400"/);
  assert.match(html, /value="80"/);
  assert.match(html, /value="70"/);
});

test('renderAdminSettingsPage: connected integration shows Disconnect button', () => {
  const htmlGdrive = renderAdminSettingsPage({
    site: { title: 'rkroll' },
    persisted: {},
    themes: ['default'],
    gdriveConnected: true, onedriveConnected: false, gitHash: 'unknown', hasBanner: false
  });
  assert.match(htmlGdrive, /Disconnect/);

  const htmlOnedrive = renderAdminSettingsPage({
    site: { title: 'rkroll' },
    persisted: {},
    themes: ['default'],
    gdriveConnected: false, onedriveConnected: true, gitHash: 'unknown', hasBanner: false
  });
  assert.match(htmlOnedrive, /Disconnect/);
});

// ---------------------------------------------------------------------------
// Banner section
// ---------------------------------------------------------------------------

test('renderAdminSettingsPage: hasBanner=true shows edit link to /admin/editor?slug=_site-banner', () => {
  const html = renderAdminSettingsPage({
    site: { title: 'rkroll' },
    persisted: {},
    themes: ['default'],
    gdriveConnected: false,
    onedriveConnected: false,
    gitHash: 'unknown',
    hasBanner: true
  });
  assert.match(html, /href="\/admin\/editor\?slug=_site-banner"/);
  assert.match(html, /Edit banner/);
});

test('renderAdminSettingsPage: hasBanner=false shows create link to /admin/editor', () => {
  const html = renderAdminSettingsPage({
    site: { title: 'rkroll' },
    persisted: {},
    themes: ['default'],
    gdriveConnected: false,
    onedriveConnected: false,
    gitHash: 'unknown',
    hasBanner: false
  });
  assert.match(html, /href="\/admin\/editor"/);
  assert.match(html, /Create banner/);
  // Should not have the slug pre-set when hasBanner=false.
  assert.doesNotMatch(html, /href="\/admin\/editor\?slug=_site-banner"/);
});

test('renderAdminSettingsPage: banner section heading present in both states', () => {
  for (const hasBanner of [true, false]) {
    const html = renderAdminSettingsPage({
      site: { title: 'rkroll' },
      persisted: {},
      themes: ['default'],
      gdriveConnected: false,
      onedriveConnected: false,
      gitHash: 'unknown',
      hasBanner
    });
    assert.match(html, /Banner/, `Banner heading missing when hasBanner=${hasBanner}`);
  }
});
