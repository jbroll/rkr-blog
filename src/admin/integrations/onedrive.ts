// OneDrive image browser. Opens a modal dialog that lists the user's
// OneDrive folders and images via the server-side Graph API wrapper
// (/admin/integrations/onedrive/files). The File Picker v8 SDK approach
// was abandoned: the consumer picker (onedrive.live.com) requires
// Live/MSA identity tokens that an Entra server-side OAuth flow cannot
// produce for personal accounts.

import { openModal } from '../dialog-focus.ts';
import { setStatus } from '../dom.ts';
import type { UploadResponse } from '../upload.ts';

interface OneDriveStatus {
  connected: boolean;
}

interface BrowseItem {
  id: string;
  name: string;
  type: 'file' | 'folder';
  mimeType?: string;
  thumbnailUrl?: string;
}

async function oneDriveStatus(): Promise<OneDriveStatus> {
  const res = await fetch('/admin/integrations/onedrive/status');
  if (!res.ok) throw new Error(`status: ${res.status}`);
  return (await res.json()) as OneDriveStatus;
}

interface FilesPage {
  items: BrowseItem[];
  nextLink: string | null;
}

async function listOneDriveFiles(folderId: string, nextLink?: string): Promise<FilesPage> {
  const params: Record<string, string> = { folderId };
  if (nextLink) params.nextLink = nextLink;
  const res = await fetch(`/admin/integrations/onedrive/files?${new URLSearchParams(params)}`);
  if (!res.ok) throw new Error(`files: ${res.status} ${await res.text()}`);
  return (await res.json()) as FilesPage;
}

async function importOneDriveFile(fileId: string): Promise<UploadResponse> {
  const res = await fetch('/admin/import/onedrive', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileId })
  });
  if (!res.ok) throw new Error(`import: ${res.status} ${await res.text()}`);
  return (await res.json()) as UploadResponse;
}

/** Open the OneDrive file browser modal → pick images → resolve with
 * the resulting stored image ids. Cancelled / no-pick resolves []. */
export async function pickFromOneDrive(): Promise<string[]> {
  const status = await oneDriveStatus();
  if (!status.connected) {
    if (confirm('OneDrive is not connected for your account. Open the connect flow now?')) {
      window.location.href = '/admin/integrations/onedrive/connect';
    }
    return [];
  }
  return openOneDriveBrowser();
}

type Crumb = { id: string; name: string };

// Persists across picker openings within the same page session
let savedCrumbs: Crumb[] = [{ id: 'root', name: 'OneDrive' }];

