// OneDrive file browser: thin adapter over the shared cloud browser
// dialog. Listing/import endpoints keep their exact shapes; the dialog
// chrome lives in provider-browser.ts.

import { type CloudFilesPage, type MediaKind, pickFromCloudProvider } from './provider-browser.ts';
import { importCloudFile, importCloudVideo } from './provider-helpers.ts';

interface BrowsePage {
  items: Array<{
    id: string;
    name: string;
    type: 'file' | 'folder';
    mimeType?: string;
  }>;
  nextLink: string | null;
}

async function listPage(
  folderId: string,
  cursor: string | null,
  kind: MediaKind
): Promise<CloudFilesPage> {
  const params: Record<string, string> = { folderId };
  if (cursor) params.nextLink = cursor;
  // Only sent for video; the server defaults any other request to image.
  if (kind === 'video') params.kind = 'video';
  const res = await fetch(`/admin/integrations/onedrive/files?${new URLSearchParams(params)}`);
  if (!res.ok) throw new Error(`files: ${res.status} ${await res.text()}`);
  const page = (await res.json()) as BrowsePage;
  return { items: page.items, cursor: page.nextLink };
}

async function fetchThumbnailUrl(itemId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `/admin/integrations/onedrive/thumbnail?${new URLSearchParams({ itemId })}`
    );
    if (!res.ok) return null;
    const { url } = (await res.json()) as { url: string };
    return url ?? null;
  } catch {
    return null;
  }
}

/** Open the OneDrive file browser modal → pick images → resolve with
 * the resulting stored image ids. Cancelled / no-pick resolves []. */
export function pickFromOneDrive(): Promise<string[]> {
  return pickFromCloudProvider(
    {
      providerName: 'OneDrive',
      dialogTitle: 'OneDrive',
      rootName: 'OneDrive',
      statusUrl: '/admin/integrations/onedrive/status',
      connectUrl: '/admin/integrations/onedrive/connect',
      emptyCopy: 'No images or folders here.',
      emptyVideoCopy: 'No videos or folders here.',
      listPage,
      fetchThumbnailUrl,
      importFile: (fileId) => importCloudFile('/admin/import/onedrive', fileId),
      importVideo: (fileId) => importCloudVideo('/admin/import/onedrive/video', fileId)
    },
    'image'
  );
}

/**
 * OneDrive video variant of pickFromOneDrive: the browser lists only
 * videos + folders and import goes through the /video endpoint.
 */
export function pickFromOneDriveVideo(): Promise<string[]> {
  return pickFromCloudProvider(
    {
      providerName: 'OneDrive',
      dialogTitle: 'OneDrive',
      rootName: 'OneDrive',
      statusUrl: '/admin/integrations/onedrive/status',
      connectUrl: '/admin/integrations/onedrive/connect',
      emptyCopy: 'No images or folders here.',
      emptyVideoCopy: 'No videos or folders here.',
      listPage,
      fetchThumbnailUrl,
      importFile: (fileId) => importCloudFile('/admin/import/onedrive', fileId),
      importVideo: (fileId) => importCloudVideo('/admin/import/onedrive/video', fileId)
    },
    'video'
  );
}
