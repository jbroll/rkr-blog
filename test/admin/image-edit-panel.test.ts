import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LocalEditState } from '@rkr/image-edit';
import type { ImageEditPipeline } from '../../src/admin/image-edit.ts';
import { wireImageEditPanel } from '../../src/admin/image-edit-panel.ts';
import { FakeDocument, type FakeElement, FakeEvent } from './fake-dom.ts';

const tick = async (n = 5): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

const BUTTONS = [
  'crop',
  'rotateL',
  'rotateR',
  'flipH',
  'flipV',
  'perspective',
  'undo',
  'redo',
  'reset',
  'resample',
  'tilt'
] as const;

function harness(t: { after(fn: () => Promise<void>): void }, withLegacySave = false) {
  const doc = new FakeDocument();
  const status = doc.createElement('div');
  status.id = 'rkroll-admin-status';
  const preview = doc.createElement('img');
  preview.id = 'rkr-cell-preview';
  Object.assign(preview, { style: {} });
  const byId = new Map<string, FakeElement>([
    ['rkroll-admin-status', status],
    ['rkr-cell-preview', preview]
  ]);
  Object.assign(doc, { getElementById: (id: string) => byId.get(id) ?? null });
  const g = globalThis as { document?: unknown };
  const saved = g.document;
  g.document = doc;
  t.after(async () => {
    await tick();
    g.document = saved;
  });

  const el = (tag: string): FakeElement => doc.createElement(tag);
  const buttons = Object.fromEntries(BUTTONS.map((n) => [n, el('button')])) as Record<
    (typeof BUTTONS)[number] | 'save',
    FakeElement
  >;
  if (withLegacySave) buttons.save = el('button');
  const inputs = { resample: el('input'), slider: el('input'), tilt: el('input') };
  const editsList = el('ol');
  const section = el('div');

  const state: LocalEditState = {
    ops: [],
    redoStack: [],
    baseline: { ops: [], redoStack: [] },
    sourceWidth: 320,
    sourceHeight: 240
  };
  const events: string[] = [];
  let commitFails = false;
  const pipeline: ImageEditPipeline = {
    ensure: async () => state,
    get: () => state,
    persist: () => {},
    preview: async (_id, ops) => `blob:${ops.length}`,
    commit: async (_id, s) => {
      events.push('commit');
      if (commitFails) throw new Error('offline');
      s.baseline = { ops: [...s.ops], redoStack: [...s.redoStack] };
    },
    load: async () => {
      throw new Error('not in unit tests');
    }
  };
  const panel = wireImageEditPanel({
    onPreview: (id, url) => events.push(`preview:${id}:${url}`),
    section: section as unknown as HTMLDivElement,
    buttons: buttons as unknown as Parameters<typeof wireImageEditPanel>[0]['buttons'],
    resampleInput: inputs.resample as unknown as HTMLInputElement,
    tiltSlider: inputs.slider as unknown as HTMLInputElement,
    tiltInput: inputs.tilt as unknown as HTMLInputElement,
    editsList: editsList as unknown as HTMLOListElement,
    activeImageId: () => 'abc',
    pipeline
  });
  return {
    panel,
    state,
    events,
    buttons,
    inputs,
    editsList,
    section,
    preview,
    failCommit: () => {
      commitFails = true;
    }
  };
}

const setValue = (el: FakeElement, v: string): void => {
  (el as unknown as { value: string }).value = v;
};
const inputValue = (el: FakeElement): string => (el as unknown as { value: string }).value;
const types = (s: LocalEditState): string[] => s.ops.map((o) => o.type);

