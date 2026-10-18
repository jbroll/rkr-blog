// Shared cloud file browser dialog. The OneDrive browser was the
// first; the Google Drive browser reuses the same chrome instead of
// the vendor Picker SDK (whose iframe 401s with a valid token and
// cannot be dismissed). Providers supply listing/import endpoints plus
// labels — everything else (breadcrumb, grid, multi-select, import,
// cancel, empty/error states) lives here exactly once.

import { openModal } from '../dialog-focus.ts';
import { setStatus } from '../dom.ts';
import { ensureConnected } from './provider-helpers.ts';

interface CloudBrowseItem {
  id: string;
  name: string;
  type: 'file' | 'folder';
  mimeType?: string;
  thumbnailUrl?: string;
}

export interface CloudFilesPage {
  items: CloudBrowseItem[];
  cursor: string | null;
}

export type MediaKind = 'image' | 'video';

export interface CloudBrowserConfig {
  /** 'OneDrive' — confirm copy + imported status. */
  providerName: string;
  /** Dialog title and crumb-root label. */
  dialogTitle: string;
  rootName: string;
  statusUrl: string;
  connectUrl: string;
  /** Empty-folder copy for image mode, e.g. 'No images or folders here.' */
  emptyCopy: string;
  /** Empty-folder copy for video mode. */
  emptyVideoCopy: string;
  /** (folderId, cursor, kind) → page; cursor null starts the listing. */
  listPage: (folderId: string, cursor: string | null, kind: MediaKind) => Promise<CloudFilesPage>;
  /** Per-item thumbnail proxy (OneDrive). Null when thumbnails arrive
   * inline on `item.thumbnailUrl` (Drive) — no extra fetch. */
  fetchThumbnailUrl: ((itemId: string) => Promise<string | null>) | null;
  importFile: (fileId: string) => Promise<{ id: string; bytes: number }>;
  importVideo: (fileId: string) => Promise<{ id: string }>;
}

type Crumb = { id: string; name: string };

// Root crumbs persist across picker openings within the page session,
// per provider (each names its own root).
const savedCrumbs = new Map<string, Crumb[]>();

function crumbsFor(rootName: string): Crumb[] {
  const saved = savedCrumbs.get(rootName);
  if (saved) return [...saved];
  return [{ id: 'root', name: rootName }];
}

/**
 * ensureConnected, then open the browser modal → resolve with the
 * resulting stored ids. Cancelled / no-pick resolves [].
 */
export async function pickFromCloudProvider(
  config: CloudBrowserConfig,
  mediaKind: MediaKind
): Promise<string[]> {
  const connected = await ensureConnected(config.providerName, config.statusUrl, config.connectUrl);
  if (!connected) return [];
  return openCloudBrowser(config, mediaKind);
}

