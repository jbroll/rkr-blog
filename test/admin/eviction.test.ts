// Admin-side eviction integration: runEviction must not reclaim an
// original whose only live reference is a queued savePost outbox
// entry (its upload entry already drained, no live DOM <img>).

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import type { OutboxEntry } from '../../src/lib/outbox-types.ts';
import { installMockOpfs } from './opfs-mock.ts';

const { resetMockOpfs } = installMockOpfs();

const { writeJson, writeBlob } = await import('../../src/admin/opfs.ts');
const { runEviction } = await import('../../src/admin/eviction.ts');

const STALE = new Date(Date.parse('2026-01-01T00:00:00Z')).toISOString();
const NOW = Date.parse('2026-05-17T00:00:00Z');

async function seedMeta(draftId: string, refIds: string[]): Promise<void> {
  await writeJson(`meta/${draftId}.json`, {
    schemaVersion: 1,
    draftId,
    mode: 'cached',
    lastAccessedAt: STALE,
    refIds
  });
}

async function seedOriginal(id: string): Promise<void> {
  await writeBlob(`originals/${id}.webp`, new Blob([new Uint8Array([1, 2, 3])]));
}

async function seedSavePost(seq: number, markdown: string): Promise<void> {
  const entry: OutboxEntry = {
    seq,
    createdAt: new Date(NOW).toISOString(),
    deviceId: 'dev',
    draftId: `draft-${seq}`,
    op: 'savePost',
    payload: { slug: '', title: 'Untitled', markdown }
  };
  await writeJson(`outbox/${seq}.savePost.json`, entry);
}

beforeEach(() => {
  resetMockOpfs();
});

test('runEviction: original referenced only by a queued savePost survives', async () => {
  // A surviving meta exists (so haveAnyMetas → orphan cleanup runs)
  // but it does NOT reference img-X. img-X is referenced solely by a
  // queued savePost's markdown — no upload entry, no live DOM.
  await seedMeta('other-draft', ['unrelated']);
  await seedOriginal('img-X');
  await seedSavePost(1, 'intro\n\n::figure{ids=img-X width=600}\n\nmore');

  const plan = await runEviction(NOW);

  assert.ok(
    !plan.evictOriginals.includes('img-X'),
    'img-X is referenced by a queued savePost and must not be evicted'
  );
});

test('runEviction: an original referenced by nothing is still evicted', async () => {
  // Inverse sanity — no over-protection regression. img-Y is in no
  // meta, no savePost, no upload, no DOM → genuine orphan.
  await seedMeta('other-draft', ['unrelated']);
  await seedOriginal('img-Y');
  await seedSavePost(1, 'just text, no figures here');

  const plan = await runEviction(NOW);

  assert.ok(
    plan.evictOriginals.includes('img-Y'),
    'img-Y is referenced by nothing and must remain evictable'
  );
});
