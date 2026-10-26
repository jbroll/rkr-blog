// What happens when the author leaves the editor page: a warning while
// work would be lost, and a flush of the pending service-worker
// re-cache so the offline copy holds the last saved tree.

interface EventSource {
  addEventListener(type: string, fn: (ev: Event) => void): void;
}

interface Timers {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number | undefined): void;
}

// Text drafts survive a reload in IndexedDB, and a conflict keeps its
// draft; a save still in the air and image edits in an open dialog don't.
const UNSETTLED: ReadonlySet<string> = new Set(['saving', 'unsaved', 'offline']);

export function shouldWarnOnLeave(s: { saveState: string | null; imageDirty: boolean }): boolean {
  return s.imageDirty || (s.saveState !== null && UNSETTLED.has(s.saveState));
}

export function guardUnload(win: EventSource, shouldWarn: () => boolean): void {
  win.addEventListener('beforeunload', (ev) => {
    if (!shouldWarn()) return;
    // Browsers show their own text; preventDefault plus a returnValue
    // is the cross-browser way to ask.
    ev.preventDefault();
    (ev as BeforeUnloadEvent).returnValue = '';
  });
}

/** Coalesces post-save re-cache requests, and posts at once when the
 * page is hidden or left, so a quick exit doesn't strand the old copy. */
export function createRecache(deps: {
  win: EventSource;
  doc: EventSource & { visibilityState: string };
  timers: Timers;
  post: () => void;
  delayMs?: number;
}): { request(): void } {
  const { win, doc, timers, post } = deps;
  let pending: number | undefined;
  const flush = (): void => {
    if (pending === undefined) return;
    timers.clearTimeout(pending);
    pending = undefined;
    post();
  };
  win.addEventListener('pagehide', flush);
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'hidden') flush();
  });
  return {
    request() {
      timers.clearTimeout(pending);
      pending = timers.setTimeout(flush, deps.delayMs ?? 1000);
    }
  };
}
