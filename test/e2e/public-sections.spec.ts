// Full-bleed bands on a public page: the band spans the viewport, its
// content stays capped, a wave edge is drawn in the band's color, and
// every built-in section theme gives the band its own background.

import { expect, test } from './coverage-fixtures.ts';
import { seedBlockPage } from './seed-blocks.ts';

const ADMIN_TOKEN = 'e2e-test-token-do-not-use-in-prod';
const THEMES = ['light', 'light-bold', 'dark', 'dark-bold'];
const SLUG = 'e2e-sections';
const HERO_SLUG = 'e2e-hero-no-image';

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
    body: [
      ...THEMES.map((t) => band(t)),
      {
        type: 'grid',
        slots: { cols: 2, min: 'narrow' },
        children: [band('dark-bold'), { type: 'text', markdown: 'Beside the nested band.' }]
      },
      band('dark', 'wave')
    ]
  });
  await seedBlockPage(page, {
    slug: HERO_SLUG,
    title: 'Hero',
    kind: 'page',
    body: [{ type: 'macro', macro: 'hero', slots: {} }]
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
    await expect(page.locator('section.rkr-section')).toHaveCount(6);

    const m = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.width = 'var(--rkr-content)';
      document.body.append(probe);
      const content = probe.getBoundingClientRect().width;
      probe.remove();
      const bg = (el: Element) => getComputedStyle(el).backgroundColor;
      const pageBg = bg(document.body);
      const all = [...document.querySelectorAll('section.rkr-section')];
      const nestedEl = all.find((s) => s.closest('.rkr-grid-cell')) as Element;
      const cell = (nestedEl.closest('.rkr-grid-cell') as Element).getBoundingClientRect();
      const nr = nestedEl.getBoundingClientRect();
      const nested = { left: nr.left, right: nr.right, cellLeft: cell.left, cellRight: cell.right };
      const main = (document.querySelector('main') as Element).getBoundingClientRect();
      const bands = all
        .filter((s) => s !== nestedEl)
        .map((s) => {
          const r = s.getBoundingClientRect();
          const inner = s.querySelector(':scope > .rkr-section-inner') as Element;
          const wave = s.querySelector(':scope > .rkr-section-wave');
          return {
            left: r.left,
            right: r.right,
            bg: bg(s),
            inner: inner.getBoundingClientRect().width,
            wave: wave
              ? {
                  height: wave.getBoundingClientRect().height,
                  bottom: wave.getBoundingClientRect().bottom,
                  bg: bg(wave)
                }
              : null
          };
        });
      return {
        content,
        pageBg,
        clientWidth: document.documentElement.clientWidth,
        bands,
        nested,
        mainBottom: main.bottom
      };
    });

    for (const b of m.bands) {
      expect(b.left).toBeLessThanOrEqual(0.5);
      expect(b.right).toBeGreaterThanOrEqual(m.clientWidth - 0.5);
      expect(b.inner).toBeLessThanOrEqual(m.content + 0.5);
      expect(b.bg).not.toBe(m.pageBg);
    }
    const themed = m.bands.slice(0, THEMES.length);
    const waved = m.bands[THEMES.length];
    expect(waved?.wave?.height).toBeGreaterThan(0);
    expect(waved?.wave?.bg).toBe(waved?.bg);
    expect(waved?.wave?.bottom).toBeLessThanOrEqual(m.mainBottom + 0.5);
    expect(m.nested.left).toBeGreaterThanOrEqual(m.nested.cellLeft - 0.5);
    expect(m.nested.right).toBeLessThanOrEqual(m.nested.cellRight + 0.5);
    expect(new Set(themed.map((b) => b.bg)).size).toBe(THEMES.length);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
      )
    ).toBe(true);
  });
}

test('a hero with no image gives its text the band inner width', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${HERO_SLUG}`);
  const m = await page.evaluate(() => {
    const band = document.querySelector('section.rkr-macro-hero') as Element;
    const inner = band.querySelector(':scope > .rkr-section-inner') as Element;
    const grid = band.querySelector('.rkr-grid[data-widths]') as Element;
    const cells = grid.querySelectorAll(':scope > .rkr-grid-cell');
    const width = (el: Element) => el.getBoundingClientRect().width;
    return { inner: width(inner), cells: cells.length, text: width(cells[0] as Element) };
  });
  expect(m.cells).toBe(1);
  expect(m.text).toBeGreaterThan(m.inner - 1);
});
