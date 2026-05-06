// Build a minimal multipart/form-data body with a single file part.
// Used by upload-route tests so we don't pull in form-data as a dep.

import crypto from 'node:crypto';

export function buildMultipart({ fieldName = 'file', filename, contentType, bytes }) {
  const boundary = `----rkrtest${crypto.randomBytes(8).toString('hex')}`;
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n` +
    `\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;

  const payload = Buffer.concat([Buffer.from(head, 'utf8'), bytes, Buffer.from(tail, 'utf8')]);

  return {
    payload,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(payload.length)
    }
  };
}
