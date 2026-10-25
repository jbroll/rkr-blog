import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  browserMediaDeps,
  type MediaSourceDeps,
  pickMedia,
  uploadImageDirect
} from '../../src/admin/media-source.ts';
import type { SourceChoice } from '../../src/admin/source-picker.ts';
import { FakeDocument, type FakeElement, FakeEvent } from './fake-dom.ts';

function fakeDeps(over: Partial<MediaSourceDeps> & { choice?: SourceChoice } = {}) {
  const log: string[] = [];
  const deps: MediaSourceDeps = {
    chooseSource: async () => over.choice ?? null,
    chooseFiles: async () => [],
    upload: async (_kind, file) => `id-${file.name}`,
    pickCloud: async () => [],
    settle: async () => {
      log.push('settle');
    },
    report: (text) => {
      log.push(text);
    },
    ...over
  };
  return { deps, log };
}

const file = (name: string): File => ({ name }) as File;

describe('pickMedia', () => {
  it('pickMedia returns [] on cancel', async () => {
    const { deps } = fakeDeps({ choice: null });
    assert.deepEqual(await pickMedia('image', deps), []);
  });

  it('returns [] when the file chooser is dismissed', async () => {
    const { deps, log } = fakeDeps({ choice: 'local', chooseFiles: async () => [] });
    assert.deepEqual(await pickMedia('image', deps), []);
    assert.deepEqual(log, []);
  });

  it('pickMedia local uploads every selected file', async () => {
    const uploaded: string[] = [];
    const { deps, log } = fakeDeps({
      choice: 'local',
      chooseFiles: async () => [file('a.png'), file('b.png')],
      upload: async (kind, f) => {
        uploaded.push(`${kind}:${f.name}`);
        return `id-${f.name}`;
      }
    });
    assert.deepEqual(await pickMedia('image', deps), ['id-a.png', 'id-b.png']);
    assert.deepEqual(uploaded, ['image:a.png', 'image:b.png']);
    assert.equal(log.at(-1), 'settle', 'waits for queued uploads to reach the server');
  });

  it('keeps the ids uploaded before a failure and reports it', async () => {
    const { deps, log } = fakeDeps({
      choice: 'local',
      chooseFiles: async () => [file('a.mp4'), file('b.mp4')],
      upload: async (_kind, f) => {
        if (f.name === 'b.mp4') throw new Error('too large');
        return `id-${f.name}`;
      }
    });
    assert.deepEqual(await pickMedia('video', deps), ['id-a.mp4']);
    assert.ok(log.some((line) => /b\.mp4.*too large/.test(line)));
  });

  for (const source of ['drive', 'onedrive', 'photos'] as const) {
    it(`${source} returns the provider's imported ids`, async () => {
      const calls: string[] = [];
      const { deps } = fakeDeps({
        choice: source,
        pickCloud: async (kind, from) => {
          calls.push(`${kind}:${from}`);
          return ['x1', 'x2'];
        }
      });
      assert.deepEqual(await pickMedia('video', deps), ['x1', 'x2']);
      assert.deepEqual(calls, [`video:${source}`]);
    });
  }

  it('a provider error reports and returns []', async () => {
    const { deps, log } = fakeDeps({
      choice: 'drive',
      pickCloud: async () => {
        throw new Error('not connected');
      }
    });
    assert.deepEqual(await pickMedia('image', deps), []);
    assert.ok(log.some((line) => /not connected/.test(line)));
  });
});

describe('browserMediaDeps', () => {
  function page(t: { after(fn: () => void): void }) {
    const doc = new FakeDocument();
    const ids = [
      'rkr-source-picker',
      'rkr-source-picker-title',
      'rkr-image-input',
      'rkr-video-input'
    ];
    const els = new Map<string, FakeElement>(
      ids.map((id) => {
        const el = doc.createElement(id.endsWith('input') ? 'input' : 'div');
        el.id = id;
        return [id, el];
      })
    );
    Object.assign(doc, { getElementById: (id: string) => els.get(id) ?? null });
    Object.assign(els.get('rkr-source-picker') as FakeElement, { open: false, showModal() {} });
    // openModal checks the active element against these browser globals.
    const g = globalThis as { document?: unknown; HTMLElement?: unknown };
    const saved = { document: g.document, HTMLElement: g.HTMLElement };
    g.document = { activeElement: null };
    g.HTMLElement ??= class {};
    t.after(() => {
      g.document = saved.document;
      g.HTMLElement = saved.HTMLElement;
    });
    const io = {
      upload: async () => 'id',
      settle: async () => {}
    };
    return { doc: doc as unknown as Document, els, io };
  }

  it('titles the picker for the kind and resolves null on cancel', async (t) => {
    const { doc, els, io } = page(t);
    const deps = browserMediaDeps(doc, true, io);
    const choice = deps.chooseSource('image');
    assert.equal(els.get('rkr-source-picker-title')?.textContent, 'Add images');
    els.get('rkr-source-picker')?.dispatchEvent(new FakeEvent('cancel'));
    assert.equal(await choice, null);
    void browserMediaDeps(doc, false, io).chooseSource('video');
    assert.equal(els.get('rkr-source-picker-title')?.textContent, 'Add video');
  });

  it('chooseFiles resolves the chosen files, or [] when dismissed', async (t) => {
    const { doc, els, io } = page(t);
    const input = els.get('rkr-image-input') as FakeElement & {
      files?: unknown[];
      multiple?: boolean;
      value?: string;
    };
    const a = file('a.png');
    input.click = () => {
      input.files = [a];
      input.dispatchEvent(new FakeEvent('change'));
    };
    const deps = browserMediaDeps(doc, true, io);
    assert.deepEqual(await deps.chooseFiles('image'), [a]);
    assert.equal(input.multiple, true);
    assert.equal(input.value, '');
    input.click = () => input.dispatchEvent(new FakeEvent('cancel'));
    assert.deepEqual(await deps.chooseFiles('image'), []);
  });

  it('video picks a single file from the video input', async (t) => {
    const { doc, els, io } = page(t);
    const input = els.get('rkr-video-input') as FakeElement & { multiple?: boolean };
    input.click = () => input.dispatchEvent(new FakeEvent('cancel'));
    await browserMediaDeps(doc, true, io).chooseFiles('video');
    assert.equal(input.multiple, false);
  });
});

describe('uploadImageDirect', () => {
  it('posts the file and returns the stored id, or throws on an error status', async () => {
    const calls: string[] = [];
    const ok = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ id: 'abc123' }), { status: 200 });
    }) as unknown as typeof fetch;
    const blob = new File(['x'], 'a.png', { type: 'image/png' });
    assert.equal(await uploadImageDirect(blob, ok), 'abc123');
    assert.deepEqual(calls, ['/admin/upload']);
    const bad = (async () => new Response('', { status: 413 })) as unknown as typeof fetch;
    await assert.rejects(uploadImageDirect(blob, bad), /upload failed \(413\)/);
  });
});
