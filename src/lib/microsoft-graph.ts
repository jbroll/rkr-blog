// Thin wrapper over Microsoft Graph for OneDrive file fetch. Mirrors
// src/lib/google-drive.ts in shape so the integration route in
// src/routes/integrations-onedrive.ts can stay close to the gdrive
// equivalent. Used by POST /admin/import/onedrive.
//
// Graph endpoints:
//   GET /me/drive/items/{id}        → metadata
//   GET /me/drive/items/{id}/content → 302 to a download URL; following
//                                       it returns the file bytes

import { Readable } from 'node:stream';

import { assertSafeFetchUrl, UnsafeUrlError } from './url-safety.ts';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

interface OneDriveFile {
  id: string;
  name: string;
  /** Sometimes called `file.mimeType` on Graph; always returned at the
   * top level alongside size for consistency with the Drive shape. */
  mimeType: string;
  size?: number;
}

export interface OneDriveFileFetch {
  file: OneDriveFile;
  body: Readable;
  contentType: string;
  contentLength: number | null;
}

interface OneDriveBrowseItem {
  id: string;
  name: string;
  type: 'file' | 'folder';
  mimeType?: string;
  thumbnailUrl?: string;
}

/**
 * List the direct children of a OneDrive folder, filtered to files of
 * `opts.kind` (`'image'` by default, `'video'` for the video picker) and
 * subfolders. folderId 'root' targets the drive root. Items are returned
 * folders-first, both groups sorted by name. A page whose items all
 * filter out is followed forward (bounded to MAX_EMPTY_PAGES requests)
 * so callers don't render an empty state while matches remain.
 */
export interface OneDriveFolderPage {
  items: OneDriveBrowseItem[];
  nextLink: string | null;
}

/**
 * Validate a Graph paging link. Graph paginates only via
 * graph.microsoft.com URLs; anything else is an SSRF attempt carrying
 * the user's bearer token.
 */
function assertGraphNextLink(nextLink: string): string {
  let u: URL;
  try {
    u = new URL(nextLink);
  } catch {
    throw new Error('invalid nextLink');
  }
  if (u.protocol !== 'https:' || u.host !== 'graph.microsoft.com') {
    throw new Error('unsafe nextLink (must be https://graph.microsoft.com)');
  }
  return nextLink;
}

/**
 * Max Graph requests made by a single listOneDriveFolder call while it
 * skips pages that filter down to nothing (see the sparse-folder note
 * below). The unconsumed nextLink is still returned so the client keeps
 * paging on demand.
 */
const MAX_EMPTY_PAGES = 5;

