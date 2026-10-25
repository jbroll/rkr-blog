// Whole-tree save pipeline for the unified editor: dirty indicator,
// coalesced saves, retry, and offline handling.
//
// Extracted from unified-shell.ts to keep that file under the 500-line
// cap. Behavior is pinned by the shell tests (blur save, in-flight
// coalescing, unsaved retry); this module holds no tree state itself —
// the shell owns the tree and passes snapshots in.
//
// Browser-safe: no node:* imports.

import type { BlockTree } from '../lib/blocks.ts';

/** Save states surfaced on the shell for tests and the indicator. */
type SaveState = 'clean' | 'editing' | 'saving' | 'unsaved';

export interface SavePipeline {
  /** Current state (mirrored to the shell's data-save-state). */
  state(): SaveState;
  /** Show a notice in the indicator without changing state (e.g. depth nudge). */
  notice(text: string): void;
  /** Mark local edits without saving (input events, queued coalescing). */
  markEditing(): void;
  /** Mark unsaved with `text` in the indicator (the change never reached
   * a save, e.g. its re-render failed). Stays until the next
   * requestSave; Save and online still retry. */
  fail(text: string): void;
  /** Save or retry now (the Save button's action); no-op when clean. */
  saveNow(): void;
  /** Persist `next`, coalescing with an in-flight save: the queued
   * tree always wins because immutable updates compose. Resolves when
   * the save (and any coalesced follow-up) settles. */
  requestSave(next: BlockTree): Promise<void>;
}

export interface SavePipelineDeps {
  onSave(tree: BlockTree): Promise<void>;
  getTree(): BlockTree;
  /** Retry path for Save and online; defaults to saving `getTree()`. */
  resave?(): Promise<void>;
  shellEl: Element;
  toolbar: Element;
}

const docOf = (el: Element): Document => el.ownerDocument;

/** Build the pipeline and its toolbar UI (Save button + indicator). */
export function createSavePipeline(deps: SavePipelineDeps): SavePipeline {
  const { onSave, getTree, shellEl, toolbar } = deps;
  const doc = docOf(shellEl);

  let saveState: SaveState = 'clean';
  let inFlight: Promise<void> | null = null;
  let queued: BlockTree | null = null;
  // Set by fail(); holds the state at unsaved until the next requestSave,
  // so an older save resolving can't report "Saved" over it.
  let failure: string | null = null;

  // The edit template ships both; the fallbacks keep bare toolbars working.
  const mountPoint = (selector: string, tag: string): HTMLElement => {
    const found = toolbar.querySelector(selector) as HTMLElement | null;
    if (found) return found;
    const created = doc.createElement(tag);
    toolbar.append(created);
    return created;
  };
  const indicator = mountPoint('.rkr-unified-save-state', 'span');
  indicator.className = 'rkr-unified-save-state';
  const saveBtn = mountPoint('.rkr-unified-save', 'button') as HTMLButtonElement;
  saveBtn.type = 'button';
  saveBtn.className = 'rkr-unified-save rkr-edit-btn is-primary';

  const offline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

  const setState = (next: SaveState): void => {
    saveState = failure === null ? next : 'unsaved';
    shellEl.setAttribute('data-save-state', saveState);
    indicator.textContent =
      failure ??
      (saveState === 'clean'
        ? 'Saved'
        : saveState === 'editing'
          ? 'Editing'
          : saveState === 'saving'
            ? 'Saving'
            : offline()
              ? 'Offline, will sync'
              : 'Not saved');
    saveBtn.textContent = saveState === 'unsaved' ? 'Retry' : 'Save';
    if (saveState === 'clean') saveBtn.setAttribute('disabled', '');
    else saveBtn.removeAttribute('disabled');
  };
  setState('clean');

  const runSave = (snapshot: BlockTree): Promise<void> => {
    setState('saving');
    const done = onSave(snapshot).then(
      () => {
        if (queued && queued !== snapshot) {
          const next = queued;
          queued = null;
          return runSave(next);
        }
        queued = null;
        inFlight = null;
        setState('clean');
      },
      () => {
        // Offline or server error: keep the tree, mark unsaved, retry
        // on the next blur, Save click, or browser online event.
        // Reload-before-reconnect loses the edit; durable offline
        // queueing is tracked follow-up work, not silent behavior.
        inFlight = null;
        setState('unsaved');
      }
    );
    inFlight = done;
    return done;
  };

  const retry = (): void => {
    if (saveState === 'clean') return;
    if (inFlight) return;
    void (deps.resave ? deps.resave() : runSave(getTree()));
  };
  saveBtn.addEventListener('click', retry);
  if (typeof window !== 'undefined') {
    window.addEventListener('online', retry);
  }

  return {
    state: () => saveState,
    saveNow: retry,
    notice: (text: string) => {
      indicator.textContent = text;
    },
    markEditing: () => {
      if (saveState === 'clean') setState('editing');
    },
    fail: (text: string) => {
      failure = text;
      setState('unsaved');
    },
    requestSave: (next: BlockTree): Promise<void> => {
      failure = null;
      if (inFlight) {
        queued = next;
        setState('editing');
        return inFlight;
      }
      return runSave(next);
    }
  };
}
