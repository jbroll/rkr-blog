// Client-side behaviour for /admin/settings:
//   1. On load with ?flash=saved: fire a toast and clean the URL.
//   2. Mark the save button .is-dirty when any field changes.

import { showToast } from './toast.ts';

const params = new URLSearchParams(location.search);
if (params.get('flash') === 'saved') {
  showToast({ kind: 'success', text: 'Settings saved.' });
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
