import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { openEditorDialog } from '../../src/admin/editor-dialog.ts';
import { FakeDocument, type FakeElement, FakeEvent } from './fake-dom.ts';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function key(name: string): FakeEvent {
  return Object.assign(new FakeEvent('keydown'), { key: name });
}

function setup(opts: { onPrimary?: () => boolean | Promise<boolean>; onCancel?: () => void }) {
  const doc = new FakeDocument();
  const root = doc.createElement('div');
  const body = doc.createElement('div');
  const handle = openEditorDialog({
    root: root as unknown as Element,
    title: 'Edit hero',
    body: body as unknown as Node,
    primaryLabel: 'Save',
    onPrimary: opts.onPrimary ?? (() => true),
    onCancel: opts.onCancel
  });
  const dialog = root.querySelector('[data-rkr-dialog]') as FakeElement;
  const find = (selector: string): FakeElement => dialog.querySelector(selector) as FakeElement;
  return { root, dialog, handle, find };
}

describe('openEditorDialog', () => {
  it('marks the dialog root so block keys are ignored inside it', () => {
    const { dialog } = setup({});
    assert.ok(dialog, 'dialog root carries data-rkr-dialog');
    assert.equal(dialog.tagName, 'DIALOG');
  });

  it('keeps open when primary returns false and shows the error', async () => {
    let calls = 0;
    const ref: { setError?: (t: string) => void } = {};
    const { root, dialog, handle, find } = setup({
      onPrimary: () => {
        calls++;
        ref.setError?.('Link is required.');
        return false;
      }
    });
    ref.setError = handle.setError;
    find('.rkr-dialog-primary').click();
    await tick();
    assert.equal(calls, 1);
    assert.equal(dialog.parentNode, root, 'still mounted');
    const error = find('.rkr-dialog-error');
    assert.equal(error.textContent, 'Link is required.');
    assert.equal(error.hidden, false);
  });

  it('closes when primary returns true', async () => {
    const { root, dialog, find } = setup({ onPrimary: async () => true });
    find('.rkr-dialog-primary').click();
    await tick();
    assert.equal(dialog.parentNode, null);
    assert.equal(root.querySelector('[data-rkr-dialog]'), null);
  });

  it('Escape calls onCancel once', () => {
    let cancels = 0;
    const { dialog, root } = setup({
      onCancel: () => {
        cancels++;
      }
    });
    dialog.dispatchEvent(key('Escape'));
    dialog.dispatchEvent(key('Escape'));
    assert.equal(cancels, 1);
    assert.equal(root.querySelector('[data-rkr-dialog]'), null);
  });

  it('setBusy disables both buttons', () => {
    const { handle, find } = setup({});
    handle.setBusy(true);
    assert.ok(find('.rkr-dialog-primary').hasAttribute('disabled'));
    assert.ok(find('.rkr-dialog-cancel').hasAttribute('disabled'));
    handle.setBusy(false);
    assert.equal(find('.rkr-dialog-primary').hasAttribute('disabled'), false);
  });

  it('an async primary holds the dialog busy so a double click submits once', async () => {
    let calls = 0;
    let release!: (ok: boolean) => void;
    const { find, dialog, root } = setup({
      onPrimary: () => {
        calls++;
        return new Promise<boolean>((resolve) => {
          release = resolve;
        });
      }
    });
    find('.rkr-dialog-primary').click();
    find('.rkr-dialog-primary').click();
    assert.equal(calls, 1);
    assert.ok(find('.rkr-dialog-primary').hasAttribute('disabled'));
    assert.equal(dialog.getAttribute('aria-busy'), 'true');
    release(false);
    await tick();
    assert.equal(find('.rkr-dialog-primary').hasAttribute('disabled'), false);
    assert.equal(dialog.parentNode, root, 'false keeps it open');
  });

  it('a thrown primary is logged and shown, and the dialog stays open', async (t) => {
    const logged: unknown[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => {
      logged.push(args);
    });
    const { find, dialog, root } = setup({
      onPrimary: async () => {
        throw new Error('upload failed');
      }
    });
    find('.rkr-dialog-primary').click();
    await tick();
    assert.equal(logged.length, 1);
    assert.equal(find('.rkr-dialog-error').hidden, false);
    assert.equal(dialog.parentNode, root);
    assert.equal(find('.rkr-dialog-primary').hasAttribute('disabled'), false);
  });

  it('pushView swaps body and footer and pops back on cancel or success', async () => {
    let cancels = 0;
    let leaves = 0;
    const { handle, find, dialog } = setup({
      onCancel: () => {
        cancels++;
      }
    });
    const base = find('.rkr-dialog-body').firstChild;
    const sub = new FakeDocument().createElement('div');
    const view = {
      title: 'Edit image',
      body: sub as unknown as Node,
      primaryLabel: 'Apply edits',
      cancelLabel: 'Back to figure',
      onPrimary: async () => true,
      onLeave: () => {
        leaves++;
      }
    };
    handle.pushView(view);
    assert.equal(find('.rkr-dialog-body').firstChild, sub);
    assert.equal(find('.rkr-dialog-primary').textContent, 'Apply edits');
    assert.equal(find('.rkr-dialog-cancel').textContent, 'Back to figure');
    assert.equal(find('.rkr-dialog-title').textContent, 'Edit image');

    dialog.dispatchEvent(key('Escape'));
    assert.equal(find('.rkr-dialog-body').firstChild, base, 'Escape pops the view');
    assert.equal(find('.rkr-dialog-primary').textContent, 'Save');
    assert.equal(find('.rkr-dialog-cancel').textContent, 'Cancel');
    assert.equal(cancels, 0, 'popping is not a cancel');

    handle.pushView(view);
    find('.rkr-dialog-primary').click();
    await tick();
    assert.equal(find('.rkr-dialog-body').firstChild, base, 'success pops the view');
    assert.equal(leaves, 2);
    assert.ok(dialog.parentNode, 'the dialog stays open');
  });

  it('Cancel button calls onCancel and removes the dialog', () => {
    let cancels = 0;
    const { find, root } = setup({
      onCancel: () => {
        cancels++;
      }
    });
    find('.rkr-dialog-cancel').click();
    assert.equal(cancels, 1);
    assert.equal(root.querySelector('[data-rkr-dialog]'), null);
  });
});
