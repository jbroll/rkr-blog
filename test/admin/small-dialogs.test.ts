import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  openAccordionDialog,
  readAccordionFields,
  validateAccordionFields
} from '../../src/admin/accordion-dialog-tree.ts';
import {
  openEmbedDialog,
  readEmbedFields,
  validateEmbedFields
} from '../../src/admin/embed-dialog-tree.ts';
import {
  openMarqueeDialog,
  readMarqueeFields,
  validateMarqueeFields
} from '../../src/admin/marquee-dialog-tree.ts';
import {
  openProgressDialog,
  readProgressFields,
  validateProgressFields
} from '../../src/admin/progress-dialog-tree.ts';
import type { BlockNode } from '../../src/lib/blocks.ts';
import { FakeDocument, type FakeElement, FakeEvent } from './fake-dom.ts';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const save = async (root: FakeElement): Promise<void> => {
  (root.querySelector('.rkr-dialog-primary') as FakeElement).click();
  await tick();
};
const newRoot = () => new FakeDocument().createElement('div');
const as = (root: FakeElement) => root as unknown as Element;

describe('marquee dialog', () => {
  it('reads and validates the text', () => {
    assert.deepEqual(readMarqueeFields({ type: 'marquee', slots: { text: 'Hi' } }), { text: 'Hi' });
    assert.deepEqual(readMarqueeFields({ type: 'marquee' }), { text: '' });
    assert.deepEqual(validateMarqueeFields({ text: ' Hi ' }), { ok: true, slots: { text: 'Hi' } });
    assert.equal(validateMarqueeFields({ text: ' ' }).ok, false);
  });

  it('commits edited text and refuses an empty one', async () => {
    const root = newRoot();
    const commits: unknown[] = [];
    const dialog = openMarqueeDialog(as(root), {
      initial: { text: '' },
      onCommit: (s) => commits.push(s)
    });
    await save(root);
    assert.equal(commits.length, 0);
    assert.match(root.querySelector('.rkr-dialog-error')?.textContent ?? '', /text/i);
    dialog.setField('text', 'Open Saturdays');
    await save(root);
    assert.deepEqual(commits, [{ text: 'Open Saturdays' }]);
  });

  it('keeps the dialog open with the refusal message', async () => {
    const root = newRoot();
    openMarqueeDialog(as(root), {
      initial: { text: 'x' },
      refuse: () => 'Offline',
      onCommit: () => assert.fail('committed')
    });
    await save(root);
    assert.equal(root.querySelector('.rkr-dialog-error')?.textContent, 'Offline');
  });
});

describe('progress dialog', () => {
  it('reads the source, goal and raised', () => {
    assert.deepEqual(readProgressFields({ type: 'progress', slots: { source: 'site' } }), {
      source: 'site',
      goal: '',
      raised: ''
    });
    assert.deepEqual(
      readProgressFields({ type: 'progress', slots: { goal: 500, raised: '120' } }),
      { source: 'block', goal: '500', raised: '120' }
    );
  });

  it('site source saves only the source', () => {
    assert.deepEqual(validateProgressFields({ source: 'site', goal: '9', raised: '1' }), {
      ok: true,
      slots: { source: 'site' }
    });
  });

  it('block source saves numbers and requires a goal', () => {
    assert.deepEqual(validateProgressFields({ source: 'block', goal: '500', raised: '' }), {
      ok: true,
      slots: { goal: 500, raised: 0 }
    });
    assert.equal(validateProgressFields({ source: 'block', goal: '0', raised: '' }).ok, false);
    assert.equal(validateProgressFields({ source: 'block', goal: '5', raised: 'x' }).ok, false);
  });

  it('shows goal and raised only for This block', () => {
    const root = newRoot();
    const dialog = openProgressDialog(as(root), {
      initial: { source: 'site', goal: '', raised: '' },
      onCommit: () => {}
    });
    const row = (name: string) =>
      (root.querySelector(`[name="${name}"]`) as FakeElement).parentNode as FakeElement;
    assert.equal(row('goal').hidden, true);
    assert.equal(row('raised').hidden, true);
    assert.deepEqual(
      root
        .querySelector('[name="source"]')
        ?.querySelectorAll('option')
        .map((o) => o.textContent),
      ['Site campaign', 'This block']
    );
    dialog.setField('source', 'block');
    assert.equal(row('goal').hidden, false);
    assert.equal(row('raised').hidden, false);
  });

  it('commits the block figures', async () => {
    const root = newRoot();
    const commits: unknown[] = [];
    const dialog = openProgressDialog(as(root), {
      initial: { source: 'site', goal: '', raised: '' },
      onCommit: (s) => commits.push(s)
    });
    dialog.setField('source', 'block');
    dialog.setField('goal', '1000');
    dialog.setField('raised', '250');
    await save(root);
    assert.deepEqual(commits, [{ goal: 1000, raised: 250 }]);
  });
});

