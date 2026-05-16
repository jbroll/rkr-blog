// Admin posts list (/admin/posts) client glue:
//
//   Status icon button: a plain form submit flips draft↔published;
//   no JS needed for the toggle itself. The button shows a globe icon
//   (published) or lock (draft); aria-label carries the text.
//
//   Sort button: client-side re-sort of the table rows by the datetime
//   attribute of each row's <time> element; no page reload.
//
//   Pin / Unpin button per row reads OPFS to learn which slugs are
//   currently pinned, paints the button state, and on click invokes
//   pinPost / unpinSlug. Pinning downloads the post bundle (markdown
//   + originals + sidecars) into OPFS so the post survives going
//   offline; unpin flips meta.mode back to 'cached' (eviction
//   reclaims on the next sweep).

import { icon } from '../templates/icons.ts';
import { ensureSchema } from './opfs-schema.ts';
import { type PinProgress, pinnedSlugs, pinPost, unpinSlug } from './pin.ts';

const SORT_ICON = icon('arrowUpDown', 14);

function sortAdminTable(asc: boolean): void {
  const tbody = document.querySelector<HTMLElement>('.rkr-admin-posts tbody');
  if (!tbody) return;
  const rows = Array.from(tbody.querySelectorAll<HTMLTableRowElement>('tr[data-slug]'));
  rows.sort((a, b) => {
    const ta = a.querySelector('time')?.getAttribute('datetime') ?? '';
    const tb = b.querySelector('time')?.getAttribute('datetime') ?? '';
    return asc ? ta.localeCompare(tb) : tb.localeCompare(ta);
  });
  for (const row of rows) tbody.appendChild(row);
}

function wireSortToggle(): void {
  const btn = document.querySelector<HTMLButtonElement>('button[data-sort-toggle]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const isAsc = btn.dataset.sortDir !== 'asc';
    btn.dataset.sortDir = isAsc ? 'asc' : 'desc';
    btn.innerHTML = SORT_ICON;
    btn.title = isAsc ? 'Newest first' : 'Oldest first';
    btn.setAttribute('aria-label', btn.title);
    sortAdminTable(isAsc);
  });
}

const PIN_ICON = icon('pin', 18);
const PIN_OFF_ICON = icon('pinOff', 18);

function setRowPinState(button: HTMLButtonElement, pinned: boolean): void {
  button.disabled = false;
  // Icon shows CURRENT STATE, not the action. Pinned posts get the
  // active pin glyph + link colour (via aria-pressed CSS); unpinned
  // get pin-off in muted colour so the visual + the aria state
  // agree. Click action verb lives in the aria-label.
  button.innerHTML = pinned ? PIN_ICON : PIN_OFF_ICON;
  button.setAttribute('aria-pressed', String(pinned));
  button.dataset.pinned = String(pinned);
  button.setAttribute(
    'aria-label',
    pinned ? 'Unpin (post is pinned for offline)' : 'Pin for offline editing'
  );
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
  wireSortToggle();
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
