// Thin wrapper over Google Drive v3: GET file metadata + GET file media,
// returning a Readable stream and the bytes' content-type. Used by
// POST /admin/import/gdrive (Step 7c). Fetched URLs are constant; the
// only HTTP work is auth-bearer + range/limit handling.

import { Readable } from 'node:stream';

const DRIVE_FILE_BASE = 'https://www.googleapis.com/drive/v3/files';

export interface DriveFile {
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
    const meta = await fetchImpl(
      `${DRIVE_FILE_BASE}/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size`,
      {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: ac.signal
      }
    );
    if (!meta.ok) {
      throw new Error(`drive metadata: HTTP ${meta.status}`);
    }
    const file = (await meta.json()) as DriveFile;

    const media = await fetchImpl(`${DRIVE_FILE_BASE}/${encodeURIComponent(fileId)}?alt=media`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: ac.signal
    });
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
