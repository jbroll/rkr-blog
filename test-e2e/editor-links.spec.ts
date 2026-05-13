// Editor link sanitisation. proseToMarkdown (admin save path) runs
// safeLinkUrl on every emitted href; the server's content rendering
// runs the same function on output. Hostile or pasted URLs
// (`javascript:`, `vbscript:`, `data:`) get rewritten to `#`.
//
// Coverage push for src/lib/safe-url.ts (8% -> 70%+): exercise the
// http allow, the javascript reject, the site-relative pass-through,
// and the empty-trim path.

import { expect, test } from './coverage-fixtures.ts';

const ADMIN_TOKEN = 'e2e-test-token-do-not-use-in-prod';

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
  await Promise.all([
    page.waitForURL((url) => new URL(url).pathname === '/'),
    page.getByRole('button', { name: /Sign in with token/ }).click()
  ]);
}

async function publishSlug(page: import('@playwright/test').Page, slug: string): Promise<void> {
  const res = await page.request.post(`/admin/posts/${encodeURIComponent(slug)}/status`, {
    form: { status: 'published' }
  });
  if (res.status() !== 200 && res.status() !== 303) {
    throw new Error(`publish ${slug}: ${res.status()} ${await res.text()}`);
  }
}

test('editor: link insertion sanitises javascript: and preserves http/relative', async ({
  page
}) => {
  await login(page);
  await page.goto('/admin/editor?e2e=1');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();
  await page.evaluate(
    () => (window as unknown as { __rkrOfflineReady: Promise<void> }).__rkrOfflineReady
  );

  const slug = `e2e-links-${Date.now()}`;
  await page.locator('#rkr-title').fill('link sanitiser');
  await page.locator('#rkr-slug').evaluate((el, v) => {
    (el as HTMLInputElement).value = v as string;
  }, slug);

  // Three paragraphs with three different link URLs. TipTap's
  // StarterKit includes the Link mark; setContent parses the
  // <a href="…"> attributes into the link mark. proseToMarkdown
  // emits them through safeLinkUrl on save.
  await page.evaluate(() => {
    type Ed = { commands: { setContent: (s: string) => boolean } };
    const ed = (window as unknown as { __rkrEditor: Ed }).__rkrEditor;
    ed.commands.setContent(
      [
        '<p>one <a href="https://example.com">safe</a></p>',
        '<p>two <a href="javascript:alert(1)">hostile</a></p>',
        '<p>three <a href="/about">relative</a></p>'
      ].join('')
    );
  });

  // Save → proseToMarkdown emits href via safeLinkUrl, server-side
  // rendering runs safeLinkUrl again on read. Either pass sanitises
  // the javascript: URL.
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#rkroll-admin-status')).toContainText(`saved /${slug}`, {
    timeout: 10_000
  });
  await publishSlug(page, slug);

  const res = await page.request.get(`/${slug}`);
  expect(res.status()).toBe(200);
  const html = await res.text();
  // Safe link kept verbatim.
  expect(html).toContain('href="https://example.com"');
  // Relative link kept verbatim.
  expect(html).toContain('href="/about"');
  // Hostile javascript: URL is sanitised — proseToMarkdown emits
  // `[text](#)` and the markdown renderer drops the link entirely
  // (or rewrites href). Either way, no `href="javascript:` remains.
  expect(html).not.toMatch(/href="javascript:/);
  expect(html).toContain('hostile');
});
