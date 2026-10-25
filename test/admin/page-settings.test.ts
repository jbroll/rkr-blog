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
const BASE: PageFields = { title: 'Spring Sale', status: 'draft', date: '', tags: [] };

describe('page settings fields', () => {
  it('reads stored fields with defaults', () => {
    assert.deepEqual(readPageFields(undefined, 'spring-sale'), {
      title: 'spring-sale',
      status: 'draft',
      date: '',
      tags: []
    });
    assert.deepEqual(
      readPageFields(
        {
          title: 'T',
          status: 'published',
          date: '2026-05-06T14:00:00Z',
          tags: ['a', 3],
          excerpt: 'E'
        },
        'x'
      ),
      { title: 'T', status: 'published', date: '2026-05-06T14:00:00Z', tags: ['a'], excerpt: 'E' }
    );
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
        excerpt: '  '
      },
      TODAY
    );
    assert.deepEqual(result, {
      ok: true,
      fields: { title: 'T', status: 'published', date: '2026-05-06T14:00:00Z', tags: ['a', 'b'] }
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
        excerpt: 'Big sale.'
      }
    ]);
  });

  it('shows the slug read-only with a link to the public page', () => {
    const { root } = open();
    const link = root.querySelector('.rkr-page-url');
    assert.equal(link?.getAttribute('href'), '/spring-sale');
  });
});