describe('embed dialog', () => {
  it('reads url and height', () => {
    assert.deepEqual(readEmbedFields({ type: 'embed', slots: { url: 'https://a', height: 600 } }), {
      url: 'https://a',
      height: '600'
    });
    assert.deepEqual(readEmbedFields({ type: 'embed' }), { url: '', height: '' });
  });

  it('rewrites a youtu.be link on validate', () => {
    assert.deepEqual(validateEmbedFields({ url: 'https://youtu.be/abc123', height: '' }), {
      ok: true,
      slots: { url: 'https://www.youtube-nocookie.com/embed/abc123' }
    });
  });

  it('keeps a numeric height', () => {
    const result = validateEmbedFields({
      url: 'https://docs.google.com/forms/d/e/x/viewform',
      height: '800'
    });
    assert.deepEqual(result, {
      ok: true,
      slots: { url: 'https://docs.google.com/forms/d/e/x/viewform?embedded=true', height: 800 }
    });
    assert.equal(validateEmbedFields({ url: 'https://youtu.be/a', height: 'tall' }).ok, false);
  });

  it('asks for a link when the url is empty', () => {
    assert.deepEqual(validateEmbedFields({ url: ' ', height: '' }), {
      ok: false,
      error: 'Enter a link to embed.',
      field: 'url'
    });
  });

  it('refuses an unsupported service with the supported list', async () => {
    const root = newRoot();
    const commits: unknown[] = [];
    const dialog = openEmbedDialog(as(root), {
      initial: { url: '', height: '' },
      onCommit: (s) => commits.push(s)
    });
    dialog.setField('url', 'https://example.com/page');
    await save(root);
    assert.equal(commits.length, 0);
    assert.equal(
      root.querySelector('.rkr-dialog-error')?.textContent,
      "This service can't be embedded. Supported: Google Docs, Forms and Maps, YouTube, Vimeo."
    );
  });

  it('commits the rewritten url', async () => {
    const root = newRoot();
    const commits: unknown[] = [];
    const dialog = openEmbedDialog(as(root), {
      initial: { url: '', height: '' },
      onCommit: (s) => commits.push(s)
    });
    dialog.setField('url', 'https://youtu.be/abc123');
    await save(root);
    assert.deepEqual(commits, [{ url: 'https://www.youtube-nocookie.com/embed/abc123' }]);
  });
});

describe('accordion dialog', () => {
  const NODE: BlockNode = {
    type: 'accordion',
    slots: { items: [{ title: 'A', body: 'one' }, { title: 'B', body: 'two' }, 'junk', { n: 1 }] }
  };

  it('reads string fields of each item', () => {
    assert.deepEqual(readAccordionFields(NODE).items, [
      { title: 'A', body: 'one' },
      { title: 'B', body: 'two' },
      {}
    ]);
    assert.deepEqual(readAccordionFields({ type: 'accordion' }).items, []);
  });

  it('validate drops empty rows and requires one item', () => {
    assert.deepEqual(validateAccordionFields({ items: [{ title: 'A' }, {}] }), {
      ok: true,
      slots: { items: [{ title: 'A' }] }
    });
    assert.equal(validateAccordionFields({ items: [] }).ok, false);
  });

  it('edits rows through the list field', async () => {
    const root = newRoot();
    const commits: unknown[] = [];
    openAccordionDialog(as(root), {
      initial: readAccordionFields({ type: 'accordion', slots: { items: [{ title: 'A' }] } }),
      onCommit: (s) => commits.push(s)
    });
    assert.equal(root.querySelectorAll('.rkr-list-row').length, 1);
    assert.deepEqual(
      root.querySelectorAll('label').map((l) => l.textContent),
      ['Title', 'Body']
    );
    root.querySelector('[aria-label="Add row"]')?.click();
    const titles = root.querySelectorAll('[name="title"]');
    const second = titles[1] as unknown as { value: string } & FakeElement;
    second.value = 'B';
    second.dispatchEvent(new FakeEvent('input'));
    await save(root);
    assert.deepEqual(commits, [{ items: [{ title: 'A' }, { title: 'B' }] }]);
  });

  it('refuses to save no items', async () => {
    const root = newRoot();
    openAccordionDialog(as(root), {
      initial: { items: [] },
      onCommit: () => assert.fail('committed')
    });
    await save(root);
    assert.match(root.querySelector('.rkr-dialog-error')?.textContent ?? '', /item/i);
  });
});
