// Unit coverage for admin/source-picker.ts — the shared +Image/+Video
// source-picker promise. Regression under test: Escape / dialog close
// used to leave the click listener attached and the promise pending, so
// the next open double-fired and could misroute the image vs video
// branch. Every exit path must both resolve and detach its listeners.
//
// The dialog is faked (no jsdom in this repo); the picker only needs
// addEventListener/removeEventListener/close plus a showModal the
// openModal helper can call.

import assert from 'node:assert/strict';
import { test } from 'node:test';

type Listener = (ev: Event) => void;

class FakeDialog {
  open = false;
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  showModal(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
    this.emit('close', new Event('close'));
  }

  emit(type: string, ev: Event): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(ev);
  }

  listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

// openModal() reads document.activeElement and HTMLElement; provide the
// minima for a non-contenteditable active element.
const g = globalThis as unknown as Record<string, unknown>;
g.document = { activeElement: null };
g.HTMLElement = class {};

const { openSourcePicker } = await import('../../src/admin/source-picker.ts');

const asDialog = (dialog: FakeDialog): HTMLDialogElement => dialog as unknown as HTMLDialogElement;

/** A click target shaped like a source <button data-source="…">. */
function sourceTarget(source: string): unknown {
  const btn = { dataset: { source }, closest: () => btn };
  return btn;
}

function click(dialog: FakeDialog, target: unknown): void {
  const ev = new Event('click');
  Object.defineProperty(ev, 'target', { value: target });
  dialog.emit('click', ev);
}

test('picking a source resolves it, closes the dialog, detaches listeners', async () => {
  const dialog = new FakeDialog();
  const picked = openSourcePicker(asDialog(dialog));
  assert.equal(dialog.open, true, 'openModal must show the dialog');

  click(dialog, sourceTarget('drive'));

  assert.equal(await picked, 'drive');
  assert.equal(dialog.open, false, 'dialog closes after a pick');
  assert.equal(dialog.listenerCount(), 0, 'no listeners left behind');
});

test('the Cancel button (data-source="") resolves null', async () => {
  const dialog = new FakeDialog();
  const picked = openSourcePicker(asDialog(dialog));
  click(dialog, sourceTarget(''));
  assert.equal(await picked, null);
  assert.equal(dialog.listenerCount(), 0);
});

test('Escape (cancel event) resolves null and detaches every listener', async () => {
  const dialog = new FakeDialog();
  const picked = openSourcePicker(asDialog(dialog));

  dialog.emit('cancel', new Event('cancel'));

  assert.equal(await picked, null);
  assert.equal(dialog.listenerCount(), 0, 'Escape must not leak the click listener');
});

test('a close event resolves null and detaches every listener', async () => {
  const dialog = new FakeDialog();
  const picked = openSourcePicker(asDialog(dialog));

  dialog.close();

  assert.equal(await picked, null);
  assert.equal(dialog.listenerCount(), 0, 'close must not leak the click listener');
});

test('a click outside a source button leaves the picker pending', async () => {
  const dialog = new FakeDialog();
  let settled: string | null | undefined;
  const picked = openSourcePicker(asDialog(dialog)).then((choice) => {
    settled = choice;
    return choice;
  });

  click(dialog, { closest: () => null });
  await Promise.resolve();
  assert.equal(settled, undefined, 'a stray click must not resolve');
  assert.equal(dialog.open, true);

  click(dialog, sourceTarget('onedrive'));
  assert.equal(await picked, 'onedrive');
});

test('reopening after Escape resolves with the new choice', async () => {
  const dialog = new FakeDialog();

  const first = openSourcePicker(asDialog(dialog));
  dialog.emit('cancel', new Event('cancel'));
  assert.equal(await first, null);

  const second = openSourcePicker(asDialog(dialog));
  click(dialog, sourceTarget('local'));
  assert.equal(await second, 'local');
  assert.equal(dialog.listenerCount(), 0);
});