function openOneDriveBrowser(): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    // Build dialog DOM
    const dialog = document.createElement('dialog');
    dialog.id = 'rkr-onedrive-browser';

    const head = document.createElement('div');
    head.className = 'rkr-od-head';
    const titleEl = document.createElement('span');
    titleEl.className = 'rkr-od-title';
    titleEl.textContent = 'OneDrive';
    const breadcrumbEl = document.createElement('nav');
    breadcrumbEl.className = 'rkr-od-breadcrumb';
    breadcrumbEl.setAttribute('aria-label', 'folder path');
    head.append(titleEl, breadcrumbEl);

    const grid = document.createElement('div');
    grid.className = 'rkr-od-grid';
    grid.setAttribute('role', 'list');

    const foot = document.createElement('div');
    foot.className = 'rkr-od-foot';
    const statusEl = document.createElement('span');
    statusEl.className = 'rkr-od-status';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'rkr-od-cancel';
    cancelBtn.textContent = 'Cancel';
    foot.append(statusEl, cancelBtn);

    dialog.append(head, grid, foot);
    document.body.append(dialog);

    const crumbs: Crumb[] = [...savedCrumbs];
    const selected = new Map<string, BrowseItem>(); // itemId → item
    let loading = false;
    let currentNextLink: string | null = null;
    let currentFolderId = 'root';

    // Import button — shown in footer when selection is non-empty
    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'rkr-od-import';
    importBtn.style.display = 'none';
    importBtn.textContent = 'Import';
    foot.prepend(importBtn);

    function updateImportBtn() {
      const n = selected.size;
      if (n === 0) {
        importBtn.style.display = 'none';
      } else {
        importBtn.style.display = '';
        importBtn.textContent = `Import ${n}`;
      }
    }

    function renderBreadcrumb() {
      breadcrumbEl.innerHTML = '';
      crumbs.forEach((crumb, i) => {
        if (i > 0) {
          const sep = document.createElement('span');
          sep.className = 'rkr-od-sep';
          sep.setAttribute('aria-hidden', 'true');
          sep.textContent = ' › ';
          breadcrumbEl.append(sep);
        }
        if (i === crumbs.length - 1) {
          const span = document.createElement('span');
          span.className = 'rkr-od-crumb';
          span.textContent = crumb.name;
          breadcrumbEl.append(span);
        } else {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'rkr-od-crumb-btn';
          btn.textContent = crumb.name;
          btn.dataset.idx = String(i);
          breadcrumbEl.append(btn);
        }
      });
    }

    async function loadMore() {
      if (loading || !currentNextLink) return;
      loading = true;
      try {
        const page = await listOneDriveFiles(currentFolderId, currentNextLink);
        currentNextLink = page.nextLink;
        for (const item of page.items) {
          grid.append(makeItemEl(item));
        }
      } catch (err) {
        const errDiv = document.createElement('div');
        errDiv.className = 'rkr-od-placeholder rkr-od-error';
        errDiv.textContent = (err as Error).message;
        grid.append(errDiv);
      } finally {
        loading = false;
      }
    }

    async function loadFolder(folderId: string) {
      if (loading) return;
      loading = true;
      currentFolderId = folderId;
      currentNextLink = null;
      grid.innerHTML = '';
      const placeholder = document.createElement('div');
      placeholder.className = 'rkr-od-placeholder';
      placeholder.textContent = 'Loading…';
      grid.append(placeholder);
      statusEl.textContent = '';
      try {
        const page = await listOneDriveFiles(folderId);
        grid.innerHTML = '';
        currentNextLink = page.nextLink;
        if (page.items.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'rkr-od-placeholder';
          empty.textContent = 'No images or folders here.';
          grid.append(empty);
        }
        for (const item of page.items) {
          grid.append(makeItemEl(item));
        }
      } catch (err) {
        grid.innerHTML = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'rkr-od-placeholder rkr-od-error';
        errDiv.textContent = (err as Error).message;
        grid.append(errDiv);
      } finally {
        loading = false;
      }
    }

    grid.addEventListener('scroll', () => {
      if (!currentNextLink || loading) return;
      if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 200) {
        void loadMore();
      }
    });

    async function fetchThumbnail(itemId: string, thumb: HTMLDivElement) {
      try {
        const res = await fetch(
          `/admin/integrations/onedrive/thumbnail?${new URLSearchParams({ itemId })}`
        );
        if (!res.ok) return;
        const { url } = (await res.json()) as { url: string };
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        thumb.innerHTML = '';
        thumb.append(img);
      } catch {
        // leave placeholder icon
      }
    }

    function makeItemEl(item: BrowseItem): HTMLButtonElement {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `rkr-od-item rkr-od-${item.type}`;
      if (selected.has(item.id)) el.classList.add('rkr-od-selected');

      const thumb = document.createElement('div');
      thumb.className = 'rkr-od-thumb';
      if (item.type === 'folder') {
        thumb.innerHTML =
          '<svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32" aria-hidden="true"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>';
      } else {
        thumb.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m3 15 5-5 4 4 3-3 6 6"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none"/></svg>';
        void fetchThumbnail(item.id, thumb);
      }
      el.append(thumb);

      const name = document.createElement('span');
      name.className = 'rkr-od-name';
      name.textContent = item.name;
      el.append(name);

      if (item.type === 'folder') {
        el.addEventListener('click', () => {
          crumbs.push({ id: item.id, name: item.name });
          savedCrumbs = [...crumbs];
          renderBreadcrumb();
          void loadFolder(item.id);
        });
      } else {
        el.addEventListener('click', () => {
          if (selected.has(item.id)) {
            selected.delete(item.id);
            el.classList.remove('rkr-od-selected');
          } else {
            selected.set(item.id, item);
            el.classList.add('rkr-od-selected');
          }
          updateImportBtn();
        });
      }
      return el;
    }

    async function importSelected() {
      if (selected.size === 0) return;
      const items = [...selected.values()];
      importBtn.disabled = true;
      cancelBtn.disabled = true;
      grid.querySelectorAll<HTMLButtonElement>('.rkr-od-item').forEach((b) => {
        b.disabled = true;
      });
      const ids: string[] = [];
      for (const item of items) {
        statusEl.textContent = `Importing ${item.name}…`;
        try {
          const r = await importOneDriveFile(item.id);
          ids.push(r.id);
        } catch (err) {
          statusEl.textContent = (err as Error).message;
          importBtn.disabled = false;
          cancelBtn.disabled = false;
          grid.querySelectorAll<HTMLButtonElement>('.rkr-od-item').forEach((b) => {
            b.disabled = false;
          });
          return;
        }
      }
      setStatus(`imported ${ids.length} image${ids.length === 1 ? '' : 's'} from OneDrive`);
      closeDialog(ids);
    }

    function closeDialog(ids: string[]) {
      savedCrumbs = [...crumbs];
      dialog.close();
      dialog.remove();
      resolve(ids);
    }

    importBtn.addEventListener('click', () => void importSelected());
    breadcrumbEl.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.rkr-od-crumb-btn');
      if (!btn) return;
      const idx = Number(btn.dataset.idx);
      crumbs.splice(idx + 1);
      savedCrumbs = [...crumbs];
      renderBreadcrumb();
      const cur = crumbs[crumbs.length - 1];
      if (cur) void loadFolder(cur.id);
    });

    cancelBtn.addEventListener('click', () => closeDialog([]));
    dialog.addEventListener('cancel', () => {
      savedCrumbs = [...crumbs];
      resolve([]);
      dialog.remove();
    });

    renderBreadcrumb();
    openModal(dialog);
    const cur = crumbs[crumbs.length - 1];
    if (cur) void loadFolder(cur.id);
  });
}
