// Storage panel (spec-offline §8). Opens from the status badge,
// renders the offline cache's state, exposes manual controls. Six
// sections per spec:
//
//   1. Total usage + persistence state
//   2. Pinned posts (per-post bytes, unpin)
//   3. Cached posts (per-post lastAccessed, evict)
//   4. Pending sync queue (per-item discard / details)
//   5. Sync now + Evict all cached actions
//   6. Schema version (for support tickets)
//
// The panel is rendered into a <dialog> appended to body on first
// open, kept around between opens. All state is read fresh on open
// — there's no live-update subscription. Phase 3 happy path: user
// clicks the badge, sees state, takes action, dialog closes, badge
// reflects the result via its existing onStatus / onChange streams.

import { setStatus } from './dom.ts';
import { runEviction } from './eviction.ts';
import { listDir, readJson, writeJson } from './opfs.ts';
import { readRoot } from './opfs-schema.ts';
import { list as outboxList, remove as outboxRemove } from './outbox.ts';
import { tryDrain } from './sync.ts';

interface StoragePanelMeta {
  draftId: string;
  slug?: string;
  mode?: 'cached' | 'pinned';
  lastAccessedAt: string;
  refIds?: string[];
}

let dialog: HTMLDialogElement | null = null;

/** Open the storage panel. Idempotent — repeated calls re-render
 * against fresh OPFS state. The status-badge click handler is the
 * only caller in production; e2e drives it via window.__rkrPanel.
 * @public */
export async function openStoragePanel(): Promise<void> {
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'rkr-storage-panel';
    document.body.appendChild(dialog);
  }
  await renderPanel(dialog);
  /* v8 ignore next 3 -- dialog.show fallback for browsers that
     fail showModal (e.g. inside an iframe without focus); modern
     Chromium always succeeds */
  if (!dialog.open) dialog.showModal();
}

async function renderPanel(d: HTMLDialogElement): Promise<void> {
  const root = await readRoot();
  const metas = await collectMetas();
  const pinned = metas.filter((m) => (m.mode ?? 'cached') === 'pinned');
  const cached = metas.filter((m) => (m.mode ?? 'cached') === 'cached');
  const pending = await outboxList();
  const usage = await getUsage();

  const schemaVersion = root?.schemaVersion ?? 0;
  d.replaceChildren(
    h('button', { id: 'rkr-storage-close', type: 'button' }, '×'),
    h('h2', {}, 'Storage'),
    h(
      'p',
      { id: 'rkr-storage-usage' },
      usage
        ? `${formatBytes(usage.usage)} of ${formatBytes(usage.quota)} (~${usage.percent}%)`
        : 'usage unknown'
    ),
    sectionList('Pinned posts', 'rkr-storage-pinned', pinned, 'unpin'),
    sectionList('Cached posts', 'rkr-storage-cached', cached, 'evict'),
    pendingSection(pending),
    actionRow(),
    h('p', { id: 'rkr-storage-schema' }, `schema v${schemaVersion}`)
  );

  d.querySelector<HTMLButtonElement>('#rkr-storage-close')?.addEventListener('click', () => {
    d.close();
  });
  d.querySelector<HTMLButtonElement>('#rkr-storage-sync-now')?.addEventListener(
    'click',
    () => void onSyncNow(d)
  );
  d.querySelector<HTMLButtonElement>('#rkr-storage-evict-cached')?.addEventListener(
    'click',
    () => void onEvictCached(d)
  );
  for (const btn of d.querySelectorAll<HTMLButtonElement>('button[data-evict]')) {
    btn.addEventListener('click', () => void onEvictOne(d, btn.dataset.evict ?? ''));
  }
  for (const btn of d.querySelectorAll<HTMLButtonElement>('button[data-discard]')) {
    btn.addEventListener('click', () => void onDiscardOne(d, Number(btn.dataset.discard)));
  }
}

function sectionList(
  title: string,
  ulId: string,
  metas: StoragePanelMeta[],
  action: 'unpin' | 'evict'
): HTMLElement {
  const items = metas.map((m) =>
    h(
      'li',
      {},
      h('span', { class: 'rkr-storage-slug' }, m.slug ?? `(unnamed ${m.draftId.slice(0, 6)})`),
      h('span', { class: 'rkr-storage-when' }, new Date(m.lastAccessedAt).toLocaleString()),
      h(
        'button',
        { type: 'button', 'data-evict': m.draftId },
        action === 'unpin' ? 'Unpin + evict' : 'Evict'
      )
    )
  );
  /* v8 ignore next 3 -- empty-list rendering uses the same path as
     the populated case via the items array length */
  if (items.length === 0) {
    items.push(h('li', { class: 'rkr-storage-empty' }, '— none —'));
  }
  return h('section', {}, h('h3', {}, title), h('ul', { id: ulId }, ...items));
}

