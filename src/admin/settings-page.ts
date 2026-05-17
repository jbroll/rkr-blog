// Client-side behaviour for /admin/settings:
//   1. On load with a recognised ?flash=…: fire a toast, clean the URL.
//   2. Mark the save button .is-dirty when any field changes.

import { showToast } from './toast.ts';

const FLASH_TOASTS: Record<string, string> = {
  saved: 'Settings saved.',
  reindexed: 'Search index rebuilt.'
};

const params = new URLSearchParams(location.search);
const flash = params.get('flash');
const flashMsg = flash ? FLASH_TOASTS[flash] : undefined;
if (flashMsg) {
  showToast({ kind: 'success', text: flashMsg });
  params.delete('flash');
  const next = params.size > 0 ? `${location.pathname}?${params}` : location.pathname;
  history.replaceState(null, '', next);
}

const form = document.querySelector<HTMLFormElement>('form.rkr-admin-settings');
const saveBtn = document.querySelector<HTMLButtonElement>(
  'form.rkr-admin-settings .rkr-admin-settings-submit'
);
if (form && saveBtn) {
  form.addEventListener('input', () => saveBtn.classList.add('is-dirty'));
  form.addEventListener('change', () => saveBtn.classList.add('is-dirty'));
}
