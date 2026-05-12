// Open a <dialog> with showModal() AFTER blurring any contenteditable
// element. Without the blur, the dialog records the editor article
// as its restore target; on close, the editor regains focus and
// mobile browsers pop the OS keyboard.
//
// Plain function, called from every showModal call site. Doesn't
// need the editor instance — `document.activeElement` is enough.

export function openModal(dialog: HTMLDialogElement): void {
  if (dialog.open) return;
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.isContentEditable) {
    active.blur();
  }
  dialog.showModal();
}
