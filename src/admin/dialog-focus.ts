// Mobile-keyboard suppressor for <dialog> close.
//
// `<dialog>.showModal()` saves the currently-focused element and
// `<dialog>.close()` restores focus to it. When the saved element
// is the editor's contenteditable article, mobile browsers pop the
// OS keyboard on close — annoying when the user is just browsing
// figure-config / source-picker / storage dialogs.
//
// Wrap showModal so any contenteditable activeElement gets blurred
// BEFORE the dialog records its restore target. Then close has
// nothing to restore to, and the keyboard stays down until the
// user explicitly taps the editor.
//
// Imported for side effect from src/admin/main.ts. Applies once
// per page load (idempotent via the `patched` flag).

let patched = false;

function patch(): void {
  if (patched) return;
  if (typeof HTMLDialogElement === 'undefined') return;
  patched = true;
  const orig = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.isContentEditable) {
      active.blur();
    }
    return orig.call(this);
  };
}

patch();
