import { expect, test } from './coverage-fixtures.ts';
import { seedBlockPage } from './seed-blocks.ts';

const ADMIN_TOKEN = 'e2e-test-token-do-not-use-in-prod';

test('a cards list filled from a tag lists pages by order, and members link back', async ({
  page
}) => {
  await page.goto('/login');
  await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
  await Promise.all([
    page.waitForURL((url: URL) => url.pathname === '/'),
    page.getByRole('button', { name: /Sign in with token/ }).click()
  ]);

  await seedBlockPage(page, {
    slug: 'board',
    title: 'Board',
    kind: 'page',
    body: [{ type: 'macro', macro: 'cards', slots: {} }]
  });
  await seedBlockPage(page, { slug: 'alice', title: 'Alice', tags: ['board'], order: 2 });
  await seedBlockPage(page, { slug: 'bob', title: 'Bob', tags: ['board'], order: 1 });

  await page.goto('/admin/blocks/edit/board');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('#rkr-blocks-page-body .rkr-macro-cards').first().click();
  await page.getByRole('button', { name: 'Configure', exact: true }).click();
  const dialog = page.getByLabel('Edit Cards');
  await dialog.getByLabel('Fill from').selectOption('tag');
  await dialog.getByLabel('Tag', { exact: true }).fill('board');
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/admin/blocks/board') && r.request().method() === 'POST'
  );
  await dialog.getByRole('button', { name: 'Save' }).click();
  await saved;

  await page.goto('/board');
  const main = page.locator('main');
  await expect(main).toContainText('Bob');
  const text = await main.innerText();
  expect(text.indexOf('Bob')).toBeLessThan(text.indexOf('Alice'));

  await page.goto('/alice');
  await expect(page.getByRole('link', { name: /Back to/ })).toHaveAttribute('href', '/board');
});
