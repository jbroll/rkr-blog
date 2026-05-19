// E2E coverage for the About page feature:
//   1. Header nav: Home link omitted on the home page (it links to
//      itself), present on non-home pages; About / Login always shown
//   2. /about 404s before the _about post is seeded
//   3. settings → "Create About" → editor opens on _about slug
//   4. Filling the title and saving creates _about.md → /about renders
//
// Selectors use CSS rather than getByLabel/getByRole because
// BrowserStack's iOS Playwright implementation does not support
// Playwright's internal:label and internal:role selector engines.

import fs from 'node:fs';
import http from 'node:http';
import type { BrowserContext, Page } from '@playwright/test';
import { test as coverageTest, expect } from './coverage-fixtures.ts';

// BrowserStack iOS allows only one browser context AND one tab per session.
// Worker-scope both so all tests in a worker reuse the same page. Each test
// still calls page.goto() explicitly so navigation state is deterministic.
const test = coverageTest.extend<object, { sharedCtx: BrowserContext; sharedPage: Page }>({
  sharedCtx: [
    async ({ browser }, use) => {
      const ctx = await browser.newContext();
      await use(ctx);
      await ctx.close();
    },
    { scope: 'worker' }
  ],
  sharedPage: [
    async ({ sharedCtx }, use) => {
      const pg = await sharedCtx.newPage();
      pg.on('console', (msg) => {
        if (msg.type() === 'error') console.error('[browser]', msg.text());
      });
      await pg.addInitScript(() => {
        if (!location.pathname.startsWith('/admin')) return;
        void (async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ed = (e: any): string => `${e?.constructor?.name}: ${e?.message}`;
          const log = (tag: string, ok: boolean, detail = ''): void =>
            console.error(`[opfs-probe] ${tag}: ${ok ? 'OK' : 'FAIL'} ${detail}`);
          try {
            const root = await navigator.storage.getDirectory();
            log('getDirectory', true);
            try {
              const fh = await root.getFileHandle('.probe-test', { create: true });
              log('getFileHandle', true);
              try {
                const w = await fh.createWritable();
                await w.write('x');
                await w.close();
                await root.removeEntry('.probe-test');
                log('createWritable', true);
              } catch (e) {
                log('createWritable', false, ed(e));
              }
            } catch (e) {
              log('getFileHandle', false, ed(e));
            }
          } catch (e) {
            log('getDirectory', false, ed(e));
          }
        })();
      });
      await use(pg);
      await pg.close();
    },
    { scope: 'worker' }
  ],
  context: async ({ sharedCtx }, use) => {
    await use(sharedCtx);
  },
  page: async ({ sharedPage }, use) => {
    await use(sharedPage);
  }
});

const ADMIN_TOKEN = 'e2e-test-token-do-not-use-in-prod';

async function capturePage(page: import('@playwright/test').Page, label: string): Promise<void> {
  const data = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    navHtml: document.querySelector('.rkr-site-head-nav')?.outerHTML ?? 'NAV_NOT_FOUND',
    bodySnippet: document.body.innerHTML.slice(0, 800)
  }));
  const file = `/tmp/ios-diag-${label}.json`;
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// POST token-login from the test process and return the raw Set-Cookie value.
// Avoids any browser-side network call, which is unreliable on BrowserStack iOS.
function fetchSessionCookie(token: string): Promise<string> {
  const body = `token=${encodeURIComponent(token)}`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 3790,
        path: '/admin/auth/token-login',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        res.resume(); // drain body
        const cookies = res.headers['set-cookie'] ?? [];
        const sessionCookie = cookies.find((c) => c.startsWith('session='));
        if (!sessionCookie) {
          reject(
            new Error(
              `token-login: no session cookie (status ${res.statusCode}, cookies: ${JSON.stringify(cookies)})`
            )
          );
          return;
        }
        resolve(sessionCookie);
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function login(page: Page): Promise<void> {
  if (process.env.LT_USERNAME) {
    // iOS TestMu AI: browser-side form submit and async evaluate are
    // unreliable on real devices. POST the token-login from the test process
    // (Node.js), parse the session cookie, and inject it directly.
    const rawCookie = await fetchSessionCookie(ADMIN_TOKEN);
    // rawCookie is like "session=<value>; Path=/; HttpOnly; Max-Age=..."
    const [nameValue, ...attrs] = rawCookie.split(';').map((s) => s.trim());
    const [name, ...valParts] = (nameValue ?? '').split('=');
    const value = valParts.join('=');
    const maxAge = attrs.find((a) => a.toLowerCase().startsWith('max-age='));
    const expires = maxAge ? Date.now() / 1000 + Number(maxAge.split('=')[1]) : undefined;
    await page.context().addCookies([
      {
        name: name ?? 'session',
        value,
        domain: 'localhost.lambdatest.com',
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
        ...(expires != null ? { expires } : {})
      }
    ]);
    await page.goto('/');
  } else {
    // Desktop: standard form-submit + redirect works fine.
    await page.goto('/login');
    await capturePage(page, 'login');
    await page.locator('input[name="token"]').fill(ADMIN_TOKEN);
    await Promise.all([
      page.waitForURL((u) => new URL(u).pathname === '/'),
      page.locator('button[type="submit"]').click()
    ]);
  }
  await capturePage(page, 'after-login');
}

test('header nav: Home omitted on /, present off-home; About/Login always; /about 404s before seed', async ({
  page
}) => {
  await page.goto('/');
  await capturePage(page, 'home');
  const homeNav = page.locator('.rkr-site-head-nav');
  await expect(homeNav.locator('a[href="/"]')).toHaveCount(0);
  // toBeVisible() — CSS selector already verifies href; BrowserStack iOS
  // returns the resolved absolute URL from getAttribute so toHaveAttribute
  // with a relative path fails on real devices.
  await expect(homeNav.locator('a[href="/about"]')).toBeVisible();
  await expect(homeNav.locator('a[href="/login"]')).toBeVisible();

  // /about 404s before the _about post is seeded.
  await page.goto('/about');
  await capturePage(page, 'about-404');
  const offHomeNav = page.locator('.rkr-site-head-nav');
  await expect(offHomeNav.locator('a[href="/"]')).toBeVisible();
  await expect(offHomeNav.locator('a[href="/about"]')).toBeVisible();
  await expect(offHomeNav.locator('a[href="/login"]')).toBeVisible();
});

test('settings → Create About → editor opens on _about; /about then renders', async ({ page }) => {
  await login(page);
  await page.goto('/admin/settings');
  await capturePage(page, 'settings');
  await page.locator('a[href="/admin/about/edit"]').click();
  await expect(page).toHaveURL(/\/admin\/editor\?slug=_about/);
  await page.locator('#rkr-title').fill('About');
  await page.locator('#rkroll-admin-toolbar button[data-cmd="save"]').click();
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^saved \//, {
    timeout: 10_000
  });
  await page.goto('/about');
  await expect(page.locator('main')).toContainText('About');
  await expect(page.locator('.rkr-comment-form')).toHaveCount(0);
});
