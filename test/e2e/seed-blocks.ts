// Shared e2e seed for a published page through the blocks save API.
//
// After Task 3 the markdown editor (and its write endpoint) is gone;
// specs that only need a real page on disk should drive the live JSON
// blocks endpoint. The save handler reindexes, so the page is
// immediately visible on / and /:slug.

import type { Page } from '@playwright/test';

export interface BlockSeed {
  slug: string;
  title: string;
  /** Markdown for one text leaf (prose only — media uses block nodes). */
  markdown?: string;
  /** Explicit block body, e.g. `[figureBlock(id)]`. Overrides markdown. */
  body?: Record<string, unknown>[];
  status?: 'draft' | 'published';
  tags?: string[];
  date?: string;
}

/** Figure leaf. `ids` may be a comma-separated list (carousel/matrix). */
export function figureBlock(
  ids: string,
  slots: Record<string, string> = {}
): Record<string, unknown> {
  return { type: 'figure', slots: { ids, ...slots } };
}

/** Video leaf. */
export function videoBlock(
  ids: string,
  slots: Record<string, string> = {}
): Record<string, unknown> {
  return { type: 'video', slots: { ids, ...slots } };
}

export async function seedBlockPage(page: Page, seed: BlockSeed): Promise<void> {
  const { slug, title, markdown = '', body, status = 'published', tags, date } = seed;
  const fields: Record<string, unknown> = { title, slug, status };
  if (tags) fields.tags = tags;
  if (date) fields.date = date;

  const res = await page.request.post(`/admin/blocks/${encodeURIComponent(slug)}`, {
    data: {
      tree: {
        version: 1,
        body: body ?? (markdown ? [{ type: 'text', markdown }] : []),
        fields
      }
    }
  });
  if (res.status() !== 200) {
    throw new Error(`seed blocks page ${slug}: ${res.status()} ${await res.text()}`);
  }
}
