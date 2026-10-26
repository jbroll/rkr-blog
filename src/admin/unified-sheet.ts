// Phone-width chrome for the unified editor: the "Add block" button that
// opens the palette dock as a bottom sheet, and the phone preview toggle.
// CSS decides when either is visible; this module only holds their state.
//
// Browser-safe: no node:* imports.

export function mountAddSheet(dock: HTMLElement): { close(): void } {
  const doc = dock.ownerDocument;
  const host = dock.parentNode as Element;

  const fab = doc.createElement('button');
  fab.type = 'button';
  fab.className = 'rkr-add-fab rkr-edit-btn is-primary';
  fab.textContent = 'Add block';
  fab.setAttribute('aria-expanded', 'false');
  fab.setAttribute('aria-controls', dock.id);

  const scrim = doc.createElement('div');
  scrim.className = 'rkr-sheet-scrim';

  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'rkr-sheet-close rkr-edit-btn is-quiet';
  closeBtn.textContent = 'Close';

  dock.prepend(closeBtn);
  host.append(fab, scrim);

  const setOpen = (open: boolean): void => {
    dock.classList.toggle('is-open', open);
    scrim.classList.toggle('is-open', open);
    fab.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  const close = (): void => {
    const wasOpen = dock.classList.contains('is-open');
    setOpen(false);
    if (wasOpen && dock.contains(doc.activeElement)) fab.focus();
  };

  fab.addEventListener('click', () => {
    setOpen(true);
    (dock.querySelector('.rkr-blocks-palette-item') as HTMLElement | null)?.focus();
  });
  scrim.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  dock.addEventListener('click', (ev: Event) => {
    if ((ev.target as Element | null)?.closest?.('.rkr-blocks-palette-item')) close();
  });
  dock.addEventListener('keydown', (ev: Event) => {
    if ((ev as KeyboardEvent).key !== 'Escape') return;
    ev.preventDefault();
    close();
  });
  return { close };
}

/** Narrows the page body to a phone in place; the page, not a frame, is
 * resized, so editing keeps working. */
export function mountPhonePreview(toolbar: Element, shellEl: Element): void {
  const button = toolbar.querySelector('.rkr-unified-preview');
  button?.addEventListener('click', () => {
    const on = !shellEl.hasAttribute('data-phone');
    if (on) shellEl.setAttribute('data-phone', '');
    else shellEl.removeAttribute('data-phone');
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}
