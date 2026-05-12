// Build a minimal multipart/form-data body. Used by route tests so
// we don't pull in form-data as a dev dep.

import crypto from 'node:crypto';

export interface BuildMultipartArgs {
  fieldName?: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
}

export interface MultipartPayload {
  payload: Buffer;
  headers: {
    'content-type': string;
    'content-length': string;
  };
}

export function buildMultipart({
  fieldName = 'file',
  filename,
  contentType,
  bytes
}: BuildMultipartArgs): MultipartPayload {
  return buildMultipartParts([{ kind: 'file', fieldName, filename, contentType, bytes }]);
}

export type MultipartPart =
  | { kind: 'field'; fieldName: string; value: string }
  | {
      kind: 'file';
      fieldName: string;
      filename: string;
      contentType: string;
      bytes: Buffer;
    };

/** Build a multipart payload with any number of field + file parts.
 * The /admin/sidecar/:id/commit endpoint takes one of each: an `ops`
 * text field (JSON) and an optional `bake` WebP file. */
export function buildMultipartParts(parts: readonly MultipartPart[]): MultipartPayload {
  const boundary = `----rkrtest${crypto.randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    if (p.kind === 'field') {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${p.fieldName}"\r\n\r\n${p.value}\r\n`,
          'utf8'
        )
      );
    } else {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${p.fieldName}"; filename="${p.filename}"\r\nContent-Type: ${p.contentType}\r\n\r\n`,
          'utf8'
        )
      );
      chunks.push(p.bytes);
      chunks.push(Buffer.from('\r\n', 'utf8'));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  const payload = Buffer.concat(chunks);
  return {
    payload,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(payload.length)
    }
  };
}
