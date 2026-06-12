// Generic browser-UI helpers used by the package's modals. Self-contained
// so the modals carry no host-app (blog admin) coupling.

/** Status callback the host supplies so a modal can surface progress / errors
 * in whatever UI it owns (a status bar, a toast, or nothing). */
export type StatusFn = (msg: string, isError?: boolean) => void;

/** getElementById that throws if the element is missing. The host page must
 * declare the dialog markup with the ids the modals query. */
export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
}

/** Open a <dialog> with showModal() after blurring any contenteditable
 * element, so the dialog doesn't record an editor as its focus-restore
 * target (which pops the OS keyboard on mobile when the dialog closes). */
export function openModal(dialog: HTMLDialogElement): void {
  if (dialog.open) return;
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.isContentEditable) {
    active.blur();
  }
  dialog.showModal();
}
