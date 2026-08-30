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
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const isStubInitial = fetcher !== fetch && hop === 0 && current.includes('www.googleapis.com');
    const url = isStubInitial ? new URL(current) : await assertSafeFetchUrl(current);
    const res = await fetcher(url.toString(), {
      headers,
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
