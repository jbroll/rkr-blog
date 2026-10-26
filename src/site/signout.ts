// Wires the header Logout form to the draft check in admin-signout.ts.
// Loaded on every page that renders the form (templates/layout.ts siteHead).

import { clearAllDrafts, listAllDrafts } from '../admin/unified-draft.ts';
import { confirmSignOut, guardSignOut } from './admin-signout.ts';

async function serverTree(slug: string): Promise<unknown> {
  try {
    const res = await fetch(`/admin/blocks/${encodeURIComponent(slug)}`, { cache: 'no-store' });
    return res.ok ? ((await res.json()) as { tree?: unknown }).tree : undefined;
  } catch {
    return undefined;
  }
}

for (const form of document.querySelectorAll<HTMLFormElement>('form[action="/admin/logout"]')) {
  guardSignOut(form, {
    listDrafts: () =>
      typeof indexedDB === 'undefined'
        ? Promise.resolve(undefined)
        : listAllDrafts().catch(() => undefined),
    serverTree,
    confirm: (entries) => confirmSignOut(document.body, entries),
    deleteDrafts: clearAllDrafts,
    // form.submit() skips the submit event, so the guard does not run twice.
    submit: () => form.submit()
  });
}
