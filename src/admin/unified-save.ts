// Whole-tree save pipeline for the unified editor: dirty indicator,
// coalesced saves, retry, durable drafts, offline sync and conflicts.
//
// The shell owns the tree and passes snapshots in. Every request is
// preceded by a draft write (unified-draft.ts) that is cleared once the
// server has the tree, so a reload never loses an unsynced edit. Each
// save sends the version it was edited from; a 409 opens the conflict
// dialog instead of overwriting another tab's or device's changes.
//
// Browser-safe: no node:* imports.

import type { BlockTree } from '../lib/blocks.ts';
import type { Path } from './block-tree-ops.ts';
import { openEditorDialog } from './editor-dialog.ts';
import { type DraftRecord, type DraftStore, within } from './unified-draft.ts';

type SaveState = 'clean' | 'editing' | 'saving' | 'unsaved' | 'offline' | 'conflict';

/** Thrown by `onSave` when the page changed since `baseVersion`. */
export class SaveConflict extends Error {
  readonly version: string;
  constructor(version: string) {
    super('conflict');
    this.version = version;
  }
}

/** Thrown by `onSave` for a refusal the author should read as is. */
export class SaveFailure extends Error {}

/** Thrown by `onSave` when the request never reached the server. */
export class SaveOffline extends Error {}

/** Thrown by `onSave` when the server refuses the tree itself (400). */
export class SaveInvalid extends Error {
  readonly path?: Path;
  constructor(message: string, path?: Path) {
    super(message);
    this.path = path;
  }
}

const INVALID_FALLBACK = "This page can't be saved.";

/** The save route's 400 reply, `{error:'invalid', message, path?}`; a bare
 * `{error}` from an older server is read as the message. */
export function invalidFromReply(reply: unknown): SaveInvalid {
  const r = (reply ?? {}) as { error?: unknown; message?: unknown; path?: unknown };
  const text = [r.message, r.error].find((v) => typeof v === 'string' && v !== '');
  const path =
    Array.isArray(r.path) && r.path.length > 0 && r.path.every((i) => Number.isInteger(i) && i >= 0)
      ? (r.path as Path)
      : undefined;
  return new SaveInvalid((text as string | undefined) ?? INVALID_FALLBACK, path);
}

export interface SaveRefusal {
  path?: Path;
  message: string;
}

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
  /** Send the next save against `version` (a restored draft's base).
   * `restoredAt` is the draft's savedAt: its conflict defaults to Load latest. */
  rebase(version: string, restoredAt?: number): void;
  /** Write `tree` to the draft store without sending it. */
  draft(tree: BlockTree): void;
}

export interface SavePipelineDeps {
  /** Store `tree`; a string result is the new stored version. */
  onSave(tree: BlockTree, baseVersion?: string): Promise<unknown>;
  getTree(): BlockTree;
  /** Retry path for Save and online; defaults to saving `getTree()`. */
  resave?(): Promise<void>;
  shellEl: Element;
  toolbar: Element;
  /** Stored version the editor loaded (`data-version`). */
  version?: string;
  drafts?: DraftStore;
  /** Where the conflict dialog mounts. */
  dialogRoot?: Element;
  /** Source of `online` events; defaults to `window`. */
  win?: EventTarget;
  /** "Load latest"; defaults to reloading the page. */
  reload?(): void;
  /** How long one draft-store call may take before the save goes on
   * without it. */
  draftTimeoutMs?: number;
  /** The server refused the tree (SaveInvalid); null once a new save starts. */
  onRefused?(refusal: SaveRefusal | null): void;
}

const LABELS: Record<SaveState, string> = {
  clean: 'Saved',
  editing: 'Editing',
  saving: 'Saving',
  unsaved: 'Not saved',
  offline: 'Offline, will sync',
  conflict: 'Changed somewhere else'
};

const CONFLICT_TITLE = 'This page changed somewhere else.';
const CONFLICT_TEXT =
  'Load latest discards your changes here. Keep mine saves your version over the other one.';
const restoredText = (savedAt: number): string =>
  `Unsaved changes from ${new Date(savedAt).toLocaleString()} on this device. ` +
  'Load latest discards them. Keep mine saves them over the newer version.';

const navigatorOffline = (): boolean =>
  typeof navigator !== 'undefined' && navigator.onLine === false;

