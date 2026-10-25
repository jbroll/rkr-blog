// Tree-backed figure dialog: pure field read/validate plus a minimal
// DOM dialog driven by the shell. No TipTap dependency — the legacy
// figure-attr panel keeps serving the retired editor bundle untouched.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  openFigureDialog,
  readFigureFields,
  validateFigureFields
} from '../../src/admin/figure-dialog-tree.ts';
import type { BlockNode } from '../../src/lib/blocks.ts';
import { FakeDocument } from './fake-dom.ts';

const FIGURE: BlockNode = {
  type: 'figure',
  slots: { ids: 'aa'.repeat(32), alts: 'old alt', captions: 'old cap', justify: 'left' }
};

/** Fake page with the image-edit section stashed inside its hidden host,
 * plus the map-backed resolver the dialog uses instead of a global
 * document. Node has no `document`, and the fake document has no
 * getElementById, so Esc cannot be exercised here — the e2e spec covers
 * the browser keydown path. */
function imageEditFixture() {
  const doc = new FakeDocument();
  const root = doc.createElement('div');
  const host = doc.createElement('div');
  host.id = 'rkr-image-edit-host';
  host.hidden = true;
  const section = doc.createElement('div');
  section.id = 'rkr-image-edit';
  host.append(section);
  root.append(host);
  const elements = new Map<string, ReturnType<FakeDocument['createElement']>>([
    ['rkr-image-edit-host', host],
    ['rkr-image-edit', section]
  ]);
  const getById = (id: string): HTMLElement | null =>
    (elements.get(id) ?? null) as unknown as HTMLElement | null;
  return { doc, root, host, section, getById };
}

function openWithFixture(fixture: ReturnType<typeof imageEditFixture>, onCancel = () => {}) {
  return openFigureDialog(fixture.root, {
    initial: readFigureFields(FIGURE),
    onCommit: () => {},
    onCancel,
    getById: fixture.getById
  });
}

describe('figure dialog fields', () => {
  it('reads current slots into fields', () => {
    assert.deepEqual(readFigureFields(FIGURE), {
      ids: 'aa'.repeat(32),
      alts: 'old alt',
      captions: 'old cap',
      justify: 'left'
    });
  });

  it('rejects non-hex ids', () => {
    const r = validateFigureFields({ ids: 'not-hex!', alts: '', captions: '', justify: 'center' });
    assert.equal(r.ok, false);
  });

  it('coerces unknown justify to center', () => {
    const r = validateFigureFields({ ids: '', alts: '', captions: '', justify: 'sideways' });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.slots.justify, 'center');
  });

  it('dialog commit delivers exactly the edited slots', () => {
    const doc = new FakeDocument();
    const root = doc.createElement('div');
    const commits: unknown[] = [];
    const dialog = openFigureDialog(root, {
      initial: readFigureFields(FIGURE),
      onCommit: (slots) => {
        commits.push(slots);
      },
      onCancel: () => {}
    });
    dialog.setField('captions', 'new cap');
    dialog.setField('alts', 'new alt');
    dialog.commit();
    assert.equal(commits.length, 1);
    assert.deepEqual(commits[0], {
      ids: 'aa'.repeat(32),
      alts: 'new alt',
      captions: 'new cap',
      justify: 'left'
    });
  });

  it('dialog carries the figure-dialog class and labelled full-width fields', () => {
    const doc = new FakeDocument();
    const root = doc.createElement('div');
    openFigureDialog(root, {
      initial: readFigureFields(FIGURE),
      onCommit: () => {},
      onCancel: () => {}
    });
    const dialog = root.querySelector('.rkr-figure-dialog');
    assert.ok(dialog, 'dialog has .rkr-figure-dialog');
    assert.match(dialog.className, /\brkr-cell-dialog\b/);
    assert.equal(root.querySelectorAll('.rkr-figure-field').length, 4);
  });

  it('justify select offers every position and selects the current one', () => {
    const doc = new FakeDocument();
    const root = doc.createElement('div');
    openFigureDialog(root, {
      initial: readFigureFields(FIGURE),
      onCommit: () => {},
      onCancel: () => {}
    });
    const dialog = root.querySelector('.rkr-figure-dialog');
    assert.ok(dialog);
    const select = dialog.querySelector('select');
    assert.ok(select, 'justify select exists');
    const options = select.querySelectorAll('option');
    assert.deepEqual(
      options.map((o) => o.getAttribute('value')),
      ['center', 'full', 'bleed', 'left', 'right', 'inline']
    );
    const selected = options.filter((o) => o.hasAttribute('selected'));
    assert.equal(selected.length, 1, 'exactly one option selected');
    assert.equal(selected[0]?.getAttribute('value'), 'left');
    const selectValue = (select as unknown as { value?: string }).value;
    assert.equal(selectValue, 'left', 'select value reflects the current slot');
  });

  it('dialog commit with bad ids reports errors and commits nothing', () => {
    const doc = new FakeDocument();
    const root = doc.createElement('div');
    let commits = 0;
    const dialog = openFigureDialog(root, {
      initial: readFigureFields(FIGURE),
      onCommit: () => {
        commits++;
      },
      onCancel: () => {}
    });
    dialog.setField('ids', 'zzz');
    dialog.commit();
    assert.equal(commits, 0);
    assert.ok(dialog.errors().length > 0);
  });
});

