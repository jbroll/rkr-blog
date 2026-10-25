// One modal for every editor dialog: title, scrollable body, footer with
// a primary and a Cancel button. Built on <dialog>.showModal(), so the
// browser traps focus and inerts the page. Escape, the close button and
// a click on the backdrop all cancel; onPrimary returning false keeps it
// open so the caller can show an error.
//
// Browser-safe: no node:* imports. Tests pass a fake DOM root, so the
// <dialog> methods are optional.

import { openModal } from './dialog-focus.ts';

export interface EditorDialogOpts {
  title: string;
  body: Node;
  primaryLabel: string;
  /** Resolve true to close, false to stay open. */
  onPrimary(): boolean | Promise<boolean>;
  /** Escape, close button, Cancel or backdrop. Not called after a successful primary. */
  onCancel?(): void;
  wide?: boolean;
  /** Where the dialog mounts. Defaults to `document.body`. */
  root?: Element;
}

export interface EditorDialog {
  /** Close without calling onCancel. */
  close(): void;
  setError(text: string): void;
  setBusy(busy: boolean): void;
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
  const cancelBtn = button(doc, 'is-quiet rkr-dialog-cancel', 'Cancel');
  const primaryBtn = button(doc, 'is-primary rkr-dialog-primary', opts.primaryLabel);
  foot.append(cancelBtn, primaryBtn);

  panel.append(head, bodyWrap, error, foot);
  dialog.append(panel);

  const html = doc.documentElement as Element | undefined;
  const pausedPage = html ? !html.hasAttribute(EDITING_ATTR) : false;
  if (pausedPage) html?.setAttribute(EDITING_ATTR, '');

  let closed = false;
  let busy = false;

  const finish = (cancelled: boolean): void => {
    if (closed) return;
    closed = true;
    if (pausedPage) html?.removeAttribute(EDITING_ATTR);
    if (dialog.open) dialog.close?.();
    dialog.remove();
    if (cancelled) opts.onCancel?.();
  };

  const submit = async (): Promise<void> => {
    if (busy || closed) return;
    handle.setError('');
    let keepOpen = false;
    try {
      keepOpen = !(await opts.onPrimary());
    } catch {
      handle.setError('Something went wrong. Try again.');
      keepOpen = true;
    }
    if (!keepOpen) finish(false);
  };

  const cancel = (): void => {
    if (!busy) finish(true);
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
    }
  };

  closeBtn.addEventListener('click', cancel);
  cancelBtn.addEventListener('click', cancel);
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
