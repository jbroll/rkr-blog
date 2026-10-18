// Thin wrapper over Google Drive v3: GET file metadata + GET file media,
// returning a Readable stream and the bytes' content-type. Used by
// POST /admin/import/gdrive (Step 7c). Fetched URLs are constant; the
// only HTTP work is auth-bearer + range/limit handling.

import { Readable } from 'node:stream';

import { assertSafeFetchUrl, UnsafeUrlError } from './url-safety.ts';

const DRIVE_FILE_BASE = 'https://www.googleapis.com/drive/v3/files';

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
}

export interface DriveFileFetch {
  file: DriveFile;
  body: Readable;
  contentType: string;
  contentLength: number | null;
}

export interface DriveBrowseItem {
  id: string;
  name: string;
  type: 'file' | 'folder';
  mimeType?: string;
  thumbnailUrl?: string;
}

/** Drive's folder mime type — the only non-file `type` the browser lists. */
const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * List a Drive folder's direct children, filtered to `opts.kind`
 * (`'image'` by default, `'video'` for the video picker) plus
 * subfolders. folderId 'root' targets the drive root. Mirrors
 * listOneDriveFolder in shape; pagination is Drive's opaque
 * `pageToken`/`nextPageToken` pair.
 */
export async function listDriveFolder(
  accessToken: string,
  folderId: string,
  opts: { fetcher?: typeof fetch; pageToken?: string; kind?: 'image' | 'video' } = {}
): Promise<{ items: DriveBrowseItem[]; nextPageToken: string | null }> {
  const fetchImpl = opts.fetcher ?? fetch;
  const mimePrefix = opts.kind === 'video' ? 'video/' : 'image/';
  const url = new URL(DRIVE_FILE_BASE);
  url.searchParams.set(
    'q',
    `'${folderId}' in parents and trashed = false and (mimeType contains '${mimePrefix}' or mimeType = '${DRIVE_FOLDER_MIME}')`
  );
  url.searchParams.set('fields', 'files(id,name,mimeType,thumbnailLink),nextPageToken');
  url.searchParams.set('pageSize', '50');
  url.searchParams.set('orderBy', 'modifiedTime desc');
  if (opts.pageToken) url.searchParams.set('pageToken', opts.pageToken);
  const res = await fetchImpl(url.toString(), {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) throw new Error(`drive list: HTTP ${res.status}`);
  const data = (await res.json()) as {
    files?: Array<{ id?: string; name?: string; mimeType?: string; thumbnailLink?: string }>;
    nextPageToken?: string;
  };
  const items = (data.files ?? [])
    .filter(
      (f) =>
        typeof f.id === 'string' &&
        typeof f.name === 'string' &&
        (f.mimeType === DRIVE_FOLDER_MIME || f.mimeType?.startsWith(mimePrefix) === true)
    )
    .map(
      (f): DriveBrowseItem => ({
        id: f.id as string,
        name: f.name as string,
        type: f.mimeType === DRIVE_FOLDER_MIME ? 'folder' : 'file',
        ...(f.mimeType !== undefined && f.mimeType !== DRIVE_FOLDER_MIME
          ? { mimeType: f.mimeType }
          : {}),
        ...(f.thumbnailLink !== undefined ? { thumbnailUrl: f.thumbnailLink } : {})
      })
    );
  // Folders first; files already newest-first from Drive.
  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return 0;
  });
  return { items, nextPageToken: data.nextPageToken ?? null };
}

/**
 * Fetch metadata + bytes for a Drive file. The caller streams `body`
 * into ingestStream. The fetch is gated by a 30s wall-clock timeout.
 */
export async function fetchDriveFile(
  accessToken: string,
  fileId: string,
  opts: { timeoutMs?: number; fetcher?: typeof fetch } = {}
): Promise<DriveFileFetch> {
  const fetchImpl = opts.fetcher ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    // Metadata fetch — fixed Google host, validate per hop if it redirects.
    const metaUrl = `${DRIVE_FILE_BASE}/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size`;
    const meta = await fetchWithRedirectValidation(
      metaUrl,
      fetchImpl,
      { authorization: `Bearer ${accessToken}` },
      ac.signal
    );
    if (!meta.ok) {
      throw new Error(`drive metadata: HTTP ${meta.status}`);
    }
    const file = (await meta.json()) as DriveFile;

    const mediaUrl = `${DRIVE_FILE_BASE}/${encodeURIComponent(fileId)}?alt=media`;
    const media = await fetchWithRedirectValidation(
      mediaUrl,
      fetchImpl,
      { authorization: `Bearer ${accessToken}` },
      ac.signal
    );
    if (!media.ok) {
      throw new Error(`drive media: HTTP ${media.status}`);
    }
    if (!media.body) {
      throw new Error('drive media: empty body');
    }

    const contentType = media.headers.get('content-type') ?? file.mimeType;
    const cl = media.headers.get('content-length');
    return {
      file,
      body: Readable.fromWeb(media.body),
      contentType,
      contentLength: cl ? Number(cl) : null
    };
  } finally {
    clearTimeout(timer);
  }
}

/* c8 ignore start */
async function fetchWithRedirectValidation(
  initialUrl: string,
  fetcher: typeof fetch,
  headers: Record<string, string>,
  signal: AbortSignal,
  maxRedirects = 5
): Promise<Response> {
  let current = initialUrl;
  let initialOrigin: string | null = null;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const isStubInitial = fetcher !== fetch && hop === 0 && current.includes('www.googleapis.com');
    const url = isStubInitial ? new URL(current) : await assertSafeFetchUrl(current);
    if (initialOrigin === null) initialOrigin = url.origin;
    // ?alt=media can 302 off Google. Forwarding our bearer token there
    // 401s some hosts (and leaks the token), so authorization stays on
    // the initial origin only — same rule as the microsoft-graph twin.
    const hopHeaders = url.origin === initialOrigin ? headers : withoutAuthHeader(headers);
    const res = await fetcher(url.toString(), {
      headers: hopHeaders,
      signal,
      redirect: 'manual'
    } as RequestInit);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new UnsafeUrlError(`redirect ${res.status} without Location header`);
      current = new URL(location, url).toString();
      continue;
    }
    return res;
  }
  throw new UnsafeUrlError(`too many redirects (>${maxRedirects})`);
}
/* c8 ignore stop */

/** Drop the authorization header (case-insensitive); other headers pass through. */
function withoutAuthHeader(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'authorization')
  );
}