/** Build the pipeline and its toolbar UI (Save button + indicator). */
export function createSavePipeline(deps: SavePipelineDeps): SavePipeline {
  const { onSave, getTree, shellEl, toolbar, drafts } = deps;
  const doc = shellEl.ownerDocument;

  let saveState: SaveState = 'clean';
  let inFlight: Promise<void> | null = null;
  let queued: BlockTree | null = null;
  let version = deps.version;
  // Set by fail() or a SaveFailure; holds the state at unsaved until the
  // next requestSave, so an older save resolving can't report "Saved".
  let failure: string | null = null;
  let latest: string | null = null;
  let choosing = false;
  // savedAt of a restored draft not yet stored; its conflict is likely stale.
  let restored: number | null = null;
  // The tree the server refused; retrying it unchanged would fail again.
  let refusedTree: BlockTree | null = null;
  const timeoutMs = deps.draftTimeoutMs ?? 500;

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

  const setState = (next: SaveState): void => {
    saveState = failure === null ? next : 'unsaved';
    shellEl.setAttribute('data-save-state', saveState);
    indicator.textContent =
      failure ??
      (saveState === 'unsaved' && navigatorOffline() ? LABELS.offline : LABELS[saveState]);
    const stuck = saveState === 'unsaved' || saveState === 'offline' || saveState === 'conflict';
    saveBtn.textContent = stuck ? 'Retry' : 'Save';
    if (saveState === 'clean') saveBtn.setAttribute('disabled', '');
    else saveBtn.removeAttribute('disabled');
  };
  setState('clean');

  // A draft write must never block or fail the save itself.
  const writeDraft = async (tree: BlockTree): Promise<DraftRecord | null> => {
    if (!drafts) return null;
    const record = { tree, baseVersion: version ?? '', savedAt: Date.now() };
    const stored = await within(
      drafts.put(record).then(() => true),
      timeoutMs
    );
    return stored ? record : null;
  };

  const runSave = (snapshot: BlockTree): Promise<void> => {
    setState('saving');
    let draft: DraftRecord | null = null;
    const done = (async () => {
      draft = await writeDraft(snapshot);
      const next = await onSave(snapshot, version);
      if (typeof next === 'string') version = next;
    })().then(
      () => {
        if (queued && queued !== snapshot) {
          const next = queued;
          queued = null;
          return runSave(next);
        }
        queued = null;
        inFlight = null;
        restored = null;
        if (draft && drafts) void within(drafts.clear(draft.savedAt), timeoutMs);
        setState('clean');
      },
      (err: unknown) => {
        // The draft stays: Save, online, or the next load retries it. A
        // retry sends the current tree, so a queued one is now stale.
        inFlight = null;
        queued = null;
        if (err instanceof SaveConflict) {
          latest = err.version;
          setState('conflict');
          chooseVersion();
          return;
        }
        if (err instanceof SaveInvalid) {
          refusedTree = snapshot;
          failure = err.path ? LABELS.unsaved : err.message;
          deps.onRefused?.({ path: err.path, message: err.message });
        }
        if (err instanceof SaveFailure) failure = err.message;
        setState(err instanceof SaveOffline || navigatorOffline() ? 'offline' : 'unsaved');
      }
    );
    inFlight = done;
    return done;
  };

  const resave = (): void => {
    void (deps.resave ? deps.resave() : runSave(getTree()));
  };

  function chooseVersion(): void {
    if (choosing) return;
    choosing = true;
    const body = doc.createElement('p');
    body.className = 'rkr-confirm-text';
    body.textContent = restored === null ? CONFLICT_TEXT : restoredText(restored);
    const keepMine = (): void => {
      if (latest !== null) version = latest;
      resave();
    };
    const loadLatest = (): void => {
      void (async () => {
        if (drafts) await within(drafts.clear(), timeoutMs);
        (deps.reload ?? (() => location.reload()))();
      })();
    };
    // A leftover draft most likely lost to newer work, so Load latest
    // leads; in a live session the author's own edit does.
    const [primary, secondary] =
      restored === null
        ? [
            { label: 'Keep mine', run: keepMine },
            { label: 'Load latest', run: loadLatest }
          ]
        : [
            { label: 'Load latest', run: loadLatest },
            { label: 'Keep mine', run: keepMine }
          ];
    openEditorDialog({
      root: deps.dialogRoot,
      title: CONFLICT_TITLE,
      body,
      primaryLabel: primary.label,
      cancelLabel: secondary.label,
      onPrimary: () => {
        choosing = false;
        primary.run();
        return true;
      },
      onCancel: (how) => {
        choosing = false;
        if (how === 'button') secondary.run();
      }
    });
  }

  const retry = (): void => {
    if (saveState === 'clean' || inFlight || getTree() === refusedTree) return;
    if (saveState === 'conflict') chooseVersion();
    else resave();
  };
  saveBtn.addEventListener('click', retry);
  const win = deps.win ?? (typeof window !== 'undefined' ? window : undefined);
  win?.addEventListener('online', () => {
    if (saveState !== 'conflict') retry();
  });

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
    rebase: (next: string, restoredAt?: number) => {
      version = next;
      restored = restoredAt ?? null;
    },
    draft: (tree: BlockTree) => {
      void writeDraft(tree);
    },
    requestSave: (next: BlockTree): Promise<void> => {
      failure = null;
      if (refusedTree) {
        refusedTree = null;
        deps.onRefused?.(null);
      }
      if (inFlight) {
        queued = next;
        void writeDraft(next);
        setState('editing');
        return inFlight;
      }
      return runSave(next);
    }
  };
}
