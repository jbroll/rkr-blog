import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DraftRecord, DraftStore } from '../../src/admin/unified-draft.ts';
import {
  createSavePipeline,
  SaveConflict,
  SaveFailure,
  type SavePipelineDeps
} from '../../src/admin/unified-save.ts';
import type { BlockTree } from '../../src/lib/blocks.ts';

import { FakeDocument, type FakeElement } from './fake-dom.ts';

const tick = async (n = 10): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

const TREE: BlockTree = { version: 1, body: [{ type: 'text', markdown: 'Hello' }] };

interface MemoryDrafts extends DraftStore {
  record: DraftRecord | null;
  log: string[];
}

function memoryDrafts(initial: DraftRecord | null = null): MemoryDrafts {
  const store: MemoryDrafts = {
    record: initial,
    log: [],
    load: async () => store.record,
    put: async (rec) => {
      store.log.push('put');
      store.record = rec;
    },
    clear: async (savedAt) => {
      store.log.push('clear');
      if (savedAt === undefined || store.record?.savedAt === savedAt) store.record = null;
    }
  };
  return store;
}

function harness(overrides: Partial<SavePipelineDeps> & Pick<SavePipelineDeps, 'onSave'>) {
  const doc = new FakeDocument();
  const root = doc.createElement('div');
  const shellEl = doc.createElement('div');
  const toolbar = doc.createElement('div');
  root.append(shellEl, toolbar);
  const win = new EventTarget();
  const pipeline = createSavePipeline({
    getTree: () => TREE,
    shellEl: shellEl as unknown as Element,
    toolbar: toolbar as unknown as Element,
    dialogRoot: root as unknown as Element,
    win,
    ...overrides
  });
  const pill = (): string =>
    (toolbar.querySelector('.rkr-unified-save-state') as FakeElement | null)?.textContent ?? '';
  const button = (label: string): FakeElement | undefined =>
    root.querySelectorAll('button').find((b) => b.textContent === label);
  return { pipeline, shellEl, toolbar, root, win, pill, button };
}

