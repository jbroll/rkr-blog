// Header from settings: the menu folds behind a toggle on a phone and
// opens with JavaScript off; the announcement bar closes and stays closed.

import type { Browser, Page } from '@playwright/test';
import sharp from 'sharp';
import { expect, test } from './coverage-fixtures.ts';

const ADMIN_TOKEN = 'e2e-test-token-do-not-use-in-prod';

async function adminPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await login(page);
  return page;
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
  await Promise.all([
    page.waitForURL((url) => new URL(url).pathname === '/'),
    page.getByRole('button', { name: /Sign in with token/ }).click()
  ]);
}

async function saveSettings(page: Page, fill: () => Promise<void>): Promise<void> {
  await page.goto('/admin/settings');
  await fill();
  await Promise.all([
    page.waitForURL(/flash=saved/),
    page.locator('form.rkr-admin-settings .rkr-admin-settings-submit').first().click()
  ]);
}

test.beforeAll(async ({ browser }) => {
  const page = await adminPage(browser);
  await saveSettings(page, async () => {
    await page.locator('[name="menu.0.label"]').fill('Visit');
    await page.locator('[name="menu.0.href"]').fill('/visit');
    await page.locator('[name="menu.1.label"]').fill('Shop');
    await page.locator('[name="menu.1.href"]').fill('/shop');
    await page.locator('[name="ctaLabel"]').fill('Join');
    await page.locator('[name="ctaHref"]').fill('/join');
    await page.locator('[name="social.0.platform"]').selectOption('email');
    await page.locator('[name="social.0.url"]').fill('hi@example.org');
    await page.locator('[name="announcementText"]').fill('Open day Saturday');
    await page.locator('[name="announcementOn"]').check();
  });
  await page.close();
});

test.afterAll(async ({ browser }) => {
  const page = await adminPage(browser);
  await saveSettings(page, async () => {
    for (const name of ['menu.0.label', 'menu.0.href', 'menu.1.label', 'menu.1.href']) {
      await page.locator(`[name="${name}"]`).fill('');
    }
    await page.locator('[name="ctaLabel"]').fill('');
    await page.locator('[name="ctaHref"]').fill('');
    await page.locator('[name="social.0.url"]').fill('');
    await page.locator('[name="announcementOn"]').uncheck();
  });
  await page.close();
});

test.describe('with JavaScript disabled', () => {
  test.use({ javaScriptEnabled: false });

  test('at 390px the menu is folded and the toggle opens it', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const menu = page.locator('nav.rkr-site-menu');
    const toggle = page.locator('label.rkr-menu-toggle-btn');
    await expect(menu).toBeHidden();
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Shop' })).toBeVisible();
    await expect(page.locator('.rkr-announce')).toBeVisible();
    await expect(page.locator('.rkr-announce-close')).toBeHidden();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
      )
    ).toBe(true);
  });

  test('at 1440px the menu is open and there is no toggle', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const menu = page.locator('nav.rkr-site-menu');
    await expect(menu).toBeVisible();
    await expect(page.locator('label.rkr-menu-toggle-btn')).toBeHidden();
    await expect(menu.getByRole('link', { name: 'Visit' })).toHaveAttribute('href', '/visit');
    await expect(menu.locator('a.rkr-btn')).toHaveText('Join');
    await expect(menu.getByRole('link', { name: 'Email' })).toHaveAttribute(
      'href',
      'mailto:hi@example.org'
    );
    await expect(page.locator('header a[href="/login"]')).toHaveCount(0);
  });
});

test('closing the announcement is remembered across page loads', async ({ page }) => {
  await page.goto('/');
  const bar = page.locator('.rkr-announce');
  await expect(bar).toBeVisible();
  await page.locator('.rkr-announce-close').click();
  await expect(bar).toBeHidden();
  await page.reload();
  await expect(bar).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('rkr-announce-dismissed'))).toMatch(
    /^[0-9a-f]{16}$/
  );
});

test('the settings page uploads a logo into the hidden field and removes it', async ({ page }) => {
  await login(page);
  await page.goto('/admin/settings');
  const buffer = await sharp({
    create: { width: 300, height: 100, channels: 3, background: { r: 200, g: 40, b: 40 } }
  })
    .png()
    .toBuffer();
  await page
    .locator('#rkr-settings-logo-file')
    .setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer });
  const id = page.locator('input[name="logo"]');
  await expect(id).toHaveValue(/^[0-9a-f]{64}$/);
  await expect(page.locator('.rkr-admin-settings-logo-thumb')).toBeVisible();
  await page.locator('.rkr-admin-settings-logo-remove').click();
  await expect(id).toHaveValue('');
  await expect(page.locator('.rkr-admin-settings-logo-thumb')).toBeHidden();
});
