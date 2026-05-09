// Tiny DOM helpers shared by main.ts and the extracted admin modules
// (integrations, save, modals). All UI in this SPA targets static
// element ids declared in templates/admin.ts; missing ids indicate a
// template/main.ts mismatch and we fail loudly rather than soldier on.

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
 * on its textContent. */
export function setStatus(msg: string): void {
  $('rkroll-admin-status').textContent = msg;
}