export async function listOneDriveFolder(
  accessToken: string,
  folderId: string,
  opts: { fetcher?: typeof fetch; nextLink?: string; kind?: 'image' | 'video' } = {}
): Promise<OneDriveFolderPage> {
  const fetchImpl = opts.fetcher ?? fetch;
  const mimePrefix = opts.kind === 'video' ? 'video/' : 'image/';
  const initialUrl = () => {
    const base =
      folderId === 'root'
        ? `${GRAPH_BASE}/me/drive/root/children`
        : `${GRAPH_BASE}/me/drive/items/${encodeURIComponent(folderId)}/children`;
    const url = new URL(base);
    url.searchParams.set('$top', '50');
    url.searchParams.set('$orderby', 'lastModifiedDateTime desc');
    return url.toString();
  };
  let fetchUrl = opts.nextLink ? assertGraphNextLink(opts.nextLink) : initialUrl();

  let items: OneDriveBrowseItem[] = [];
  let nextLink: string | null = null;
  // A page can filter down to nothing (e.g. video mode over a folder of
  // photos). Keep following the nextLink so the picker doesn't render
  // "No videos or folders here." while matching items sit on later
  // pages — bounded by MAX_EMPTY_PAGES so a media-less drive isn't
  // walked end to end.
  for (let fetched = 0; fetched < MAX_EMPTY_PAGES; fetched++) {
    const res = await fetchImpl(fetchUrl, {
      headers: { authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) throw new Error(`Graph ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      value?: Array<{
        id?: string;
        name?: string;
        file?: { mimeType?: string } | null;
        folder?: object | null;
      }>;
      '@odata.nextLink'?: string;
    };
    const raw = data.value ?? [];
    items = raw
      .filter((item) => item.folder != null || item.file?.mimeType?.startsWith(mimePrefix))
      .map((item) => ({
        id: item.id ?? '',
        name: item.name ?? '',
        type: item.folder != null ? ('folder' as const) : ('file' as const),
        mimeType: item.file?.mimeType
      }));
    nextLink = data['@odata.nextLink'] ?? null;
    if (items.length > 0 || !nextLink) break;
    fetchUrl = assertGraphNextLink(nextLink);
  }
  // Folders first; files already newest-first from Graph
  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return 0;
  });
  return { items, nextLink };
}

/**
 * Fetch the small thumbnail URL for a single OneDrive item. Returns null
 * when no thumbnail is available (folder, unsupported type, etc.).
 * Uses the individual thumbnails endpoint rather than $expand on the
 * children list, which avoids the SPO license check on personal accounts.
 */
export async function getOneDriveThumbnail(
  accessToken: string,
  itemId: string,
  opts: { fetcher?: typeof fetch } = {}
): Promise<string | null> {
  const fetchImpl = opts.fetcher ?? fetch;
  const res = await fetchImpl(
    `${GRAPH_BASE}/me/drive/items/${encodeURIComponent(itemId)}/thumbnails/0`,
    { headers: { authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) return null;
  const data = (await res.json()) as {
    large?: { url?: string };
    medium?: { url?: string };
    small?: { url?: string };
  };
  return data.large?.url ?? data.medium?.url ?? data.small?.url ?? null;
}

/**
 * Fetch metadata + bytes for a OneDrive item. The caller streams `body`
 * into ingestStream. Gated by a 30s wall-clock timeout; the metadata
 * + content fetches share one AbortController so a stuck server times
 * out cleanly.
 */
export async function fetchOneDriveFile(
  accessToken: string,
  itemId: string,
  opts: { timeoutMs?: number; fetcher?: typeof fetch } = {}
): Promise<OneDriveFileFetch> {
  const fetchImpl = opts.fetcher ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const metaUrl = `${GRAPH_BASE}/me/drive/items/${encodeURIComponent(itemId)}?$select=id,name,size,file`;
    const meta = await fetchWithRedirectValidation(
      metaUrl,
      fetchImpl,
      { authorization: `Bearer ${accessToken}` },
      ac.signal
    );
    if (!meta.ok) {
      throw new Error(`onedrive metadata: HTTP ${meta.status}`);
    }
    const json = (await meta.json()) as {
      id?: string;
      name?: string;
      size?: number;
      file?: { mimeType?: string };
    };
    if (!json.id || !json.name) {
      throw new Error('onedrive metadata: missing id or name');
    }
    const file: OneDriveFile = {
      id: json.id,
      name: json.name,
      mimeType: json.file?.mimeType ?? 'application/octet-stream',
      ...(json.size !== undefined ? { size: json.size } : {})
    };

    const mediaUrl = `${GRAPH_BASE}/me/drive/items/${encodeURIComponent(itemId)}/content`;
    const media = await fetchWithRedirectValidation(
      mediaUrl,
      fetchImpl,
      { authorization: `Bearer ${accessToken}` },
      ac.signal
    );
    if (!media.ok) {
      throw new Error(`onedrive media: HTTP ${media.status}`);
    }
    if (!media.body) {
      throw new Error('onedrive media: empty body');
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
    const isStubInitial = fetcher !== fetch && hop === 0 && current.includes('graph.microsoft.com');
    const url = isStubInitial ? new URL(current) : await assertSafeFetchUrl(current);
    if (initialOrigin === null) initialOrigin = url.origin;
    // The /content 302 lands on a preauthenticated download URL on
    // another host. Forwarding our Graph bearer token there makes the
    // host 401 (and leaks the token), so authorization stays on the
    // initial origin only — same rule fetch() itself applies.
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
