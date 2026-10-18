// Google Drive file browser: thin adapter over the shared cloud
// browser dialog. Listing/import endpoints keep their exact shapes;
// the dialog chrome lives in provider-browser.ts. (The Picker SDK
// approach was abandoned: its iframe 401s with a valid token and
// cannot be dismissed.)

import { type CloudFilesPage, type MediaKind, pickFromCloudProvider } from './provider-browser.ts';
import { importCloudFile, importCloudVideo } from './provider-helpers.ts';

interface BrowsePage {
  items: Array<{
    id: string;
    name: string;
    type: 'file' | 'folder';
    mimeType?: string;
    thumbnailUrl?: string;
  }>;
  nextPageToken: string | null;
}

async function listPage(
  folderId: string,
  cursor: string | null,
  kind: MediaKind
): Promise<CloudFilesPage> {
  const params: Record<string, string> = { folderId };
  if (cursor) params.pageToken = cursor;
  // Only sent for video; the server defaults any other request to image.
  if (kind === 'video') params.kind = 'video';
  const res = await fetch(`/admin/integrations/gdrive/files?${new URLSearchParams(params)}`);
  if (!res.ok) throw new Error(`files: ${res.status} ${await res.text()}`);
  const page = (await res.json()) as BrowsePage;
  return { items: page.items, cursor: page.nextPageToken };
}

function driveConfig() {
  return {
    providerName: 'Google Drive',
    dialogTitle: 'Google Drive',
    rootName: 'Google Drive',
    statusUrl: '/admin/integrations/gdrive/status',
    connectUrl: '/admin/integrations/gdrive/connect',
    emptyCopy: 'No images or folders here.',
    emptyVideoCopy: 'No videos or folders here.',
    listPage,
    // Drive thumbnails arrive inline as thumbnailLink — no extra fetch.
    fetchThumbnailUrl: null,
    importFile: (fileId: string) => importCloudFile('/admin/import/gdrive', fileId),
    importVideo: (fileId: string) => importCloudVideo('/admin/import/gdrive/video', fileId)
  } as const;
}

/** Open the Drive browser → pick images → resolve with the resulting
 * stored ids. Cancelled / no-pick resolves []. */
export function pickFromDrive(): Promise<string[]> {
  return pickFromCloudProvider(driveConfig(), 'image');
}

/**
 * Drive video variant of pickFromDrive: the browser lists only videos
 * + folders and import goes through the /video endpoint.
 */
export function pickFromDriveVideo(): Promise<string[]> {
  return pickFromCloudProvider(driveConfig(), 'video');
}
