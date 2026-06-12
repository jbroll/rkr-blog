// Shared request shapes for the gdrive + onedrive integration routes.
// Both providers expose the same Picker-style import flow:
//   - POST /admin/import/<provider>  body = { fileId, name, mimeType }
//   - GET  /admin/integrations/<provider>/callback?code=...&state=...
// Extracting these keeps the two route modules from declaring the same
// shapes; per-provider extras (e.g. OneDrive's error_description) are
// added by extending the base types.

import { type Readable, Transform } from 'node:stream';
import type { FastifyReply } from 'fastify';

/** Per-request byte cap shared by every remote-import path (gdrive, onedrive,
 * import-from-url): bounds a single streamed file so a multi-GB source can't be
 * buffered before sharp's pixel guard would fire. */
export const REMOTE_IMPORT_MAX_BYTES = 50 * 1024 * 1024;

/** Stream a fetched remote image body straight to the client with a hard byte
 * cap, image content-type, and no-store. Shared by the gdrive/onedrive
 * `/fetch` endpoints, which hand the standalone editor raw bytes (a Blob to
 * edit locally) rather than ingesting a stored original. */
export function streamImageWithCap(
  reply: FastifyReply,
  body: Readable,
  contentType: string,
  maxBytes: number
): FastifyReply {
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      /* c8 ignore next 3 -- testing the cap requires impractical stream size */
      if (bytes > maxBytes) {
        cb(new Error('streamed bytes exceeded limit'));
        return;
      }
      cb(null, chunk);
    }
  });
  reply.header('content-type', contentType);
  reply.header('cache-control', 'no-store');
  reply.send(body.pipe(limiter));
  return reply;
}

/** POST body for /admin/import/<provider>. The user-facing handler
 * validates fields itself, so unknowns stay loose. */
export interface ProviderImportBody {
  fileId?: unknown;
  name?: unknown;
  mimeType?: unknown;
}

/** Query string for the OAuth callback. `error` is set by the provider
 * when the user denies consent or the request is malformed. */
export interface ProviderCallbackQuery {
  code?: string;
  state?: string;
  error?: string;
}