describe('unified save pipeline', () => {
  it('pipeline writes a draft before request and clears it on success', async () => {
    const drafts = memoryDrafts();
    const seen: { draft: DraftRecord | null; base?: string }[] = [];
    const h = harness({
      version: 'v1',
      drafts,
      onSave: async (_tree, base) => {
        drafts.log.push('send');
        seen.push({ draft: drafts.record, base });
        return 'v2';
      }
    });
    await h.pipeline.requestSave(TREE);
    await tick();
    assert.deepEqual(drafts.log, ['put', 'send', 'clear']);
    assert.equal(seen[0]?.draft?.tree, TREE);
    assert.equal(seen[0]?.draft?.baseVersion, 'v1');
    assert.equal(typeof seen[0]?.draft?.savedAt, 'number');
    assert.equal(seen[0]?.base, 'v1');
    assert.equal(drafts.record, null);
    assert.equal(h.pipeline.state(), 'clean');

    await h.pipeline.requestSave(TREE);
    assert.equal(seen[1]?.base, 'v2', 'the next save carries the returned version');
  });

  it('a draft from another save survives this save clearing its own', async () => {
    const drafts = memoryDrafts();
    const h = harness({
      version: 'v1',
      drafts,
      onSave: async () => {
        drafts.record = { tree: TREE, baseVersion: 'v1', savedAt: -1 };
        return 'v2';
      }
    });
    await h.pipeline.requestSave(TREE);
    assert.equal(drafts.record?.savedAt, -1);
  });

  it('pipeline enters offline on fetch TypeError and drains on online', async () => {
    const drafts = memoryDrafts();
    let online = false;
    const sent: BlockTree[] = [];
    const h = harness({
      version: 'v1',
      drafts,
      onSave: async (tree) => {
        if (!online) throw new TypeError('Failed to fetch');
        sent.push(tree);
        return 'v2';
      }
    });
    await h.pipeline.requestSave(TREE);
    assert.equal(h.pipeline.state(), 'offline');
    assert.equal(h.shellEl.getAttribute('data-save-state'), 'offline');
    assert.equal(h.pill(), 'Offline, will sync');
    assert.equal(drafts.record?.tree, TREE, 'the draft outlives the failed request');

    online = true;
    h.win.dispatchEvent(new Event('online'));
    await tick();
    assert.equal(sent.length, 1);
    assert.equal(h.pipeline.state(), 'clean');
    assert.equal(drafts.record, null);
  });

  it('a retry after a failed save never sends an older queued tree last', async () => {
    const tree = (markdown: string): BlockTree => ({
      version: 1,
      body: [{ type: 'text', markdown }]
    });
    let current = tree('one');
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const sent: string[] = [];
    const h = harness({
      getTree: () => current,
      onSave: async (t) => {
        if (++calls === 1) {
          await gate;
          throw new TypeError('Failed to fetch');
        }
        sent.push((t.body[0] as { markdown: string }).markdown);
      }
    });
    const first = h.pipeline.requestSave(current);
    current = tree('two');
    void h.pipeline.requestSave(current);
    current = tree('three');
    release();
    await first;
    h.win.dispatchEvent(new Event('online'));
    await tick();
    assert.deepEqual(sent, ['three']);
  });

  it('a conflict opens the dialog and Keep mine resaves on the new version', async () => {
    const drafts = memoryDrafts();
    const bases: (string | undefined)[] = [];
    const h = harness({
      version: 'v1',
      drafts,
      onSave: async (_tree, base) => {
        bases.push(base);
        if (base === 'v1') throw new SaveConflict('v9');
        return 'v10';
      }
    });
    await h.pipeline.requestSave(TREE);
    assert.equal(h.pipeline.state(), 'conflict');
    const dialog = h.root.querySelector('[data-rkr-dialog]');
    assert.ok(dialog, 'the conflict dialog opens');
    assert.match(dialog.textContent ?? '', /This page changed somewhere else\./);
    assert.ok(h.button('Load latest'));
    assert.ok(drafts.record, 'the local tree is kept while undecided');

    h.button('Keep mine')?.click();
    await tick();
    assert.deepEqual(bases, ['v1', 'v9']);
    assert.equal(h.pipeline.state(), 'clean');
    assert.equal(drafts.record, null);
  });

  it('Load latest discards the local draft and reloads', async () => {
    const drafts = memoryDrafts();
    let reloads = 0;
    const h = harness({
      version: 'v1',
      drafts,
      reload: () => {
        reloads++;
      },
      onSave: async () => {
        throw new SaveConflict('v9');
      }
    });
    await h.pipeline.requestSave(TREE);
    h.button('Load latest')?.click();
    await tick();
    assert.equal(drafts.record, null);
    assert.equal(reloads, 1);
  });

  it('dismissing the conflict dialog keeps the edit; Retry asks again', async () => {
    const h = harness({
      version: 'v1',
      drafts: memoryDrafts(),
      onSave: async () => {
        throw new SaveConflict('v9');
      }
    });
    await h.pipeline.requestSave(TREE);
    h.root.querySelector('.rkr-dialog-close')?.click();
    assert.equal(h.root.querySelector('[data-rkr-dialog]'), null);
    assert.equal(h.pipeline.state(), 'conflict');
    (h.toolbar.querySelector('.rkr-unified-save') as FakeElement).click();
    assert.ok(h.root.querySelector('[data-rkr-dialog]'), 'Retry reopens the choice');
  });

  it('a refused save shows its message without the conflict dialog', async () => {
    const h = harness({
      onSave: async () => {
        throw new SaveFailure('Not saved. Another page already uses this address.');
      }
    });
    await h.pipeline.requestSave(TREE);
    assert.equal(h.pipeline.state(), 'unsaved');
    assert.equal(h.pill(), 'Not saved. Another page already uses this address.');
    assert.equal(h.root.querySelector('[data-rkr-dialog]'), null);
  });
});
