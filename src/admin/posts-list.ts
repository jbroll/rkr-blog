// Admin posts list (/admin/posts) client glue. Two concerns:
//
//   1. Status select per row submits its parent <form> on change so
//      the author doesn't have to click a separate Apply button.
//      The form posts to /admin/posts/:slug/status which 303-redirects
//      back to the list — no JS-only flow, the noscript Apply button
//      keeps non-JS browsers working too.
//
//   2. Pin / Unpin button per row reads OPFS to learn which slugs are
//      currently pinned, paints the button state, and on click invokes
//      pinPost / unpinSlug. Pinning downloads the post bundle (markdown
//      + originals + sidecars) into OPFS so the post survives going
//      offline; unpin flips meta.mode back to 'cached' (eviction
//      reclaims on the next sweep).

import { icon } from '../templates/icons.ts';
import { ensureSchema } from './opfs-schema.ts';
import { type PinProgress, pinnedSlugs, pinPost, unpinSlug } from './pin.ts';

const PIN_ICON = icon('pin', 18);
const PIN_OFF_ICON = icon('pinOff', 18);

function wireStatusForms(): void {
  for (const form of document.querySelectorAll<HTMLFormElement>(
    'form.rkr-admin-posts-status-form'
  )) {
    const select = form.querySelector<HTMLSelectElement>('select[name="status"]');
    if (!select) continue;
    select.addEventListener('change', () => {
      // is-* class drives the public-style coloured pill; flip
      // optimistically so the author sees feedback before the page
      // reload that the form submit triggers.
      select.classList.remove('is-draft', 'is-published');
      select.classList.add(`is-${select.value}`);
      form.submit();
    });
  }
}

function setRowPinState(button: HTMLButtonElement, pinned: boolean): void {
  button.disabled = false;
  // pinOff icon ("unpin") for the currently-pinned state since the
  // click action would unpin; pin icon for the unpinned state.
  button.innerHTML = pinned ? PIN_OFF_ICON : PIN_ICON;
  button.setAttribute('aria-pressed', String(pinned));
  button.dataset.pinned = String(pinned);
}

async function refreshPinnedStates(buttons: HTMLButtonElement[]): Promise<void> {
  const slugs = await pinnedSlugs();
  for (const btn of buttons) {
    const slug = btn.closest<HTMLElement>('tr[data-slug]')?.dataset.slug;
    if (!slug) continue;
    setRowPinState(btn, slugs.has(slug));
  }
}

function statusFor(button: HTMLButtonElement, msg: string): void {
  // The posts list has no central status line, so per-button title
  // attribute carries the most-recent action message; screen readers
  // read it on hover/focus and devs can inspect it.
  button.title = msg;
}

async function handlePinClick(button: HTMLButtonElement): Promise<void> {
  const tr = button.closest<HTMLElement>('tr[data-slug]');
  const slug = tr?.dataset.slug;
  if (!slug) return;
  const wasPinned = button.dataset.pinned === 'true';
  button.disabled = true;
  // Progress messages go to title= so the icon doesn't flicker
  // through partial-state text. Screen readers + hover surface it.
  statusFor(button, wasPinned ? 'unpinning…' : 'pinning…');
  try {
    if (wasPinned) {
      await unpinSlug(slug);
      setRowPinState(button, false);
      statusFor(button, `unpinned /${slug}`);
    } else {
      const result = await pinPost(slug, (p: PinProgress) => {
        statusFor(button, `pinning ${p.fetched + p.skipped}/${p.total}…`);
      });
      setRowPinState(button, true);
      const note =
        result.progress.failed > 0
          ? `pinned /${slug} (${result.progress.failed} originals failed)`
          : `pinned /${slug}`;
      statusFor(button, note);
    }
  } catch (err) {
    setRowPinState(button, wasPinned);
    statusFor(button, `pin failed: ${(err as Error).message}`);
  }
}

function wireDeleteConfirms(): void {
  // Guard the delete form submit with confirm(). Bare server-form
  // posts go straight to /admin/posts/<slug>/delete; without the
  // confirm an accidental icon tap removes the post + bundle.
  for (const form of document.querySelectorAll<HTMLFormElement>('form.rkr-admin-posts-del')) {
    const title = form.dataset.title ?? form.closest('tr')?.querySelector('a')?.textContent ?? '';
    form.addEventListener('submit', (ev) => {
      if (!window.confirm(`Delete "${title}"? This can't be undone.`)) {
        ev.preventDefault();
      }
    });
  }
}

async function init(): Promise<void> {
  wireStatusForms();
  wireDeleteConfirms();
  const pinButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('button[data-pin-toggle]')
  );
  for (const btn of pinButtons) {
    btn.addEventListener('click', () => void handlePinClick(btn));
  }
  // OPFS may be unavailable (private window, unsupported browser);
  // ensureSchema returns 'unsupported' rather than throwing. Leave
  // the Pin buttons disabled in that case so the author isn't
  // promised a pin that would fail.
  const schema = await ensureSchema();
  if (schema.status === 'unsupported') {
    for (const btn of pinButtons) {
      btn.title = 'Offline pinning unavailable in this browser';
    }
    return;
  }
  await refreshPinnedStates(pinButtons);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void init(), { once: true });
} else {
  void init();
}