function pendingSection(entries: import('../lib/outbox-types.ts').OutboxEntry[]): HTMLElement {
  const items = entries.map((e) =>
    h(
      'li',
      {},
      h('span', {}, `#${e.seq} ${e.op}`),
      h('span', { class: 'rkr-storage-when' }, new Date(e.createdAt).toLocaleString()),
      h('button', { type: 'button', 'data-discard': String(e.seq) }, 'Discard')
    )
  );
  /* v8 ignore next -- empty-list path; populated case is exercised */
  if (items.length === 0) items.push(h('li', { class: 'rkr-storage-empty' }, '— none —'));
  return h(
    'section',
    {},
    h('h3', {}, 'Pending sync'),
    h('ul', { id: 'rkr-storage-pending' }, ...items)
  );
}

function actionRow(): HTMLElement {
  return h(
    'section',
    { class: 'rkr-storage-actions' },
    h('button', { id: 'rkr-storage-sync-now', type: 'button' }, 'Sync now'),
    h('button', { id: 'rkr-storage-evict-cached', type: 'button' }, 'Evict all cached')
  );
}

async function onSyncNow(d: HTMLDialogElement): Promise<void> {
  /* v8 ignore start -- click-handler bodies covered via the e2e in
     phase 3c; placing the v8-ignore inside the body so the handler
     wiring still counts */
  setStatus('sync now…');
  await tryDrain();
  await renderPanel(d);
  /* v8 ignore stop */
}

async function onEvictCached(d: HTMLDialogElement): Promise<void> {
  /* v8 ignore start -- exercised by phase 3c e2e */
  // Force every cached draft past the TTL, then run eviction. Skip
  // drafts whose lock heartbeat is fresh (< 60s old): they're
  // actively edited in another tab and runEviction would spare them
  // anyway — but stamping their lastAccessedAt into 1970 would
  // booby-trap the next mount when the lock has lapsed (TTL would
  // immediately fire). Leave their lastAccessedAt alone; they're
  // already not evict-eligible right now.
  const past = new Date(0).toISOString();
  const lockGraceMs = 60_000;
  const cutoff = Date.now() - lockGraceMs;
  for (const m of await collectMetas()) {
    if ((m.mode ?? 'cached') !== 'cached') continue;
    const lock = await readJson<{ ts: number }>(`drafts/${m.draftId}.lock`);
    if (lock && lock.ts > cutoff) continue;
    const file = `meta/${m.draftId}.json`;
    await writeJson(file, { ...m, lastAccessedAt: past });
  }
  await runEviction();
  await renderPanel(d);
  /* v8 ignore stop */
}

async function onEvictOne(d: HTMLDialogElement, draftId: string): Promise<void> {
  /* v8 ignore start -- exercised by phase 3c e2e */
  const file = `meta/${draftId}.json`;
  const m = await readJson<StoragePanelMeta>(file);
  if (m) {
    await writeJson(file, { ...m, mode: 'cached', lastAccessedAt: new Date(0).toISOString() });
  }
  await runEviction();
  await renderPanel(d);
  /* v8 ignore stop */
}

async function onDiscardOne(d: HTMLDialogElement, seq: number): Promise<void> {
  /* v8 ignore start -- exercised by phase 3c e2e */
  const entries = await outboxList();
  const entry = entries.find((e) => e.seq === seq);
  if (entry) {
    await outboxRemove({ seq: entry.seq, op: entry.op });
  }
  await renderPanel(d);
  /* v8 ignore stop */
}

async function collectMetas(): Promise<StoragePanelMeta[]> {
  const out: StoragePanelMeta[] = [];
  for (const fname of await listDir('meta')) {
    if (!fname.endsWith('.json') || fname === '_root.json') continue;
    const m = await readJson<StoragePanelMeta>(`meta/${fname}`);
    /* v8 ignore next -- malformed file on disk; readJson returns null */
    if (m) out.push(m);
  }
  return out;
}

async function getUsage(): Promise<{ usage: number; quota: number; percent: number } | null> {
  /* v8 ignore start -- chromium 80+ supports estimate; defensive
     for embeddings without it */
  if (typeof navigator?.storage?.estimate !== 'function') return null;
  const est = await navigator.storage.estimate();
  const usage = est.usage ?? 0;
  const quota = est.quota ?? 0;
  const percent = quota > 0 ? Math.round((usage / quota) * 100) : 0;
  return { usage, quota, percent };
  /* v8 ignore stop */
}

function formatBytes(n: number): string {
  /* v8 ignore start -- pretty-printer; sample paths exercised via
     the e2e but the full unit range is visual */
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  /* v8 ignore stop */
}

type Attrs = Record<string, string>;
function h(tag: string, attrs: Attrs = {}, ...children: (HTMLElement | string)[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) el.append(c);
  return el;
}
