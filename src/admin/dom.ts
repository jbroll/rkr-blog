// Status-line helper shared by the editor's media and sync modules.

import { showToast } from './toast.ts';

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el;
}

/** Update the status line under the toolbar. The single source of
 * progress / error feedback for the editor; tests + e2e specs assert
 * on its textContent. Errors also show a persistent toast so the
 * message is visible even when the status bar is scrolled off screen. */
export function setStatus(msg: string, isError = false): void {
  const el = $('rkroll-admin-status');
  el.textContent = msg;
  el.classList.toggle('is-error', isError);
  if (isError) showToast({ kind: 'error', text: msg, ttlMs: Infinity });
}
