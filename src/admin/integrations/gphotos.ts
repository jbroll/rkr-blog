// Google Photos session picking. Unlike Drive/OneDrive there is no
// server-browsable library (the Library API returns app-created items
// only), so selection happens in Google's picker UI: the server creates
// a picking session, this dialog opens the session's pickerUri in a new
// tab, polls completion through the server, then lists the picked items
// for multi-select + import. The grid reuses the rkr-cb-* browser
// chrome; only the session preamble (open button, polling, retry) is
// Photos-specific.

import { openModal } from '../dialog-focus.ts';
import { setStatus } from '../dom.ts';
import type { UploadResponse } from '../upload.ts';
import type { VideoUploadResponse } from '../video-upload.ts';
import { ensureConnected, postImportBody } from './provider-helpers.ts';

type MediaKind = 'image' | 'video';

interface PickedListItem {
  id: string;
  name: string;
  mimeType: string;
  thumbnailUrl: string | null;
  kind: MediaKind;
}

interface MediaItemsPage {
  items: PickedListItem[];
  nextPageToken: string | null;
}

const POLL_MS = 2000;
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

/** Open the Photos session flow → resolve with stored ids. Cancel resolves []. */
export function pickFromPhotos(): Promise<string[]> {
  return pickFromPhotosInternal('image');
}

/** Video variant: only video picks are listed, import goes through /video. */
export function pickFromPhotosVideo(): Promise<string[]> {
  return pickFromPhotosInternal('video');
}

async function pickFromPhotosInternal(mediaKind: MediaKind): Promise<string[]> {
  const connected = await ensureConnected(
    'Google Photos',
    '/admin/integrations/gphotos/status',
    '/admin/integrations/gphotos/connect'
  );
  if (!connected) return [];
  return openPhotosDialog(mediaKind);
}

