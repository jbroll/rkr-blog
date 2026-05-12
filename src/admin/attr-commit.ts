// Per-keystroke debounce for the editor's figure-attribute input
// handlers. Without this, each `input` event on caption / alt /
// width / aspect / timer fires a TipTap transaction (and a panel
// selectionUpdate cycle). For long captions, the rapid-fire
// transactions are wasted work — the user's intent is the final
// string, not every intermediate one.
//
// Debounce is keyed by attribute name so concurrent edits on
// different fields don't clobber each other's pending commits.
// `flushPendingAttrCommits()` runs every queued fn immediately;
// `handleSave` calls it at the start so save serialises the
// latest typed values.

const COMMIT_DEBOUNCE_MS = 150;

type Pending = { timer: ReturnType<typeof setTimeout>; fn: () => void };
const pending = new Map<string, Pending>();

/** Schedule `fn` to run after COMMIT_DEBOUNCE_MS. Re-scheduling
 * with the same key restarts the timer; the earlier fn is dropped
 * (only the latest matters — the debounced commit reads the
 * input's current value at fire time). */
export function scheduleAttrCommit(key: string, fn: () => void): void {
  const prev = pending.get(key);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => {
    pending.delete(key);
    fn();
  }, COMMIT_DEBOUNCE_MS);
  pending.set(key, { timer, fn });
}

/** Run every queued fn immediately, clearing the queue. Save calls
 * this before serialising so a quick "type then save" round-trip
 * doesn't drop the last typed character. */
export function flushPendingAttrCommits(): void {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.fn();
  }
  pending.clear();
}
