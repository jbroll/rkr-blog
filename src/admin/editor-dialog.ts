// One modal for every editor dialog: title, scrollable body, footer with
// a primary and a Cancel button. Built on <dialog>.showModal(), so the
// browser traps focus and inerts the page. Escape, the close button and
// a click on the backdrop all cancel; onPrimary returning false keeps it
// open so the caller can show an error.
//
// A dialog can push one sub-view (the figure dialog's image editor): it
// swaps the body, title and footer labels until its primary succeeds or
// it is cancelled, then the base view comes back.
//
// Browser-safe: no node:* imports. Tests pass a fake DOM root, so the
// <dialog> methods are optional.

import { openModal } from './dialog-focus.ts';

export interface EditorDialogOpts {
  title: string;
  body: Node;
  primaryLabel: string;
  /** Defaults to "Cancel". */
  cancelLabel?: string;
  /** Resolve true to close, false to stay open. */
  onPrimary(): boolean | Promise<boolean>;
  /** Escape, close button, Cancel or backdrop. Not called after a
   * successful primary. `how` tells the Cancel button from a dismissal. */
  onCancel?(how: 'button' | 'dismiss'): void;
  wide?: boolean;
  /** Where the dialog mounts. Defaults to `document.body`. */
  root?: Element;
}

interface DialogView {
  title: string;
  body: Node;
  primaryLabel: string;
  cancelLabel: string;
  /** Resolve true to return to the base view, false to stay. */
  onPrimary(): boolean | Promise<boolean>;
  /** Runs whenever the view is left: after a successful primary, on
   * cancel, or when the whole dialog closes. */
  onLeave?(cancelled: boolean): void;
  /** Asked before a cancel or close leaves the view; false stays. */
  confirmLeave?(): boolean | Promise<boolean>;
}

export interface EditorDialog {
  /** Close without calling onCancel. */
  close(): void;
  setError(text: string): void;
  setBusy(busy: boolean): void;
  pushView(view: DialogView): void;
}

const EDITING_ATTR = 'data-rkr-editing';

let titleCounter = 0;

function button(doc: Document, className: string, text: string): HTMLButtonElement {
  const el = doc.createElement('button');
  el.type = 'button';
  el.className = `rkr-edit-btn ${className}`;
  el.textContent = text;
  return el;
}

function isThenable(value: unknown): value is PromiseLike<boolean> {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}

