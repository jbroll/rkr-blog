// Sign-out on a shared device. The logout landing (admin-caches.ts)
// drops the editor's cached pages; page drafts are deleted only from the
// Logout button, after the author confirms losing the ones the server
// never got. A GET to the landing URL can therefore never wipe a draft.

import { openEditorDialog } from '../admin/editor-dialog.ts';
import { stableJson, within } from '../admin/unified-draft.ts';

const COUNT_TIMEOUT_MS = 3000;

export interface DraftEntry {
  slug: string;
  tree: unknown;
}

export interface SignOutDeps {
  /** Stored drafts; undefined when IndexedDB is unavailable. */
  listDrafts(): Promise<DraftEntry[] | undefined>;
  /** The page as the server holds it; undefined when it cannot be read. */
  serverTree(slug: string): Promise<unknown>;
  confirm(entries: DraftEntry[]): Promise<boolean>;
  deleteDrafts(): Promise<void>;
  submit(): void;
  timeoutMs?: number;
}

/** Drafts the server does not hold. A page the server cannot return
 * counts as unsynced. Undefined when the drafts cannot be listed. */
export async function unsyncedDrafts(
  deps: Pick<SignOutDeps, 'listDrafts' | 'serverTree'>
): Promise<DraftEntry[] | undefined> {
  const drafts = await deps.listDrafts();
  if (!drafts) return undefined;
  const checked = await Promise.all(
    drafts.map(async (d) => {
      const server = await deps.serverTree(d.slug);
      return server !== undefined && stableJson(server) === stableJson(d.tree) ? null : d;
    })
  );
  return checked.filter((d): d is DraftEntry => d !== null);
}

export function signOutMessage(n: number): string {
  return n === 1
    ? '1 page has changes that never reached the server. Signing out deletes them.'
    : `${n} pages have changes that never reached the server. Signing out deletes them.`;
}

function draftTitle(d: DraftEntry): string {
  const title = (d.tree as { fields?: { title?: unknown } } | null)?.fields?.title;
  return typeof title === 'string' && title !== '' ? title : d.slug;
}

/** Ask before deleting unsynced drafts. Cancel has focus. */
export function confirmSignOut(root: Element, entries: DraftEntry[]): Promise<boolean> {
  const doc = root.ownerDocument;
  const body = doc.createElement('div');
  const text = doc.createElement('p');
  text.textContent = signOutMessage(entries.length);
  const list = doc.createElement('ul');
  for (const d of entries) {
    const item = doc.createElement('li');
    item.textContent = draftTitle(d);
    list.append(item);
  }
  body.append(text, list);
  return new Promise((resolve) => {
    openEditorDialog({
      root,
      title: 'Sign out',
      body,
      primaryLabel: 'Sign out and delete',
      cancelLabel: 'Cancel',
      focusCancel: true,
      onPrimary: () => {
        resolve(true);
        return true;
      },
      onCancel: () => resolve(false)
    });
  });
}

/** Intercept the Logout form: sign out at once when nothing is unsynced
 * or the drafts cannot be counted in time; otherwise confirm, and delete
 * the drafts only on confirmation. */
export function guardSignOut(form: HTMLFormElement, deps: SignOutDeps): void {
  let busy = false;
  form.addEventListener('submit', (ev: Event) => {
    ev.preventDefault();
    if (busy) return;
    busy = true;
    void (async () => {
      const unsynced = await within(unsyncedDrafts(deps), deps.timeoutMs ?? COUNT_TIMEOUT_MS);
      if (!unsynced || unsynced.length === 0) {
        deps.submit();
        return;
      }
      if (await deps.confirm(unsynced)) {
        await deps.deleteDrafts().catch(() => {});
        deps.submit();
        return;
      }
      busy = false;
    })();
  });
}
