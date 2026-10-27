// Full-bleed bands on a public page: the band spans the viewport, its
// content stays capped, a wave edge is drawn in the band's color, and
// every built-in section theme gives the band its own background.

import { expect, test } from './coverage-fixtures.ts';
import { seedBlockPage } from './seed-blocks.ts';

const ADMIN_TOKEN = 'e2e-test-token-do-not-use-in-prod';
const THEMES = ['light', 'light-bold', 'dark', 'dark-bold'];
const SLUG = 'e2e-sections';

function band(theme: string, edge: 'straight' | 'wave' = 'straight'): Record<string, unknown> {
  return {
    type: 'grid',
    slots: { cols: 2, band: true, theme, edge },
    children: [
      { type: 'text', markdown: `## ${theme}\n\nA band in the ${theme} theme.` },
      { type: 'text', markdown: 'Second column.' }
    ]
  };
}

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('/login');
  await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
  await Promise.all([
    page.waitForURL((url) => new URL(url).pathname === '/'),
    page.getByRole('button', { name: /Sign in with token/ }).click()
  ]);
  await seedBlockPage(page, {
    slug: SLUG,
    title: 'Sections',
    kind: 'page',
    body: [band('dark', 'wave'), ...THEMES.map((t) => band(t))]
  });
  await page.close();
});

for (const size of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 }
]) {
  test(`bands at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto(`/${SLUG}`);
    const sections = page.locator('section.rkr-section');
    await expect(sections).toHaveCount(5);

    const m = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.width = 'var(--rkr-content)';
      document.body.append(probe);
      const content = probe.getBoundingClientRect().width;
      probe.remove();
      const bg = (el: Element) => getComputedStyle(el).backgroundColor;
      const pageBg = bg(document.body);
      const bands = [...document.querySelectorAll('section.rkr-section')].map((s) => {
        const r = s.getBoundingClientRect();
        const inner = s.querySelector(':scope > .rkr-section-inner') as Element;
        const wave = s.querySelector(':scope > .rkr-section-wave');
        return {
          left: r.left,
          right: r.right,
          bg: bg(s),
          inner: inner.getBoundingClientRect().width,
          wave: wave ? { height: wave.getBoundingClientRect().height, bg: bg(wave) } : null
        };
      });
      return { content, pageBg, clientWidth: document.documentElement.clientWidth, bands };
    });

    for (const b of m.bands) {
      expect(b.left).toBeLessThanOrEqual(0.5);
      expect(b.right).toBeGreaterThanOrEqual(m.clientWidth - 0.5);
      expect(b.inner).toBeLessThanOrEqual(m.content + 0.5);
      expect(b.bg).not.toBe(m.pageBg);
    }
    const [waved, ...themed] = m.bands;
    expect(waved?.wave?.height).toBeGreaterThan(0);
    expect(waved?.wave?.bg).toBe(waved?.bg);
    expect(new Set(themed.map((b) => b.bg)).size).toBe(THEMES.length);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
      )
    ).toBe(true);
  });
}