function openCloudBrowser(config: CloudBrowserConfig, mediaKind: MediaKind): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    // Build dialog DOM
    const dialog = document.createElement('dialog');
    dialog.id = 'rkr-cloud-browser';

    const head = document.createElement('div');
    head.className = 'rkr-cb-head';
    const titleEl = document.createElement('span');
    titleEl.className = 'rkr-cb-title';
    titleEl.textContent = config.dialogTitle;
    const breadcrumbEl = document.createElement('nav');
    breadcrumbEl.className = 'rkr-cb-breadcrumb';
    breadcrumbEl.setAttribute('aria-label', 'folder path');
    head.append(titleEl, breadcrumbEl);

    const grid = document.createElement('div');
    grid.className = 'rkr-cb-grid';
    grid.setAttribute('role', 'list');

    const foot = document.createElement('div');
    foot.className = 'rkr-cb-foot';
    const statusEl = document.createElement('span');
    statusEl.className = 'rkr-cb-status';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'rkr-cb-cancel';
    cancelBtn.textContent = 'Cancel';
    foot.append(statusEl, cancelBtn);

    dialog.append(head, grid, foot);
    document.body.append(dialog);

    const crumbs: Crumb[] = crumbsFor(config.rootName);
    const selected = new Map<string, CloudBrowseItem>(); // itemId → item
    let loading = false;
    let currentCursor: string | null = null;
    let currentFolderId = 'root';

    // Import button — shown in footer when selection is non-empty
    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'rkr-cb-import';
    importBtn.style.display = 'none';
    importBtn.textContent = 'Import';
    foot.prepend(importBtn);

    function saveCrumbs(): void {
      savedCrumbs.set(config.rootName, [...crumbs]);
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

    function renderBreadcrumb() {
      breadcrumbEl.innerHTML = '';
      crumbs.forEach((crumb, i) => {
        if (i > 0) {
          const sep = document.createElement('span');
          sep.className = 'rkr-cb-sep';
          sep.setAttribute('aria-hidden', 'true');
          sep.textContent = ' › ';
          breadcrumbEl.append(sep);
        }
        if (i === crumbs.length - 1) {
          const span = document.createElement('span');
          span.className = 'rkr-cb-crumb';
          span.textContent = crumb.name;
          breadcrumbEl.append(span);
        } else {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'rkr-cb-crumb-btn';
          btn.textContent = crumb.name;
          btn.dataset.idx = String(i);
          breadcrumbEl.append(btn);
        }
      });
    }

    // The grid only auto-loads more on scroll (grid.addEventListener below),
    // so when a page is short its content may not overflow and no scroll
    // ever fires. Render an explicit affordance whenever a cursor is
    // pending, so a sparse page can always reach the rest of the folder.
    function renderLoadMore() {
      grid.querySelector('.rkr-cb-loadmore')?.remove();
      if (!currentCursor) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rkr-cb-loadmore';
      btn.textContent = 'Load more';
      btn.addEventListener('click', () => void loadMore());
      grid.append(btn);
    }

    async function loadMore() {
      if (loading || !currentCursor) return;
      loading = true;
      try {
        const page = await config.listPage(currentFolderId, currentCursor, mediaKind);
        currentCursor = page.cursor;
        for (const item of page.items) {
          grid.append(makeItemEl(item));
        }
        renderLoadMore();
      } catch (err) {
        const errDiv = document.createElement('div');
        errDiv.className = 'rkr-cb-placeholder rkr-cb-error';
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
      currentCursor = null;
      grid.innerHTML = '';
      const placeholder = document.createElement('div');
      placeholder.className = 'rkr-cb-placeholder';
      placeholder.textContent = 'Loading…';
      grid.append(placeholder);
      statusEl.textContent = '';
      try {
        const page = await config.listPage(folderId, null, mediaKind);
        grid.innerHTML = '';
        currentCursor = page.cursor;
        // Only claim the folder is empty when there is no further page:
        // an empty filtered page with a cursor still has items to show
        // behind the Load more affordance.
        if (page.items.length === 0 && !page.cursor) {
          const empty = document.createElement('div');
          empty.className = 'rkr-cb-placeholder';
          empty.textContent = mediaKind === 'video' ? config.emptyVideoCopy : config.emptyCopy;
          grid.append(empty);
        }
        for (const item of page.items) {
          grid.append(makeItemEl(item));
        }
        renderLoadMore();
      } catch (err) {
        grid.innerHTML = '';
        const errDiv = document.createElement('div');
        errDiv.className = 'rkr-cb-placeholder rkr-cb-error';
        errDiv.textContent = (err as Error).message;
        grid.append(errDiv);
      } finally {
        loading = false;
      }
    }

    grid.addEventListener('scroll', () => {
      if (!currentCursor || loading) return;
      if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 200) {
        void loadMore();
      }
    });

    async function fetchThumbnail(item: CloudBrowseItem, thumb: HTMLDivElement) {
      try {
        const url =
          item.thumbnailUrl ??
          (config.fetchThumbnailUrl ? await config.fetchThumbnailUrl(item.id) : null);
        if (!url) return;
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        thumb.innerHTML = '';
        thumb.append(img);
      } catch {
        // leave placeholder icon
      }
    }

    function makeItemEl(item: CloudBrowseItem): HTMLButtonElement {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `rkr-cb-item rkr-cb-${item.type}`;
      if (selected.has(item.id)) el.classList.add('rkr-cb-selected');

      const thumb = document.createElement('div');
      thumb.className = 'rkr-cb-thumb';
      if (item.type === 'folder') {
        thumb.innerHTML =
          '<svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32" aria-hidden="true"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0 2-2h-8l-2-2z"/></svg>';
      } else {
        thumb.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m3 15 5-5 4 4 3-3 6 6"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none"/></svg>';
        void fetchThumbnail(item, thumb);
      }
      el.append(thumb);

      const name = document.createElement('span');
      name.className = 'rkr-cb-name';
      name.textContent = item.name;
      el.append(name);

      if (item.type === 'folder') {
        el.addEventListener('click', () => {
          crumbs.push({ id: item.id, name: item.name });
          saveCrumbs();
          renderBreadcrumb();
          void loadFolder(item.id);
        });
      } else {
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
      }
      return el;
    }

    async function importSelected() {
      if (selected.size === 0) return;
      const items = [...selected.values()];
      importBtn.disabled = true;
      cancelBtn.disabled = true;
      grid.querySelectorAll<HTMLButtonElement>('.rkr-cb-item').forEach((b) => {
        b.disabled = true;
      });
      const ids: string[] = [];
      const importItem =
        mediaKind === 'video'
          ? (id: string) => config.importVideo(id)
          : (id: string) => config.importFile(id);
      for (const item of items) {
        statusEl.textContent = `Importing ${item.name}…`;
        try {
          const r = await importItem(item.id);
          ids.push(r.id);
        } catch (err) {
          statusEl.textContent = (err as Error).message;
          importBtn.disabled = false;
          cancelBtn.disabled = false;
          grid.querySelectorAll<HTMLButtonElement>('.rkr-cb-item').forEach((b) => {
            b.disabled = false;
          });
          return;
        }
      }
      const noun = mediaKind === 'video' ? 'video' : 'image';
      setStatus(
        `imported ${ids.length} ${noun}${ids.length === 1 ? '' : 's'} from ${config.providerName}`
      );
      closeDialog(ids);
    }

    function closeDialog(ids: string[]) {
      saveCrumbs();
      dialog.close();
      dialog.remove();
      resolve(ids);
    }

    importBtn.addEventListener('click', () => void importSelected());
    breadcrumbEl.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.rkr-cb-crumb-btn');
      if (!btn) return;
      const idx = Number(btn.dataset.idx);
      crumbs.splice(idx + 1);
      saveCrumbs();
      renderBreadcrumb();
      const cur = crumbs[crumbs.length - 1];
      if (cur) void loadFolder(cur.id);
    });

    cancelBtn.addEventListener('click', () => closeDialog([]));
    dialog.addEventListener('cancel', () => {
      saveCrumbs();
      resolve([]);
      dialog.remove();
    });

    renderBreadcrumb();
    openModal(dialog);
    const cur = crumbs[crumbs.length - 1];
    if (cur) void loadFolder(cur.id);
  });
}