describe('figure dialog image-edit hosting and close paths', () => {
  it('open moves the same section node into the dialog body and hides it', () => {
    const f = imageEditFixture();
    openWithFixture(f);
    const dialog = f.root.querySelector('.rkr-figure-dialog');
    assert.ok(dialog);
    const body = dialog.querySelector('.rkr-cell-dialog-body');
    assert.ok(body);
    assert.equal(f.section.parentNode, body, 'same section node, not a clone');
    assert.equal(f.section.hidden, true);
    assert.equal(f.host.children.length, 0, 'host is emptied while open');
  });

  it('✕ restores the section to the host and cancels once', () => {
    const f = imageEditFixture();
    let cancels = 0;
    openWithFixture(f, () => {
      cancels++;
    });
    const dialog = f.root.querySelector('.rkr-figure-dialog');
    assert.ok(dialog);
    const closeBtn = dialog.querySelector('.rkr-cell-dialog-close');
    assert.ok(closeBtn);
    closeBtn.click();
    assert.equal(f.section.parentNode, f.host);
    assert.equal(f.section.hidden, true);
    assert.equal(cancels, 1);
  });

  it('scrim click restores the section to the host and cancels once', () => {
    const f = imageEditFixture();
    let cancels = 0;
    openWithFixture(f, () => {
      cancels++;
    });
    const scrim = f.root.querySelector('.rkr-figure-scrim');
    assert.ok(scrim);
    scrim.click();
    assert.equal(f.section.parentNode, f.host);
    assert.equal(f.section.hidden, true);
    assert.equal(cancels, 1);
  });

  it('save commit restores the section without cancelling', () => {
    const f = imageEditFixture();
    let cancels = 0;
    let commits = 0;
    openFigureDialog(f.root, {
      initial: readFigureFields(FIGURE),
      onCommit: () => {
        commits++;
      },
      onCancel: () => {
        cancels++;
      },
      getById: f.getById
    });
    const dialog = f.root.querySelector('.rkr-figure-dialog');
    assert.ok(dialog);
    const saveBtn = dialog.querySelector('.rkr-figure-dialog-save');
    assert.ok(saveBtn);
    saveBtn.click();
    assert.equal(commits, 1);
    assert.equal(cancels, 0, 'save is not a cancel');
    assert.equal(f.section.parentNode, f.host);
    assert.equal(f.section.hidden, true);
  });

  it('double close is safe and cancels only once', () => {
    const f = imageEditFixture();
    let cancels = 0;
    const driver = openWithFixture(f, () => {
      cancels++;
    });
    driver.close();
    driver.close();
    assert.equal(cancels, 1);
    assert.equal(f.section.parentNode, f.host);
    assert.equal(f.section.hidden, true);
  });
});
