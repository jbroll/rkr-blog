import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRecache, guardUnload, shouldWarnOnLeave } from '../../src/admin/editor-leave.ts';

type Handler = (ev: Event) => void;

class FakeTarget {
  handlers = new Map<string, Handler[]>();
  visibilityState: 'visible' | 'hidden' = 'visible';
  addEventListener(type: string, fn: Handler): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  fire(type: string, ev: Event = new Event(type)): Event {
    for (const fn of this.handlers.get(type) ?? []) fn(ev);
    return ev;
  }
}

function fakeTimers() {
  let next = 1;
  const pending = new Map<number, () => void>();
  return {
    pending,
    setTimeout: (fn: () => void) => {
      const id = next++;
      pending.set(id, fn);
      return id;
    },
    clearTimeout: (id: number | undefined) => {
      if (id !== undefined) pending.delete(id);
    },
    runAll: () => {
      for (const [id, fn] of [...pending]) {
        pending.delete(id);
        fn();
      }
    }
  };
}

function recacheRig() {
  const win = new FakeTarget();
  const doc = new FakeTarget();
  const timers = fakeTimers();
  let posts = 0;
  const recache = createRecache({
    win,
    doc,
    timers,
    post: () => {
      posts++;
    }
  });
  return { win, doc, timers, recache, posts: () => posts };
}

test('shouldWarnOnLeave: unapplied image edits warn', () => {
  assert.equal(shouldWarnOnLeave({ saveState: 'clean', imageDirty: true }), true);
});

test('shouldWarnOnLeave: an unsettled page save warns', () => {
  for (const saveState of ['saving', 'unsaved', 'offline']) {
    assert.equal(shouldWarnOnLeave({ saveState, imageDirty: false }), true, saveState);
  }
});

test('shouldWarnOnLeave: settled or draft-backed states do not warn', () => {
  for (const saveState of ['clean', 'editing', 'conflict', null]) {
    assert.equal(shouldWarnOnLeave({ saveState, imageDirty: false }), false, String(saveState));
  }
});

test('guardUnload: blocks the unload only while the check says so', () => {
  const win = new FakeTarget();
  let warn = false;
  guardUnload(win, () => warn);

  const quiet = win.fire('beforeunload', new Event('beforeunload', { cancelable: true }));
  assert.equal(quiet.defaultPrevented, false);

  warn = true;
  const blocked = win.fire('beforeunload', new Event('beforeunload', { cancelable: true }));
  assert.equal(blocked.defaultPrevented, true);
});

test('createRecache: coalesces saves into one post after the delay', () => {
  const rig = recacheRig();
  rig.recache.request();
  rig.recache.request();
  assert.equal(rig.posts(), 0);
  rig.timers.runAll();
  assert.equal(rig.posts(), 1);
});

test('createRecache: pagehide flushes a pending re-cache at once', () => {
  const rig = recacheRig();
  rig.recache.request();
  rig.win.fire('pagehide');
  assert.equal(rig.posts(), 1);
  rig.timers.runAll();
  assert.equal(rig.posts(), 1, 'the cancelled timer does not post again');
});

test('createRecache: the tab going hidden flushes a pending re-cache', () => {
  const rig = recacheRig();
  rig.recache.request();
  rig.doc.visibilityState = 'hidden';
  rig.doc.fire('visibilitychange');
  assert.equal(rig.posts(), 1);
});

test('createRecache: leaving with nothing pending posts nothing', () => {
  const rig = recacheRig();
  rig.win.fire('pagehide');
  rig.doc.fire('visibilitychange');
  assert.equal(rig.posts(), 0);
});

test('createRecache: the tab becoming visible does not flush', () => {
  const rig = recacheRig();
  rig.recache.request();
  rig.doc.fire('visibilitychange');
  assert.equal(rig.posts(), 0);
});
