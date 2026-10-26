import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clearAdminCaches } from '../../src/site/admin-caches.ts';
import {
  confirmSignOut,
  type DraftEntry,
  guardSignOut,
  type SignOutDeps,
  signOutMessage,
  unsyncedDrafts
} from '../../src/site/admin-signout.ts';
import { FakeDocument, type FakeElement, FakeEvent } from '../admin/fake-dom.ts';

const tick = async (n = 5): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

const draft = (slug: string, body: string): DraftEntry => ({
  slug,
  tree: { version: 1, body: [{ type: 'text', markdown: body }], fields: { title: `T ${slug}` } }
});

describe('sign-out landing', () => {
  it('clears admin caches and the worker, never the drafts database', async () => {
    const names = ['rkr-admin-abc', 'other'];
    const deleted: string[] = [];
    let unregistered = 0;
    const idb = {
      deleteDatabase: () => {
        throw new Error('drafts must survive the landing page');
      }
    };
    await clearAdminCaches({
      caches: {
        keys: async () => names,
        delete: async (n: string) => {
          deleted.push(n);
          return true;
        }
      },
      serviceWorker: {
        getRegistration: async () => ({
          unregister: async () => {
            unregistered++;
            return true;
          }
        })
      },
      ...({ indexedDB: idb } as object)
    });
    assert.deepEqual(deleted, ['rkr-admin-abc']);
    assert.equal(unregistered, 1);
  });
});

describe('unsynced drafts', () => {
  it('counts drafts that differ from the server or cannot be checked', async () => {
    const server: Record<string, unknown> = {
      same: draft('same', 'Kept').tree,
      changed: draft('changed', 'Old').tree
    };
    const result = await unsyncedDrafts({
      listDrafts: async () => [draft('same', 'Kept'), draft('changed', 'New'), draft('away', 'X')],
      serverTree: async (slug) => server[slug]
    });
    assert.deepEqual(
      result?.map((d) => d.slug),
      ['changed', 'away']
    );
  });

  it('is unknown when IndexedDB is unavailable', async () => {
    assert.equal(
      await unsyncedDrafts({
        listDrafts: async () => undefined,
        serverTree: async () => undefined
      }),
      undefined
    );
  });
});

describe('sign-out message', () => {
  it('names the count in the singular and plural', () => {
    assert.equal(
      signOutMessage(1),
      '1 page has changes that never reached the server. Signing out deletes them.'
    );
    assert.equal(
      signOutMessage(3),
      '3 pages have changes that never reached the server. Signing out deletes them.'
    );
  });
});

describe('sign-out confirm dialog', () => {
  function open(entries: DraftEntry[]) {
    const doc = new FakeDocument();
    const root = doc.createElement('div');
    const answer = confirmSignOut(root as unknown as Element, entries);
    return { doc, root, answer };
  }

  it('lists the pages and focuses Cancel', () => {
    const { doc, root } = open([draft('a', 'x'), draft('b', 'y')]);
    assert.match(root.querySelector('.rkr-dialog-body')?.textContent ?? '', /2 pages have changes/);
    assert.match(root.querySelector('.rkr-dialog-body')?.textContent ?? '', /T a.*T b/);
    const cancel = root.querySelector('.rkr-dialog-cancel') as FakeElement;
    assert.equal(cancel.textContent, 'Cancel');
    assert.equal(doc.activeElement, cancel);
    assert.equal(root.querySelector('.rkr-dialog-primary')?.textContent, 'Sign out and delete');
  });

  it('Cancel resolves false', async () => {
    const { root, answer } = open([draft('a', 'x')]);
    (root.querySelector('.rkr-dialog-cancel') as FakeElement).click();
    assert.equal(await answer, false);
  });

  it('Sign out and delete resolves true', async () => {
    const { root, answer } = open([draft('a', 'x')]);
    (root.querySelector('.rkr-dialog-primary') as FakeElement).click();
    assert.equal(await answer, true);
  });
});

describe('sign-out submit guard', () => {
  function setup(over: Partial<SignOutDeps>) {
    const doc = new FakeDocument();
    const form = doc.createElement('form');
    const calls: string[] = [];
    const deps: SignOutDeps = {
      listDrafts: async () => [],
      serverTree: async () => undefined,
      confirm: async () => {
        calls.push('confirm');
        return false;
      },
      deleteDrafts: async () => {
        calls.push('delete');
      },
      submit: () => {
        calls.push('submit');
      },
      ...over
    };
    guardSignOut(form as unknown as HTMLFormElement, deps);
    const ev = new FakeEvent('submit');
    form.dispatchEvent(ev);
    return { calls, ev };
  }

  it('zero unsynced drafts signs out with no dialog', async () => {
    const { calls, ev } = setup({});
    await tick();
    assert.equal(ev.defaultPrevented, true);
    assert.deepEqual(calls, ['submit']);
  });

  it('Cancel keeps the drafts and stays signed in', async () => {
    const { calls } = setup({ listDrafts: async () => [draft('a', 'x')] });
    await tick();
    assert.deepEqual(calls, ['confirm']);
  });

  it('confirming deletes the drafts, then signs out', async () => {
    const { calls } = setup({
      listDrafts: async () => [draft('a', 'x')],
      confirm: async () => {
        calls.push('confirm');
        return true;
      }
    });
    await tick();
    assert.deepEqual(calls, ['confirm', 'delete', 'submit']);
  });

  it('signs out without deleting when IndexedDB is unavailable', async () => {
    const { calls } = setup({ listDrafts: async () => undefined });
    await tick();
    assert.deepEqual(calls, ['submit']);
  });

  it('signs out without deleting when the count times out', async () => {
    const { calls } = setup({ listDrafts: () => new Promise(() => {}), timeoutMs: 5 });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(calls, ['submit']);
  });
});