export function openEditorDialog(opts: EditorDialogOpts): EditorDialog {
  const host = opts.root ?? document.body;
  const doc = host.ownerDocument;
  const dialog = doc.createElement('dialog');
  dialog.className = opts.wide ? 'rkr-dialog is-wide' : 'rkr-dialog';
  dialog.setAttribute('data-rkr-dialog', '');
  const titleId = `rkr-dialog-title-${++titleCounter}`;
  dialog.setAttribute('aria-labelledby', titleId);

  const panel = doc.createElement('div');
  panel.className = 'rkr-dialog-panel';

  const head = doc.createElement('div');
  head.className = 'rkr-dialog-head';
  const title = doc.createElement('h2');
  title.id = titleId;
  title.className = 'rkr-dialog-title';
  title.textContent = opts.title;
  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'rkr-dialog-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M3 3l10 10M13 3L3 13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  head.append(title, closeBtn);

  const bodyWrap = doc.createElement('div');
  bodyWrap.className = 'rkr-dialog-body';
  bodyWrap.append(opts.body);

  const error = doc.createElement('p');
  error.className = 'rkr-dialog-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;

  const foot = doc.createElement('div');
  foot.className = 'rkr-dialog-foot';
  const baseCancel = opts.cancelLabel ?? 'Cancel';
  const cancelBtn = button(doc, 'is-quiet rkr-dialog-cancel', baseCancel);
  const primaryBtn = button(doc, 'is-primary rkr-dialog-primary', opts.primaryLabel);
  foot.append(cancelBtn, primaryBtn);

  panel.append(head, bodyWrap, error, foot);
  dialog.append(panel);

  const html = doc.documentElement as Element | undefined;
  const pausedPage = html ? !html.hasAttribute(EDITING_ATTR) : false;
  if (pausedPage) html?.setAttribute(EDITING_ATTR, '');

  let closed = false;
  let busy = false;
  let view: DialogView | null = null;

  const show = (next: { title: string; body: Node; primaryLabel: string; cancelLabel: string }) => {
    title.textContent = next.title;
    bodyWrap.textContent = '';
    bodyWrap.append(next.body);
    primaryBtn.textContent = next.primaryLabel;
    cancelBtn.textContent = next.cancelLabel;
    handle.setError('');
  };

  const popView = (cancelled: boolean): void => {
    const leaving = view;
    if (!leaving) return;
    view = null;
    show({ ...opts, cancelLabel: baseCancel });
    leaving.onLeave?.(cancelled);
  };

  const finish = (cancelled: boolean, how: 'button' | 'dismiss' = 'dismiss'): void => {
    if (closed) return;
    popView(true);
    closed = true;
    if (pausedPage) html?.removeAttribute(EDITING_ATTR);
    if (dialog.open) dialog.close?.();
    dialog.remove();
    if (cancelled) opts.onCancel?.(how);
  };

  const submit = async (): Promise<void> => {
    if (busy || closed) return;
    handle.setError('');
    const active = view;
    let ok = false;
    try {
      const result = (active ?? opts).onPrimary();
      if (isThenable(result)) {
        handle.setBusy(true);
        try {
          ok = await result;
        } finally {
          handle.setBusy(false);
        }
      } else {
        ok = result;
      }
    } catch (err) {
      console.error('editor dialog:', err);
      handle.setError('Something went wrong. Try again.');
      ok = false;
    }
    if (!ok || closed) return;
    if (active) popView(false);
    else finish(false);
  };

  /** Run `leave` unless the active view's leave check says no. A plain
   * boolean answer acts synchronously. */
  const guardLeave = (leave: () => void): void => {
    if (busy) return;
    const asking = view;
    const answer = asking?.confirmLeave ? asking.confirmLeave() : true;
    if (answer === true) {
      leave();
      return;
    }
    if (answer === false) return;
    void answer.then((ok) => {
      // A stale answer (the view changed meanwhile) counts as no.
      if (ok && view === asking && !closed) leave();
    });
  };

  const cancel = (how: 'button' | 'dismiss' = 'dismiss'): void => {
    guardLeave(() => {
      if (view) popView(true);
      else finish(true, how);
    });
  };

  const handle: EditorDialog = {
    close: () => finish(false),
    setError: (text) => {
      error.textContent = text;
      error.hidden = text === '';
    },
    setBusy: (next) => {
      busy = next;
      for (const el of [primaryBtn, cancelBtn]) {
        if (next) el.setAttribute('disabled', '');
        else el.removeAttribute('disabled');
      }
      if (next) dialog.setAttribute('aria-busy', 'true');
      else dialog.removeAttribute('aria-busy');
    },
    pushView: (next) => {
      if (closed) return;
      popView(true);
      view = next;
      show(next);
    }
  };

  closeBtn.addEventListener('click', () => guardLeave(() => finish(true)));
  cancelBtn.addEventListener('click', () => cancel('button'));
  primaryBtn.addEventListener('click', () => {
    void submit();
  });

  // Native Escape fires `cancel` before closing; keydown covers browsers
  // and fakes without <dialog>.
  dialog.addEventListener('cancel', (ev) => {
    ev.preventDefault();
    cancel();
  });
  dialog.addEventListener('keydown', (ev) => {
    const key = (ev as KeyboardEvent).key;
    if (key === 'Escape') {
      ev.preventDefault();
      cancel();
    } else if (key === 'Enter') {
      const tag = (ev.target as Element | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT') {
        ev.preventDefault();
        void submit();
      }
    }
  });

  // A drag that starts in a field and ends on the backdrop must not close it.
  let pressedBackdrop = false;
  dialog.addEventListener('mousedown', (ev) => {
    pressedBackdrop = ev.target === dialog;
  });
  dialog.addEventListener('click', (ev) => {
    if (ev.target === dialog && pressedBackdrop) cancel();
    pressedBackdrop = false;
  });

  host.append(dialog);
  if (typeof dialog.showModal === 'function') openModal(dialog);
  else dialog.setAttribute('open', '');
  const first = bodyWrap.querySelector('input,select,textarea') as HTMLElement | null;
  (first ?? primaryBtn).focus?.();
  return handle;
}
