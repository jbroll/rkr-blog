import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  openPageSettings,
  type PageFields,
  readPageFields,
  validatePageFields
} from '../../src/admin/page-settings.ts';
import { FakeDocument, type FakeElement } from './fake-dom.ts';

const TODAY = '2026-10-25';
const BASE: PageFields = {
  title: 'Spring Sale',
  status: 'draft',
  date: '',
  tags: [],
  kind: 'post'
};

describe('page settings fields', () => {
  it('reads stored fields with defaults', () => {
    assert.deepEqual(readPageFields(undefined, 'spring-sale'), {
      title: 'spring-sale',
      status: 'draft',
      date: '',
      tags: [],
      kind: 'post'
    });
    assert.deepEqual(
      readPageFields(
        {
          title: 'T',
          status: 'published',
          date: '2026-05-06T14:00:00Z',
          tags: ['a', 3],
          excerpt: 'E',
          subtitle: 'S'
        },
        'x'
      ),
      {
        title: 'T',
        status: 'published',
        date: '2026-05-06T14:00:00Z',
        tags: ['a'],
        excerpt: 'E',
        subtitle: 'S',
        kind: 'post'
      }
    );
  });

  it('Kind select round-trips page and defaults to post', () => {
    assert.equal(readPageFields({}, 's').kind, 'post');
    assert.equal(readPageFields({ kind: 'page' }, 's').kind, 'page');
    assert.equal(readPageFields({ kind: 'weird' }, 's').kind, 'post');
    const result = validatePageFields({ ...BASE, kind: 'page' }, TODAY);
    assert.equal(result.ok && result.fields.kind, 'page');
  });

  it('requires a title', () => {
    const result = validatePageFields({ ...BASE, title: '   ' }, TODAY);
    assert.equal(result.ok, false);
  });

  it('defaults the date to today on first publish and stores the index format', () => {
    const result = validatePageFields({ ...BASE, status: 'published' }, TODAY);
    assert.deepEqual(result, {
      ok: true,
      fields: { ...BASE, status: 'published', date: '2026-10-25T00:00:00Z' }
    });
  });

  it('keeps a stored timestamp and cleans tags and excerpt', () => {
    const result = validatePageFields(
      {
        title: ' T ',
        status: 'published',
        date: '2026-05-06T14:00:00Z',
        tags: [' a ', 'A', 'b'],
        excerpt: '  ',
        kind: 'post'
      },
      TODAY
    );
    assert.deepEqual(result, {
      ok: true,
      fields: {
        title: 'T',
        status: 'published',
        date: '2026-05-06T14:00:00Z',
        tags: ['a', 'b'],
        kind: 'post'
      }
    });
  });
});

describe('page settings dialog', () => {
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  function open(fields: PageFields = BASE) {
    const doc = new FakeDocument();
    const root = doc.createElement('div');
    const commits: PageFields[] = [];
    const dialog = openPageSettings(root as unknown as Element, {
      slug: 'spring-sale',
      fields,
      today: TODAY,
      onCommit: (f) => {
        commits.push(f);
      }
    });
    return { root, dialog, commits };
  }
  const save = (root: FakeElement) =>
    (root.querySelector('.rkr-dialog-primary') as FakeElement).click();

  it('settings commit requires a title', async () => {
    const { root, dialog, commits } = open();
    dialog.setField('title', '  ');
    save(root);
    await tick();
    assert.equal(commits.length, 0);
    assert.match(root.querySelector('.rkr-dialog-error')?.textContent ?? '', /title/i);
  });

  it('commits status, tags and excerpt', async () => {
    const { root, dialog, commits } = open();
    dialog.setField('status', 'published');
    dialog.setField('tags', 'news, sale');
    dialog.setField('excerpt', 'Big sale.');
    save(root);
    await tick();
    assert.deepEqual(commits, [
      {
        title: 'Spring Sale',
        status: 'published',
        date: '2026-10-25T00:00:00Z',
        tags: ['news', 'sale'],
        excerpt: 'Big sale.',
        kind: 'post'
      }
    ]);
  });

  it('commits the chosen kind', async () => {
    const { root, dialog, commits } = open();
    dialog.setField('kind', 'page');
    save(root);
    await tick();
    assert.equal(commits[0]?.kind, 'page');
  });

  it('shows and edits the subtitle', async () => {
    const { root, dialog, commits } = open({ ...BASE, subtitle: 'Old line' });
    const input = root.querySelector('[name="subtitle"]') as FakeElement & { value: string };
    assert.equal(input.value, 'Old line');
    dialog.setField('subtitle', '  New line ');
    save(root);
    await tick();
    assert.equal(commits[0]?.subtitle, 'New line');
  });

  it('shows the slug read-only with a link to the public page', () => {
    const { root } = open();
    const link = root.querySelector('.rkr-page-url');
    assert.equal(link?.getAttribute('href'), '/spring-sale');
  });

  describe('delete page', () => {
    function openWithDelete(result: string | null) {
      const doc = new FakeDocument();
      const root = doc.createElement('div');
      const calls: string[] = [];
      openPageSettings(root as unknown as Element, {
        slug: 'spring-sale',
        fields: BASE,
        today: TODAY,
        onCommit: () => {
          calls.push('commit');
        },
        onDelete: async () => {
          calls.push('delete');
          return result;
        }
      });
      return { root, calls };
    }

    it('has no delete button without a delete handler', () => {
      const { root } = open();
      assert.equal(root.querySelector('.rkr-page-delete'), null);
    });

    it('asks for confirmation naming the page, then deletes', async () => {
      const { root, calls } = openWithDelete(null);
      const button = root.querySelector('.rkr-page-delete') as FakeElement;
      assert.equal(button.textContent, 'Delete page');
      button.click();
      assert.equal(calls.length, 0, 'nothing deleted before confirming');
      const title = root.querySelector('.rkr-dialog-title')?.textContent ?? '';
      assert.equal(title, 'Delete page');
      assert.match(root.querySelector('.rkr-dialog-body')?.textContent ?? '', /“Spring Sale”/);
      assert.equal(root.querySelector('.rkr-dialog-primary')?.textContent, 'Delete page');
      save(root);
      await tick();
      await tick();
      assert.deepEqual(calls, ['delete']);
      assert.equal(root.querySelector('dialog'), null, 'dialog closed');
    });

    it('keeps the dialog open with the error when delete fails', async () => {
      const { root, calls } = openWithDelete("Couldn't delete the page. Try again.");
      (root.querySelector('.rkr-page-delete') as FakeElement).click();
      save(root);
      await tick();
      await tick();
      assert.deepEqual(calls, ['delete']);
      assert.ok(root.querySelector('dialog'));
      assert.equal(
        root.querySelector('.rkr-dialog-error')?.textContent,
        "Couldn't delete the page. Try again."
      );
    });
  });
});
