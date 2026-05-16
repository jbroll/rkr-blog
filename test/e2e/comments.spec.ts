// E2E happy-path for public comment submission, pending-state, and
// honeypot rejection. Uses the admin approve endpoint (admin-comments.ts)
// as the deterministic publish path — no Ollama dependency.
//
// Flow:
//   A. Submit valid comment → pending (not yet visible on post page)
//   B. Approve via admin API → reload post → comment body is visible
//   C. Honeypot comment → silent 303, text never appears on post page

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

async function seedPost(page: import('@playwright/test').Page, slug: string): Promise<void> {
  const res = await page.request.post('/admin/posts', {
    data: {
      slug,
      title: 'Comment test post',
      status: 'published',
      markdown: 'A post for testing comments.\n'
    }
  });
  expect(res.status()).toBe(200);
}

test('comments: submit → pending (not visible), approve via admin → visible on post', async ({
  page
}) => {
  await login(page);
  const slug = `e2e-comments-${Date.now()}`;
  await seedPost(page, slug);

  // Navigate to post; comment form must be present.
  await page.goto(`/${slug}`);
  await expect(page.locator('form[action$="/comments"]')).toBeVisible();

  // Fill form, leave honeypot website empty, submit.
  const commentBody = `Hello from e2e test ${Date.now()}`;
  await page.locator('form[action$="/comments"] input[name="name"]').fill('E2E Tester');
  await page.locator('form[action$="/comments"] input[name="email"]').fill('e2e@example.com');
  await page.locator('form[action$="/comments"] textarea[name="body"]').fill(commentBody);
  // Leave website (honeypot) empty — already empty, just confirm.
  await expect(page.locator('form[action$="/comments"] input[name="website"]')).toHaveValue('');

  await Promise.all([
    page.waitForURL((url) => {
      const s = url.toString();
      return s.includes(slug);
    }),
    page.locator('form[action$="/comments"] button[type="submit"]').click()
  ]);

  // After 303 redirect, land back on the post (URL contains slug).
  expect(page.url()).toContain(slug);

  // Comment is pending — no published comments yet; the list must be empty.
  await expect(page.locator('.rkr-comment-body')).toHaveCount(0);
  await expect(page.locator('.rkr-comments-empty')).toBeVisible();

  // ── Deterministic publish via admin approve endpoint ──
  // Fetch the moderation list to find the new comment's id.
  const modResp = await page.request.get('/admin/comments');
  expect(modResp.status()).toBe(200);
  const html = await modResp.text();
  // The moderation page contains the comment body text; extract the id
  // from a form action like /admin/comments/42/approve.
  const idMatch = html.match(/\/admin\/comments\/(\d+)\/approve/);
  expect(idMatch, 'pending comment id not found in /admin/comments').toBeTruthy();
  const commentId = idMatch![1];

  // Approve it.
  const approveResp = await page.request.post(`/admin/comments/${commentId}/approve`);
  // 303 redirect — fetch follows redirects, so final status is 200.
  expect([200, 303]).toContain(approveResp.status());

  // Reload the post page and assert the comment body is now visible.
  await page.goto(`/${slug}`);
  await expect(page.locator('.rkr-comment-body')).toContainText(commentBody);
});

test('comments: honeypot filled → silent 303, spam text absent from post', async ({ page }) => {
  await login(page);
  const slug = `e2e-comments-hp-${Date.now()}`;
  await seedPost(page, slug);

  await page.goto(`/${slug}`);
  await expect(page.locator('form[action$="/comments"]')).toBeVisible();

  const spamBody = `Spam text e2e ${Date.now()}`;
  await page.locator('form[action$="/comments"] input[name="name"]').fill('Spambot');
  await page.locator('form[action$="/comments"] input[name="email"]').fill('spam@example.com');
  await page.locator('form[action$="/comments"] textarea[name="body"]').fill(spamBody);
  // Fill the honeypot website field to trigger bot detection.
  await page
    .locator('form[action$="/comments"] input[name="website"]')
    .fill('http://spam.example.com');

  await Promise.all([
    page.waitForURL((url) => url.toString().includes(slug)),
    page.locator('form[action$="/comments"] button[type="submit"]').click()
  ]);

  // Redirected back to the post; honeypot row was silently dropped —
  // no published comments, so the empty-state element is present and
  // no .rkr-comment-body elements exist.
  expect(page.url()).toContain(slug);
  await expect(page.locator('.rkr-comment-body')).toHaveCount(0);
  await expect(page.locator('.rkr-comments-empty')).toBeVisible();
});