describe('image edit panel', () => {
  it('image edit panel calls onPreview after apply', async (t) => {
    const h = harness(t);
    h.panel.activateForId('abc', () => true);
    await tick();
    assert.deepEqual(h.events, ['preview:abc:blob:0']);
    assert.equal(h.section.dataset.ready, 'true');
    assert.equal((h.preview as unknown as { src?: string }).src, 'blob:0');

    assert.equal(await h.panel.save(), false, 'nothing to apply yet');
    h.events.length = 0;
    h.buttons.rotateR.click();
    await tick();
    assert.equal(await h.panel.save(), true);
    assert.deepEqual(h.events.slice(-2), ['commit', 'preview:abc:blob:1']);
  });

  it('a failed apply rejects and keeps the edits', async (t) => {
    const h = harness(t);
    h.panel.activateForId('abc', () => true);
    await tick();
    h.buttons.flipH.click();
    h.failCommit();
    await assert.rejects(h.panel.save(), /offline/);
    assert.equal(h.state.ops.length, 1);
  });

  it('tool buttons append ops, and undo, redo and reset walk them', async (t) => {
    const h = harness(t);
    h.panel.activateForId('abc', () => true);
    await tick();
    h.buttons.rotateL.click();
    h.buttons.flipV.click();
    assert.deepEqual(types(h.state), ['rotate', 'flip']);
    assert.equal(h.editsList.children.length, 2, 'one step row per op');
    h.buttons.undo.click();
    assert.deepEqual(types(h.state), ['rotate']);
    h.buttons.redo.click();
    assert.deepEqual(types(h.state), ['rotate', 'flip']);
    h.editsList.children[0]?.querySelector('button')?.click();
    assert.deepEqual(types(h.state), ['flip'], 'a step can be deleted');
    h.buttons.reset.click();
    assert.deepEqual(h.state.ops, []);
  });

  it('resample and tilt add their ops', async (t) => {
    const h = harness(t);
    h.panel.activateForId('abc', () => true);
    await tick();
    setValue(h.inputs.resample, '1200');
    h.buttons.resample.click();
    assert.deepEqual(types(h.state), ['resample']);
    setValue(h.inputs.resample, '');
    h.buttons.resample.click();
    assert.deepEqual(h.state.ops, [], 'an empty width clears the resample');
    setValue(h.inputs.slider, '12');
    h.inputs.slider.dispatchEvent(new FakeEvent('input'));
    assert.equal(inputValue(h.inputs.tilt), '12');
    setValue(h.inputs.tilt, '8');
    h.inputs.tilt.dispatchEvent(new FakeEvent('input'));
    assert.equal(inputValue(h.inputs.slider), '8');
    h.buttons.tilt.click();
    assert.deepEqual(types(h.state), ['rotate']);
  });

  it('discard restores the applied baseline and deactivate hides the panel', async (t) => {
    const h = harness(t);
    h.panel.activateForId('abc', () => true);
    await tick();
    h.buttons.rotateR.click();
    assert.equal(h.state.ops.length, 1);
    h.panel.discard();
    assert.deepEqual(h.state.ops, []);
    h.panel.deactivate();
    assert.equal(h.section.hidden, true);
    assert.equal(h.section.dataset.ready, 'false');
  });

  it('the legacy Save button applies through save()', async (t) => {
    const h = harness(t, true);
    h.panel.activateForId('abc', () => true);
    await tick();
    h.buttons.rotateR.click();
    h.buttons.save.click();
    await tick();
    assert.ok(h.events.includes('commit'));
  });

  it('step delete buttons are labelled by step number', async (t) => {
    const h = harness(t);
    h.panel.activateForId('abc', () => true);
    await tick();
    h.buttons.rotateR.click();
    h.buttons.flipH.click();
    assert.deepEqual(
      h.editsList.querySelectorAll('button').map((b) => b.getAttribute('aria-label')),
      ['Delete step 1', 'Delete step 2']
    );
  });

  it('dirty reports unapplied edits', async (t) => {
    const h = harness(t);
    h.panel.activateForId('abc', () => true);
    await tick();
    assert.equal(h.panel.dirty(), false);
    h.buttons.rotateR.click();
    assert.equal(h.panel.dirty(), true);
    await h.panel.save();
    assert.equal(h.panel.dirty(), false);
  });

  it('a discard repaint after deactivate keeps the preview hidden', async (t) => {
    const h = harness(t);
    h.panel.activateForId('abc', () => true);
    await tick();
    h.buttons.rotateR.click();
    await tick();
    h.panel.discard();
    h.panel.deactivate();
    await tick();
    assert.equal(h.preview.hidden, true);
  });

  it('a stale activation does not paint', async (t) => {
    const h = harness(t);
    h.panel.activateForId('abc', () => false);
    await tick();
    assert.deepEqual(h.events, []);
  });
});