function openPhotosDialog(mediaKind: MediaKind): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.id = 'rkr-cloud-browser';

    const head = document.createElement('div');
    head.className = 'rkr-cb-head';
    const titleEl = document.createElement('span');
    titleEl.className = 'rkr-cb-title';
    titleEl.textContent = 'Google Photos';
    head.append(titleEl);

    const statusEl = document.createElement('div');
    statusEl.className = 'rkr-cb-status';
    statusEl.setAttribute('role', 'status');

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'rkr-cb-open-photos';
    openBtn.textContent = 'Open Google Photos';
    openBtn.style.display = 'none';

    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'rkr-cb-retry';
    retryBtn.textContent = 'Try again';
    retryBtn.style.display = 'none';

    const grid = document.createElement('div');
    grid.className = 'rkr-cb-grid';
    grid.setAttribute('role', 'list');

    const foot = document.createElement('div');
    foot.className = 'rkr-cb-foot';
    const footStatus = document.createElement('span');
    footStatus.className = 'rkr-cb-status';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'rkr-cb-cancel';
    cancelBtn.textContent = 'Cancel';
    foot.append(footStatus, cancelBtn);

    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'rkr-cb-import';
    importBtn.style.display = 'none';
    importBtn.textContent = 'Import';
    foot.prepend(importBtn);

    dialog.append(head, statusEl, openBtn, retryBtn, grid, foot);
    document.body.append(dialog);

    let sessionId: string | null = null;
    let pickerUri: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const selected = new Map<string, PickedListItem>();

    function stopTimer() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    }

    function closeDialog(ids: string[]) {
      settled = true;
      stopTimer();
      dialog.close();
      dialog.remove();
      resolve(ids);
    }

    async function deleteSession(): Promise<void> {
      const id = sessionId;
      sessionId = null;
      if (!id) return;
      try {
        await fetch(`/admin/integrations/gphotos/sessions/${encodeURIComponent(id)}`, {
          method: 'DELETE'
        });
      } catch {
        // best-effort: an orphaned session expires server-side
      }
    }

    function showRetry(copy: string) {
      statusEl.textContent = copy;
      retryBtn.style.display = '';
    }

    async function start() {
      statusEl.textContent = 'Starting a Google Photos session…';
      openBtn.style.display = 'none';
      retryBtn.style.display = 'none';
      grid.innerHTML = '';
      try {
        const res = await fetch('/admin/integrations/gphotos/sessions', { method: 'POST' });
        if (!res.ok) throw new Error(`session: ${res.status} ${await res.text()}`);
        const body = (await res.json()) as { sessionId: string; pickerUri: string };
        sessionId = body.sessionId;
        pickerUri = body.pickerUri;
      } catch (err) {
        showRetry(`Could not start a Google Photos session: ${(err as Error).message}.`);
        return;
      }
      statusEl.textContent =
        'Choose photos in the Google Photos tab, then come back here — this dialog fills in on its own.';
      // Open straight away while the source-button gesture is fresh;
      // a blocker yields null and the Open button stays as fallback.
      const win = window.open(pickerUri, '_blank', 'noopener');
      openBtn.style.display = win ? 'none' : '';
      void poll(Date.now() + SESSION_TIMEOUT_MS);
    }

    async function poll(deadline: number) {
      if (settled) return;
      let done = false;
      try {
        const res = await fetch(
          `/admin/integrations/gphotos/sessions/${encodeURIComponent(sessionId ?? '')}`
        );
        if (!res.ok) throw new Error(`session: ${res.status}`);
        done = ((await res.json()) as { done: boolean }).done === true;
      } catch (err) {
        showRetry(`Could not check the Google Photos session: ${(err as Error).message}.`);
        return;
      }
      if (done) {
        await loadItems();
        return;
      }
      if (Date.now() >= deadline) {
        showRetry('The Google Photos session expired before anything was selected.');
        return;
      }
      timer = setTimeout(() => void poll(deadline), POLL_MS);
    }

    async function loadItems() {
      statusEl.textContent = 'Loading your selection…';
      try {
        const res = await fetch(
          `/admin/integrations/gphotos/sessions/${encodeURIComponent(sessionId ?? '')}/media-items`
        );
        if (!res.ok) throw new Error(`media-items: ${res.status}`);
        const page = (await res.json()) as MediaItemsPage;
        const items = page.items.filter((item) =>
          mediaKind === 'video' ? item.kind === 'video' : item.kind === 'image'
        );
        grid.innerHTML = '';
        if (items.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'rkr-cb-placeholder';
          empty.textContent =
            mediaKind === 'video'
              ? 'No videos were selected in Google Photos.'
              : 'No photos were selected in Google Photos.';
          grid.append(empty);
        }
        for (const item of items) grid.append(makeItemEl(item));
        statusEl.textContent =
          items.length > 0 ? 'Tick what to import, then Import.' : statusEl.textContent;
      } catch (err) {
        showRetry(`Could not load your selection: ${(err as Error).message}.`);
      }
    }

    function updateImportBtn() {
      const n = selected.size;
      if (n === 0) {
        importBtn.style.display = 'none';
      } else {
        importBtn.style.display = '';
        importBtn.textContent = `Import ${n}`;
      }
    }

    function makeItemEl(item: PickedListItem): HTMLButtonElement {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'rkr-cb-item rkr-cb-file';

      const thumb = document.createElement('div');
      thumb.className = 'rkr-cb-thumb';
      if (item.thumbnailUrl) {
        const img = document.createElement('img');
        img.src = item.thumbnailUrl;
        img.alt = '';
        thumb.append(img);
      } else {
        thumb.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m3 15 5-5 4 4 3-3 6 6"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none"/></svg>';
      }
      el.append(thumb);

      const name = document.createElement('span');
      name.className = 'rkr-cb-name';
      name.textContent = item.name;
      el.append(name);

      el.addEventListener('click', () => {
        if (selected.has(item.id)) {
          selected.delete(item.id);
          el.classList.remove('rkr-cb-selected');
        } else {
          selected.set(item.id, item);
          el.classList.add('rkr-cb-selected');
        }
        updateImportBtn();
      });
      return el;
    }

    async function importSelected() {
      if (selected.size === 0 || !sessionId) return;
      const sid = sessionId;
      const items = [...selected.values()];
      importBtn.disabled = true;
      cancelBtn.disabled = true;
      grid.querySelectorAll<HTMLButtonElement>('.rkr-cb-item').forEach((b) => {
        b.disabled = true;
      });
      const ids: string[] = [];
      for (const item of items) {
        footStatus.textContent = `Importing ${item.name}…`;
        try {
          // Session import endpoints take { sessionId, mediaItemId }.
          const r =
            mediaKind === 'video'
              ? await postImportBody<VideoUploadResponse>('/admin/import/gphotos/video', {
                  sessionId: sid,
                  mediaItemId: item.id
                })
              : await postImportBody<UploadResponse>('/admin/import/gphotos', {
                  sessionId: sid,
                  mediaItemId: item.id
                });
          ids.push(r.id);
        } catch (err) {
          footStatus.textContent = (err as Error).message;
          importBtn.disabled = false;
          cancelBtn.disabled = false;
          grid.querySelectorAll<HTMLButtonElement>('.rkr-cb-item').forEach((b) => {
            b.disabled = false;
          });
          return;
        }
      }
      const noun = mediaKind === 'video' ? 'video' : 'image';
      setStatus(`imported ${ids.length} ${noun}${ids.length === 1 ? '' : 's'} from Google Photos`);
      closeDialog(ids);
    }

    openBtn.addEventListener('click', () => {
      if (pickerUri) window.open(pickerUri, '_blank', 'noopener');
    });
    retryBtn.addEventListener('click', () => {
      void deleteSession().finally(() => void start());
    });
    importBtn.addEventListener('click', () => void importSelected());
    cancelBtn.addEventListener('click', () => {
      void deleteSession().finally(() => closeDialog([]));
    });
    dialog.addEventListener('cancel', () => {
      void deleteSession().finally(() => closeDialog([]));
    });

    openModal(dialog);
    void start();
  });
}
