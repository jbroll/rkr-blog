// The shared source picker behind both the +Image and +Video toolbar
// entries. The dialog has one button per source plus a Cancel button;
// each carries `data-source` on the click target. Both entry points
// reuse this single implementation so the cancel/close cleanup (which
// used to be duplicated, and buggy) lives in one place.

import { openModal } from './dialog-focus.ts';

/** The source a user picked, or null for Cancel/Escape/close. */
export type SourceChoice = 'local' | 'drive' | 'onedrive' | 'photos' | null;

/** Show the source-picker dialog and resolve with the chosen source
 * (or null on cancel). Resolves and detaches every listener on all exit
 * paths: a source-button click, the Cancel button, Escape (`cancel`), or
 * a programmatic/form-method close (`close`). Without the cancel/close
 * handling the click listener would outlive the dialog: the promise
 * would stay pending and the next open would double-fire, misrouting
 * the image vs video branch. */
export function openSourcePicker(dialog: HTMLDialogElement): Promise<SourceChoice> {
  return new Promise((resolve) => {
    let settled = false;

    const cleanup = (): void => {
      dialog.removeEventListener('click', onClick);
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('close', onClose);
    };
    const settle = (choice: SourceChoice): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(choice);
    };

    const onClick = (ev: Event): void => {
      const btn = (ev.target as HTMLElement | null)?.closest<HTMLButtonElement>(
        'button[data-source]'
      );
      if (!btn) return;
      const src = btn.dataset.source ?? '';
      // Settle before closing so a synchronously-dispatched `close`
      // event can't win the race and resolve null instead of the pick.
      settle(
        src === 'local' || src === 'drive' || src === 'onedrive' || src === 'photos' ? src : null
      );
      dialog.close();
    };
    const onCancel = (): void => settle(null);
    const onClose = (): void => settle(null);

    dialog.addEventListener('click', onClick);
    dialog.addEventListener('cancel', onCancel);
    dialog.addEventListener('close', onClose);
    openModal(dialog);
  });
}
