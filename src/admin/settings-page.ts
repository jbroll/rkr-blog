// Client-side behaviour for /admin/settings:
//   1. On load with a recognised ?flash=…: fire a toast, clean the URL.
//   2. Mark the save button .is-dirty when any field changes.
//   3. Upload a header logo and keep its id in the hidden logo field.

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

// Logo: the file input has no name, so it never posts with the form; the
// upload's image id goes into the hidden `logo` field instead.
const logoBox = document.querySelector<HTMLElement>('.rkr-admin-settings-logo');
const logoId = logoBox?.querySelector<HTMLInputElement>('input[name="logo"]');
const logoFile = logoBox?.querySelector<HTMLInputElement>('input[type="file"]');
const logoThumb = logoBox?.querySelector<HTMLImageElement>('.rkr-admin-settings-logo-thumb');
const logoRemove = logoBox?.querySelector<HTMLButtonElement>('.rkr-admin-settings-logo-remove');
if (logoId && logoFile && logoThumb && logoRemove) {
  const setLogo = (id: string): void => {
    logoId.value = id;
    if (id) logoThumb.src = `/admin/preview/${id}`;
    else logoThumb.removeAttribute('src');
    logoThumb.hidden = !id;
    logoRemove.hidden = !id;
    saveBtn?.classList.add('is-dirty');
  };
  logoFile.addEventListener('change', async () => {
    const file = logoFile.files?.[0];
    if (!file) return;
    const body = new FormData();
    body.append('file', file);
    try {
      const res = await fetch('/admin/upload', { method: 'POST', body });
      if (!res.ok) throw new Error(String(res.status));
      setLogo(((await res.json()) as { id: string }).id);
    } catch {
      showToast({ kind: 'error', text: 'Logo upload failed.' });
    }
    logoFile.value = '';
  });
  logoRemove.addEventListener('click', () => setLogo(''));
}
