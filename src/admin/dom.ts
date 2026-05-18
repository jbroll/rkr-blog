// Tiny DOM helpers shared by main.ts and the extracted admin modules
// (integrations, save, modals). All UI in this SPA targets static
// element ids declared in templates/admin.ts; missing ids indicate a
// template/main.ts mismatch and we fail loudly rather than soldier on.

import { showToast } from './toast.ts';

/** getElementById that throws if the element is missing. T defaults to
 * HTMLElement; pass a more specific subtype where the call site
 * narrows usage (e.g. $<HTMLInputElement>('rkr-slug').value). */
export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
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

/** Status line with a trailing link — used after a successful save to
 * surface the public URL. Both args are inserted as text/attribute via
 * the DOM API so no caller is responsible for escaping. */
export function setStatusWithLink(msg: string, href: string, linkText: string): void {
  const el = $('rkroll-admin-status');
  el.textContent = `${msg} `;
  const a = document.createElement('a');
  a.href = href;
  a.textContent = linkText;
  el.appendChild(a);
}
